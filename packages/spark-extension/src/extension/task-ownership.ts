import type { Task, TaskRun } from "@zendev-lab/pi-extension-api";
import { isUnfinishedTaskStatus } from "@zendev-lab/pi-tasks";

export function taskClaimedBy(task: Task): string | undefined {
  return task.claim?.claimedBy;
}

export function isClaimOwnedBySession(task: Task, sessionKey: string): boolean {
  return task.claim?.sessionId === sessionKey;
}

export function deriveTaskRoleLabel(input: {
  task: Task;
  currentSessionKey: string;
  latestRun?: TaskRun;
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

export function shortRoleLabel(roleRef: string): string {
  return roleRef.replace(/^role:(builtin-|project-|user-)?/, "");
}

function sessionDisplayLabel(sessionId: string, currentSessionKey: string): string {
  if (sessionId === currentSessionKey) return "me";
  return sessionId.startsWith("session:")
    ? sessionId.slice("session:".length, "session:".length + 8)
    : sessionId;
}
