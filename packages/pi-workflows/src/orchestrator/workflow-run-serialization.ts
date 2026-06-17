import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  DEFAULT_READY_TASK_TIMEOUT_MS,
  newRef,
  nowIso,
  readJsonFileOptional,
} from "@zendev-lab/pi-extension-api";

import { normalizeTaskRunCompletionSummaries } from "./workflow-run-completion.ts";
import { reconcileWorkflowRunCounters } from "./workflow-run-counters.ts";
import type {
  WorkflowRunCompletionFollowUp,
  WorkflowRunControl,
  WorkflowRunManagerState,
  WorkflowRunManagerStatus,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowRunStoreSnapshot,
} from "./index.ts";

type LoadableWorkflowRunStoreSnapshot = Omit<
  WorkflowRunStoreSnapshot,
  "manager" | "runs" | "control"
> & {
  manager: Partial<WorkflowRunManagerState>;
  runs: Array<Partial<WorkflowRunRecord>>;
  control?: unknown;
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
  assertOptionalWorkflowRunStoreString(
    value.manager.activeRunRef,
    filePath,
    "manager.activeRunRef",
  );
  assertOptionalWorkflowRunStoreString(value.manager.lastRunRef, filePath, "manager.lastRunRef");
  assertOptionalWorkflowRunStoreString(value.manager.updatedAt, filePath, "manager.updatedAt");
  if (value.manager.status !== undefined && !isWorkflowRunManagerStatus(value.manager.status)) {
    throw new WorkflowRunStoreFormatError(filePath, "manager.status must be a valid status");
  }
  if (!Array.isArray(value.runs)) {
    throw new WorkflowRunStoreFormatError(filePath, "runs must be an array");
  }
  if (value.control !== undefined) {
    assertWorkflowRunControl(value.control, filePath);
  }
  value.runs.forEach((run, index) => {
    assertWorkflowRunStoreRecord(run, filePath, index);
  });
}

function assertWorkflowRunControl(value: unknown, filePath: string): void {
  if (!isRecord(value)) {
    throw new WorkflowRunStoreFormatError(filePath, "control must be an object");
  }
  if (typeof value.projectRef !== "string" || !value.projectRef.trim()) {
    throw new WorkflowRunStoreFormatError(
      filePath,
      "control.projectRef must be a non-empty string",
    );
  }
  assertOptionalWorkflowRunStoreString(value.focus, filePath, "control.focus");
  assertOptionalWorkflowRunStoreString(value.enteredAt, filePath, "control.enteredAt");
  assertOptionalWorkflowRunStoreString(value.updatedAt, filePath, "control.updatedAt");
  if (value.status !== undefined && !isWorkflowRunControlStatus(value.status)) {
    throw new WorkflowRunStoreFormatError(filePath, "control.status must be a valid status");
  }
  if (value.policy !== undefined) {
    if (!isRecord(value.policy)) {
      throw new WorkflowRunStoreFormatError(filePath, "control.policy must be an object");
    }
    assertOptionalWorkflowRunStoreNumber(
      value.policy.maxConcurrency,
      filePath,
      "control.policy.maxConcurrency",
    );
    assertOptionalWorkflowRunStoreNumber(
      value.policy.timeoutMs,
      filePath,
      "control.policy.timeoutMs",
    );
  }
}

