import type {
  ArtifactRef,
  ProjectRef,
  RoleRef,
  RoleRunCompletionOutcome,
  RunRef,
  TaskRef,
  TaskRun,
  TaskRunFailureKind,
  TaskRunStatus,
} from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import type { ActiveSparkRoleRunProcess } from "@zendev-lab/spark-runtime";

export type SparkRoleRunObservedStatus =
  | "queued"
  | "waiting"
  | "running"
  | "done"
  | "blocked"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "stale";

export type SparkRoleRunLifecycleEventType =
  | "queued"
  | "waiting"
  | "started"
  | "tool_activity"
  | "message_activity"
  | "waiting_for_user"
  | "replied"
  | "completed"
  | "blocked"
  | "failed"
  | "stopped"
  | "interrupted"
  | "recovered_stale";

export type SparkRoleRunEventSource =
  | "task-graph"
  | "process-registry"
  | "activity-log"
  | "recovery";

export type SparkRoleRunMessageRole = "system" | "user" | "assistant" | "tool" | "unknown";

export interface SparkRoleRunUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface SparkRoleRunEventProvenance {
  source: SparkRoleRunEventSource;
  runRef: RunRef;
  projectRef: ProjectRef;
  taskRef: TaskRef;
  roleRef?: RoleRef;
  runName?: string;
  ownerSessionId?: string;
  parentRunRefs?: RunRef[];
}

export interface SparkRoleRunLifecycleEvent {
  type: SparkRoleRunLifecycleEventType;
  status: SparkRoleRunObservedStatus;
  at: string;
  provenance: SparkRoleRunEventProvenance;
  failureKind?: TaskRunFailureKind;
  message?: string;
  toolName?: string;
  messageRole?: SparkRoleRunMessageRole;
  usage?: SparkRoleRunUsage;
  artifactRefs?: ArtifactRef[];
}

export interface SparkRoleRunActivityEventInput {
  runRef: RunRef;
  type: Extract<
    SparkRoleRunLifecycleEventType,
    "tool_activity" | "message_activity" | "waiting_for_user" | "replied" | "interrupted"
  >;
  at: string;
  message?: string;
  toolName?: string;
  messageRole?: SparkRoleRunMessageRole;
  usage?: SparkRoleRunUsage;
  artifactRefs?: ArtifactRef[];
}

export interface SparkRoleRunParentChildLink {
  parentRunRef: RunRef;
  childRunRef: RunRef;
}

export interface SparkRoleRunRegistryEntry {
  runRef: RunRef;
  parentRunRefs: RunRef[];
  childRunRefs: RunRef[];
  projectRef: ProjectRef;
  taskRef: TaskRef;
  roleRef?: RoleRef;
  runName?: string;
  ownerSessionId?: string;
  status: SparkRoleRunObservedStatus;
  taskRunStatus: TaskRunStatus;
  activeProcess: boolean;
  pid?: number;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  lastActivityAt?: string;
  outputArtifacts: ArtifactRef[];
  usage?: SparkRoleRunUsage;
  failureKind?: TaskRunFailureKind;
  errorMessage?: string;
  outcome?: RoleRunCompletionOutcome;
  recoveryKind?: "interrupted_without_process" | "stale_without_process";
  events: SparkRoleRunLifecycleEvent[];
}

export interface SparkRoleRunRegistrySnapshot {
  generatedAt: string;
  projectRef?: ProjectRef;
  entries: SparkRoleRunRegistryEntry[];
  counts: Record<SparkRoleRunObservedStatus, number>;
}

