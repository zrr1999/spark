export interface SparkStateSessionScopes {
  currentSessionScope: string;
  currentOwnerScope: string;
}

export type SparkStateCacheKind =
  | "sessions"
  | "task-todos"
  | "session-todos"
  | "todo-display-numbers"
  | "legacy-task-todos";

export type SparkProtectedStoreReason =
  | "artifact-history"
  | "task-graph"
  | "todo-records"
  | "session-state"
  | "notes"
  | "role-reports"
  | "review-gate"
  | "workflow-runs";

export interface SparkStateCacheSummary {
  path: string;
  kind: SparkStateCacheKind;
  files: number;
  bytes: number;
  staleFiles: number;
  brokenFiles: number;
  safeToDeleteFiles: number;
  activeFiles: number;
}

export interface SparkProtectedStoreSummary {
  path: string;
  reason: SparkProtectedStoreReason;
  files: number;
  bytes: number;
}

export type SparkStateCleanupReason =
  | "broken-json"
  | "missing-project"
  | "stale-sessions"
  | "empty-task-todos"
  | "stale-terminal-task-todos"
  | "empty-session-todos"
  | "stale-terminal-session-todos"
  | "stale-display-numbers";

export interface SparkStateCleanupCandidate {
  path: string;
  kind: SparkStateCacheKind;
  reason: SparkStateCleanupReason;
  bytes: number;
  stale: boolean;
}

export interface SparkStateCleanupSkippedSummary {
  kind: SparkStateCacheKind;
  files: number;
}
