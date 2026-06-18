/** Types shared by the Spark CLI daemon-only runtime. */

export type SparkDaemonTask = SparkDaemonSessionRunTask;

export interface SparkDaemonSessionRunTask {
  type: "session.run";
  sessionId: string;
  prompt: string;
  reset?: boolean;
  actor?: string;
  note?: string;
  input?: string;
}

export interface SparkDaemonQueuePayload<TTask extends SparkDaemonTask = SparkDaemonTask> {
  enqueuedAt: string;
  task: TTask;
}

export interface SparkDaemonFailedQueuePayload<
  TTask extends SparkDaemonTask = SparkDaemonTask,
> extends SparkDaemonQueuePayload<TTask> {
  failedAt: string;
  error: string;
}

export type SparkDaemonQueueState = "inbox" | "processed" | "failed";

export interface SparkDaemonQueueEntry<TTask extends SparkDaemonTask = SparkDaemonTask> {
  fileName: string;
  filePath: string;
  payload: SparkDaemonQueuePayload<TTask>;
}

export interface SparkDaemonTaskExecutionContext {
  fileName: string;
  queueEntry: SparkDaemonQueueEntry;
}

export type SparkDaemonTaskExecutor = (
  task: SparkDaemonTask,
  context: SparkDaemonTaskExecutionContext,
) => Promise<unknown>;

export interface SparkDaemonActiveTasks {
  files: Set<string>;
  sessions: Set<string>;
}

export function createSparkDaemonActiveTasks(): SparkDaemonActiveTasks {
  return { files: new Set(), sessions: new Set() };
}

export function getSparkDaemonTaskSessionId(task: SparkDaemonTask): string | null {
  return task.type === "session.run" ? task.sessionId : null;
}

export function validateSparkDaemonTask(value: unknown): SparkDaemonTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("daemon task must be an object");
  }
  const task = value as Partial<SparkDaemonSessionRunTask>;
  if (task.type !== "session.run") {
    throw new Error(`unsupported daemon task type: ${String((value as { type?: unknown }).type)}`);
  }
  if (typeof task.sessionId !== "string" || task.sessionId.trim().length === 0) {
    throw new Error("session.run task requires sessionId");
  }
  if (typeof task.prompt !== "string" || task.prompt.trim().length === 0) {
    throw new Error("session.run task requires prompt");
  }
  return {
    type: "session.run",
    sessionId: task.sessionId.trim(),
    prompt: task.prompt,
    reset: typeof task.reset === "boolean" ? task.reset : undefined,
    actor: typeof task.actor === "string" && task.actor.length > 0 ? task.actor : undefined,
    note: typeof task.note === "string" && task.note.length > 0 ? task.note : undefined,
    input: typeof task.input === "string" && task.input.length > 0 ? task.input : undefined,
  };
}
