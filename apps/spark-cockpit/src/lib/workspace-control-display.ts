import type { AppMessages } from "./i18n";

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
    reason?: string;
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

type WorkspaceControlMessages = AppMessages["home"]["workspaceControl"];

export function workspaceControlDisplay(
  control: WorkspaceControlDisplayInput,
  messages: WorkspaceControlMessages,
): WorkspaceControlDisplay {
  return {
    connectionLabel:
      control.connection.status === "connected"
        ? messages.daemonConnected
        : messages.daemonDisconnected,
    borrowedLabel: borrowedLabel(control.borrowed, messages),
    executorLabel: executorLabel(control.executor, messages),
    controlLabel: workspaceControlControlLabel(control.control, messages),
  };
}

export function workspaceControlControlLabel(
  control: WorkspaceControlDisplayInput["control"],
  messages: WorkspaceControlMessages,
): string {
  if (control.serverMutationAllowed) return messages.serverControlEnabled;
  switch (control.reason) {
    case "workspace_borrowed":
      return messages.workspaceBorrowedSnapshotOnly;
    case "daemon_disconnected":
      return messages.daemonDisconnectedSnapshotOnly;
    default:
      return control.message ?? messages.snapshotOnlyMode;
  }
}

function borrowedLabel(
  borrowed: WorkspaceControlDisplayInput["borrowed"],
  messages: WorkspaceControlMessages,
): string {
  if (!borrowed?.borrowed) return messages.workspaceNotBorrowed;
  const count = Math.max(0, Math.floor(borrowed.interactiveClientCount ?? 0));
  return count === 1
    ? messages.borrowedByOneTuiClient
    : `${messages.borrowedByTuiClientsPrefix} ${count} ${messages.tuiClients}`;
}

function executorLabel(
  executor: WorkspaceControlDisplayInput["executor"],
  messages: WorkspaceControlMessages,
): string {
  if (!executor || executor.state === "none") return messages.noBackgroundExecutor;
  if (executor.state === "starting") return messages.backgroundExecutorStarting;
  const activeInvocations = Math.max(0, Math.floor(executor.activeInvocationCount ?? 0));
  const activeAgents = Math.max(0, Math.floor(executor.activeAgentCount ?? 0));
  if (executor.state === "unhealthy") {
    return executor.unhealthyReason
      ? `${messages.backgroundExecutorUnhealthy}: ${executor.unhealthyReason}`
      : messages.backgroundExecutorUnhealthy;
  }
  const invocationLabel =
    activeInvocations === 1 ? messages.activeInvocationSingular : messages.activeInvocationPlural;
  const agentLabel = activeAgents === 1 ? messages.activeAgentSingular : messages.activeAgentPlural;
  return `${messages.backgroundExecutorOnline} · ${activeInvocations} ${invocationLabel} · ${activeAgents} ${agentLabel}`;
}
