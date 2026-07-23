import { createHash } from "node:crypto";

import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { defaultTaskTodoStore, type SessionTodoEntry } from "@zendev-lab/spark-tasks";

import type { DaemonSessionRegistry } from "./session-registry.ts";
import { SparkDriverStore } from "./store/drivers.ts";

export const SESSION_TODO_AUTO_SOURCE_KIND = "session.todo";

export interface IdleSessionTodoReconcileResult {
  examined: number;
  submitted: number;
  errors: Array<{ sessionId: string; message: string }>;
}

export interface IdleSessionTodoReconcileDependencies {
  driverStore: SparkDriverStore;
  sessionRegistry: Pick<DaemonSessionRegistry, "list">;
  resolveWorkspaceCwd?: (workspaceId: string) => string | undefined;
  /** Synchronous daemon-generation fence checked before every durable admission. */
  canAdmit?: () => boolean;
}

/**
 * Reconcile one daemon-owned fallback driver for each session with executable
 * TODOs. The TODO-state digest is the progress boundary: a tick that makes no
 * checklist progress becomes dormant and cannot trigger itself again.
 */
export async function reconcileIdleSessionTodos(
  deps: IdleSessionTodoReconcileDependencies,
): Promise<IdleSessionTodoReconcileResult> {
  const sessions = await deps.sessionRegistry.list();
  const result: IdleSessionTodoReconcileResult = {
    examined: sessions.length,
    submitted: 0,
    errors: [],
  };

  for (const session of sessions) {
    if (deps.canAdmit?.() === false) break;
    if (!isRunnableSession(session)) continue;
    try {
      const cwd = sessionExecutionCwd(session, deps.resolveWorkspaceCwd);
      if (!cwd) continue;
      const todos = await defaultTaskTodoStore(cwd).loadSessionTodos(
        sessionTodoOwnerRef(session.sessionId),
      );
      const executable = executableSessionTodos(todos);
      const driverId = sessionTodoDriverId(session.sessionId);
      const existing = deps.driverStore.get(driverId);
      if (executable.length === 0) {
        if (existing && existing.status !== "stopped") {
          deps.driverStore.stop(driverId, "session TODO checklist has no executable work");
        }
        continue;
      }

      const explicitForeground = deps.driverStore
        .list({ ownerSessionId: session.sessionId })
        .find((driver) => driver.lane === "foreground" && driver.status !== "stopped");
      if (explicitForeground) {
        if (existing && existing.status !== "stopped") {
          deps.driverStore.stop(driverId, "explicit foreground driver owns the session");
        }
        continue;
      }

      const stateDigest = sessionTodoStateDigest(session.sessionId, todos);
      if (existing?.domainStateDigest === stateDigest && existing.status !== "stopped") {
        continue;
      }
      if (deps.canAdmit?.() === false) break;

      deps.driverStore.start({
        driverId,
        kind: "session_todo",
        ownerSessionId: session.sessionId,
        continuity: "session",
        prompt: renderSessionTodoContinuationPrompt(executable),
        cwd,
        ...(session.scope.kind === "workspace" ? { workspaceId: session.scope.workspaceId } : {}),
        domainStateDigest: stateDigest,
        reason: "executable session TODO state changed",
      });
      result.submitted += 1;
    } catch (error) {
      // Another producer may win the idle admission race after our optimistic
      // activity read. That is expected and needs no operator-facing error.
      result.errors.push({ sessionId: session.sessionId, message: errorMessage(error) });
    }
  }

  return result;
}

export function sessionTodoStateDigest(sessionId: string, todos: SessionTodoEntry[]): string {
  const state = todos
    .filter((todo) => todo.status !== "deleted")
    .map((todo) => ({
      id: todo.id ?? null,
      displayNumber: todo.displayNumber ?? null,
      content: todo.content,
      status: todo.status,
      blockedBy: todo.blockedBy ?? [],
    }));
  return createHash("sha256")
    .update(JSON.stringify([sessionId.trim(), state]))
    .digest("hex")
    .slice(0, 32);
}

export function renderSessionTodoContinuationPrompt(todos: SessionTodoEntry[]): string {
  const lines = todos.map((todo, index) => {
    const number = todo.displayNumber ?? index + 1;
    return `- #${number} [${todo.status}] ${todo.content}`;
  });
  return [
    "The session is idle. Continue its durable session TODO checklist now.",
    "Work on the in-progress item first, then continue through other executable items when safe. Use the todo tool to record each item as done, blocked, or cancelled before ending the turn. Do the work now; do not only describe future work and do not reinitialize or delete the checklist.",
    "Executable TODOs:",
    ...lines,
  ].join("\n");
}

function isRunnableSession(session: SparkSessionRegistryRecord): boolean {
  return session.status !== "archived";
}

function sessionExecutionCwd(
  session: SparkSessionRegistryRecord,
  resolveWorkspaceCwd: IdleSessionTodoReconcileDependencies["resolveWorkspaceCwd"],
): string | undefined {
  const sessionCwd = session.cwd?.trim();
  if (sessionCwd && sessionCwd !== "/") return sessionCwd;
  if (session.scope.kind !== "workspace") return undefined;
  const workspaceCwd = resolveWorkspaceCwd?.(session.scope.workspaceId)?.trim();
  return workspaceCwd && workspaceCwd !== "/" ? workspaceCwd : undefined;
}

function executableSessionTodos(todos: SessionTodoEntry[]): SessionTodoEntry[] {
  return todos.filter((todo) => todo.status === "in_progress" || todo.status === "pending");
}

function sessionTodoOwnerRef(sessionId: string): string {
  const normalized = sessionId.trim();
  return normalized.startsWith("session:") ? normalized : `session:${normalized}`;
}

function sessionTodoDriverId(sessionId: string): string {
  return `session-todo:${sessionId.trim()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
