import { createChannelExternalKey, createDefaultChannelExternalKey } from "./external-key.ts";
import type {
  ChannelInteractionCapability,
  ChannelInteractionEvent,
  RoutedChannelInteractionEvent,
} from "./interaction.ts";
import { isQqbotInboundAllowed } from "./qqbot-policy.ts";
import { createQqbotTransport } from "./qqbot-transport.ts";
import type { QqbotNormalizedInbound } from "./qqbot-types.ts";
import type {
  ChannelAdapter,
  ChannelTransport,
  IncomingMessage,
  QqbotAdapterConfig,
} from "./types.ts";
import type { ChannelReplyCapability } from "./reply.ts";

export interface QqbotAdapterOptions {
  id: string;
  config: QqbotAdapterConfig;
  transport?: ChannelTransport;
  onMessage?: (message: IncomingMessage) => void;
  onInteraction?: (event: RoutedChannelInteractionEvent) => void | Promise<void>;
}

export class QqbotAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = "qqbot" as const;
  readonly config: QqbotAdapterConfig;
  private readonly transport: ChannelTransport;
  private readonly onMessage?: (message: IncomingMessage) => void;
  private readonly onInteraction?: (event: RoutedChannelInteractionEvent) => void | Promise<void>;
  private readonly seenMessages = new Map<string, number>();
  private running = false;

  get reply(): ChannelReplyCapability | undefined {
    return this.transport.reply;
  }

  get interaction(): ChannelInteractionCapability | undefined {
    return this.transport.interaction;
  }

  constructor(options: QqbotAdapterOptions) {
    this.id = options.id;
    this.config = options.config;
    this.onMessage = options.onMessage;
    this.onInteraction = options.onInteraction;
    this.transport = options.transport ?? createDefaultQqbotTransport(options.config);
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.transport.start(
      (raw) => this.handleInbound(raw),
      (event) => this.handleInteraction(event),
    );
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.transport.stop();
    this.running = false;
  }

  async send(input: { recipient: string; text: string }): Promise<void> {
    await this.transport.send(input.recipient, input.text);
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

  parseInbound(raw: unknown): IncomingMessage | undefined {
    const normalized = normalizeQqbotInboundEvent(raw);
    if (!normalized) return undefined;
    if (
      !isQqbotInboundAllowed(this.config, {
        chatType: normalized.chatType,
        senderId: normalized.senderId,
        ...(normalized.chatId ? { groupId: normalized.chatId } : {}),
        text: normalized.text,
        ...(normalized.eventType ? { eventType: normalized.eventType } : {}),
        ...(typeof normalized.mentionedSelf === "boolean"
          ? { mentionedSelf: normalized.mentionedSelf }
          : {}),
      })
    ) {
      return undefined;
    }
    if (isDuplicateMessage(this.seenMessages, normalized.messageId)) {
      return undefined;
    }

    const externalKey =
      normalized.chatType === "group" && normalized.chatId
        ? createChannelExternalKey("qqbot", "group", normalized.chatId)
        : normalized.chatType === "channel" && normalized.chatId
          ? createChannelExternalKey("qqbot", "channel", normalized.chatId)
          : createDefaultChannelExternalKey("qqbot", normalized.senderId);

    return {
      adapter: "qqbot",
      externalKey,
      senderId: normalized.senderId,
      ...(normalized.senderName ? { senderName: normalized.senderName } : {}),
      ...(normalized.chatId ? { chatId: normalized.chatId } : {}),
      text: normalized.text,
      ...(normalized.messageId ? { messageId: normalized.messageId } : {}),
      ...(normalized.eventType ? { eventType: normalized.eventType } : {}),
      contentType: "text",
      ...(normalized.mentions?.length ? { mentions: normalized.mentions } : {}),
      ...(typeof normalized.mentionedSelf === "boolean"
        ? { mentionedSelf: normalized.mentionedSelf }
        : {}),
      raw,
    };
  }

  private handleInbound(raw: unknown): void {
    try {
      const message = this.parseInbound(raw);
      if (!message) return;
      this.onMessage?.(message);
    } catch (error) {
      console.error("[spark-channels] qqbot inbound parse failed", error);
    }
  }

  private handleInteraction(event: ChannelInteractionEvent): void {
    try {
      const handled = this.onInteraction?.({ ...event, adapterId: this.id });
      if (handled) {
        void handled.catch((error: unknown) => {
          console.error("[spark-channels] qqbot interaction handler failed", error);
        });
      }
    } catch (error) {
      console.error("[spark-channels] qqbot interaction handler failed", error);
    }
  }
}

