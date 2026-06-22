import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import { parseWorkflowScript } from "./metadata.ts";
import type {
  WorkflowAgentDeliverySummary,
  WorkflowAgentOptions,
  WorkflowAgentReportedTelemetry,
  WorkflowAgentTelemetry,
  WorkflowAgentTokenUsage,
  WorkflowArtifactRecordInput,
  WorkflowArtifactRecordResult,
  WorkflowJournalEntry,
  WorkflowParallelOptions,
  WorkflowParallelSettledResult,
  WorkflowPhaseOptions,
  WorkflowPhaseRun,
  WorkflowPhaseStatus,
  WorkflowFetchContentInput,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowWebSearchInput,
} from "./types.ts";

const DEFAULT_PARALLEL_CONCURRENCY = 16;
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in workflow scripts because it breaks deterministic resume"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (name) => { throw new Error(name + " is unavailable in workflow scripts because it breaks deterministic resume"); };',
  "  const SafeDate = function (...args) {",
  '    if (!new.target) fail("Date()");',
  '    if (args.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, args, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

interface WorkflowSharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spentTokens: number;
  depth: number;
}

interface WorkflowPhaseBudget {
  budget: number;
  startSpent: number;
  warned: boolean;
}

export function workflowCallHash(input: {
  prompt: string;
  phase?: string;
  options?: WorkflowAgentOptions;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ prompt: input.prompt, phase: input.phase, options: input.options ?? {} }),
    )
    .digest("hex");
}

