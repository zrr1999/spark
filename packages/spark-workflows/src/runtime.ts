import { AsyncLocalStorage } from "node:async_hooks";
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
  WorkflowStageOptions,
  WorkflowStageRun,
  WorkflowStageStatus,
  WorkflowFetchContentInput,
  WorkflowRunEvent,
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

interface WorkflowStageBudget {
  budget: number;
  startSpent: number;
  warned: boolean;
}

export function workflowCallHash(input: {
  prompt: string;
  stage?: string;
  /** @deprecated Use stage. */
  phase?: string;
  options?: WorkflowAgentOptions;
}): string {
  const stage = input.stage ?? input.phase;
  return createHash("sha256")
    .update(JSON.stringify({ prompt: input.prompt, stage, options: input.options ?? {} }))
    .digest("hex");
}

export async function runWorkflowScript<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
  const parsed = parseWorkflowScript(script);
  const stages: WorkflowStageRun[] = [];
  const stageByTitle = new Map<string, WorkflowStageRun>();
  const stageBudgets = new Map<string, WorkflowStageBudget>();
  const journal: WorkflowJournalEntry[] = [];
  const resume = options.resumeJournal ?? new Map<number, WorkflowJournalEntry>();
  const maxAgents = options.maxAgents ?? 1000;
  let currentStage: string | undefined;
  const workflowStages = parsed.meta.stages ?? parsed.meta.phases ?? [];
  const stageModelByTitle = new Map(
    workflowStages
      .filter((stage) => stage.model)
      .map((stage) => [stage.title, stage.model as string]),
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
  let eventSequence = 0;
  let parallelGroupIndex = 0;
  let toolCallIndex = 0;
  let nestedWorkflowIndex = 0;
  let eventDispatch = Promise.resolve();
  let eventDispatchError: unknown;
  const nodeContext = new AsyncLocalStorage<{ parentNodeId: string }>();
  const emitWorkflowEvent = (
    type: WorkflowRunEvent["type"],
    event: Omit<WorkflowRunEvent, "id" | "sequence" | "timestamp" | "type"> = {},
  ) => {
    if (!options.onEvent) return;
    const sequence = eventSequence++;
    const workflowEvent = {
      id: `event:${sequence}`,
      sequence,
      timestamp: now(),
      type,
      ...event,
    } as WorkflowRunEvent;
    // Workflow helpers such as stage() are intentionally synchronous, but the
    // persistence/projection callback may be asynchronous. Serialize callbacks
    // so a later agent_started update can never overtake its stage_started
    // parent in the durable stream or the live UI.
    eventDispatch = eventDispatch.then(async () => {
      try {
        await options.onEvent?.(workflowEvent);
      } catch (error) {
        eventDispatchError ??= error;
      }
    });
  };
  const flushWorkflowEvents = async (): Promise<void> => {
    await eventDispatch;
    if (eventDispatchError) throw eventDispatchError;
  };
  const stageNodeId = (stageTitle: string | undefined) =>
    stageTitle ? `stage:${stageTitle}` : undefined;
  const currentParentNodeId = (stageTitle: string | undefined = currentStage) =>
    nodeContext.getStore()?.parentNodeId ?? stageNodeId(stageTitle) ?? "run";
  const withWorkflowParent = <T>(parentNodeId: string, thunk: () => Promise<T> | T) =>
    nodeContext.run({ parentNodeId }, thunk);
  const emitToolStarted = (toolName: string, data?: unknown) => {
    const nodeId = `tool:${toolCallIndex++}`;
    emitWorkflowEvent("tool_started", {
      nodeId,
      parentId: currentParentNodeId(),
      nodeKind: "tool",
      stage: currentStage,
      phase: currentStage,
      toolName,
      label: toolName,
      data,
    });
    return nodeId;
  };

  emitWorkflowEvent("run_started", {
    nodeId: "run",
    nodeKind: "run",
    label: parsed.meta.name,
    meta: parsed.meta,
  });

  const stage = (title: string, stageOptions: WorkflowStageOptions = {}) => {
    const stageTitle = String(title);
    const status = normalizeWorkflowStageStatus(stageOptions.status);
    const timestamp = now();
    let record = stageByTitle.get(stageTitle);
    const isNewStage = !record;
    if (!record) {
      record = { title: stageTitle, startedAt: timestamp };
      stageByTitle.set(stageTitle, record);
      stages.push(record);
    }
    if (typeof stageOptions.budget === "number" && Number.isFinite(stageOptions.budget)) {
      if (stageOptions.budget <= 0) throw new Error("workflow stage budget must be > 0");
      stageBudgets.set(stageTitle, {
        budget: Math.trunc(stageOptions.budget),
        startSpent: shared.spentTokens,
        warned: false,
      });
    }
    if (status) {
      record.status = status;
      record.finishedAt = timestamp;
      emitWorkflowEvent("stage_finished", {
        nodeId: stageNodeId(stageTitle),
        nodeKind: "stage",
        title: stageTitle,
        stage: stageTitle,
        phase: stageTitle,
        stageRun: { ...record },
        phaseRun: { ...record },
        status: status === "fail" ? "failed" : status === "skip" ? "skipped" : "succeeded",
      });
      if (currentStage === stageTitle) currentStage = undefined;
    } else {
      currentStage = stageTitle;
      if (isNewStage) {
        emitWorkflowEvent("stage_started", {
          nodeId: stageNodeId(stageTitle),
          parentId: "run",
          nodeKind: "stage",
          title: stageTitle,
          stage: stageTitle,
          phase: stageTitle,
          stageRun: { ...record },
          phaseRun: { ...record },
        });
      }
    }
    options.onStage?.({ ...record });
    options.onPhase?.({ ...record });
  };

  /** @deprecated Use stage(). */
  const phase = stage;

  const budget = Object.freeze({
    total: tokenBudget,
    spent: () => shared.spentTokens,
    remaining: () =>
      tokenBudget === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, tokenBudget - shared.spentTokens),
  });

  const assertBudgetBeforeAgent = (stageName: string | undefined) => {
    if (tokenBudget !== null && shared.spentTokens >= tokenBudget) {
      throw new Error("workflow token budget exhausted");
    }
    if (!stageName) return;
    const stageBudget = stageBudgets.get(stageName);
    if (!stageBudget) return;
    const spent = shared.spentTokens - stageBudget.startSpent;
    if (spent >= stageBudget.budget) {
      throw new Error(`workflow stage budget exhausted: ${stageName}`);
    }
    if (!stageBudget.warned && spent >= stageBudget.budget * 0.8) {
      stageBudget.warned = true;
      options.onLog?.(
        `workflow stage ${stageName} has used ${Math.round((spent / stageBudget.budget) * 100)}% of its token budget`,
      );
    }
  };

  const agent = async (prompt: string, agentOptions: WorkflowAgentOptions = {}) => {
    const normalizedAgentOptions = normalizeWorkflowAgentOptions(agentOptions);
    if (shared.agentCount >= maxAgents) throw new Error("workflow agent limit exceeded");
    const index = callIndex++;
    const stageName = normalizedAgentOptions.stage ?? normalizedAgentOptions.phase ?? currentStage;
    assertBudgetBeforeAgent(stageName);
    const effectiveAgentOptions = applyWorkflowStageModel(
      normalizedAgentOptions,
      stageName ? stageModelByTitle.get(stageName) : undefined,
    );
    const effectivePrompt = renderWorkflowAgentPrompt(prompt, effectiveAgentOptions);
    const hash = workflowCallHash({
      prompt: effectivePrompt,
      stage: stageName,
      options: effectiveAgentOptions,
    });
    const cached = resume.get(index);
    if (cached?.hash === hash && index < firstResumeMiss) {
      emitWorkflowEvent("agent_cached", {
        nodeId: `agent:${index}`,
        parentId: currentParentNodeId(stageName),
        nodeKind: "agent",
        stage: stageName,
        phase: stageName,
        index,
        label: effectiveAgentOptions.label ?? "agent " + (index + 1),
        result: cached.result,
      });
      journal.push(cached);
      return cached.result;
    }
    if (!cached || cached.hash !== hash) firstResumeMiss = Math.min(firstResumeMiss, index);

    shared.agentCount += 1;
    const event = {
      index,
      label: effectiveAgentOptions.label ?? "agent " + (index + 1),
      stage: stageName,
      phase: stageName,
      prompt: effectivePrompt,
      model: effectiveAgentOptions.model,
    };
    const startedAt = workflowTelemetryTimestamp();
    const startedMs = performance.now();
    let reportedTelemetry: WorkflowAgentReportedTelemetry | undefined;
    emitWorkflowEvent("agent_started", {
      nodeId: `agent:${index}`,
      parentId: currentParentNodeId(stageName),
      nodeKind: "agent",
      stage: stageName,
      phase: stageName,
      index,
      label: event.label,
      data: { model: event.model },
    });
    await flushWorkflowEvents();
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
          stage: stageName,
          phase: stageName,
          reportTelemetry: (telemetry) => {
            reportedTelemetry = mergeWorkflowAgentReportedTelemetry(reportedTelemetry, telemetry);
          },
        }),
      );
    } catch (error) {
      const finishedAt = workflowTelemetryTimestamp();
      const telemetry = agentTelemetryFromRuntime({
        event,
        status: "failed",
        startedAt,
        finishedAt,
        startedMs,
        reportedTelemetry,
        spentTokens: shared.spentTokens,
      });
      emitWorkflowEvent("agent_failed", {
        nodeId: `agent:${index}`,
        nodeKind: "agent",
        stage: stageName,
        phase: stageName,
        index,
        label: event.label,
        telemetry,
        errorMessage: errorText(error),
      });
      await options.onAgentTelemetry?.(telemetry);
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
    emitWorkflowEvent("agent_succeeded", {
      nodeId: `agent:${index}`,
      nodeKind: "agent",
      stage: stageName,
      phase: stageName,
      index,
      label: event.label,
      telemetry,
      usage,
      result,
    });
    await options.onAgentTelemetry?.(telemetry);
    await options.onTokenUsage?.({
      spent: shared.spentTokens,
      tokens: usage.totalTokens,
      index,
      stage: stageName,
      phase: stageName,
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
    const normalized = normalizeWorkflowArtifactRecordInput(input);
    const nodeId = emitToolStarted("artifactRecord", normalized);
    if (!options.artifactRecord) {
      const error = new Error("workflow artifactRecord adapter is required for this workflow");
      emitWorkflowEvent("tool_failed", {
        nodeId,
        nodeKind: "tool",
        toolName: "artifactRecord",
        errorMessage: error.message,
      });
      throw error;
    }
    try {
      const result = await options.artifactRecord(normalized);
      if (!result.ref.trim()) throw new Error("workflow artifactRecord adapter returned empty ref");
      const recorded = { ref: result.ref.trim() };
      emitWorkflowEvent("tool_succeeded", {
        nodeId,
        nodeKind: "tool",
        toolName: "artifactRecord",
        result: recorded,
      });
      emitWorkflowEvent("artifact_recorded", {
        nodeId: `artifact:${recorded.ref}`,
        parentId: nodeId,
        nodeKind: "artifact",
        stage: currentStage,
        phase: currentStage,
        label: recorded.ref,
        result: recorded,
        data: normalized,
      });
      return recorded;
    } catch (error) {
      emitWorkflowEvent("tool_failed", {
        nodeId,
        nodeKind: "tool",
        toolName: "artifactRecord",
        errorMessage: errorText(error),
      });
      throw error;
    }
  };

  const webSearch = async (input: WorkflowWebSearchInput): Promise<unknown> => {
    const normalized = normalizeWorkflowWebSearchInput(input);
    const nodeId = emitToolStarted("webSearch", normalized);
    if (!options.webSearch) {
      const unavailable = {
        unavailable: true,
        reason: "workflow webSearch adapter is not configured",
        input: normalized,
      };
      emitWorkflowEvent("tool_succeeded", {
        nodeId,
        nodeKind: "tool",
        toolName: "webSearch",
        result: unavailable,
      });
      return unavailable;
    }
    try {
      const result = await options.webSearch(normalized);
      emitWorkflowEvent("tool_succeeded", {
        nodeId,
        nodeKind: "tool",
        toolName: "webSearch",
        result,
      });
      return result;
    } catch (error) {
      emitWorkflowEvent("tool_failed", {
        nodeId,
        nodeKind: "tool",
        toolName: "webSearch",
        errorMessage: errorText(error),
      });
      throw error;
    }
  };

  const fetchContent = async (input: WorkflowFetchContentInput): Promise<unknown> => {
    const normalized = normalizeWorkflowFetchContentInput(input);
    const nodeId = emitToolStarted("fetchContent", normalized);
    if (!options.fetchContent) {
      const unavailable = {
        unavailable: true,
        reason: "workflow fetchContent adapter is not configured",
        input: normalized,
      };
      emitWorkflowEvent("tool_succeeded", {
        nodeId,
        nodeKind: "tool",
        toolName: "fetchContent",
        result: unavailable,
      });
      return unavailable;
    }
    try {
      const result = await options.fetchContent(normalized);
      emitWorkflowEvent("tool_succeeded", {
        nodeId,
        nodeKind: "tool",
        toolName: "fetchContent",
        result,
      });
      return result;
    } catch (error) {
      emitWorkflowEvent("tool_failed", {
        nodeId,
        nodeKind: "tool",
        toolName: "fetchContent",
        errorMessage: errorText(error),
      });
      throw error;
    }
  };

  const parallel = async <T>(
    items: Array<() => Promise<T> | T>,
    parallelOptions: WorkflowParallelOptions = {},
  ): Promise<T[] | Array<WorkflowParallelSettledResult<T>>> => {
    const groupIndex = parallelGroupIndex++;
    const groupNodeId = `parallel:${groupIndex}`;
    const normalized = normalizeWorkflowParallelOptions({
      ...parallelOptions,
      concurrency: parallelOptions.concurrency ?? options.concurrency,
    });
    emitWorkflowEvent("parallel_group_started", {
      nodeId: groupNodeId,
      parentId: currentParentNodeId(),
      nodeKind: "parallel_group",
      stage: currentStage,
      phase: currentStage,
      label: `parallel group ${groupIndex + 1}`,
      data: {
        items: items.length,
        concurrency: normalized.concurrency,
        onError: normalized.onError,
      },
    });
    const wrapped = items.map((item, itemIndex) => async () => {
      const itemNodeId = `${groupNodeId}:item:${itemIndex}`;
      emitWorkflowEvent("parallel_item_started", {
        nodeId: itemNodeId,
        parentId: groupNodeId,
        nodeKind: "parallel_item",
        stage: currentStage,
        phase: currentStage,
        index: itemIndex,
        label: `parallel item ${itemIndex + 1}`,
      });
      if (typeof item !== "function") {
        const error = new TypeError("workflow parallel item must be a function");
        emitWorkflowEvent("parallel_item_failed", {
          nodeId: itemNodeId,
          nodeKind: "parallel_item",
          stage: currentStage,
          phase: currentStage,
          index: itemIndex,
          errorMessage: error.message,
        });
        throw error;
      }
      try {
        const value = await withWorkflowParent(itemNodeId, item);
        emitWorkflowEvent("parallel_item_succeeded", {
          nodeId: itemNodeId,
          nodeKind: "parallel_item",
          stage: currentStage,
          phase: currentStage,
          index: itemIndex,
          result: value,
        });
        return value;
      } catch (error) {
        emitWorkflowEvent("parallel_item_failed", {
          nodeId: itemNodeId,
          nodeKind: "parallel_item",
          stage: currentStage,
          phase: currentStage,
          index: itemIndex,
          errorMessage: errorText(error),
        });
        throw error;
      }
    });
    try {
      const result = await runWorkflowParallel(wrapped, normalized);
      const failed = Array.isArray(result)
        ? result.filter(
            (item): item is WorkflowParallelSettledResult<T> & { status: "rejected" } =>
              item !== null &&
              typeof item === "object" &&
              "status" in item &&
              item.status === "rejected",
          )
        : [];
      emitWorkflowEvent(failed.length > 0 ? "parallel_group_failed" : "parallel_group_succeeded", {
        nodeId: groupNodeId,
        nodeKind: "parallel_group",
        stage: currentStage,
        phase: currentStage,
        result,
        errorMessage: failed.length > 0 ? `${failed.length} parallel item(s) failed` : undefined,
      });
      return result;
    } catch (error) {
      emitWorkflowEvent("parallel_group_failed", {
        nodeId: groupNodeId,
        nodeKind: "parallel_group",
        stage: currentStage,
        phase: currentStage,
        errorMessage: errorText(error),
      });
      throw error;
    }
  };
  const pipeline = async (...input: unknown[]): Promise<unknown> => runWorkflowPipeline(input);
  const workflow = async (nameOrScript: string, childArgs?: unknown): Promise<unknown> => {
    if (shared.depth >= 1) throw new Error("workflow() nesting is limited to one level");
    const requested = String(nameOrScript);
    const nodeId = `workflow:${nestedWorkflowIndex++}`;
    emitWorkflowEvent("nested_workflow_started", {
      nodeId,
      parentId: currentParentNodeId(),
      nodeKind: "nested_workflow",
      stage: currentStage,
      phase: currentStage,
      workflowName: requested,
      label: requested,
      data: childArgs,
    });
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
        onEvent: undefined,
      });
      emitWorkflowEvent("nested_workflow_succeeded", {
        nodeId,
        nodeKind: "nested_workflow",
        stage: currentStage,
        phase: currentStage,
        workflowName: requested,
        result: child.result,
      });
      return child.result;
    } catch (error) {
      emitWorkflowEvent("nested_workflow_failed", {
        nodeId,
        nodeKind: "nested_workflow",
        stage: currentStage,
        phase: currentStage,
        workflowName: requested,
        errorMessage: errorText(error),
      });
      throw error;
    } finally {
      shared.depth -= 1;
    }
  };

  const verify = async (
    item: unknown,
    verifyOptions: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const toolNodeId = emitToolStarted("verify", { item, options: verifyOptions });
    const reviewers = Math.max(1, Math.trunc(verifyOptions.reviewers ?? 2));
    const threshold = verifyOptions.threshold ?? 0.5;
    const lenses = verifyOptions.lens
      ? Array.isArray(verifyOptions.lens)
        ? verifyOptions.lens
        : [verifyOptions.lens]
      : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (await withWorkflowParent(toolNodeId, () =>
      parallel(
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
      ),
    )) as unknown[];
    const realCount = votes.filter(readRealVote).length;
    const result = {
      real: votes.length > 0 && realCount / votes.length >= threshold,
      realCount,
      total: votes.length,
      votes,
    };
    emitWorkflowEvent("tool_succeeded", {
      nodeId: toolNodeId,
      nodeKind: "tool",
      toolName: "verify",
      result,
    });
    return result;
  };

  const judgePanel = async (
    attempts: unknown[],
    judgeOptions: { judges?: number; rubric?: string } = {},
  ) => {
    const toolNodeId = emitToolStarted("judgePanel", { attempts, options: judgeOptions });
    const judges = Math.max(1, Math.trunc(judgeOptions.judges ?? 3));
    const rubric = judgeOptions.rubric ?? "overall quality and correctness";
    const scored = (await withWorkflowParent(toolNodeId, () =>
      parallel(
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
      ),
    )) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    const result =
      scored.length === 0
        ? undefined
        : scored.reduce((best, candidate) =>
            candidate.score > best.score ||
            (candidate.score === best.score && candidate.index < best.index)
              ? candidate
              : best,
          );
    emitWorkflowEvent("tool_succeeded", {
      nodeId: toolNodeId,
      nodeKind: "tool",
      toolName: "judgePanel",
      result,
    });
    return result;
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
    log: (message: unknown) => {
      const text = String(message);
      emitWorkflowEvent("log", { message: text });
      options.onLog?.(text);
    },
    webSearch,
    fetchContent,
    loopUntilDry,
    parallel,
    pipeline,
    stage,
    phase,
    retry,
    verify,
    workflow,
    setTimeout,
    clearTimeout,
  });
  try {
    const result = (await runTrustedWorkflowScriptInVm<T>(parsed.body, context)) as T;
    emitWorkflowEvent("run_succeeded", { nodeId: "run", nodeKind: "run", result });
    await flushWorkflowEvents();
    return { meta: parsed.meta, result, stages, phases: stages, agentCount: callIndex, journal };
  } catch (error) {
    emitWorkflowEvent("run_failed", {
      nodeId: "run",
      nodeKind: "run",
      errorMessage: errorText(error),
    });
    try {
      await flushWorkflowEvents();
    } catch {
      // Preserve the workflow/script failure that initiated this path. When
      // event delivery itself failed, that error is already the active error.
    }
    throw error;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function applyWorkflowStageModel(
  options: WorkflowAgentOptions,
  stageModel: string | undefined,
): WorkflowAgentOptions {
  if (options.model || !stageModel) return options;
  return { ...options, model: stageModel };
}

/** @deprecated Use applyWorkflowStageModel. */
export const applyWorkflowPhaseModel = applyWorkflowStageModel;

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

export function normalizeWorkflowStageStatus(
  status: WorkflowStageOptions["status"],
): WorkflowStageStatus | undefined {
  if (status === undefined) return undefined;
  if (status === "success" || status === "fail" || status === "skip") return status;
  throw new Error("workflow stage status must be success, fail, or skip");
}

/** @deprecated Use normalizeWorkflowStageStatus. */
export const normalizeWorkflowPhaseStatus = normalizeWorkflowStageStatus;

function workflowTelemetryTimestamp(): string {
  return new Date().toISOString();
}

function agentTelemetryBase(
  event: { index: number; label: string; stage?: string; phase?: string; model?: string },
  startedAt: string,
): Omit<WorkflowAgentTelemetry, "status"> {
  const stage = event.stage ?? event.phase;
  return {
    index: event.index,
    label: event.label,
    stage,
    phase: stage,
    model: event.model,
    startedAt,
  };
}

function agentTelemetryFromRuntime(input: {
  event: { index: number; label: string; stage?: string; phase?: string; model?: string };
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