export interface BuildSparkRoleRunRegistryInput {
  graph: Pick<TaskGraph, "runs">;
  projectRef?: ProjectRef;
  activeProcesses?: ActiveSparkRoleRunProcess[];
  parentChildLinks?: SparkRoleRunParentChildLink[];
  activityEvents?: SparkRoleRunActivityEventInput[];
  usageByRunRef?: Partial<Record<RunRef, SparkRoleRunUsage>>;
  now?: string;
  staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 60_000;

const EMPTY_COUNTS: Record<SparkRoleRunObservedStatus, number> = {
  queued: 0,
  waiting: 0,
  running: 0,
  done: 0,
  blocked: 0,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
  stale: 0,
};

export function buildSparkRoleRunRegistry(
  input: BuildSparkRoleRunRegistryInput,
): SparkRoleRunRegistrySnapshot {
  const generatedAt = input.now ?? new Date().toISOString();
  const activeByRunRef = new Map(
    (input.activeProcesses ?? []).map((process) => [process.runRef, process]),
  );
  const parentRunRefsByChild = parentRunRefsByChildRunRef(input.parentChildLinks ?? []);
  const childRunRefsByParent = childRunRefsByParentRunRef(input.parentChildLinks ?? []);
  const activityEventsByRunRef = groupActivityEventsByRunRef(input.activityEvents ?? []);
  const entries = input.graph
    .runs(input.projectRef)
    .map((run) =>
      roleRunRegistryEntry({
        run,
        activeProcess: activeByRunRef.get(run.ref),
        parentRunRefs: parentRunRefsByChild.get(run.ref) ?? [],
        childRunRefs: childRunRefsByParent.get(run.ref) ?? [],
        activityEvents: activityEventsByRunRef.get(run.ref) ?? [],
        usage: input.usageByRunRef?.[run.ref],
        now: generatedAt,
        staleAfterMs: input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      }),
    )
    .sort(compareRegistryEntries);
  const counts = { ...EMPTY_COUNTS };
  for (const entry of entries) counts[entry.status] += 1;
  return { generatedAt, projectRef: input.projectRef, entries, counts };
}

export function serializeSparkRoleRunRegistry(
  snapshot: SparkRoleRunRegistrySnapshot,
): SparkRoleRunRegistrySnapshot {
  return pruneUndefined({
    generatedAt: snapshot.generatedAt,
    projectRef: snapshot.projectRef,
    counts: { ...EMPTY_COUNTS, ...snapshot.counts },
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      parentRunRefs: [...entry.parentRunRefs],
      childRunRefs: [...entry.childRunRefs],
      outputArtifacts: [...entry.outputArtifacts],
      outcome: entry.outcome ? { ...entry.outcome } : undefined,
      usage: entry.usage ? { ...entry.usage } : undefined,
      events: entry.events.map((event) => ({
        ...event,
        provenance: {
          ...event.provenance,
          parentRunRefs: event.provenance.parentRunRefs
            ? [...event.provenance.parentRunRefs]
            : undefined,
        },
        usage: event.usage ? { ...event.usage } : undefined,
        artifactRefs: event.artifactRefs ? [...event.artifactRefs] : undefined,
      })),
    })),
  }) as SparkRoleRunRegistrySnapshot;
}

export function findSparkRoleRunRegistryEntry(
  snapshot: SparkRoleRunRegistrySnapshot,
  runRef: RunRef,
): SparkRoleRunRegistryEntry | undefined {
  return snapshot.entries.find((entry) => entry.runRef === runRef);
}

export function roleRunObservedStatus(run: TaskRun): SparkRoleRunObservedStatus {
  switch (run.status) {
    case "succeeded":
      return "done";
    case "blocked":
      return "blocked";
    case "failed":
    case "cancelled":
    case "queued":
    case "running":
      return run.status;
  }
}