export async function runWorkflowScript<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
  const parsed = parseWorkflowScript(script);
  const phases: WorkflowPhaseRun[] = [];
  const phaseByTitle = new Map<string, WorkflowPhaseRun>();
  const phaseBudgets = new Map<string, WorkflowPhaseBudget>();
  const journal: WorkflowJournalEntry[] = [];
  const resume = options.resumeJournal ?? new Map<number, WorkflowJournalEntry>();
  const maxAgents = options.maxAgents ?? 1000;
  let currentPhase: string | undefined;
  const phaseModelByTitle = new Map(
    (parsed.meta.phases ?? [])
      .filter((phase) => phase.model)
      .map((phase) => [phase.title, phase.model as string]),
  );
  let callIndex = 0;
  let firstResumeMiss = Number.POSITIVE_INFINITY;
  const now = options.now ?? (() => new Date().toISOString());
  const shared: WorkflowSharedRuntime = (options.sharedRuntime as
    | WorkflowSharedRuntime
    | undefined) ?? {
    limiter: createWorkflowLimiter(options.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY),
    agentCount: 0,
    spentTokens: 0,
    depth: 0,
  };
  const tokenBudget = options.tokenBudget ?? null;

  const phase = (title: string, phaseOptions: WorkflowPhaseOptions = {}) => {
    const phaseTitle = String(title);
    const status = normalizeWorkflowPhaseStatus(phaseOptions.status);
    const timestamp = now();
    let record = phaseByTitle.get(phaseTitle);
    if (!record) {
      record = { title: phaseTitle, startedAt: timestamp };
      phaseByTitle.set(phaseTitle, record);
      phases.push(record);
    }
    if (typeof phaseOptions.budget === "number" && Number.isFinite(phaseOptions.budget)) {
      if (phaseOptions.budget <= 0) throw new Error("workflow phase budget must be > 0");
      phaseBudgets.set(phaseTitle, {
        budget: Math.trunc(phaseOptions.budget),
        startSpent: shared.spentTokens,
        warned: false,
      });
    }
    if (status) {
      record.status = status;
      record.finishedAt = timestamp;
      if (currentPhase === phaseTitle) currentPhase = undefined;
    } else {
      currentPhase = phaseTitle;
    }
    options.onPhase?.({ ...record });
  };

  const budget = Object.freeze({
    total: tokenBudget,
    spent: () => shared.spentTokens,
    remaining: () =>
      tokenBudget === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, tokenBudget - shared.spentTokens),
  });

  const assertBudgetBeforeAgent = (phaseName: string | undefined) => {
    if (tokenBudget !== null && shared.spentTokens >= tokenBudget) {
      throw new Error("workflow token budget exhausted");
    }
    if (!phaseName) return;
    const phaseBudget = phaseBudgets.get(phaseName);
    if (!phaseBudget) return;
    const spent = shared.spentTokens - phaseBudget.startSpent;
    if (spent >= phaseBudget.budget) {
      throw new Error(`workflow phase budget exhausted: ${phaseName}`);
    }
    if (!phaseBudget.warned && spent >= phaseBudget.budget * 0.8) {
      phaseBudget.warned = true;
      options.onLog?.(
        `workflow phase ${phaseName} has used ${Math.round((spent / phaseBudget.budget) * 100)}% of its token budget`,
      );
    }
  };

  const agent = async (prompt: string, agentOptions: WorkflowAgentOptions = {}) => {
    const normalizedAgentOptions = normalizeWorkflowAgentOptions(agentOptions);
    if (shared.agentCount >= maxAgents) throw new Error("workflow agent limit exceeded");
    const index = callIndex++;
    const phaseName = normalizedAgentOptions.phase ?? currentPhase;
    assertBudgetBeforeAgent(phaseName);
    const effectiveAgentOptions = applyWorkflowPhaseModel(
      normalizedAgentOptions,
      phaseName ? phaseModelByTitle.get(phaseName) : undefined,
    );
    const effectivePrompt = renderWorkflowAgentPrompt(prompt, effectiveAgentOptions);
    const hash = workflowCallHash({
      prompt: effectivePrompt,
      phase: phaseName,
      options: effectiveAgentOptions,
    });
    const cached = resume.get(index);
    if (cached?.hash === hash && index < firstResumeMiss) {
      journal.push(cached);
      return cached.result;
    }
    if (!cached || cached.hash !== hash) firstResumeMiss = Math.min(firstResumeMiss, index);

    shared.agentCount += 1;
    const event = {
      index,
      label: effectiveAgentOptions.label ?? "agent " + (index + 1),
      phase: phaseName,
      prompt: effectivePrompt,
      model: effectiveAgentOptions.model,
    };
    const startedAt = workflowTelemetryTimestamp();
    const startedMs = performance.now();
    let reportedTelemetry: WorkflowAgentReportedTelemetry | undefined;
    options.onAgentStart?.(event);
    await options.onAgentTelemetry?.({
      ...agentTelemetryBase(event, startedAt),
      status: "running",
      lastActivityAt: startedAt,
      metadata: undefined,
    });
    let result: unknown;
    try {
      result = await shared.limiter(() =>
        options.agent(effectivePrompt, {
          ...effectiveAgentOptions,
          index,
          phase: phaseName,
          reportTelemetry: (telemetry) => {
            reportedTelemetry = mergeWorkflowAgentReportedTelemetry(reportedTelemetry, telemetry);
          },
        }),
      );
    } catch (error) {
      const finishedAt = workflowTelemetryTimestamp();
      await options.onAgentTelemetry?.(
        agentTelemetryFromRuntime({
          event,
          status: "failed",
          startedAt,
          finishedAt,
          startedMs,
          reportedTelemetry,
          spentTokens: shared.spentTokens,
        }),
      );
      throw error;
    }
    assertWorkflowAgentDelivered(result, event.label);
    const estimatedTokens =
      estimateWorkflowTokens(effectivePrompt) + estimateWorkflowTokens(result);
    const usage = normalizeWorkflowAgentUsage(
      reportedTelemetry?.usage,
      estimatedTokens,
      effectiveAgentOptions.model,
    );
    if (!usage) throw new Error("workflow agent usage unavailable");
    shared.spentTokens += usage.totalTokens;
    const finishedAt = workflowTelemetryTimestamp();
    const telemetry = agentTelemetryFromRuntime({
      event,
      status: "succeeded",
      startedAt,
      finishedAt,
      startedMs,
      reportedTelemetry,
      usage,
      spentTokens: shared.spentTokens,
    });
    await options.onAgentTelemetry?.(telemetry);
    await options.onTokenUsage?.({
      spent: shared.spentTokens,
      tokens: usage.totalTokens,
      index,
      phase: phaseName,
      usage,
    });
    const entry = { index, hash, result };
    journal.push(entry);
    await options.onAgentJournal?.(entry);
    options.onAgentEnd?.({ ...event, result });
    return result;
  };

  const artifactRecord = async (
    input: WorkflowArtifactRecordInput,
  ): Promise<WorkflowArtifactRecordResult> => {
    if (!options.artifactRecord) {
      throw new Error("workflow artifactRecord adapter is required for this workflow");
    }
    const normalized = normalizeWorkflowArtifactRecordInput(input);
    const result = await options.artifactRecord(normalized);
    if (!result.ref.trim()) throw new Error("workflow artifactRecord adapter returned empty ref");
    return { ref: result.ref.trim() };
  };

  const webSearch = async (input: WorkflowWebSearchInput): Promise<unknown> => {
    const normalized = normalizeWorkflowWebSearchInput(input);
    if (!options.webSearch) {
      return {
        unavailable: true,
        reason: "workflow webSearch adapter is not configured",
        input: normalized,
      };
    }
    return options.webSearch(normalized);
  };

  const fetchContent = async (input: WorkflowFetchContentInput): Promise<unknown> => {
    const normalized = normalizeWorkflowFetchContentInput(input);
    if (!options.fetchContent) {
      return {
        unavailable: true,
        reason: "workflow fetchContent adapter is not configured",
        input: normalized,
      };
    }
    return options.fetchContent(normalized);
  };

  const parallel = async <T>(
    items: Array<() => Promise<T> | T>,
    parallelOptions: WorkflowParallelOptions = {},
  ): Promise<T[] | Array<WorkflowParallelSettledResult<T>>> =>
    runWorkflowParallel(items, {
      ...parallelOptions,
      concurrency: parallelOptions.concurrency ?? options.concurrency,
    });
  const pipeline = async (...input: unknown[]): Promise<unknown> => runWorkflowPipeline(input);
  const workflow = async (nameOrScript: string, childArgs?: unknown): Promise<unknown> => {
    if (shared.depth >= 1) throw new Error("workflow() nesting is limited to one level");
    const requested = String(nameOrScript);
    shared.depth += 1;
    try {
      const loaded = options.loadWorkflowScript
        ? await options.loadWorkflowScript(requested)
        : requested;
      if (!loaded) throw new Error(`workflow not found: ${requested}`);
      const child = await runWorkflowScript(loaded, {
        ...options,
        args: childArgs,
        resumeJournal: undefined,
        sharedRuntime: shared,
      });
      return child.result;
    } finally {
      shared.depth -= 1;
    }
  };

  const verify = async (
    item: unknown,
    verifyOptions: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const reviewers = Math.max(1, Math.trunc(verifyOptions.reviewers ?? 2));
    const threshold = verifyOptions.threshold ?? 0.5;
    const lenses = verifyOptions.lens
      ? Array.isArray(verifyOptions.lens)
        ? verifyOptions.lens
        : [verifyOptions.lens]
      : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (await parallel(
      Array.from(
        { length: reviewers },
        (_value, index) => () =>
          agent(
            [
              "Adversarially verify whether this item is real/correct.",
              "Return JSON-compatible data with a boolean `real` field and optional `reason`.",
              lenses.length ? `Lens: ${lenses[index % lenses.length]}` : undefined,
              "",
              claim,
            ]
              .filter((line): line is string => line !== undefined)
              .join("\n"),
            { label: `verify ${index + 1}`, schema: VERIFY_SCHEMA },
          ),
      ),
    )) as unknown[];
    const realCount = votes.filter(readRealVote).length;
    return {
      real: votes.length > 0 && realCount / votes.length >= threshold,
      realCount,
      total: votes.length,
      votes,
    };
  };

  const judgePanel = async (
    attempts: unknown[],
    judgeOptions: { judges?: number; rubric?: string } = {},
  ) => {
    const judges = Math.max(1, Math.trunc(judgeOptions.judges ?? 3));
    const rubric = judgeOptions.rubric ?? "overall quality and correctness";
    const scored = (await parallel(
      attempts.map((attempt, attemptIndex) => async () => {
        const text = typeof attempt === "string" ? attempt : JSON.stringify(attempt);
        const judgments = (await parallel(
          Array.from(
            { length: judges },
            (_value, judgeIndex) => () =>
              agent(
                `Score this candidate from 0 to 1 on ${rubric}. Return JSON with numeric score and optional reason.\n\n${text}`,
                { label: `judge ${attemptIndex + 1}.${judgeIndex + 1}`, schema: JUDGE_SCHEMA },
              ),
          ),
        )) as unknown[];
        const score = meanScore(judgments);
        return { index: attemptIndex, attempt, score, judgments };
      }),
    )) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    if (scored.length === 0) return undefined;
    return scored.reduce((best, candidate) =>
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.index < best.index)
        ? candidate
        : best,
    );
  };

  const loopUntilDry = async (loopOptions: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => {
    if (!loopOptions || typeof loopOptions.round !== "function") {
      throw new TypeError("loopUntilDry requires { round: (index) => items[] }");
    }
    const key = loopOptions.key ?? ((item: unknown) => JSON.stringify(item));
    const consecutiveEmpty = Math.max(1, Math.trunc(loopOptions.consecutiveEmpty ?? 2));
    const maxRounds = Math.max(1, Math.trunc(loopOptions.maxRounds ?? 50));
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dryRounds = 0;
    for (let roundIndex = 0; roundIndex < maxRounds && dryRounds < consecutiveEmpty; roundIndex++) {
      const items = (await loopOptions.round(roundIndex)) ?? [];
      const fresh = (Array.isArray(items) ? items : []).filter((item) => {
        const itemKey = key(item);
        if (seen.has(itemKey)) return false;
        seen.add(itemKey);
        return true;
      });
      if (fresh.length === 0) {
        dryRounds += 1;
      } else {
        dryRounds = 0;
        all.push(...fresh);
      }
    }
    return all;
  };

  const completenessCheck = (taskArgs: unknown, results: unknown) =>
    agent(
      [
        "Given the task and gathered results, identify concrete missing coverage or say complete=true.",
        "Return JSON-compatible data with boolean `complete` and optional array `missing`.",
        "",
        "Task:",
        JSON.stringify(taskArgs),
        "",
        "Results:",
        JSON.stringify(results).slice(0, 8_000),
      ].join("\n"),
      { label: "completeness critic", schema: COMPLETENESS_SCHEMA },
    );

  const retry = async (
    thunk: (attempt: number) => unknown,
    retryOptions: { attempts?: number; until?: (result: unknown) => boolean } = {},
  ) => {
    const attempts = Math.max(1, Math.trunc(retryOptions.attempts ?? 3));
    let last: unknown;
    for (let index = 0; index < attempts; index++) {
      last = await thunk(index);
      if (!retryOptions.until || retryOptions.until(last)) return last;
    }
    return last;
  };

  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => unknown,
    validator: (
      result: unknown,
    ) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    gateOptions: { attempts?: number } = {},
  ) => {
    const attempts = Math.max(1, Math.trunc(gateOptions.attempts ?? 3));
    let feedback: string | undefined;
    let value: unknown;
    for (let index = 0; index < attempts; index++) {
      value = await thunk(feedback, index);
      const verdict = await validator(value);
      if (verdict.ok) return { ok: true, value, attempts: index + 1 };
      feedback = verdict.feedback;
    }
    return { ok: false, value, attempts };
  };

  const context = vm.createContext({
    args: options.args,
    agent,
    artifactRecord,
    budget,
    completenessCheck,
    console,
    gate,
    judgePanel,
    log: (message: unknown) => options.onLog?.(String(message)),
    webSearch,
    fetchContent,
    loopUntilDry,
    parallel,
    pipeline,
    phase,
    retry,
    verify,
    workflow,
    setTimeout,
    clearTimeout,
  });
  const result = (await runTrustedWorkflowScriptInVm<T>(parsed.body, context)) as T;
  return { meta: parsed.meta, result, phases, agentCount: callIndex, journal };
}

