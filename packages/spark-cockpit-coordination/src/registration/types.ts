import type { RuntimeDeviceAuthorizationRequest } from "@zendev-lab/spark-protocol";

export interface RegisteredRuntime {
  runtimeId: string;
  runtimeToken: string;
  runtimeTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  registeredAt: string;
  workspaceBinding?: RegisteredWorkspaceBinding;
  workspaceAuthorization?: RegisteredWorkspaceAuthorization;
}

export type RefreshedRuntimeToken = Omit<RegisteredRuntime, "registeredAt"> & {
  refreshedAt: string;
};

export interface RegisteredWorkspaceBinding {
  workspaceId: string;
  bindingId: string;
  localWorkspaceKey: string;
  displayName: string;
  status: "available";
}

export interface RegisteredRuntimeWorkspace {
  runtimeId: string;
  registeredAt: string;
  workspaceBinding: RegisteredWorkspaceBinding;
  workspaceAuthorization: RegisteredWorkspaceAuthorization;
}

export interface RegisteredWorkspaceAuthorization {
  workspaceId: string;
  workspaceSlug: string;
  oneTimeToken: string;
  expiresAt: string;
}

export interface UnboundRuntimeWorkspace {
  runtimeId: string;
  bindingId: string;
  workspaceIds: string[];
  unboundAt: string;
}

export interface RuntimeEnrollmentToken {
  id: string;
  refreshToken: string;
  createdAt: string;
  expiresAt: string;
  workspaceName: string | null;
  workspaceSlug: string | null;
}

export interface RuntimeEnrollmentTokenSummary {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
  createdRuntimeId: string | null;
  runtimeName: string | null;
  workspaceName: string | null;
  workspaceSlug: string | null;
  workspaceId: string | null;
}

export interface CreatedRuntimeDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  createdAt: string;
  expiresAt: string;
  expiresIn: number;
  interval: number;
}

export type RuntimeDeviceAuthorizationStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed";

export interface RuntimeDeviceAuthorizationApproval {
  id: string;
  userCode: string;
  installationId: string;
  displayName: string;
  registration: RuntimeDeviceAuthorizationRequest;
  status: RuntimeDeviceAuthorizationStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  deniedAt: string | null;
  consumedAt: string | null;
}

export class RuntimeEnrollmentError extends Error {
  readonly reasonCode: string;

  constructor(message: string, reasonCode: string) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

export class RuntimeTokenRefreshError extends Error {
  readonly reasonCode: string;

  constructor(message: string, reasonCode: string) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

export class RuntimeRelocationPreflightError extends Error {
  readonly reasonCode: string;

  constructor(message: string, reasonCode: string) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

export class RuntimeAccessTokenError extends Error {
  readonly reasonCode: string;

  constructor(message: string, reasonCode: string) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

type RuntimeDeviceAuthorizationReasonCode =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | "approval_forbidden"
  | "too_many_pending_authorizations"
  | "authorization_capacity_exceeded";

export class RuntimeDeviceAuthorizationError extends Error {
  readonly reasonCode: RuntimeDeviceAuthorizationReasonCode;

  constructor(message: string, reasonCode: RuntimeDeviceAuthorizationReasonCode) {
    super(message);
    this.reasonCode = reasonCode;
  }
}

export interface RuntimeWorkspaceLeaseConflict {
  workspaceId: string;
  currentRuntimeId: string;
  currentBindingId: string;
  attemptedRuntimeId: string;
  attemptedBindingId: string;
  occurredAt: string;
}

/** @deprecated Prefer {@link RuntimeWorkspaceLeaseConflict}. */
export type RuntimeWorkspaceOwnerConflict = RuntimeWorkspaceLeaseConflict;

export class RuntimeWorkspaceLeaseConflictError extends Error {
  readonly reasonCode = "WORKSPACE_LEASE_CONFLICT";
  /** Wire/HTTP alias retained for older clients and ops docs. */
  readonly aliasReasonCode = "WORKSPACE_OWNER_CONFLICT";
  readonly conflict: RuntimeWorkspaceLeaseConflict;

  constructor(conflict: RuntimeWorkspaceLeaseConflict) {
    super("Workspace already has an active origin lease.");
    this.conflict = conflict;
  }
}

/** @deprecated Prefer {@link RuntimeWorkspaceLeaseConflictError}. */
export class RuntimeWorkspaceOwnerConflictError extends RuntimeWorkspaceLeaseConflictError {}