function roleRunRegistryEntry(input: {
  run: TaskRun;
  activeProcess: ActiveSparkRoleRunProcess | undefined;
  parentRunRefs: RunRef[];
  childRunRefs: RunRef[];
  activityEvents: SparkRoleRunActivityEventInput[];
  usage: SparkRoleRunUsage | undefined;
  now: string;
  staleAfterMs: number;
}): SparkRoleRunRegistryEntry {
  const recoveryStatus = nonTerminalRecoveryStatus(
    input.run,
    input.activeProcess,
    input.now,
    input.staleAfterMs,
  );
  const status = recoveryStatus?.status ?? roleRunObservedStatus(input.run);
  const events = roleRunLifecycleEvents({
    run: input.run,
    status,
    recoveryStatus,
    activityEvents: input.activityEvents,
    parentRunRefs: input.parentRunRefs,
    now: input.now,
  });
  return {
    runRef: input.run.ref,
    parentRunRefs: [...input.parentRunRefs],
    childRunRefs: [...input.childRunRefs],
    projectRef: input.run.projectRef,
    taskRef: input.run.taskRef,
    roleRef: input.run.roleRef,
    runName: input.run.runName,
    ownerSessionId: input.run.ownerSessionId,
    status,
    taskRunStatus: input.run.status,
    activeProcess: Boolean(input.activeProcess),
    pid: input.activeProcess?.pid,
    startedAt: input.run.startedAt,
    updatedAt: input.run.finishedAt ?? lastEventAt(events) ?? input.run.startedAt ?? input.now,
    finishedAt: input.run.finishedAt,
    lastActivityAt: lastEventAt(events),
    outputArtifacts: [...input.run.outputArtifacts],
    usage: input.usage ? { ...input.usage } : undefined,
    failureKind: input.run.failureKind,
    errorMessage: input.run.errorMessage,
    outcome: input.run.outcome ? { ...input.run.outcome } : undefined,
    recoveryKind: recoveryStatus?.recoveryKind,
    events,
  };
}

function nonTerminalRecoveryStatus(
  run: TaskRun,
  activeProcess: ActiveSparkRoleRunProcess | undefined,
  now: string,
  staleAfterMs: number,
):
  | {
      status: Extract<SparkRoleRunObservedStatus, "waiting" | "interrupted" | "stale">;
      recoveryKind?: SparkRoleRunRegistryEntry["recoveryKind"];
    }
  | undefined {
  if (run.status !== "queued" && run.status !== "running") return undefined;
  if (activeProcess) return undefined;
  if (run.status === "queued") return { status: "waiting" };
  const ageMs = Math.max(0, Date.parse(now) - Date.parse(run.startedAt ?? now));
  if (!Number.isFinite(ageMs) || ageMs < staleAfterMs) {
    return { status: "interrupted", recoveryKind: "interrupted_without_process" };
  }
  return { status: "stale", recoveryKind: "stale_without_process" };
}

function roleRunLifecycleEvents(input: {
  run: TaskRun;
  status: SparkRoleRunObservedStatus;
  recoveryStatus: ReturnType<typeof nonTerminalRecoveryStatus>;
  activityEvents: SparkRoleRunActivityEventInput[];
  parentRunRefs: RunRef[];
  now: string;
}): SparkRoleRunLifecycleEvent[] {
  const events: SparkRoleRunLifecycleEvent[] = [];
  const provenance = (source: SparkRoleRunEventSource): SparkRoleRunEventProvenance => ({
    source,
    runRef: input.run.ref,
    projectRef: input.run.projectRef,
    taskRef: input.run.taskRef,
    roleRef: input.run.roleRef,
    runName: input.run.runName,
    ownerSessionId: input.run.ownerSessionId,
    parentRunRefs: [...input.parentRunRefs],
  });

  if (input.run.status === "queued" && !input.run.startedAt) {
    events.push({
      type: "queued",
      status: "queued",
      at: input.now,
      provenance: provenance("task-graph"),
    });
  }
  if (input.run.startedAt) {
    events.push({
      type: "started",
      status: "running",
      at: input.run.startedAt,
      provenance: provenance("task-graph"),
    });
  }
  for (const activityEvent of input.activityEvents) {
    events.push({
      type: activityEvent.type,
      status: input.status,
      at: activityEvent.at,
      provenance: provenance("activity-log"),
      message: activityEvent.message,
      toolName: activityEvent.toolName,
      messageRole: activityEvent.messageRole,
      usage: activityEvent.usage ? { ...activityEvent.usage } : undefined,
      artifactRefs: activityEvent.artifactRefs ? [...activityEvent.artifactRefs] : undefined,
    });
  }
  if (input.run.finishedAt) {
    const terminalEvent = terminalLifecycleEvent(input.run);
    events.push({
      ...terminalEvent,
      at: input.run.finishedAt,
      provenance: provenance("task-graph"),
      failureKind: input.run.failureKind,
      message: input.run.errorMessage,
      artifactRefs: [...input.run.outputArtifacts],
    });
  }
  if (input.recoveryStatus?.status === "waiting") {
    events.push({
      type: "waiting",
      status: input.status,
      at: input.now,
      provenance: provenance("recovery"),
    });
  }
  if (input.recoveryStatus?.recoveryKind === "interrupted_without_process") {
    events.push({
      type: "interrupted",
      status: input.status,
      at: input.now,
      provenance: provenance("recovery"),
      message: "run is non-terminal but no active child process is registered",
    });
  }
  if (input.recoveryStatus?.recoveryKind === "stale_without_process") {
    events.push({
      type: "recovered_stale",
      status: input.status,
      at: input.now,
      provenance: provenance("recovery"),
      message:
        "run is non-terminal and older than the stale threshold with no active child process",
    });
  }

  return events.sort(compareLifecycleEvents);
}