function runTrustedWorkflowScriptInVm<T>(body: string, context: vm.Context): Promise<T> {
  const wrapped = DETERMINISM_PRELUDE + "\n(async () => {\n" + body + "\n})()";
  return new vm.Script(wrapped).runInContext(context, { timeout: 1000 }) as Promise<T>; // NOSONAR saved workflows are local workspace/user scripts run in a capability-limited VM context.
}

export function normalizeWorkflowAgentOptions(options: WorkflowAgentOptions): WorkflowAgentOptions {
  if (options.isolation !== undefined && options.isolation !== "graft") {
    throw new Error("workflow agent isolation must be 'graft' when provided");
  }
  if (options.artifactRef !== undefined) {
    const artifactRef = options.artifactRef.trim();
    if (!artifactRef) throw new Error("workflow agent artifactRef must be non-empty");
    return { ...options, artifactRef };
  }
  return options;
}

export function applyWorkflowPhaseModel(
  options: WorkflowAgentOptions,
  phaseModel: string | undefined,
): WorkflowAgentOptions {
  if (options.model || !phaseModel) return options;
  return { ...options, model: phaseModel };
}

export function normalizeWorkflowArtifactRecordInput(
  input: WorkflowArtifactRecordInput,
): WorkflowArtifactRecordInput {
  if (!input || typeof input !== "object") {
    throw new Error("workflow artifactRecord input must be an object");
  }
  const title = normalizeNonEmptyWorkflowString(input.title, "artifactRecord.title");
  const body = normalizeNonEmptyWorkflowString(input.body, "artifactRecord.body");
  const normalized: WorkflowArtifactRecordInput = {
    ...input,
    title,
    body,
    kind: input.kind?.trim() || "research",
    format: input.format?.trim() || "markdown",
  };
  const taskRef = input.taskRef?.trim();
  const projectRef = input.projectRef?.trim();
  if (taskRef) normalized.taskRef = taskRef;
  if (projectRef) normalized.projectRef = projectRef;
  return normalized;
}

