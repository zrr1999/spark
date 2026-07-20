import { createDefaultChannelExternalKey } from "./external-key.ts";
import type {
  ChannelAdapter,
  ChannelTransport,
  FeishuAdapterConfig,
  FeishuInboundRaw,
  IncomingMessage,
} from "./types.ts";
import {
  channelDeliveryNotSent,
  normalizeChannelDeliveryResult,
  type ChannelDeliveryFacts,
  type ChannelDeliveryResult,
  type ChannelMessageTarget,
} from "./reply.ts";

export interface FeishuAdapterOptions {
  id: string;
  config: FeishuAdapterConfig;
  transport?: ChannelTransport;
  onMessage?: (message: IncomingMessage) => void;
}

export class FeishuAdapter implements ChannelAdapter {
  readonly id: string;
  readonly type = "feishu" as const;
  readonly config: FeishuAdapterConfig;
  readonly runtimeCapable: boolean;
  private readonly transport: ChannelTransport;
  private readonly onMessage?: (message: IncomingMessage) => void;
  private running = false;

  constructor(options: FeishuAdapterOptions) {
    this.id = options.id;
    this.config = options.config;
    this.runtimeCapable = options.transport !== undefined;
    this.onMessage = options.onMessage;
    this.transport = options.transport ?? createDefaultFeishuTransport(options.config);
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
    const payload = parseFeishuInbound(raw);
    const chatId = payload.chat_id.trim();
    return {
      adapter: "feishu",
      externalKey: createDefaultChannelExternalKey("feishu", chatId),
      senderId: payload.sender_id,
      chatId,
      text: payload.text,
      messageId: payload.message_id,
      raw,
    };
  }

  private handleInbound(raw: unknown): void {
    const message = this.parseInbound(raw);
    this.onMessage?.(message);
  }
}

function parseFeishuInbound(raw: unknown): FeishuInboundRaw {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("feishu inbound payload must be an object");
  }
  const record = raw as Record<string, unknown>;
  const chatId = record.chat_id;
  const text = record.text;
  if (typeof chatId !== "string" || !chatId.trim()) {
    throw new Error("feishu inbound payload requires chat_id");
  }
  if (typeof text !== "string") {
    throw new Error("feishu inbound payload requires text");
  }
  return {
    chat_id: chatId,
    text,
    ...(typeof record.sender_id === "string" ? { sender_id: record.sender_id } : {}),
    ...(typeof record.message_id === "string" ? { message_id: record.message_id } : {}),
  };
}

function createDefaultFeishuTransport(config: FeishuAdapterConfig): ChannelTransport {
  void config;
  const unavailable =
    "Feishu transport is not implemented; inject a concrete transport before enabling it";
  return {
    async start() {
      // Production wiring loads @larksuiteoapi/node-sdk via dynamic import here.
    },
    async stop() {},
    async send() {
      throw channelDeliveryNotSent(new Error(unavailable));
    },
    status() {
      return { state: "degraded", error: unavailable };
    },
  };
}
