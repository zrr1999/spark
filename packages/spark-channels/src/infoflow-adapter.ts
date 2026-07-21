import { createChannelExternalKey, createDefaultChannelExternalKey } from "./external-key.ts";
import { normalizeChannelImage } from "./channel-images.ts";
import { isInfoflowInboundAllowed } from "./infoflow-policy.ts";
import { createInfoflowTransport } from "./infoflow-transport.ts";
import type { ChannelInteractionCapability } from "./interaction.ts";
import type {
  ChannelAdapter,
  ChannelImageCapability,
  ChannelTransport,
  IncomingMessage,
  InfoflowAdapterConfig,
  InfoflowInboundRaw,
} from "./types.ts";
import {
  channelDeliveryNotSent,
  normalizeChannelDeliveryResult,
  type ChannelDeliveryFacts,
  type ChannelDeliveryResult,
  type ChannelMessageTarget,
  type ChannelReplyCapability,
} from "./reply.ts";
import { normalizeChannelMessageReference } from "./message-reference.ts";

export interface InfoflowAdapterOptions {
  id: string;
  config: InfoflowAdapterConfig;
  transport?: ChannelTransport;
  onMessage?: (message: IncomingMessage) => void;
}

export class InfoflowAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = "infoflow" as const;
  readonly config: InfoflowAdapterConfig;
  private readonly transport: ChannelTransport;
  private readonly onMessage?: (message: IncomingMessage) => void;
  private readonly seenMessages = new Map<string, number>();
  private running = false;

  get reply(): ChannelReplyCapability | undefined {
    return this.transport.reply;
  }

  get image(): ChannelImageCapability | undefined {
    return this.transport.image;
  }

  get interaction(): ChannelInteractionCapability | undefined {
    return this.transport.interaction;
  }

  constructor(options: InfoflowAdapterOptions) {
    this.id = options.id;
    this.config = options.config;
    this.onMessage = options.onMessage;
    this.transport = options.transport ?? createDefaultInfoflowTransport(options.config);
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.transport.start((raw) => this.handleInbound(raw));
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.transport.stop();
    this.running = false;
  }

  messageDeliveryFacts(target: ChannelMessageTarget): ChannelDeliveryFacts {
    return this.transport.messageDeliveryFacts?.(target) ?? { replaySafety: "unsafe" };
  }

  async send(input: {
    recipient: string;
    text: string;
    deliveryId?: string;
  }): Promise<ChannelDeliveryResult> {
    const facts = this.messageDeliveryFacts(input);
    const result = await this.transport.send(input.recipient, input.text, input.deliveryId);
    return normalizeChannelDeliveryResult(result, facts);
  }

  status() {
    const transportStatus = this.transport.status?.() ?? {
      state: this.running ? ("connected" as const) : ("stopped" as const),
    };
    return {
      id: this.id,
      type: this.type,
      running: this.running,
      ...transportStatus,
    };
  }

  parseInbound(raw: unknown): IncomingMessage {
    const payload = parseInfoflowInbound(raw);
    const userId = payload.user_id.trim();
    const chatType = payload.chat_type;
    const groupId = payload.chat_id?.trim();
    const externalKey =
      chatType === "group" && groupId
        ? createChannelExternalKey("infoflow", "group", groupId)
        : createDefaultChannelExternalKey("infoflow", userId);
    const mentionMeta = extractInfoflowMentionMeta(raw, this.config);
    const mentionedSelf = mentionMeta.mentionedSelf ?? payload.mentioned_self;
    const mentions =
      mentionMeta.mentions.length > 0
        ? mentionMeta.mentions
        : (payload.mentions ?? []).map((entry) => entry.trim()).filter(Boolean);
    return {
      adapter: "infoflow",
      externalKey,
      senderId: userId,
      ...(payload.sender_name?.trim() ? { senderName: payload.sender_name.trim() } : {}),
      ...(groupId ? { chatId: groupId } : {}),
      text: payload.text,
      messageId: payload.message_id,
      ...(payload.message_reference ? { messageReference: payload.message_reference } : {}),
      ...(payload.event_type ? { eventType: payload.event_type } : {}),
      ...(payload.content_type ? { contentType: payload.content_type } : {}),
      ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
      ...(payload.images?.length ? { images: payload.images } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(typeof mentionedSelf === "boolean" ? { mentionedSelf } : {}),
      raw,
    };
  }

  private handleInbound(raw: unknown): void {
    const message = this.parseInbound(raw);
    const payload = parseInfoflowInbound(raw);
    if (
      !isInfoflowInboundAllowed(this.config, {
        chatType: payload.chat_type,
        senderId: payload.user_id,
        ...(payload.sender_name ? { senderName: payload.sender_name } : {}),
        ...(payload.chat_id ? { groupId: payload.chat_id } : {}),
        text: payload.text,
        ...(payload.event_type ? { eventType: payload.event_type } : {}),
        ...(typeof message.mentionedSelf === "boolean"
          ? { mentionedSelf: message.mentionedSelf }
          : {}),
      })
    ) {
      console.log(
        `[spark-channels] infoflow dropped ${payload.chat_type} from=${payload.user_id}` +
          (payload.chat_id ? ` group=${payload.chat_id}` : "") +
          ` policy=${this.config.group_policy ?? "disabled"}`,
      );
      return;
    }
    const messageId = message.messageId?.trim();
    const dedupeKey = messageId ? `${message.externalKey}\u0000${messageId}` : undefined;
    const now = Date.now();
    this.pruneSeenMessages(now);
    const seenAt = dedupeKey ? this.seenMessages.get(dedupeKey) : undefined;
    if (dedupeKey && seenAt !== undefined && now - seenAt < INFOFLOW_DEDUPE_TTL_MS) {
      this.seenMessages.delete(dedupeKey);
      this.seenMessages.set(dedupeKey, now);
      console.log(`[spark-channels] infoflow dropped duplicate message=${messageId}`);
      return;
    }
    this.onMessage?.(message);
    // The callback is the daemon's durable receipt boundary. Do not suppress a
    // platform redelivery until that receipt has completed successfully.
    if (dedupeKey) {
      this.seenMessages.set(dedupeKey, now);
      if (this.seenMessages.size > INFOFLOW_DEDUPE_CAPACITY) {
        const oldest = this.seenMessages.keys().next().value;
        if (oldest) this.seenMessages.delete(oldest);
      }
    }
  }

  private pruneSeenMessages(now: number): void {
    for (const [key, seenAt] of this.seenMessages) {
      if (now - seenAt < INFOFLOW_DEDUPE_TTL_MS) break;
      this.seenMessages.delete(key);
    }
  }
}

