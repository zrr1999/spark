import type { Task, TaskRef, ProjectRef } from "@zendev-lab/pi-extension-api";
import { isUnfinishedTaskStatus, type TaskGraph } from "@zendev-lab/pi-tasks";
import { isClaimOwnedBySession } from "./task-ownership.ts";

export function resolveSessionClaimedTask(
  graph: TaskGraph,
  projectRef: ProjectRef,
  sessionKey: string,
  query?: string,
): Task | undefined {
  const claimed = graph
    .tasks(projectRef)
    .filter(
      (task) => isClaimOwnedBySession(task, sessionKey) && isUnfinishedTaskStatus(task.status),
    );
  if (query?.trim()) {
    const needle = query.trim();
    const normalizedNeedle = needle.startsWith("@") ? needle.slice(1) : needle;
    return claimed.find(
      (task) =>
        task.ref === needle ||
        task.name === normalizedNeedle ||
        task.title === needle ||
        task.title.startsWith(needle),
    );
  }
  const current = graph.currentTask(projectRef);
  if (
    current &&
    isClaimOwnedBySession(current, sessionKey) &&
    isUnfinishedTaskStatus(current.status)
  )
    return current;
  return claimed.at(-1);
}

export function findActiveSessionClaim(
  graph: TaskGraph,
  projectRef: ProjectRef,
  sessionKey: string,
  exceptTaskRef?: TaskRef,
): Task | undefined {
  return graph
    .tasks(projectRef)
    .find(
      (task) =>
        task.ref !== exceptTaskRef &&
        isClaimOwnedBySession(task, sessionKey) &&
        isUnfinishedTaskStatus(task.status),
    );
}
