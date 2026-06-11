import { createHash } from "node:crypto";
import vm from "node:vm";
import { parseSparkWorkflowScript } from "./metadata.ts";
import type {
  SparkWorkflowAgentDeliverySummary,
  SparkWorkflowAgentOptions,
  SparkWorkflowArtifactRecordInput,
  SparkWorkflowArtifactRecordResult,
  SparkWorkflowJournalEntry,
  SparkWorkflowParallelOptions,
  SparkWorkflowParallelSettledResult,
  SparkWorkflowPhaseOptions,
  SparkWorkflowPhaseRun,
  SparkWorkflowPhaseStatus,
  SparkWorkflowRunOptions,
  SparkWorkflowRunResult,
} from "./types.ts";

const DEFAULT_PARALLEL_CONCURRENCY = Number.POSITIVE_INFINITY;

export function sparkWorkflowCallHash(input: {
  prompt: string;
  phase?: string;
  options?: SparkWorkflowAgentOptions;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ prompt: input.prompt, phase: input.phase, options: input.options ?? {} }),
    )
    .digest("hex");
}

export async function runSparkWorkflowScript<T = unknown>(
  script: string,
  options: SparkWorkflowRunOptions,
): Promise<SparkWorkflowRunResult<T>> {
  const parsed = parseSparkWorkflowScript(script);
  const phases: SparkWorkflowPhaseRun[] = [];
  const phaseByTitle = new Map<string, SparkWorkflowPhaseRun>();
  const journal: SparkWorkflowJournalEntry[] = [];
  const resume = options.resumeJournal ?? new Map<number, SparkWorkflowJournalEntry>();
  const maxAgents = options.maxAgents ?? 1000;
  let currentPhase: string | undefined;
  const phaseModelByTitle = new Map(
    (parsed.meta.phases ?? [])
      .filter((phase) => phase.model)
      .map((phase) => [phase.title, phase.model as string]),
  );
  let callIndex = 0;
  const now = options.now ?? (() => new Date().toISOString());

  const phase = (title: string, phaseOptions: SparkWorkflowPhaseOptions = {}) => {
    const phaseTitle = String(title);
    const status = normalizeSparkWorkflowPhaseStatus(phaseOptions.status);
    const timestamp = now();
    let record = phaseByTitle.get(phaseTitle);
    if (!record) {
      record = { title: phaseTitle, startedAt: timestamp };
      phaseByTitle.set(phaseTitle, record);
      phases.push(record);
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

  const agent = async (prompt: string, agentOptions: SparkWorkflowAgentOptions = {}) => {
    const normalizedAgentOptions = normalizeSparkWorkflowAgentOptions(agentOptions);
    if (callIndex >= maxAgents) throw new Error("Spark workflow agent limit exceeded");
    const index = callIndex++;
    const phaseName = normalizedAgentOptions.phase ?? currentPhase;
    const effectiveAgentOptions = applySparkWorkflowPhaseModel(
      normalizedAgentOptions,
      phaseName ? phaseModelByTitle.get(phaseName) : undefined,
    );
    const effectivePrompt = renderSparkWorkflowAgentPrompt(prompt, effectiveAgentOptions);
    const hash = sparkWorkflowCallHash({
      prompt: effectivePrompt,
      phase: phaseName,
      options: effectiveAgentOptions,
    });
    const cached = resume.get(index);
    if (cached?.hash === hash) {
      journal.push(cached);
      return cached.result;
    }
    const event = {
      index,
      label: effectiveAgentOptions.label ?? "agent " + (index + 1),
      phase: phaseName,
      prompt: effectivePrompt,
      model: effectiveAgentOptions.model,
    };
    options.onAgentStart?.(event);
    const result = await options.agent(effectivePrompt, {
      ...effectiveAgentOptions,
      index,
      phase: phaseName,
    });
    assertSparkWorkflowAgentDelivered(result, event.label);
    const entry = { index, hash, result };
    journal.push(entry);
    options.onAgentJournal?.(entry);
    options.onAgentEnd?.({ ...event, result });
    return result;
  };

  const artifactRecord = async (
    input: SparkWorkflowArtifactRecordInput,
  ): Promise<SparkWorkflowArtifactRecordResult> => {
    if (!options.artifactRecord) {
      throw new Error("Spark workflow artifactRecord adapter is required for this workflow");
    }
    const normalized = normalizeSparkWorkflowArtifactRecordInput(input);
    const result = await options.artifactRecord(normalized);
    if (!result.ref.trim())
      throw new Error("Spark workflow artifactRecord adapter returned empty ref");
    return { ref: result.ref.trim() };
  };

  const parallel = async <T>(
    items: Array<() => Promise<T> | T>,
    parallelOptions: SparkWorkflowParallelOptions = {},
  ): Promise<T[] | Array<SparkWorkflowParallelSettledResult<T>>> =>
    runSparkWorkflowParallel(items, {
      ...parallelOptions,
      concurrency: parallelOptions.concurrency ?? options.concurrency,
    });
  const pipeline = async <T>(
    steps: Array<(value: unknown) => Promise<unknown>>,
    initial?: T,
  ): Promise<unknown> => {
    let value: unknown = initial;
    for (const step of steps) value = await step(value);
    return value;
  };

  const context = vm.createContext({
    args: options.args,
    agent,
    artifactRecord,
    parallel,
    pipeline,
    phase,
    console,
    setTimeout,
    clearTimeout,
  });
  const result = (await runTrustedWorkflowScriptInVm<T>(parsed.body, context)) as T;
  return { meta: parsed.meta, result, phases, agentCount: callIndex, journal };
}

function runTrustedWorkflowScriptInVm<T>(body: string, context: vm.Context): Promise<T> {
  const wrapped = "(async () => {\n" + body + "\n})()";
  return new vm.Script(wrapped).runInContext(context, { timeout: 1000 }) as Promise<T>; // NOSONAR saved Spark workflows are local workspace/user scripts run in a capability-limited VM context.
}

export function normalizeSparkWorkflowAgentOptions(
  options: SparkWorkflowAgentOptions,
): SparkWorkflowAgentOptions {
  if (options.isolation !== undefined && options.isolation !== "worktree") {
    throw new Error("Spark workflow agent isolation must be 'worktree' when provided");
  }
  if (options.artifactRef !== undefined) {
    const artifactRef = options.artifactRef.trim();
    if (!artifactRef) throw new Error("Spark workflow agent artifactRef must be non-empty");
    return { ...options, artifactRef };
  }
  return options;
}

export function applySparkWorkflowPhaseModel(
  options: SparkWorkflowAgentOptions,
  phaseModel: string | undefined,
): SparkWorkflowAgentOptions {
  if (options.model || !phaseModel) return options;
  return { ...options, model: phaseModel };
}

export function normalizeSparkWorkflowArtifactRecordInput(
  input: SparkWorkflowArtifactRecordInput,
): SparkWorkflowArtifactRecordInput {
  if (!input || typeof input !== "object") {
    throw new Error("Spark workflow artifactRecord input must be an object");
  }
  const title = normalizeNonEmptyWorkflowString(input.title, "artifactRecord.title");
  const body = normalizeNonEmptyWorkflowString(input.body, "artifactRecord.body");
  const normalized: SparkWorkflowArtifactRecordInput = {
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

export function normalizeSparkWorkflowPhaseStatus(
  status: SparkWorkflowPhaseOptions["status"],
): SparkWorkflowPhaseStatus | undefined {
  if (status === undefined) return undefined;
  if (status === "success" || status === "fail" || status === "skip") return status;
  throw new Error("Spark workflow phase status must be success, fail, or skip");
}

export function renderSparkWorkflowAgentPrompt(
  prompt: string,
  options: SparkWorkflowAgentOptions,
): string {
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

export async function runSparkWorkflowParallel<T>(
  items: Array<() => Promise<T> | T>,
  options: SparkWorkflowParallelOptions = {},
): Promise<T[] | Array<SparkWorkflowParallelSettledResult<T>>> {
  const normalized = normalizeSparkWorkflowParallelOptions(options);
  if (items.length === 0) return [];
  const results = new Array<SparkWorkflowParallelSettledResult<T>>(items.length);
  let nextIndex = 0;
  let shouldStop = false;
  const workerCount = Math.min(normalized.concurrency, items.length);

  const worker = async () => {
    while (!shouldStop) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const result = await runSparkWorkflowParallelItem(items[index], normalized.retry);
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

export function normalizeSparkWorkflowParallelOptions(options: SparkWorkflowParallelOptions): {
  concurrency: number;
  retry: Required<SparkWorkflowParallelOptions>["retry"] & { attempts: number; backoffMs: number };
  onError: "fail-fast" | "collect";
} {
  const rawConcurrency = options.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY;
  const concurrency = Number.isFinite(rawConcurrency)
    ? Math.trunc(rawConcurrency)
    : DEFAULT_PARALLEL_CONCURRENCY;
  if (concurrency < 1) throw new Error("Spark workflow parallel concurrency must be >= 1");
  const attempts = Math.trunc(options.retry?.attempts ?? 1);
  if (attempts < 1) throw new Error("Spark workflow parallel retry.attempts must be >= 1");
  const backoffMs = Math.trunc(options.retry?.backoffMs ?? 0);
  if (backoffMs < 0) throw new Error("Spark workflow parallel retry.backoffMs must be >= 0");
  const onError = options.onError ?? "fail-fast";
  if (onError !== "fail-fast" && onError !== "collect") {
    throw new Error("Spark workflow parallel onError must be 'fail-fast' or 'collect'");
  }
  return { concurrency, retry: { attempts, backoffMs }, onError };
}

async function runSparkWorkflowParallelItem<T>(
  item: () => Promise<T> | T,
  retry: { attempts: number; backoffMs: number },
): Promise<SparkWorkflowParallelSettledResult<T>> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNonEmptyWorkflowString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Spark workflow " + field + " must be a non-empty string");
  }
  return value.trim();
}

export function summarizeSparkWorkflowAgentDelivery(
  result: unknown,
): SparkWorkflowAgentDeliverySummary {
  const explicit = readSparkWorkflowAgentDelivery(result);
  if (explicit) return explicit;
  if (result === undefined || result === null) {
    return { status: "empty", message: "agent returned no result" };
  }
  if (typeof result === "string" && result.trim().length === 0) {
    return { status: "empty", message: "agent returned empty text" };
  }
  return { status: typeof result === "string" ? "non_json_output" : "delivered" };
}

function assertSparkWorkflowAgentDelivered(result: unknown, label: string): void {
  const delivery = summarizeSparkWorkflowAgentDelivery(result);
  if (delivery.status !== "empty") return;
  throw new Error(
    "Spark workflow agent " +
      label +
      " produced empty delivery" +
      (delivery.message ? ": " + delivery.message : ""),
  );
}

function readSparkWorkflowAgentDelivery(
  result: unknown,
): SparkWorkflowAgentDeliverySummary | undefined {
  if (!isRecord(result)) return undefined;
  const direct = parseSparkWorkflowAgentDelivery(result.delivery);
  if (direct) return direct;
  const details = isRecord(result.details)
    ? parseSparkWorkflowAgentDelivery(result.details.delivery)
    : undefined;
  return details;
}

function parseSparkWorkflowAgentDelivery(
  value: unknown,
): SparkWorkflowAgentDeliverySummary | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  if (status !== "delivered" && status !== "non_json_output" && status !== "empty") {
    return undefined;
  }
  const message = typeof value.message === "string" ? value.message : undefined;
  return { status, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
