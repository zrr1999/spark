/** Types shared by the Spark daemon core runtime. */

import {
  parseSparkAssignment,
  type SparkAssignment,
  type SparkDaemonEvent,
} from "@zendev-lab/spark-protocol";
import {
  CHANNEL_IMAGE_MAX_COUNT,
  CHANNEL_IMAGE_MAX_TOTAL_BYTES,
  normalizeChannelImage,
  normalizeChannelMessageReference,
  type ChannelAdapterType,
  type ChannelImage,
  type ChannelMessageReference,
  type InfoflowAttachment,
} from "@zendev-lab/spark-channels";

export type SparkDaemonTask = SparkDaemonSessionRunTask;

/** Normalized platform facts captured with one inbound channel message. */
export interface SparkDaemonChannelContext {
  /** Stable binding used to identify the conversation surface. */
  externalKey: string;
  senderId?: string;
  senderName?: string;
  chatId?: string;
  messageId?: string;
  messageReference?: ChannelMessageReference;
  eventType?: string;
  contentType?: string;
  attachments?: InfoflowAttachment[];
  /** Provider-ready image blocks captured before temporary platform URLs expire. */
  images?: ChannelImage[];
  mentions?: string[];
  mentionedSelf?: boolean;
}

export interface SparkDaemonSessionRunTask {
  type: "session.run";
  sessionId: string;
  prompt: string;
  /** Canonical provider/model frozen when this turn is enqueued. */
  model?: string;
  /** Thinking/reasoning intensity frozen when this turn is enqueued. */
  thinkingLevel?: string;
  reset?: boolean;
  /** Set when a successor daemon resumes an interrupted running turn. */
  resumeFromInterrupt?: boolean;
  actor?: string;
  note?: string;
  input?: string;
  /** Execution directory frozen from the durable session owner at enqueue time. */
  cwd?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
  assignment?: SparkAssignment;
  /** Direct request message metadata persisted on the target user turn. */
  messageMetadata?: Record<string, unknown>;
  /** Complete immutable channel origin. Channel-origin tasks fail closed when this is incomplete. */
  channelReply?: {
    workspaceId: string;
    adapter?: ChannelAdapterType;
    adapterId: string;
    /** Rename-stable provider account identity frozen with the inbound turn. */
    adapterAccountIdentity?: string;
    externalKey?: string;
    recipient: string;
  };
  /** Inbound platform facts for this turn; never part of the persisted user message body. */
  channelContext?: SparkDaemonChannelContext;
}

export type SparkDaemonEventSink = (event: SparkDaemonEvent) => void | Promise<void>;

export interface SparkDaemonTaskExecutionContext {
  invocationId: string;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Pause the task wall-clock timeout while waiting on an explicit human decision. */
  withPausedTimeout?<T>(operation: () => Promise<T>): Promise<T>;
  emitEvent?: SparkDaemonEventSink;
}

export type SparkDaemonTaskExecutor = (
  task: SparkDaemonTask,
  context: SparkDaemonTaskExecutionContext,
) => Promise<unknown>;

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
    thinkingLevel: nonEmptyString(task.thinkingLevel),
    reset: typeof task.reset === "boolean" ? task.reset : undefined,
    resumeFromInterrupt:
      typeof task.resumeFromInterrupt === "boolean" ? task.resumeFromInterrupt : undefined,
    actor: nonEmptyString(task.actor),
    note: nonEmptyString(task.note),
    input: nonEmptyString(task.input),
    cwd: nonEmptyString(task.cwd),
    workspaceBindingId: nonEmptyString(task.workspaceBindingId),
    workspaceId: nonEmptyString(task.workspaceId),
    projectId: nonEmptyString(task.projectId),
    assignment: task.assignment === undefined ? undefined : parseSparkAssignment(task.assignment),
    ...(task.messageMetadata === undefined
      ? {}
      : { messageMetadata: requiredRecord(task.messageMetadata, "messageMetadata") }),
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
  const adapter = channelAdapterType(record.adapter);
  const adapterId = nonEmptyString(record.adapterId);
  const adapterAccountIdentity = nonEmptyString(record.adapterAccountIdentity);
  const externalKey = nonEmptyString(record.externalKey);
  const recipient = nonEmptyString(record.recipient);
  if (!workspaceId || !adapterId || !recipient) return undefined;
  return {
    workspaceId,
    ...(adapter ? { adapter } : {}),
    adapterId,
    ...(adapterAccountIdentity ? { adapterAccountIdentity } : {}),
    ...(externalKey ? { externalKey } : {}),
    recipient,
  };
}

function channelAdapterType(value: unknown): ChannelAdapterType | undefined {
  return value === "feishu" || value === "infoflow" || value === "qqbot" ? value : undefined;
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
  const images = parseChannelImages(record.images);
  const messageReference = normalizeChannelMessageReference(record.messageReference);
  return {
    externalKey,
    senderId: nonEmptyString(record.senderId)?.trim(),
    senderName: nonEmptyString(record.senderName)?.trim(),
    chatId: nonEmptyString(record.chatId)?.trim(),
    messageId: nonEmptyString(record.messageId)?.trim(),
    ...(messageReference ? { messageReference } : {}),
    eventType: nonEmptyString(record.eventType)?.trim(),
    contentType: nonEmptyString(record.contentType)?.trim(),
    ...(attachments.length ? { attachments } : {}),
    ...(images.length ? { images } : {}),
    ...(mentions?.length ? { mentions } : {}),
    ...(typeof record.mentionedSelf === "boolean" ? { mentionedSelf: record.mentionedSelf } : {}),
  };
}

function parseChannelImages(value: unknown): ChannelImage[] {
  if (!Array.isArray(value)) return [];
  const images: ChannelImage[] = [];
  let totalBytes = 0;
  for (const entry of value.slice(0, CHANNEL_IMAGE_MAX_COUNT)) {
    const image = normalizeChannelImage(entry);
    if (!image) continue;
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    const bytes = Math.floor((image.data.length * 3) / 4) - padding;
    if (totalBytes + bytes > CHANNEL_IMAGE_MAX_TOTAL_BYTES) break;
    totalBytes += bytes;
    images.push(image);
  }
  return images;
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

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`daemon task ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