function assertWorkflowRunStoreRecord(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is Partial<WorkflowRunRecord> {
  if (!isRecord(value)) {
    throw new WorkflowRunStoreFormatError(filePath, `runs[${index}] must be an object`);
  }
  assertOptionalWorkflowRunStoreString(value.ref, filePath, `runs[${index}].ref`);
  assertOptionalWorkflowRunStoreString(value.projectRef, filePath, `runs[${index}].projectRef`);
  assertOptionalWorkflowRunStoreString(
    value.ownerSessionId,
    filePath,
    `runs[${index}].ownerSessionId`,
  );
  assertOptionalWorkflowRunStoreString(value.startedAt, filePath, `runs[${index}].startedAt`);
  assertOptionalWorkflowRunStoreString(value.updatedAt, filePath, `runs[${index}].updatedAt`);
  assertOptionalWorkflowRunStoreString(value.finishedAt, filePath, `runs[${index}].finishedAt`);
  assertOptionalWorkflowRunStoreString(value.errorMessage, filePath, `runs[${index}].errorMessage`);
  assertOptionalWorkflowRunStoreString(
    value.acknowledgedAt,
    filePath,
    `runs[${index}].acknowledgedAt`,
  );
  assertOptionalWorkflowRunStoreString(
    value.acknowledgedBySession,
    filePath,
    `runs[${index}].acknowledgedBySession`,
  );
  assertOptionalWorkflowRunStoreNumber(
    value.maxConcurrency,
    filePath,
    `runs[${index}].maxConcurrency`,
  );
  assertOptionalWorkflowRunStoreNumber(value.timeoutMs, filePath, `runs[${index}].timeoutMs`);
  assertOptionalWorkflowRunStoreNumber(value.scheduled, filePath, `runs[${index}].scheduled`);
  assertOptionalWorkflowRunStoreNumber(value.completed, filePath, `runs[${index}].completed`);
  assertOptionalWorkflowRunStoreBoolean(value.dryRun, filePath, `runs[${index}].dryRun`);
  assertOptionalWorkflowRunStoreBoolean(value.timedOut, filePath, `runs[${index}].timedOut`);
  if (value.status !== undefined && !isWorkflowRunStatus(value.status)) {
    throw new WorkflowRunStoreFormatError(filePath, `runs[${index}].status must be a valid status`);
  }
  assertOptionalWorkflowRunStoreStringArray(
    value.scheduledTaskRefs,
    filePath,
    `runs[${index}].scheduledTaskRefs`,
  );
  assertOptionalWorkflowRunStoreStringArray(
    value.completedTaskRefs,
    filePath,
    `runs[${index}].completedTaskRefs`,
  );
  assertOptionalWorkflowRunStoreStringArray(
    value.taskRunRefs,
    filePath,
    `runs[${index}].taskRunRefs`,
  );
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
  assertOptionalWorkflowRunStoreString(
    value.createdAt,
    filePath,
    `${runPath}.completionFollowUp.createdAt`,
  );
  assertOptionalWorkflowRunStoreString(
    value.runRef,
    filePath,
    `${runPath}.completionFollowUp.runRef`,
  );
  assertOptionalWorkflowRunStoreNumber(
    value.scheduled,
    filePath,
    `${runPath}.completionFollowUp.scheduled`,
  );
  assertOptionalWorkflowRunStoreNumber(
    value.completed,
    filePath,
    `${runPath}.completionFollowUp.completed`,
  );
  assertOptionalWorkflowRunStoreString(
    value.summary,
    filePath,
    `${runPath}.completionFollowUp.summary`,
  );
  assertOptionalWorkflowRunStoreStringArray(
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

function assertOptionalWorkflowRunStoreString(
  value: unknown,
  filePath: string,
  path: string,
): void {
  if (value !== undefined && typeof value !== "string") {
    throw new WorkflowRunStoreFormatError(filePath, `${path} must be a string`);
  }
}

function assertOptionalWorkflowRunStoreNumber(
  value: unknown,
  filePath: string,
  path: string,
): void {
  if (value !== undefined && typeof value !== "number") {
    throw new WorkflowRunStoreFormatError(filePath, `${path} must be a number`);
  }
}

function assertOptionalWorkflowRunStoreBoolean(
  value: unknown,
  filePath: string,
  path: string,
): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new WorkflowRunStoreFormatError(filePath, `${path} must be a boolean`);
  }
}

function assertOptionalWorkflowRunStoreStringArray(
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

function isWorkflowRunControlStatus(value: unknown): boolean {
  return (
    value === "running" ||
    value === "paused" ||
    value === "blocked" ||
    value === "done" ||
    value === "failed" ||
    value === "cancelled"
  );
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
    control: normalizeWorkflowRunControl(raw.control),
  };
}

function normalizeWorkflowRunControl(value: unknown): WorkflowRunControl | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.projectRef !== "string" || !value.projectRef.trim()) return undefined;
  const now = nowIso();
  const status = isWorkflowRunControlStatus(value.status)
    ? (value.status as WorkflowRunControl["status"])
    : "running";
  const policy = isRecord(value.policy) ? value.policy : {};
  const enteredAt = typeof value.enteredAt === "string" ? value.enteredAt : now;
  return {
    projectRef: value.projectRef as WorkflowRunControl["projectRef"],
    focus: typeof value.focus === "string" ? value.focus.trim() || undefined : undefined,
    status,
    policy: {
      maxConcurrency:
        typeof policy.maxConcurrency === "number"
          ? policy.maxConcurrency
          : DEFAULT_READY_TASK_MAX_CONCURRENCY,
      timeoutMs:
        typeof policy.timeoutMs === "number" ? policy.timeoutMs : DEFAULT_READY_TASK_TIMEOUT_MS,
    },
    enteredAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : enteredAt,
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
  reconcileWorkflowRunCounters(record);
  return record;
}