const INFOFLOW_DEDUPE_CAPACITY = 2_048;
const INFOFLOW_DEDUPE_TTL_MS = 10 * 60_000;

function parseInfoflowInbound(raw: unknown): InfoflowInboundRaw {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("infoflow inbound payload must be an object");
  }
  const record = raw as Record<string, unknown>;
  const userId = record.user_id;
  const text = record.text;
  if (typeof userId !== "string" || !userId.trim()) {
    throw new Error("infoflow inbound payload requires user_id");
  }
  if (typeof text !== "string") {
    throw new Error("infoflow inbound payload requires text");
  }
  // Prefer explicit chat_type from transport normalize; fall back to chat_id for fixtures.
  const resolvedType =
    record.chat_type === "private" || record.chat_type === "group"
      ? record.chat_type
      : typeof record.chat_id === "string" && record.chat_id.trim()
        ? "group"
        : "private";
  return {
    user_id: userId,
    text,
    chat_type: resolvedType,
    ...(typeof record.chat_id === "string" ? { chat_id: record.chat_id } : {}),
    ...(typeof record.message_id === "string" ? { message_id: record.message_id } : {}),
    ...(normalizeChannelMessageReference(record.message_reference)
      ? { message_reference: normalizeChannelMessageReference(record.message_reference) }
      : {}),
    ...(typeof record.event_type === "string" ? { event_type: record.event_type } : {}),
    ...(typeof record.content_type === "string" ? { content_type: record.content_type } : {}),
    ...(Array.isArray(record.attachments)
      ? {
          attachments: record.attachments.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
            const attachment = entry as Record<string, unknown>;
            if (
              attachment.kind !== "image" &&
              attachment.kind !== "file" &&
              attachment.kind !== "voice"
            ) {
              return [];
            }
            return [
              {
                kind: attachment.kind,
                ...(typeof attachment.name === "string" ? { name: attachment.name } : {}),
                ...(typeof attachment.mediaType === "string"
                  ? { mediaType: attachment.mediaType }
                  : {}),
                ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
                ...(typeof attachment.reference === "string"
                  ? { reference: attachment.reference }
                  : {}),
              },
            ];
          }),
        }
      : {}),
    ...(Array.isArray(record.images)
      ? {
          images: record.images.flatMap((entry) => {
            const image = normalizeChannelImage(entry);
            return image ? [image] : [];
          }),
        }
      : {}),
    ...(typeof record.sender_name === "string" ? { sender_name: record.sender_name } : {}),
    ...(Array.isArray(record.mentions)
      ? {
          mentions: record.mentions
            .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
            .map((entry) => entry.trim()),
        }
      : {}),
    ...(typeof record.mentioned_self === "boolean"
      ? { mentioned_self: record.mentioned_self }
      : {}),
  };
}

function createDefaultInfoflowTransport(config: InfoflowAdapterConfig): ChannelTransport {
  if (config.app_key?.trim() && config.app_secret?.trim() && config.app_agent_id?.trim()) {
    return createInfoflowTransport(config);
  }
  const error = "InfoflowAdapter requires app_key, app_secret, and app_agent_id";
  return {
    async start() {
      throw new Error(error);
    },
    async stop() {},
    async send() {
      throw channelDeliveryNotSent(new Error(error));
    },
    status() {
      return { state: "degraded", error };
    },
  };
}

function extractInfoflowMentionMeta(
  raw: unknown,
  config: InfoflowAdapterConfig,
): { mentions: string[]; mentionedSelf?: boolean } {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const message =
    record?.message && typeof record.message === "object" && !Array.isArray(record.message)
      ? (record.message as Record<string, unknown>)
      : null;
  const body = Array.isArray(message?.body)
    ? message.body
    : Array.isArray(record?.body)
      ? record.body
      : [];
  const mentions: string[] = [];
  const agentId = config.app_agent_id?.trim();
  let mentionedSelf: boolean | undefined =
    typeof record?.mentioned_self === "boolean" ? record.mentioned_self : undefined;
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const type = infoflowScalar(entry.type).toUpperCase();
    if (type !== "AT" && type !== "@") continue;
    const name = firstInfoflowScalar(entry.name, entry.userid, entry.robotid);
    if (name) mentions.push(name);
    const targetId = firstInfoflowScalar(entry.userid, entry.robotid, entry.atuserid);
    if (agentId && (targetId === agentId || name === agentId)) {
      mentionedSelf = true;
    }
  }
  return {
    mentions,
    ...(typeof mentionedSelf === "boolean" ? { mentionedSelf } : {}),
  };
}

function firstInfoflowScalar(...values: unknown[]): string {
  for (const value of values) {
    const normalized = infoflowScalar(value);
    if (normalized) return normalized;
  }
  return "";
}

function infoflowScalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
