/**
 * Spark state ownership boundaries (daemon canonical, Cockpit projection).
 *
 * Inspired by cue-shell's single-daemon truth model: execution state lives in the
 * runtime/daemon; web/TUI clients observe and submit commands through protocol envelopes.
 */

export const SPARK_STATE_OWNERS = {
  /** Workspace agent runtime: tasks, artifacts, sessions, workflow runs. */
  workspaceRuntime: "daemon",
  /** Cockpit SQLite: read-model projection + command outbox for reconnect delivery. */
  cockpitProjection: "cockpit",
  /** Local queue + daemon metadata under XDG spark/daemon. */
  daemonControlPlane: "daemon",
} as const;

export type SparkStateOwner = (typeof SPARK_STATE_OWNERS)[keyof typeof SPARK_STATE_OWNERS];

/** Scopes where daemon/runtime is the canonical writer; Cockpit only projects. */
export const DAEMON_OWNED_SCOPES = [
  "task_graph",
  "artifacts",
  "invocations",
  "invocation_logs",
  "human_requests",
  "workspace_bindings",
] as const;

export type DaemonOwnedScope = (typeof DAEMON_OWNED_SCOPES)[number];

/** Scopes where Cockpit may write before daemon acknowledges over the runtime protocol. */
export const COCKPIT_OUTBOX_SCOPES = ["commands", "human_responses"] as const;

export type CockpitOutboxScope = (typeof COCKPIT_OUTBOX_SCOPES)[number];

export function isDaemonOwnedScope(scope: string): scope is DaemonOwnedScope {
  return (DAEMON_OWNED_SCOPES as readonly string[]).includes(scope);
}

export function isCockpitOutboxScope(scope: string): scope is CockpitOutboxScope {
  return (COCKPIT_OUTBOX_SCOPES as readonly string[]).includes(scope);
}