export function normalizeWorkflowWebSearchInput(
  input: WorkflowWebSearchInput,
): WorkflowWebSearchInput {
  if (!input || typeof input !== "object") {
    throw new Error("workflow webSearch input must be an object");
  }
  const query = input.query?.trim();
  const queries = Array.isArray(input.queries)
    ? input.queries.map((item) => String(item).trim()).filter(Boolean)
    : undefined;
  if (!query && (!queries || queries.length === 0)) {
    throw new Error("workflow webSearch requires query or queries");
  }
  return removeUndefinedFields({
    query,
    queries,
    numResults: normalizeOptionalPositiveInteger(input.numResults, "webSearch.numResults"),
    includeContent: input.includeContent,
    recencyFilter: input.recencyFilter,
    domainFilter: Array.isArray(input.domainFilter)
      ? input.domainFilter.map((item) => String(item).trim()).filter(Boolean)
      : undefined,
  });
}

export function normalizeWorkflowFetchContentInput(
  input: WorkflowFetchContentInput,
): WorkflowFetchContentInput {
  if (!input || typeof input !== "object") {
    throw new Error("workflow fetchContent input must be an object");
  }
  return removeUndefinedFields({
    url: normalizeNonEmptyWorkflowString(input.url, "fetchContent.url"),
    prompt: input.prompt?.trim() || undefined,
  });
}

function normalizeOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`workflow ${field} must be a positive number`);
  }
  return Math.trunc(value);
}

export function normalizeWorkflowPhaseStatus(
  status: WorkflowPhaseOptions["status"],
): WorkflowPhaseStatus | undefined {
  if (status === undefined) return undefined;
  if (status === "success" || status === "fail" || status === "skip") return status;
  throw new Error("workflow phase status must be success, fail, or skip");
}

function workflowTelemetryTimestamp(): string {
  return new Date().toISOString();
}

function agentTelemetryBase(
  event: { index: number; label: string; phase?: string; model?: string },
  startedAt: string,
): Omit<WorkflowAgentTelemetry, "status"> {
  return {
    index: event.index,
    label: event.label,
    phase: event.phase,
    model: event.model,
    startedAt,
  };
}

function agentTelemetryFromRuntime(input: {
  event: { index: number; label: string; phase?: string; model?: string };
  status: WorkflowAgentTelemetry["status"];
  startedAt: string;
  finishedAt: string;
  startedMs: number;
  reportedTelemetry?: WorkflowAgentReportedTelemetry;
  usage?: WorkflowAgentTokenUsage;
  spentTokens?: number;
}): WorkflowAgentTelemetry {
  const durationMs = Math.max(0, Math.round(performance.now() - input.startedMs));
  const usage = input.usage ?? normalizeWorkflowAgentUsage(input.reportedTelemetry?.usage);
  const telemetry: WorkflowAgentTelemetry = {
    ...agentTelemetryBase(input.event, input.startedAt),
    status: input.status,
    finishedAt: input.finishedAt,
    lastActivityAt: input.reportedTelemetry?.lastActivityAt ?? input.finishedAt,
    durationMs,
    runRef: input.reportedTelemetry?.runRef,
    metadata: sanitizeWorkflowTelemetryMetadata(input.reportedTelemetry?.metadata),
  };
  if (usage) telemetry.usage = usage;
  if (input.spentTokens !== undefined) telemetry.spentTokens = input.spentTokens;
  if (usage && durationMs > 0) telemetry.tokensPerSecond = usage.totalTokens / (durationMs / 1000);
  return telemetry;
}