function createDefaultQqbotTransport(config: QqbotAdapterConfig): ChannelTransport {
  return createQqbotTransport(config);
}

export function normalizeQqbotInboundEvent(raw: unknown): QqbotNormalizedInbound | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const eventType =
    typeof record.event_type === "string"
      ? record.event_type.trim()
      : typeof record.t === "string"
        ? record.t.trim()
        : "";
  const payload =
    record.d && typeof record.d === "object" && !Array.isArray(record.d)
      ? (record.d as Record<string, unknown>)
      : record;

  if (
    eventType === "C2C_MESSAGE_CREATE" ||
    (!eventType && payload.author && !payload.group_openid)
  ) {
    const author = asRecord(payload.author);
    const senderId =
      stringField(author, "user_openid") ||
      stringField(author, "union_openid") ||
      stringField(author, "id");
    const text = stringField(payload, "content") ?? "";
    const messageId = stringField(payload, "id");
    if (!senderId) return undefined;
    return {
      chatType: "c2c",
      senderId,
      ...(stringField(author, "username") ? { senderName: stringField(author, "username") } : {}),
      text: stripBotMention(text),
      ...(messageId ? { messageId } : {}),
      eventType: eventType || "C2C_MESSAGE_CREATE",
    };
  }

  if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MESSAGE_CREATE") {
    const author = asRecord(payload.author);
    const senderId =
      stringField(author, "member_openid") ||
      stringField(author, "user_openid") ||
      stringField(author, "id");
    const groupId = stringField(payload, "group_openid") || stringField(payload, "group_id");
    const text = stringField(payload, "content") ?? "";
    const messageId = stringField(payload, "id");
    const mentions = extractMentions(payload.mentions);
    const mentionedSelf =
      eventType === "GROUP_AT_MESSAGE_CREATE" || mentions.some((entry) => entry.isYou) || undefined;
    if (!senderId || !groupId) return undefined;
    return {
      chatType: "group",
      senderId,
      ...(stringField(author, "username") ? { senderName: stringField(author, "username") } : {}),
      chatId: groupId,
      text: stripBotMention(text),
      ...(messageId ? { messageId } : {}),
      eventType,
      ...(mentions.length
        ? { mentions: mentions.map((entry) => entry.label).filter(Boolean) }
        : {}),
      ...(typeof mentionedSelf === "boolean" ? { mentionedSelf } : {}),
    };
  }

  if (eventType === "AT_MESSAGE_CREATE" || eventType === "MESSAGE_CREATE") {
    const author = asRecord(payload.author);
    const senderId = stringField(author, "id");
    const channelId = stringField(payload, "channel_id");
    const text = stringField(payload, "content") ?? "";
    const messageId = stringField(payload, "id");
    if (!senderId || !channelId) return undefined;
    return {
      chatType: "channel",
      senderId,
      ...(stringField(author, "username") ? { senderName: stringField(author, "username") } : {}),
      chatId: channelId,
      text: stripBotMention(text),
      ...(messageId ? { messageId } : {}),
      eventType,
      mentionedSelf: eventType === "AT_MESSAGE_CREATE" ? true : undefined,
    };
  }

  return undefined;
}

function extractMentions(value: unknown): Array<{ label: string; isYou: boolean }> {
  if (!Array.isArray(value)) return [];
  const mentions: Array<{ label: string; isYou: boolean }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const label =
      stringField(record, "nickname") ||
      stringField(record, "member_openid") ||
      stringField(record, "user_openid") ||
      stringField(record, "id") ||
      "";
    mentions.push({
      label,
      isYou: record.is_you === true || record.bot === true,
    });
  }
  return mentions;
}

function stripBotMention(text: string): string {
  return text
    .replace(/<@!?\d+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isDuplicateMessage(seen: Map<string, number>, messageId?: string): boolean {
  if (!messageId?.trim()) return false;
  const now = Date.now();
  for (const [id, at] of seen) {
    if (now - at > 5 * 60 * 1000) seen.delete(id);
  }
  if (seen.has(messageId)) return true;
  seen.set(messageId, now);
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
