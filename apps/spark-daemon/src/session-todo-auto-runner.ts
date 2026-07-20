import { createHash } from "node:crypto";

import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { defaultTaskTodoStore, type SessionTodoEntry } from "@zendev-lab/spark-tasks";

import type { SparkDaemonModelControl } from "./model-control.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import type { SparkDaemonSessionRunTask } from "./core/types.ts";
import { SparkInvocationStore } from "./store/invocations.ts";

export const SESSION_TODO_AUTO_SOURCE_KIND = "session.todo";

export interface IdleSessionTodoReconcileResult {
  examined: number;
  submitted: number;
  errors: Array<{ sessionId: string; message: string }>;
}

export interface IdleSessionTodoReconcileDependencies {
  invocationStore: SparkInvocationStore;
  sessionRegistry: Pick<DaemonSessionRegistry, "list" | "recordTurnQueued">;
  modelControl?: Pick<
    SparkDaemonModelControl,
    "effectiveModel" | "effectiveThinkingLevel" | "prepareModel"
  >;
  resolveWorkspaceCwd?: (workspaceId: string) => string | undefined;
  /** Synchronous daemon-generation fence checked before every durable admission. */
  canAdmit?: () => boolean;
}

/**
 * Admit one durable continuation for each idle session with executable session
 * TODOs. Channel-bound sessions keep their bounded tool surface, but this
 * internal continuation does not carry a channel-reply target and therefore
 * cannot manufacture an unsolicited platform reply. The TODO-state digest is
 * the idempotency boundary: an
 * automatic turn that makes no checklist progress cannot trigger itself again.
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
    if (deps.invocationStore.sessionActivity(session.sessionId).active) continue;
    try {
      const cwd = sessionExecutionCwd(session, deps.resolveWorkspaceCwd);
      if (!cwd) continue;
      const todos = await defaultTaskTodoStore(cwd).loadSessionTodos(
        sessionTodoOwnerRef(session.sessionId),
      );
      const executable = executableSessionTodos(todos);
      if (executable.length === 0) continue;

      const stateDigest = sessionTodoStateDigest(session.sessionId, todos);
      const idempotencyKey = `session.todo:${stateDigest}`;
      if (deps.invocationStore.findByIdempotencyKey(idempotencyKey)) continue;
      if (deps.canAdmit?.() === false) break;

      const model = deps.modelControl
        ? await deps.modelControl.effectiveModel(session.sessionId)
        : undefined;
      if (model) await deps.modelControl?.prepareModel(model);
      const thinkingLevel = deps.modelControl
        ? await deps.modelControl.effectiveThinkingLevel(session.sessionId)
        : undefined;
      const task: SparkDaemonSessionRunTask = {
        type: "session.run",
        sessionId: session.sessionId,
        prompt: renderSessionTodoContinuationPrompt(executable),
        cwd,
        ...(session.scope.kind === "workspace" ? { workspaceId: session.scope.workspaceId } : {}),
        ...(model ? { model: `${model.providerName}/${model.modelId}` } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        actor: "spark-daemon-session-todo",
        messageMetadata: {
          origin: { kind: "system", host: "daemon", intent: SESSION_TODO_AUTO_SOURCE_KIND },
          sessionTodo: {
            mode: "auto",
            stateDigest,
            itemIds: executable.flatMap((todo) => (todo.id ? [todo.id] : [])),
          },
        },
      };
      if (deps.canAdmit?.() === false) break;
      deps.invocationStore.submitIfSessionIdle({
        sessionId: session.sessionId,
        idempotencyKey,
        prompt: task.prompt,
        task,
        sourceKind: SESSION_TODO_AUTO_SOURCE_KIND,
        sourceRef: stateDigest,
      });
      await deps.sessionRegistry.recordTurnQueued(session.sessionId);
      result.submitted += 1;
    } catch (error) {
      // Another producer may win the idle admission race after our optimistic
      // activity read. That is expected and needs no operator-facing error.
      if (errorMessage(error).startsWith("SESSION_NOT_IDLE:")) continue;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
