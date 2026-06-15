import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_READY_TASK_TIMEOUT_MS,
  newRef,
  nowIso,
  readJsonFileOptional,
} from "pi-extension-api";

import { normalizeTaskRunCompletionSummaries } from "./dag-run-completion.ts";
import { reconcileDagRunCounters } from "./dag-run-counters.ts";
import type {
  WorkflowRunCompletionFollowUp,
  WorkflowRunManagerState,
  WorkflowRunManagerStatus,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowRunStoreSnapshot,
} from "./index.ts";

type LoadableWorkflowRunStoreSnapshot = Omit<WorkflowRunStoreSnapshot, "manager" | "runs"> & {
  manager: Partial<WorkflowRunManagerState>;
  runs: Array<Partial<WorkflowRunRecord>>;
};

export class WorkflowRunStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid workflow-run store: ${filePath}: ${message}`);
    this.name = "WorkflowRunStoreFormatError";
    this.filePath = filePath;
  }
}

export async function loadWorkflowRunStoreSnapshot(
  filePath: string,
): Promise<WorkflowRunStoreSnapshot> {
  const raw = await readJsonFileOptional(
    filePath,
    (path, message) => new WorkflowRunStoreFormatError(path, message),
  );
  if (raw === undefined) return emptyWorkflowRunSnapshot();
  assertWorkflowRunStoreSnapshot(raw, filePath);
  return normalizeWorkflowRunSnapshot(raw);
}

export function emptyWorkflowRunSnapshot(): WorkflowRunStoreSnapshot {
  const now = nowIso();
  return { version: 1, manager: { status: "idle", updatedAt: now }, runs: [] };
}

function assertWorkflowRunStoreSnapshot(
  value: unknown,
  filePath: string,
): asserts value is LoadableWorkflowRunStoreSnapshot {
  if (!isRecord(value)) {
    throw new WorkflowRunStoreFormatError(filePath, "JSON root must be an object");
  }
  if (value.version !== 1) {
    throw new WorkflowRunStoreFormatError(filePath, "version must be 1");
  }
  if (!isRecord(value.manager)) {
    throw new WorkflowRunStoreFormatError(filePath, "manager must be an object");
  }
  assertOptionalDagRunStoreString(value.manager.activeRunRef, filePath, "manager.activeRunRef");
  assertOptionalDagRunStoreString(value.manager.lastRunRef, filePath, "manager.lastRunRef");
  assertOptionalDagRunStoreString(value.manager.updatedAt, filePath, "manager.updatedAt");
  if (value.manager.status !== undefined && !isWorkflowRunManagerStatus(value.manager.status)) {
    throw new WorkflowRunStoreFormatError(filePath, "manager.status must be a valid status");
  }
  if (!Array.isArray(value.runs)) {
    throw new WorkflowRunStoreFormatError(filePath, "runs must be an array");
  }
  value.runs.forEach((run, index) => {
    assertWorkflowRunStoreRecord(run, filePath, index);
  });
}

function assertWorkflowRunStoreRecord(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is Partial<WorkflowRunRecord> {
  if (!isRecord(value)) {
    throw new WorkflowRunStoreFormatError(filePath, `runs[${index}] must be an object`);
  }
  assertOptionalDagRunStoreString(value.ref, filePath, `runs[${index}].ref`);
  assertOptionalDagRunStoreString(value.projectRef, filePath, `runs[${index}].projectRef`);
  assertOptionalDagRunStoreString(value.ownerSessionId, filePath, `runs[${index}].ownerSessionId`);
  assertOptionalDagRunStoreString(value.startedAt, filePath, `runs[${index}].startedAt`);
  assertOptionalDagRunStoreString(value.updatedAt, filePath, `runs[${index}].updatedAt`);
  assertOptionalDagRunStoreString(value.finishedAt, filePath, `runs[${index}].finishedAt`);
  assertOptionalDagRunStoreString(value.errorMessage, filePath, `runs[${index}].errorMessage`);
  assertOptionalDagRunStoreString(value.acknowledgedAt, filePath, `runs[${index}].acknowledgedAt`);
  assertOptionalDagRunStoreString(
    value.acknowledgedBySession,
    filePath,
    `runs[${index}].acknowledgedBySession`,
  );
  assertOptionalDagRunStoreNumber(value.maxConcurrency, filePath, `runs[${index}].maxConcurrency`);
  assertOptionalDagRunStoreNumber(value.timeoutMs, filePath, `runs[${index}].timeoutMs`);
  assertOptionalDagRunStoreNumber(value.scheduled, filePath, `runs[${index}].scheduled`);
  assertOptionalDagRunStoreNumber(value.completed, filePath, `runs[${index}].completed`);
  assertOptionalDagRunStoreBoolean(value.dryRun, filePath, `runs[${index}].dryRun`);
  assertOptionalDagRunStoreBoolean(value.timedOut, filePath, `runs[${index}].timedOut`);
  if (value.status !== undefined && !isWorkflowRunStatus(value.status)) {
    throw new WorkflowRunStoreFormatError(filePath, `runs[${index}].status must be a valid status`);
  }
  assertOptionalDagRunStoreStringArray(
    value.scheduledTaskRefs,
    filePath,
    `runs[${index}].scheduledTaskRefs`,
  );
  assertOptionalDagRunStoreStringArray(
    value.completedTaskRefs,
    filePath,
    `runs[${index}].completedTaskRefs`,
  );
  assertOptionalDagRunStoreStringArray(value.taskRunRefs, filePath, `runs[${index}].taskRunRefs`);
  if (value.completionDigest !== undefined && !Array.isArray(value.completionDigest)) {
    throw new WorkflowRunStoreFormatError(
      filePath,
      `runs[${index}].completionDigest must be an array`,
    );
  }
  if (value.completionFollowUp !== undefined) {
    assertWorkflowRunCompletionFollowUp(value.completionFollowUp, filePath, `runs[${index}]`);
  }
}

function assertWorkflowRunCompletionFollowUp(
  value: unknown,
  filePath: string,
  runPath: string,
): asserts value is WorkflowRunCompletionFollowUp {
  if (!isRecord(value)) {
    throw new WorkflowRunStoreFormatError(
      filePath,
      `${runPath}.completionFollowUp must be an object`,
    );
  }
  assertOptionalDagRunStoreString(
    value.createdAt,
    filePath,
    `${runPath}.completionFollowUp.createdAt`,
  );
  assertOptionalDagRunStoreString(value.runRef, filePath, `${runPath}.completionFollowUp.runRef`);
  assertOptionalDagRunStoreNumber(
    value.scheduled,
    filePath,
    `${runPath}.completionFollowUp.scheduled`,
  );
  assertOptionalDagRunStoreNumber(
    value.completed,
    filePath,
    `${runPath}.completionFollowUp.completed`,
  );
  assertOptionalDagRunStoreString(value.summary, filePath, `${runPath}.completionFollowUp.summary`);
  assertOptionalDagRunStoreStringArray(
    value.nextActions,
    filePath,
    `${runPath}.completionFollowUp.nextActions`,
  );
  if (value.status !== undefined && !isWorkflowRunStatus(value.status)) {
    throw new WorkflowRunStoreFormatError(
      filePath,
      `${runPath}.completionFollowUp.status must be a valid status`,
    );
  }
  if (value.completionDigest !== undefined && !Array.isArray(value.completionDigest)) {
    throw new WorkflowRunStoreFormatError(
      filePath,
      `${runPath}.completionFollowUp.completionDigest must be an array`,
    );
  }
}

function assertOptionalDagRunStoreString(value: unknown, filePath: string, path: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new WorkflowRunStoreFormatError(filePath, `${path} must be a string`);
  }
}

function assertOptionalDagRunStoreNumber(value: unknown, filePath: string, path: string): void {
  if (value !== undefined && typeof value !== "number") {
    throw new WorkflowRunStoreFormatError(filePath, `${path} must be a number`);
  }
}

function assertOptionalDagRunStoreBoolean(value: unknown, filePath: string, path: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new WorkflowRunStoreFormatError(filePath, `${path} must be a boolean`);
  }
}

function assertOptionalDagRunStoreStringArray(
  value: unknown,
  filePath: string,
  path: string,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new WorkflowRunStoreFormatError(filePath, `${path} must be a string array`);
  }
}

function isWorkflowRunManagerStatus(value: unknown): value is WorkflowRunManagerStatus {
  return value === "idle" || value === "running" || value === "failed";
}

function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return (
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "timed_out" ||
    value === "stale"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeWorkflowRunSnapshot(
  raw: LoadableWorkflowRunStoreSnapshot,
): WorkflowRunStoreSnapshot {
  const fallback = emptyWorkflowRunSnapshot();
  return {
    version: 1,
    manager: {
      status:
        raw.manager?.status === "running" || raw.manager?.status === "failed"
          ? raw.manager.status
          : "idle",
      activeRunRef: raw.manager?.activeRunRef,
      lastRunRef: raw.manager?.lastRunRef,
      updatedAt: raw.manager?.updatedAt ?? fallback.manager.updatedAt,
    },
    runs: (raw.runs ?? []).map(normalizeWorkflowRunRecord),
  };
}

function normalizeWorkflowRunRecord(raw: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  const now = nowIso();
  const ref = raw.ref ?? newRef("run");
  const status =
    raw.status === "succeeded" ||
    raw.status === "failed" ||
    raw.status === "timed_out" ||
    raw.status === "stale"
      ? raw.status
      : "running";
  const scheduled = raw.scheduled ?? raw.scheduledTaskRefs?.length ?? 0;
  const completed = raw.completed ?? raw.completedTaskRefs?.length ?? 0;
  const record: WorkflowRunRecord = {
    ref,
    projectRef: raw.projectRef,
    ownerSessionId: raw.ownerSessionId,
    dryRun: raw.dryRun ?? false,
    maxConcurrency: raw.maxConcurrency ?? DEFAULT_READY_TASK_MAX_CONCURRENCY,
    timeoutMs: raw.timeoutMs ?? DEFAULT_READY_TASK_TIMEOUT_MS,
    status,
    startedAt: raw.startedAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    finishedAt: raw.finishedAt,
    scheduled,
    completed,
    timedOut: raw.timedOut ?? raw.status === "timed_out",
    scheduledTaskRefs: [...(raw.scheduledTaskRefs ?? [])],
    completedTaskRefs: [...(raw.completedTaskRefs ?? [])],
    taskRunRefs: [...(raw.taskRunRefs ?? [])],
    errorMessage: raw.errorMessage,
    acknowledgedAt: typeof raw.acknowledgedAt === "string" ? raw.acknowledgedAt : undefined,
    acknowledgedBySession:
      typeof raw.acknowledgedBySession === "string" ? raw.acknowledgedBySession : undefined,
    completionDigest: normalizeTaskRunCompletionSummaries(raw.completionDigest),
    completionFollowUp: raw.completionFollowUp
      ? {
          createdAt: raw.completionFollowUp.createdAt ?? raw.finishedAt ?? now,
          runRef: raw.completionFollowUp.runRef ?? ref,
          status: raw.completionFollowUp.status ?? status,
          scheduled: raw.completionFollowUp.scheduled ?? scheduled,
          completed: raw.completionFollowUp.completed ?? completed,
          summary: raw.completionFollowUp.summary ?? "Workflow run finished.",
          nextActions: [...(raw.completionFollowUp.nextActions ?? [])],
          completionDigest: normalizeTaskRunCompletionSummaries(
            raw.completionFollowUp.completionDigest ?? raw.completionDigest,
          ),
        }
      : undefined,
  };
  reconcileDagRunCounters(record);
  return record;
}

/** @deprecated SparkDag* alias kept for compatibility. Prefer WorkflowRunStoreFormatError. */
export const SparkDagRunStoreFormatError = WorkflowRunStoreFormatError;
/** @deprecated SparkDag* alias kept for compatibility. Prefer loadWorkflowRunStoreSnapshot. */
export const loadSparkDagRunStoreSnapshot = loadWorkflowRunStoreSnapshot;
/** @deprecated SparkDag* alias kept for compatibility. Prefer emptyWorkflowRunSnapshot. */
export const emptySparkDagRunSnapshot = emptyWorkflowRunSnapshot;
