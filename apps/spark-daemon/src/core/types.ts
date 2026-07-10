/** Types shared by the Spark daemon core runtime. */

import {
  parseSparkAssignment,
  type SparkAssignment,
  type SparkDaemonEvent,
} from "@zendev-lab/spark-protocol";
import { SparkDaemonInvocationRegistry } from "./invocations.ts";

export type SparkDaemonTask = SparkDaemonSessionRunTask;

export interface SparkDaemonSessionRunTask {
  type: "session.run";
  sessionId: string;
  prompt: string;
  /** Canonical provider/model frozen when this turn is enqueued. */
  model?: string;
  reset?: boolean;
  actor?: string;
  note?: string;
  input?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
  assignment?: SparkAssignment;
  /** When set, daemon sends the assistant reply back through channel notify. */
  channelReply?: {
    workspaceId: string;
    adapterId: string;
    recipient: string;
  };
}

export interface SparkDaemonQueuePayload<TTask extends SparkDaemonTask = SparkDaemonTask> {
  enqueuedAt: string;
  task: TTask;
  processedAt?: string;
  result?: unknown;
  failedAt?: string;
  error?: string;
}

export interface SparkDaemonProcessedQueuePayload<
  TTask extends SparkDaemonTask = SparkDaemonTask,
> extends SparkDaemonQueuePayload<TTask> {
  processedAt: string;
  result?: unknown;
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

export type SparkDaemonEventSink = (event: SparkDaemonEvent) => void | Promise<void>;

export interface SparkDaemonTaskExecutionContext {
  fileName: string;
  queueEntry: SparkDaemonQueueEntry;
  invocationId: string;
  signal: AbortSignal;
  timeoutMs?: number;
  emitEvent?: SparkDaemonEventSink;
}

export type SparkDaemonTaskExecutor = (
  task: SparkDaemonTask,
  context: SparkDaemonTaskExecutionContext,
) => Promise<unknown>;

export interface SparkDaemonActiveTasks {
  /** Queue-worker concurrency slots. These may be released before an aborted executor settles. */
  files: Set<string>;
  /** Session fences owned by the underlying executors, including abort cleanup. */
  sessions: Set<string>;
  /** Invocation/session authority; an entry lives until its underlying executor settles. */
  invocations: SparkDaemonInvocationRegistry;
}

export function createSparkDaemonActiveTasks(
  invocations = new SparkDaemonInvocationRegistry(),
): SparkDaemonActiveTasks {
  return { files: new Set(), sessions: new Set(), invocations };
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
    model: nonEmptyString(task.model),
    reset: typeof task.reset === "boolean" ? task.reset : undefined,
    actor: nonEmptyString(task.actor),
    note: nonEmptyString(task.note),
    input: nonEmptyString(task.input),
    workspaceBindingId: nonEmptyString(task.workspaceBindingId),
    workspaceId: nonEmptyString(task.workspaceId),
    projectId: nonEmptyString(task.projectId),
    assignment: task.assignment === undefined ? undefined : parseSparkAssignment(task.assignment),
    ...(parseChannelReply(task.channelReply)
      ? { channelReply: parseChannelReply(task.channelReply) }
      : {}),
  };
}

function parseChannelReply(value: unknown): SparkDaemonSessionRunTask["channelReply"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const workspaceId = nonEmptyString(record.workspaceId);
  const adapterId = nonEmptyString(record.adapterId);
  const recipient = nonEmptyString(record.recipient);
  if (!workspaceId || !adapterId || !recipient) return undefined;
  return { workspaceId, adapterId, recipient };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
