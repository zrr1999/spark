/** Shared Cockpit query view types. */

export type RuntimeConnectionStatus = "online" | "offline" | "draining" | "disabled";
export type RuntimeWorkspaceStatus =
  | "available"
  | "indexing"
  | "degraded"
  | "unavailable"
  | "archived";

export interface WorkbenchWorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  /** Active owner-binding directory; null until a daemon directory is connected. */
  localPath: string | null;
}

export interface WorkspaceFullRow extends WorkbenchWorkspaceSummary {
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeWorkspaceBindingView {
  id: string;
  runtimeId: string;
  localWorkspaceKey: string;
  localPath: string | null;
  displayName: string;
  status: RuntimeWorkspaceStatus;
  lastSnapshotAt: string | null;
  updatedAt: string;
  runtimeName: string;
  runtimeStatus: string;
}

export interface RuntimeConnectionView {
  id: string;
  installationId: string | null;
  name: string;
  status: RuntimeConnectionStatus;
  protocolVersion: string | null;
  lastHeartbeatAt: string | null;
  updatedAt: string;
}

/** Active Cockpit origin lease projection for a workspace directory. */
export interface LeaseBindingView {
  id: string;
  workspaceId: string;
  runtimeWorkspaceBindingId: string;
  startedAt: string;
  workspaceName: string;
  bindingName: string;
  runtimeName: string;
  runtimeStatus: string;
}

/** @deprecated Prefer {@link LeaseBindingView}. */
export type OwnerBindingView = LeaseBindingView;

export interface PendingWorkspaceBindingSetup {
  name: string;
  slug: string;
  enrollmentTokenId?: string;
}

/**
 * A workspace directory registration whose runtime has completed the HTTP
 * registration handshake (so the enrollment token has a `created_runtime_id`
 * and a binding row exists) but is not yet usable, because the runtime
 * connection is not `online` or the binding is not `available`. The most
 * common cause is that the daemon registered over HTTP but its WebSocket has
 * not connected back (e.g. a misconfigured Cockpit public URL behind a proxy).
 */
export interface PendingWorkspaceRuntimeState {
  runtimeName: string | null;
  runtimeStatus: string;
  bindingStatus: RuntimeWorkspaceStatus;
  bindingDisplayName: string;
}
