import type { Task } from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import { shortRoleLabel, taskClaimedBy } from "./task-ownership.ts";
import { truncateInline } from "./tool-rendering.ts";

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

export function taskClaimSummary(task: Task): string {
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

export function taskLifecycleSuffix(task: Task): string {
  const parts: string[] = [];
  if (task.supersededBy.length > 0) parts.push(`supersededBy=${task.supersededBy.join(",")}`);
  if (task.cancellation) {
    const by = task.cancellation.by ? ` by=${task.cancellation.by}` : "";
    const reason = task.cancellation.reason
      ? ` reason=${JSON.stringify(truncateInline(task.cancellation.reason, 120))}`
      : "";
    parts.push(`cancelledAt=${task.cancellation.at}${by}${reason}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
