import type {
  RoleRef,
  Task,
  TaskAttribution,
  TaskCancellation,
  TaskClaim,
  TaskRef,
  TaskRun,
  TaskStatus,
} from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "./graph.ts";
import { isUnfinishedTaskStatus } from "./internal.ts";

export interface PiTaskDisplayIdentity {
  ref?: string | null;
  runtimeTaskId?: string | null;
  name?: string | null;
  title: string;
  status?: string | null;
}

export interface PiTaskDisplayLifecycle {
  cancellation?: TaskCancellation | null;
  supersededBy?: readonly string[] | null;
}

export interface PiTaskActiveLineInput {
  task: PiTaskDisplayIdentity & PiTaskDisplayLifecycle;
  owner: string;
  readyFrontier?: boolean;
  plan?: "missing" | string;
  lifecycleSuffix?: string;
}

export interface PiTaskSummaryLineInput extends PiTaskActiveLineInput {
  kind?: string | null;
  ref?: string | null;
  claimed?: string;
  todos?: string;
}

export function piTaskDisplayHandle(task: PiTaskDisplayIdentity): string {
  const handle = firstNonEmpty(task.name, task.runtimeTaskId, task.ref, "task");
  return handle.startsWith("@") ? handle : `@${handle}`;
}

export function piTaskDisplayTitle(task: PiTaskDisplayIdentity): string {
  return `${piTaskDisplayHandle(task)}: ${task.title}`;
}

export function formatPiTaskActiveStatusLine(input: PiTaskActiveLineInput): string {
  const readyFrontierSuffix = input.readyFrontier ? " ready_frontier=yes" : "";
  const planSuffix = input.plan ? ` plan=${input.plan}` : "";
  const lifecycleSuffix = input.lifecycleSuffix ?? piTaskLifecycleSuffix(input.task);
  return `- [${input.task.status ?? "unknown"}] ${piTaskDisplayTitle(
    input.task,
  )} owner=@${input.owner}${readyFrontierSuffix}${planSuffix}${lifecycleSuffix}`;
}

export function formatPiTaskSummaryStatusLine(input: PiTaskSummaryLineInput): string {
  const readyFrontierSuffix = input.readyFrontier ? " ready_frontier=yes" : "";
  const planSuffix = input.plan ? ` plan=${input.plan}` : "";
  const lifecycleSuffix = input.lifecycleSuffix ?? piTaskLifecycleSuffix(input.task);
  const ref = input.ref ?? input.task.ref;
  const refSuffix = ref ? ` (${ref})` : "";
  const kind = input.kind ?? "generic";
  const claimed = input.claimed ?? "no";
  const todos = input.todos ?? "0/0/0/0";
  return `- [${input.task.status ?? "unknown"}] ${piTaskDisplayTitle(
    input.task,
  )}${refSuffix} kind=${kind} owner=@${input.owner} claimed=${claimed} todos=${todos}${readyFrontierSuffix}${planSuffix}${lifecycleSuffix}`;
}

export function normalizePiTaskStatusGroup(status: string): TaskStatus | "other" {
  const normalized = status.toLowerCase().replaceAll("_", "-");
  if (["ready", "queued", "not-started"].includes(normalized)) return "ready";
  if (normalized === "pending") return "pending";
  if (["running", "in-progress", "processing"].includes(normalized)) return "running";
  if (["blocked", "waiting"].includes(normalized)) return "blocked";
  if (["done", "completed", "complete", "succeeded", "success", "resolved"].includes(normalized))
    return "done";
  if (["failed", "error", "timed-out"].includes(normalized)) return "failed";
  if (["cancelled", "canceled", "archived"].includes(normalized)) return "cancelled";
  return "other";
}

export function isImportantPiTaskStatus(status: TaskStatus): boolean {
  return status !== "done" && status !== "cancelled";
}

export function taskStatusVisibilityRank(status: TaskStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "blocked":
      return 1;
    case "ready":
    case "pending":
      return 2;
    case "failed":
      return 3;
    case "done":
      return 4;
    case "cancelled":
      return 5;
  }
}

export function sortPiTasksForStatusVisibility(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const byStatus = taskStatusVisibilityRank(a.status) - taskStatusVisibilityRank(b.status);
    if (byStatus !== 0) return byStatus;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
}