function terminalLifecycleEvent(run: TaskRun): Pick<SparkRoleRunLifecycleEvent, "type" | "status"> {
  if (run.status === "succeeded") return { type: "completed", status: "done" };
  if (run.status === "blocked") return { type: "blocked", status: "blocked" };
  if (run.status === "failed") return { type: "failed", status: "failed" };
  if (run.status === "cancelled") return { type: "stopped", status: "cancelled" };
  return { type: "waiting", status: roleRunObservedStatus(run) };
}

function parentRunRefsByChildRunRef(links: SparkRoleRunParentChildLink[]): Map<RunRef, RunRef[]> {
  const grouped = new Map<RunRef, RunRef[]>();
  for (const link of links) {
    grouped.set(link.childRunRef, [...(grouped.get(link.childRunRef) ?? []), link.parentRunRef]);
  }
  return grouped;
}

function childRunRefsByParentRunRef(links: SparkRoleRunParentChildLink[]): Map<RunRef, RunRef[]> {
  const grouped = new Map<RunRef, RunRef[]>();
  for (const link of links) {
    grouped.set(link.parentRunRef, [...(grouped.get(link.parentRunRef) ?? []), link.childRunRef]);
  }
  return grouped;
}

function groupActivityEventsByRunRef(
  events: SparkRoleRunActivityEventInput[],
): Map<RunRef, SparkRoleRunActivityEventInput[]> {
  const grouped = new Map<RunRef, SparkRoleRunActivityEventInput[]>();
  for (const event of events)
    grouped.set(event.runRef, [...(grouped.get(event.runRef) ?? []), event]);
  return grouped;
}

function lastEventAt(events: SparkRoleRunLifecycleEvent[]): string | undefined {
  return events.at(-1)?.at;
}

function compareRegistryEntries(
  a: SparkRoleRunRegistryEntry,
  b: SparkRoleRunRegistryEntry,
): number {
  const updated = b.updatedAt.localeCompare(a.updatedAt);
  if (updated !== 0) return updated;
  return a.runRef.localeCompare(b.runRef);
}

function compareLifecycleEvents(
  a: SparkRoleRunLifecycleEvent,
  b: SparkRoleRunLifecycleEvent,
): number {
  const byTime = a.at.localeCompare(b.at);
  if (byTime !== 0) return byTime;
  return lifecycleEventRank(a.type) - lifecycleEventRank(b.type);
}

function lifecycleEventRank(type: SparkRoleRunLifecycleEventType): number {
  switch (type) {
    case "queued":
      return 0;
    case "started":
      return 1;
    case "message_activity":
      return 2;
    case "tool_activity":
      return 3;
    case "waiting_for_user":
      return 4;
    case "replied":
      return 5;
    case "waiting":
      return 6;
    case "interrupted":
      return 7;
    case "recovered_stale":
      return 8;
    case "completed":
      return 9;
    case "blocked":
      return 10;
    case "failed":
      return 11;
    case "stopped":
      return 12;
  }
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, pruneUndefined(entryValue)]),
  );
}
