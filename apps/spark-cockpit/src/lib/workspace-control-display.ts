export interface WorkspaceControlDisplayInput {
  connection: {
    status: "connected" | "disconnected";
    lastSeenAt: string | null;
  };
  borrowed?: {
    borrowed: boolean;
    interactiveClientCount?: number;
  };
  executor?: {
    state: "none" | "starting" | "online" | "unhealthy";
    activeInvocationCount?: number;
    activeAgentCount?: number;
    unhealthyReason?: string;
  };
  control: {
    mode: "full" | "snapshot_only";
    serverMutationAllowed: boolean;
    message?: string;
  };
}

export interface WorkspaceControlDisplay {
  connectionLabel: string;
  borrowedLabel: string;
  executorLabel: string;
  controlLabel: string;
}

export function workspaceControlDisplay(
  control: WorkspaceControlDisplayInput,
): WorkspaceControlDisplay {
  return {
    connectionLabel:
      control.connection.status === "connected" ? "Daemon connected" : "Daemon disconnected",
    borrowedLabel: borrowedLabel(control.borrowed),
    executorLabel: executorLabel(control.executor),
    controlLabel: control.control.serverMutationAllowed
      ? "Server control enabled"
      : (control.control.message ?? "Snapshot-only mode"),
  };
}

function borrowedLabel(borrowed: WorkspaceControlDisplayInput["borrowed"]): string {
  if (!borrowed?.borrowed) return "Workspace not borrowed";
  const count = Math.max(0, Math.floor(borrowed.interactiveClientCount ?? 0));
  return count === 1 ? "Borrowed by 1 TUI client" : `Borrowed by ${count} TUI clients`;
}

function executorLabel(executor: WorkspaceControlDisplayInput["executor"]): string {
  if (!executor || executor.state === "none") return "No background executor";
  if (executor.state === "starting") return "Background executor starting";
  const activeInvocations = Math.max(0, Math.floor(executor.activeInvocationCount ?? 0));
  const activeAgents = Math.max(0, Math.floor(executor.activeAgentCount ?? 0));
  if (executor.state === "unhealthy") {
    return executor.unhealthyReason
      ? `Background executor unhealthy: ${executor.unhealthyReason}`
      : "Background executor unhealthy";
  }
  return `Background executor online · ${activeInvocations} active invocation${
    activeInvocations === 1 ? "" : "s"
  } · ${activeAgents} active agent${activeAgents === 1 ? "" : "s"}`;
}