function mergeWorkflowAgentReportedTelemetry(
  previous: WorkflowAgentReportedTelemetry | undefined,
  next: WorkflowAgentReportedTelemetry,
): WorkflowAgentReportedTelemetry {
  return {
    ...previous,
    ...next,
    usage: mergeReportedUsage(previous?.usage, next.usage),
    metadata: mergeTelemetryMetadata(previous?.metadata, next.metadata),
  };
}

function mergeReportedUsage(
  previous: WorkflowAgentReportedTelemetry["usage"],
  next: WorkflowAgentReportedTelemetry["usage"],
): WorkflowAgentReportedTelemetry["usage"] {
  if (!previous) return next;
  if (!next) return previous;
  return { ...previous, ...next };
}

function mergeTelemetryMetadata(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!previous) return next;
  if (!next) return previous;
  return { ...previous, ...next };
}

function normalizeWorkflowAgentUsage(
  reported: WorkflowAgentReportedTelemetry["usage"],
  estimatedTokens?: number,
  fallbackModel?: string,
): WorkflowAgentTokenUsage | undefined {
  const inputTokens = nonNegativeInteger(reported?.inputTokens);
  const outputTokens = nonNegativeInteger(reported?.outputTokens);
  const cacheReadTokens = nonNegativeInteger(reported?.cacheReadTokens);
  const cacheWriteTokens = nonNegativeInteger(reported?.cacheWriteTokens);
  const reportedTotal = nonNegativeInteger(reported?.totalTokens);
  const summedTotal = sumDefined([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]);
  const actualTotal = reportedTotal ?? summedTotal;
  if (actualTotal !== undefined) {
    return removeUndefinedFields({
      source: "actual" as const,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: actualTotal,
      costUsd: nonNegativeFiniteNumber(reported?.costUsd),
      model: reported?.model ?? fallbackModel,
      provider: reported?.provider,
    });
  }
  if (estimatedTokens === undefined) return undefined;
  return removeUndefinedFields({
    source: "estimated" as const,
    totalTokens: Math.max(0, Math.trunc(estimatedTokens)),
    costUsd: nonNegativeFiniteNumber(reported?.costUsd),
    model: reported?.model ?? fallbackModel,
    provider: reported?.provider,
  });
}

function sanitizeWorkflowTelemetryMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  try {
    const encoded = JSON.stringify(metadata);
    if (encoded.length > 2_000) return { truncated: true, bytes: encoded.length };
    return JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    return { truncated: true };
  }
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = nonNegativeFiniteNumber(value);
  return number === undefined ? undefined : Math.trunc(number);
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  let total = 0;
  let found = false;
  for (const value of values) {
    if (value === undefined) continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
}

function removeUndefinedFields<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
}

export function renderWorkflowAgentPrompt(prompt: string, options: WorkflowAgentOptions): string {
  if (!options.artifactRef) return prompt;
  return [
    "CONTEXT_BUNDLE: read artifact ref " +
      options.artifactRef +
      " for shared context before acting.",
    "",
    "Workflow agent request:",
    prompt,
  ].join("\n");
}

export async function runWorkflowParallel<T>(
  items: Array<() => Promise<T> | T>,
  options: WorkflowParallelOptions = {},
): Promise<T[] | Array<WorkflowParallelSettledResult<T>>> {
  const normalized = normalizeWorkflowParallelOptions(options);
  if (items.length === 0) return [];
  const results = Array.from({ length: items.length }, () => missingWorkflowParallelResult<T>());
  let nextIndex = 0;
  let shouldStop = false;
  const workerCount = Math.min(normalized.concurrency, items.length);

  const worker = async () => {
    while (!shouldStop) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const result = await runWorkflowParallelItem(items[index], normalized.retry);
      results[index] = result;
      if (normalized.onError === "fail-fast" && result.status === "rejected") {
        shouldStop = true;
        throw result.reason;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (normalized.onError === "collect") return results;
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

export function normalizeWorkflowParallelOptions(options: WorkflowParallelOptions): {
  concurrency: number;
  retry: Required<WorkflowParallelOptions>["retry"] & { attempts: number; backoffMs: number };
  onError: "fail-fast" | "collect";
} {
  const rawConcurrency = options.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY;
  const concurrency = Number.isFinite(rawConcurrency)
    ? Math.trunc(rawConcurrency)
    : DEFAULT_PARALLEL_CONCURRENCY;
  if (concurrency < 1) throw new Error("workflow parallel concurrency must be >= 1");
  const attempts = Math.trunc(options.retry?.attempts ?? 1);
  if (attempts < 1) throw new Error("workflow parallel retry.attempts must be >= 1");
  const backoffMs = Math.trunc(options.retry?.backoffMs ?? 0);
  if (backoffMs < 0) throw new Error("workflow parallel retry.backoffMs must be >= 0");
  const onError = options.onError ?? "fail-fast";
  if (onError !== "fail-fast" && onError !== "collect") {
    throw new Error("workflow parallel onError must be 'fail-fast' or 'collect'");
  }
  return { concurrency, retry: { attempts, backoffMs }, onError };
}

function missingWorkflowParallelResult<T>(): WorkflowParallelSettledResult<T> {
  return {
    status: "rejected",
    reason: new Error("workflow parallel result was not recorded"),
    attempts: 0,
  };
}

async function runWorkflowParallelItem<T>(
  item: (() => Promise<T> | T) | undefined,
  retry: { attempts: number; backoffMs: number },
): Promise<WorkflowParallelSettledResult<T>> {
  if (typeof item !== "function") {
    return {
      status: "rejected",
      reason: new TypeError("workflow parallel item must be a function"),
      attempts: 0,
    };
  }
  let attempt = 0;
  let lastError: unknown;
  while (attempt < retry.attempts) {
    attempt += 1;
    try {
      return { status: "fulfilled", value: await item(), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < retry.attempts && retry.backoffMs > 0) await sleep(retry.backoffMs);
    }
  }
  return { status: "rejected", reason: lastError, attempts: attempt };
}

async function runWorkflowPipeline(input: unknown[]): Promise<unknown> {
  const [first, second, ...rest] = input;
  if (Array.isArray(first) && first.every((step) => typeof step === "function")) {
    let value = second;
    for (const step of first as Array<(value: unknown) => unknown>) {
      value = await step(value);
    }
    return value;
  }
  if (Array.isArray(first) && [second, ...rest].every((stage) => typeof stage === "function")) {
    const stages = [second, ...rest] as Array<
      (value: unknown, original: unknown, index: number) => unknown
    >;
    return Promise.all(
      first.map(async (item, index) => {
        let value = item;
        for (const stage of stages) value = await stage(value, item, index);
        return value;
      }),
    );
  }
  throw new TypeError(
    "workflow pipeline expects pipeline([steps], initial) or pipeline(items, ...stages)",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNonEmptyWorkflowString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("workflow " + field + " must be a non-empty string");
  }
  return value.trim();
}

export function summarizeWorkflowAgentDelivery(result: unknown): WorkflowAgentDeliverySummary {
  const explicit = readWorkflowAgentDelivery(result);
  if (explicit) return explicit;
  if (result === undefined || result === null) {
    return { status: "empty", message: "agent returned no result" };
  }
  if (typeof result === "string" && result.trim().length === 0) {
    return { status: "empty", message: "agent returned empty text" };
  }
  return { status: typeof result === "string" ? "non_json_output" : "delivered" };
}

function assertWorkflowAgentDelivered(result: unknown, label: string): void {
  const delivery = summarizeWorkflowAgentDelivery(result);
  if (delivery.status !== "empty") return;
  throw new Error(
    "workflow agent " +
      label +
      " produced empty delivery" +
      (delivery.message ? ": " + delivery.message : ""),
  );
}

function readWorkflowAgentDelivery(result: unknown): WorkflowAgentDeliverySummary | undefined {
  if (!isRecord(result)) return undefined;
  const direct = parseWorkflowAgentDelivery(result.delivery);
  if (direct) return direct;
  const details = isRecord(result.details)
    ? parseWorkflowAgentDelivery(result.details.delivery)
    : undefined;
  return details;
}

function parseWorkflowAgentDelivery(value: unknown): WorkflowAgentDeliverySummary | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  if (status !== "delivered" && status !== "non_json_output" && status !== "empty") {
    return undefined;
  }
  const message = typeof value.message === "string" ? value.message : undefined;
  return { status, message };
}

function createWorkflowLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const normalized = Math.max(1, Math.trunc(limit));
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active -= 1;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= normalized) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

const VERIFY_SCHEMA = {
  type: "object",
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
  required: ["real"],
};

const JUDGE_SCHEMA = {
  type: "object",
  properties: { score: { type: "number" }, reason: { type: "string" } },
  required: ["score"],
};

const COMPLETENESS_SCHEMA = {
  type: "object",
  properties: {
    complete: { type: "boolean" },
    missing: { type: "array", items: { type: "string" } },
  },
  required: ["complete"],
};

function readRealVote(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.real === true;
}

function meanScore(values: unknown[]): number {
  const scores = values
    .map((value) => (isRecord(value) && typeof value.score === "number" ? value.score : undefined))
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (scores.length === 0) return 0;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function estimateWorkflowTokens(value: unknown): number {
  if (typeof value === "string") return Math.ceil(value.length / 4);
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
