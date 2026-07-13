/** Types shared by the Spark daemon core runtime. */

import {
  parseSparkAssignment,
  type SparkAssignment,
  type SparkDaemonEvent,
} from "@zendev-lab/spark-protocol";
import type { InfoflowAttachment } from "@zendev-lab/spark-channels";
import { SparkDaemonInvocationRegistry } from "./invocations.ts";

export type SparkDaemonTask = SparkDaemonSessionRunTask;

/** Normalized platform facts captured with one inbound channel message. */
export interface SparkDaemonChannelContext {
  /** Stable binding used to identify the conversation surface. */
  externalKey: string;
  senderId?: string;
  senderName?: string;
  chatId?: string;
  messageId?: string;
  eventType?: string;
  contentType?: string;
  attachments?: InfoflowAttachment[];
  mentions?: string[];
  mentionedSelf?: boolean;
}

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
  /** Execution directory frozen from the durable session owner at enqueue time. */
  cwd?: string;
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
  /** Inbound platform facts for this turn; never part of the persisted user message body. */
  channelContext?: SparkDaemonChannelContext;
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
    cwd: nonEmptyString(task.cwd),
    workspaceBindingId: nonEmptyString(task.workspaceBindingId),
    workspaceId: nonEmptyString(task.workspaceId),
    projectId: nonEmptyString(task.projectId),
    assignment: task.assignment === undefined ? undefined : parseSparkAssignment(task.assignment),
    ...(parseChannelReply(task.channelReply)
      ? { channelReply: parseChannelReply(task.channelReply) }
      : {}),
    ...(parseChannelContext(task.channelContext)
      ? { channelContext: parseChannelContext(task.channelContext) }
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

function parseChannelContext(value: unknown): SparkDaemonChannelContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const externalKey = nonEmptyString(record.externalKey)?.trim();
  if (!externalKey) return undefined;
  const mentions = Array.isArray(record.mentions)
    ? record.mentions
        .map((entry) => nonEmptyString(entry)?.trim())
        .filter((entry): entry is string => Boolean(entry))
    : undefined;
  const attachments = parseInfoflowAttachments(record.attachments);
  return {
    externalKey,
    senderId: nonEmptyString(record.senderId)?.trim(),
    senderName: nonEmptyString(record.senderName)?.trim(),
    chatId: nonEmptyString(record.chatId)?.trim(),
    messageId: nonEmptyString(record.messageId)?.trim(),
    eventType: nonEmptyString(record.eventType)?.trim(),
    contentType: nonEmptyString(record.contentType)?.trim(),
    ...(attachments.length ? { attachments } : {}),
    ...(mentions?.length ? { mentions } : {}),
    ...(typeof record.mentionedSelf === "boolean" ? { mentionedSelf: record.mentionedSelf } : {}),
  };
}

function parseInfoflowAttachments(value: unknown): InfoflowAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((entry): InfoflowAttachment[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (record.kind !== "image" && record.kind !== "file" && record.kind !== "voice") return [];
    const size =
      typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0
        ? record.size
        : undefined;
    return [
      {
        kind: record.kind,
        ...(nonEmptyString(record.name)?.trim()
          ? { name: nonEmptyString(record.name)!.trim() }
          : {}),
        ...(nonEmptyString(record.mediaType)?.trim()
          ? { mediaType: nonEmptyString(record.mediaType)!.trim() }
          : {}),
        ...(size !== undefined ? { size } : {}),
        ...(nonEmptyString(record.reference)?.trim()
          ? { reference: nonEmptyString(record.reference)!.trim() }
          : {}),
      },
    ];
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