export function countPiTaskStatuses<T extends { status: TaskStatus }>(
  tasks: readonly T[],
): Partial<Record<TaskStatus, number>> {
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

export function formatPiTaskStatusCounts(
  counts: Partial<Record<TaskStatus | string, number>>,
): string {
  const order: TaskStatus[] = [
    "running",
    "blocked",
    "pending",
    "ready",
    "failed",
    "done",
    "cancelled",
  ];
  const parts = order.flatMap((status) => {
    const count = counts[status] ?? 0;
    return count > 0 ? [`${status}=${count}`] : [];
  });
  return parts.length > 0 ? parts.join(" ") : "none";
}

export function latestRunsByTaskRef(
  runs: ReturnType<TaskGraph["runs"]>,
): Map<string, ReturnType<TaskGraph["runs"]>[number]> {
  const result = new Map<string, ReturnType<TaskGraph["runs"]>[number]>();
  for (const run of runs) {
    const current = result.get(run.taskRef);
    const currentTime = current?.finishedAt ?? current?.startedAt ?? "";
    const runTime = run.finishedAt ?? run.startedAt ?? "";
    if (!current || runTime >= currentTime) result.set(run.taskRef, run);
  }
  return result;
}

export function taskClaimedBy(task: Pick<Task, "claim">): string | undefined {
  return task.claim?.claimedBy;
}

export function isClaimOwnedBySession(task: Pick<Task, "claim">, sessionKey: string): boolean {
  return task.claim?.sessionId === sessionKey;
}

export function deriveTaskRoleLabel(input: {
  task: Pick<Task, "claim" | "status" | "finishedBy">;
  currentSessionKey: string;
  latestRun?: Partial<TaskRun>;
}): string {
  const { task, currentSessionKey, latestRun } = input;
  const claimedBy = taskClaimedBy(task);
  const runName = task.claim?.runName?.trim();
  if (task.claim?.kind === "role-run") {
    if (!runName) return "unknown-role-run";
    const owner = task.claim.sessionId
      ? sessionDisplayLabel(task.claim.sessionId, currentSessionKey)
      : "unknown-session";
    return `${owner}/${runName}`;
  }
  if (!claimedBy) {
    if (!isUnfinishedTaskStatus(task.status)) {
      const finishedRoleName = task.finishedBy?.runName?.trim();
      const finishedSessionId = task.finishedBy?.sessionId?.trim();
      if (finishedRoleName) {
        const owner = finishedSessionId
          ? sessionDisplayLabel(finishedSessionId, currentSessionKey)
          : "unknown-session";
        const spec = task.finishedBy?.roleRef ? shortRoleLabel(task.finishedBy.roleRef) : undefined;
        return spec ? `${owner}/${finishedRoleName}(spec:${spec})` : `${owner}/${finishedRoleName}`;
      }
      if (finishedSessionId) return sessionDisplayLabel(finishedSessionId, currentSessionKey);
      if (latestRun?.runName) {
        const owner = latestRun.ownerSessionId
          ? sessionDisplayLabel(latestRun.ownerSessionId, currentSessionKey)
          : sessionDisplayLabel(currentSessionKey, currentSessionKey);
        return `${owner}/${latestRun.runName}`;
      }
      return sessionDisplayLabel(currentSessionKey, currentSessionKey);
    }
    return "unassigned";
  }
  if (isClaimOwnedBySession(task, currentSessionKey)) return "me";
  if (claimedBy.startsWith("session:")) return sessionDisplayLabel(claimedBy, currentSessionKey);
  return claimedBy;
}

export function shortRoleLabel(roleRef: RoleRef | string): string {
  return roleRef.replace(/^role:(builtin-|project-|user-)?/, "");
}

export function taskClaimSummary(task: { claim?: TaskClaim }): string {
  const claimedBy = taskClaimedBy(task);
  if (!claimedBy) return "no";
  const runName = task.claim?.runName?.trim();
  const spec = task.claim?.roleRef ? shortRoleLabel(task.claim.roleRef) : undefined;
  if (runName) return spec ? `${runName}(spec:${spec})` : runName;
  return claimedBy;
}

export function taskPlanSummary(task: Pick<Task, "plan">): "missing" | undefined {
  return task.plan ? undefined : "missing";
}

export function taskLifecycleSuffix(task: Pick<Task, "supersededBy" | "cancellation">): string {
  return piTaskLifecycleSuffix(task);
}

function piTaskLifecycleSuffix(task: PiTaskDisplayLifecycle): string {
  const parts: string[] = [];
  if (task.supersededBy && task.supersededBy.length > 0)
    parts.push(`supersededBy=${task.supersededBy.join(",")}`);
  if (task.cancellation) {
    const by = task.cancellation.by ? ` by=${task.cancellation.by}` : "";
    const reason = task.cancellation.reason
      ? ` reason=${JSON.stringify(truncateInline(task.cancellation.reason, 120))}`
      : "";
    parts.push(`cancelledAt=${task.cancellation.at}${by}${reason}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "task";
}

function sessionDisplayLabel(sessionId: string, currentSessionKey: string): string {
  if (sessionId === currentSessionKey) return "me";
  return sessionId.startsWith("session:")
    ? sessionId.slice("session:".length, "session:".length + 8)
    : sessionId;
}

function truncateInline(value: string, width: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= width) return normalized;
  return `${normalized.slice(0, Math.max(0, width - 1))}…`;
}
