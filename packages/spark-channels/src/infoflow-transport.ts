import {
  Client,
  LogLevel,
  Logger,
  WSClient,
  type EventMessage,
  type GetMessageOptions,
  type MessageDetail,
  type NormalizedEventData,
} from "@core-workspace/infoflow-sdk-nodejs";
import {
  materializeChannelImages,
  type ChannelImage,
  type ChannelImageHostnameLookup,
  type ChannelImageSource,
} from "./channel-images.ts";
import { normalizeInfoflowContent, type InfoflowAttachment } from "./infoflow-content.ts";
import { createInfoflowSdkOutbound, type InfoflowSdkOutbound } from "./infoflow-sdk-outbound.ts";
import type { ChannelInteractionCapability } from "./interaction.ts";
import { channelDeliveryNotSent, type ChannelDeliveryResult } from "./reply.ts";
import { scheduledReconnectDelayWithJitter } from "./reconnect-delay.ts";
import { renderTextChannelAskRequest } from "./text-ask.ts";
import type { ChannelConnectionState, ChannelTransport, InfoflowAdapterConfig } from "./types.ts";
import type { ChannelMessageReference } from "./message-reference.ts";

export const DEFAULT_INFOFLOW_API_HOST = "https://api.im.baidu.com";
/** Nykore/OpenClaw-aligned default gateway host for WS endpoint allocation. */
export const DEFAULT_INFOFLOW_WS_GATEWAY = "infoflow-open-gateway.baidu.com";
const INFOFLOW_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const DEFAULT_INFOFLOW_PONG_TIMEOUT_MS = 30_000;
const DEFAULT_INFOFLOW_CONNECT_TIMEOUT_MS = 45_000;
const INFOFLOW_IMAGE_DOWNLOAD_HOST = "apiin.im.baidu.com";
const INFOFLOW_IMAGE_DOWNLOAD_PATH = "/api/v2/im/images";

export interface InfoflowTransportOptions {
  outbound?: InfoflowSdkOutbound;
  /** Test seam for downloading platform-issued inbound image URLs. */
  fetchImpl?: typeof fetch;
  /** Test seam for platform media DNS policy. */
  lookupHostname?: ChannelImageHostnameLookup;
  /** Test seam for authenticated Infoflow image downloads. */
  getImageAccessToken?: () => Promise<string>;
  /**
   * Read-only history lookup used because private MIXED callbacks can collapse
   * to a text-only event while the message detail still contains face/image
   * blocks.
   */
  getMessageDetail?: (input: GetMessageOptions) => Promise<MessageDetail | undefined>;
  wsClientFactory?: () => WSClient;
  /** Test seam for the wrapper-owned connect recovery schedule. */
  reconnectDelaysMs?: readonly number[];
  /** Test seam for equal-jitter reconnect delays. */
  reconnectRandom?: () => number;
  /** Maximum wait for the pong corresponding to an SDK heartbeat ping. */
  pongTimeoutMs?: number;
  /** Application deadline covering endpoint allocation and WS handshake. */
  connectTimeoutMs?: number;
}

export function ensureHttpsHost(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_INFOFLOW_API_HOST;
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return trimmed;
  return `https://${trimmed}`;
}

export type InfoflowNormalizedInbound = {
  user_id: string;
  text: string;
  chat_type: "private" | "group";
  chat_id?: string;
  message_id?: string;
  message_reference?: ChannelMessageReference;
  event_type?: string;
  content_type?: string;
  attachments?: InfoflowAttachment[];
  images?: ChannelImage[];
  sender_name?: string;
  mentions?: string[];
  mentioned_self?: boolean;
};

/**
 * Infoflow transport aligned with nyakore:
 * - inbound via official `@core-workspace/infoflow-sdk-nodejs` WSClient
 * - ordinary outbound via the SDK MessageApi schema with a single provider attempt
 * - streaming cards via the official SDK Client lifecycle
 */
export function createInfoflowTransport(
  config: InfoflowAdapterConfig,
  options: InfoflowTransportOptions = {},
): ChannelTransport {
  const apiHost = ensureHttpsHost(config.endpoint ?? DEFAULT_INFOFLOW_API_HOST);
  const appKey = config.app_key?.trim() ?? "";
  const appSecret = config.app_secret?.trim() ?? "";
  const wsGateway = config.ws_gateway?.trim() || DEFAULT_INFOFLOW_WS_GATEWAY;
  const appAgentId = config.app_agent_id?.trim();
  const outbound = options.outbound ?? createInfoflowSdkOutbound(config);
  const historyClient =
    options.getMessageDetail || options.wsClientFactory || !appKey || !appSecret || !appAgentId
      ? undefined
      : new Client({
          appKey,
          appSecret,
          agentId: appAgentId,
          baseUrl: infoflowApiBaseUrl(apiHost),
          loggerLevel: LogLevel.warn,
        });
  const getMessageDetail =
    options.getMessageDetail ??
    (historyClient
      ? async (input: GetMessageOptions) => await historyClient.im.message.getMessage(input)
      : undefined);
  const getImageAccessToken =
    options.getImageAccessToken ??
    (historyClient
      ? async () => await historyClient.getTokenManager().getAccessToken()
      : undefined);

  let wsClient: WSClient | null = null;
  let onMessage: ((raw: unknown) => void) | null = null;
  let running = false;
  let connectionState: ChannelConnectionState = "stopped";
  let connectionError: string | undefined;
  let privateHandler: ((event: EventMessage<NormalizedEventData>) => void) | null = null;
  let groupHandler: ((event: EventMessage<NormalizedEventData>) => void) | null = null;
  let anyHandler: ((event: EventMessage<NormalizedEventData>) => void) | null = null;
  let heartbeatHandler: ((event: EventMessage<unknown>) => void) | null = null;
  let connectedHandler: ((event: EventMessage<unknown>) => void) | null = null;
  let disconnectedHandler: ((event: EventMessage<unknown>) => void) | null = null;
  let errorHandler: ((event: EventMessage<unknown>) => void) | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let connectionGeneration = 0;
  const pendingReceipts = new Set<Promise<void>>();
  const reconnectDelays =
    options.reconnectDelaysMs?.length === 0
      ? INFOFLOW_RECONNECT_DELAYS_MS
      : (options.reconnectDelaysMs ?? INFOFLOW_RECONNECT_DELAYS_MS);
  const reconnectRandom = options.reconnectRandom ?? Math.random;
  const pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_INFOFLOW_PONG_TIMEOUT_MS;
  if (!Number.isFinite(pongTimeoutMs) || pongTimeoutMs <= 0) {
    throw new Error("infoflow pongTimeoutMs must be a positive finite number");
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_INFOFLOW_CONNECT_TIMEOUT_MS;
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new Error("infoflow connectTimeoutMs must be a positive finite number");
  }

  async function sendOutbound(
    input: Parameters<InfoflowSdkOutbound["send"]>[0],
  ): Promise<ChannelDeliveryResult> {
    if (outbound.sendWithReceipt) return await outbound.sendWithReceipt(input);
    await outbound.send(input);
    return { replaySafety: "unsafe" };
  }

  async function send(recipient: string, text: string, deliveryId?: string) {
    return await sendOutbound({
      recipient,
      content: { type: "text", text },
      ...(deliveryId ? { deliveryId } : {}),
    });
  }

  /**
   * Infoflow has no native interactive cards/buttons. Project asks as Markdown
   * text; later user messages are correlated by the daemon pending-ask path.
   */
  const sentAskKeys = new Set<string>();
  const interaction: ChannelInteractionCapability = {
    async sendAsk(recipient, request) {
      const key = request.idempotencyKey?.trim();
      if (key && sentAskKeys.has(key)) {
        return {};
      }
      const text = renderTextChannelAskRequest(request);
      if (!text.trim()) {
        throw new Error("infoflow text ask prompt must not be empty");
      }
      const mentionUserIds =
        request.audience?.kind === "users" && /^group:/iu.test(recipient)
          ? [...request.audience.userIds]
          : undefined;
      await outbound.send({
        recipient,
        content: { type: "markdown", text },
        ...(mentionUserIds?.length ? { mentionUserIds } : {}),
      });
      if (key) sentAskKeys.add(key);
      return {};
    },
    async ackInteraction() {
      // Text asks have no platform interaction id to acknowledge.
    },
  };

  const image: NonNullable<ChannelTransport["image"]> = {
    async sendImage(input) {
      if (input.caption?.trim()) {
        throw channelDeliveryNotSent(
          new Error("infoflow image messages do not support an atomic text caption"),
        );
      }
      const [materialized] = await materializeChannelImages([input.image], {
        fetchImpl: options.fetchImpl,
      });
      if (!materialized) {
        throw channelDeliveryNotSent(new Error("infoflow image could not be materialized"));
      }
      return await sendOutbound({
        recipient: input.recipient,
        content: { type: "image", base64: materialized.data },
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
      });
    },
  };

  async function handleSdkEvent(event: EventMessage<NormalizedEventData>): Promise<void> {
    if (
      event.type === "connected" ||
      event.type === "disconnected" ||
      event.type === "error" ||
      event.type === "heartbeat"
    ) {
      return;
    }
    const callbackNormalized = normalizeInfoflowSdkEvent(event, { agentId: appAgentId });
    if (!callbackNormalized) {
      console.error(`[spark-channels] infoflow skipped sdk event type=${String(event.type ?? "")}`);
      return;
    }
    let normalized = callbackNormalized;
    let detailImageSources: ChannelImageSource[] = [];
    const detailRequest = infoflowMessageDetailRequest(callbackNormalized, appAgentId);
    if (detailRequest && getMessageDetail) {
      try {
        const detail = await getMessageDetail(detailRequest);
        if (detail) {
          const enriched = infoflowContentFromMessageDetail(detail);
          if (enriched?.text) {
            normalized = {
              ...callbackNormalized,
              text: enriched.text,
              content_type: enriched.contentType,
              ...(enriched.attachments.length ? { attachments: enriched.attachments } : {}),
              ...(enriched.messageReference
                ? { message_reference: enriched.messageReference }
                : {}),
              ...(enriched.mentions.length ? { mentions: enriched.mentions } : {}),
            };
          }
          detailImageSources = infoflowMessageDetailImageSources(detail);
        }
      } catch (error) {
        console.error(
          `[spark-channels] infoflow message detail unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    console.error(
      `[spark-channels] infoflow inbound ${normalized.chat_type}` +
        ` textChars=${normalized.text.length}` +
        (normalized.mentions?.length ? ` mentions=${JSON.stringify(normalized.mentions)}` : ""),
    );
    const imageSources = uniqueInfoflowImageSources([
      ...infoflowImageSources(event),
      ...detailImageSources,
    ]);
    if (imageSources.length === 0) {
      onMessage?.(normalized);
      return;
    }
    const images = await materializeChannelImages(imageSources, {
      fetchImpl: options.fetchImpl,
      lookupHostname: options.lookupHostname,
      isTrustedPrivateUrl: isAuthenticatedInfoflowImageUrl,
      ...(getImageAccessToken
        ? {
            requestHeaders: async (url: URL) =>
              isAuthenticatedInfoflowImageUrl(url)
                ? { Authorization: `Bearer-${await getImageAccessToken()}` }
                : undefined,
          }
        : {}),
      onError: (error) => {
        console.error(`[spark-channels] infoflow image skipped: ${error.message}`);
      },
    });
    onMessage?.({ ...normalized, ...(images.length ? { images } : {}) });
  }

  async function handleTrackedSdkEvent(event: EventMessage<NormalizedEventData>): Promise<void> {
    const operation = handleSdkEvent(event);
    pendingReceipts.add(operation);
    try {
      await operation;
    } finally {
      pendingReceipts.delete(operation);
    }
  }

  function clearReconnect(): void {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function clearPongDeadline(): void {
    if (!pongTimer) return;
    clearTimeout(pongTimer);
    pongTimer = null;
  }

  /**
   * Spark is the sole retry-policy owner. The SDK's server-provided finite
   * reconnect count cannot satisfy the daemon's always-on contract, so every
   * retryable connection episode is normalized into this infinite supervisor.
   */
  function scheduleWrapperReconnect(generation: number): void {
    if (!running || !wsClient || generation !== connectionGeneration) return;
    clearReconnect();
    const delay = scheduledReconnectDelayWithJitter(
      reconnectAttempt + 1,
      reconnectDelays,
      reconnectRandom,
    );
    reconnectAttempt += 1;
    connectionState = "reconnecting";
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const client = wsClient;
      if (!running || !client || generation !== connectionGeneration) return;
      void connectWithDeadline(client)
        .then(() => {
          if (!running || client !== wsClient || generation !== connectionGeneration) {
            try {
              client.disconnect();
            } catch {
              // ignore a connection that completed after stop/reconfiguration
            }
            return;
          }
          const state = infoflowConnectionState(client.getState(), running);
          if (state !== "connected") {
            scheduleWrapperReconnect(generation);
            return;
          }
          connectionState = state;
          connectionError = undefined;
          reconnectAttempt = 0;
          console.error("[spark-channels] infoflow supervised reconnect succeeded");
        })
        .catch((error: unknown) => {
          if (!running || client !== wsClient || generation !== connectionGeneration) return;
          connectionState = "degraded";
          connectionError = error instanceof Error ? error.message : String(error);
          console.error("[spark-channels] infoflow supervised reconnect failed", error);
          scheduleWrapperReconnect(generation);
        });
    }, delay);
  }

  async function connectWithDeadline(client: WSClient): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const operation = client.connect();
    void operation.catch(() => undefined);
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`infoflow websocket connect timed out after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([operation, deadline]);
    } catch (error) {
      if (timedOut) {
        try {
          client.disconnect();
        } catch {
          // best-effort cancellation for SDK versions without AbortSignal
        }
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function rejectDurableReceipt(error: unknown): void {
    clearPongDeadline();
    connectionState = "degraded";
    connectionError = error instanceof Error ? error.message : String(error);
    // The SDK catches listener errors and auto-ACKs after dispatch. Closing the
    // socket synchronously here makes that ACK a no-op; the supervised resume
    // then lets Infoflow redeliver the unacknowledged frame.
    try {
      wsClient?.disconnect();
    } catch (disconnectError) {
      console.error("[spark-channels] infoflow receipt disconnect failed", disconnectError);
    }
    scheduleWrapperReconnect(connectionGeneration);
  }

  async function start(handler: (raw: unknown) => void): Promise<void> {
    if (running) return;
    if (!appKey || !appSecret || !appAgentId) {
      throw new Error("Infoflow ingress requires app_key, app_secret, and app_agent_id");
    }
    onMessage = handler;
    running = true;
    const generation = ++connectionGeneration;
    connectionState = "connecting";
    connectionError = undefined;
    const logger = new Logger(LogLevel.info, "spark-infoflow");
    // Official SDK docs use appKey + autoRegister (default true). Older 0.1.7
    // connected for heartbeat but never called /imRobot/updateReCallUrl, so
    // private/group DATA frames were never pushed to this connection.
    wsClient =
      options.wsClientFactory?.() ??
      new WSClient({
        appKey,
        appSecret,
        baseUrl: apiHost,
        wsGateway,
        logger,
        loggerLevel: LogLevel.info,
        autoRegister: true,
        endpointTimeout: 30_000,
        maxReconnectAttempts: -1,
      });
    const client = wsClient;
    const isCurrentClient = () => client === wsClient && generation === connectionGeneration;
    const isActiveClient = () => running && isCurrentClient();
    privateHandler = async (event) => {
      if (!isActiveClient()) return;
      try {
        await handleTrackedSdkEvent(event);
      } catch (error) {
        console.error("[spark-channels] infoflow private handler failed", error);
        rejectDurableReceipt(error);
        throw error;
      }
    };
    groupHandler = async (event) => {
      if (!isActiveClient()) return;
      try {
        await handleTrackedSdkEvent(event);
      } catch (error) {
        console.error("[spark-channels] infoflow group handler failed", error);
        rejectDurableReceipt(error);
        throw error;
      }
    };
    anyHandler = (event: EventMessage<NormalizedEventData>) => {
      if (!isActiveClient()) return;
      const data = ((event as { data?: unknown }).data ?? event) as Record<string, unknown>;
      const raw = ((data.raw as unknown) ?? data) as Record<string, unknown>;
      const keys =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? Object.keys(raw).slice(0, 12).join(",")
          : "";
      console.error(
        `[spark-channels] infoflow sdk event type=${scalarString(event.type)}` +
          ` chatType=${scalarString(data.chatType)} keys=${keys}`,
      );
    };
    heartbeatHandler = (event: EventMessage<unknown>) => {
      if (!isActiveClient()) return;
      const data =
        event.data && typeof event.data === "object" && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};
      if (data.type === "pong") {
        clearPongDeadline();
        return;
      }
      if (data.type !== "ping") return;
      clearPongDeadline();
      pongTimer = setTimeout(() => {
        pongTimer = null;
        if (!isActiveClient()) return;
        const error = new Error(`infoflow websocket pong timed out after ${pongTimeoutMs}ms`);
        console.error(`[spark-channels] ${error.message}`);
        rejectDurableReceipt(error);
      }, pongTimeoutMs);
      pongTimer.unref?.();
    };
    wsClient.on("private.*", privateHandler);
    wsClient.on("group.*", groupHandler);
    wsClient.on("*", anyHandler);
    wsClient.on("heartbeat", heartbeatHandler);
    connectedHandler = () => {
      if (!isActiveClient()) return;
      clearPongDeadline();
      clearReconnect();
      reconnectAttempt = 0;
      connectionState = "connected";
      connectionError = undefined;
      console.error("[spark-channels] infoflow websocket connected");
    };
    disconnectedHandler = () => {
      if (!isCurrentClient()) return;
      clearPongDeadline();
      connectionState = running ? "reconnecting" : "stopped";
      console.error("[spark-channels] infoflow websocket disconnected");
      if (!running) return;
      // The SDK dispatches this event synchronously before starting its own
      // reconnect loop. Marking the disconnect as manual here prevents that
      // finite, server-configured loop from racing Spark's durable supervisor.
      try {
        client.disconnect();
      } catch (error) {
        console.error("[spark-channels] infoflow reconnect handoff failed", error);
      }
      scheduleWrapperReconnect(generation);
    };
    errorHandler = (event) => {
      if (!isActiveClient()) return;
      connectionState = "degraded";
      connectionError = infoflowEventError(event);
      console.error("[spark-channels] infoflow websocket error", event);
    };
    wsClient.on("connected", connectedHandler);
    wsClient.on("disconnected", disconnectedHandler);
    wsClient.on("error", errorHandler);
    // Arming the supervised connector is the startup boundary. A third-party
    // handshake cannot delay core daemon admission or successor readiness.
    void connectWithDeadline(client)
      .then(() => {
        if (!running || generation !== connectionGeneration) {
          try {
            client.disconnect();
          } catch {
            // stop may already have disconnected the in-flight SDK client
          }
          return;
        }
        connectionState = infoflowConnectionState(client.getState(), running);
        console.error("[spark-channels] infoflow websocket connect() resolved");
      })
      .catch((error: unknown) => {
        if (!running || generation !== connectionGeneration) return;
        connectionState = "degraded";
        connectionError = error instanceof Error ? error.message : String(error);
        console.error("[spark-channels] infoflow initial connect failed", error);
        scheduleWrapperReconnect(generation);
      });
  }

  async function stop(): Promise<void> {
    running = false;
    connectionGeneration += 1;
    clearReconnect();
    clearPongDeadline();
    reconnectAttempt = 0;
    connectionState = "stopped";
    connectionError = undefined;
    const stoppedHandler = onMessage;
    if (wsClient) {
      if (privateHandler) wsClient.off("private.*", privateHandler);
      if (groupHandler) wsClient.off("group.*", groupHandler);
      if (anyHandler) wsClient.off("*", anyHandler);
      if (heartbeatHandler) wsClient.off("heartbeat", heartbeatHandler);
      if (connectedHandler) wsClient.off("connected", connectedHandler);
      if (disconnectedHandler) wsClient.off("disconnected", disconnectedHandler);
      if (errorHandler) wsClient.off("error", errorHandler);
      privateHandler = null;
      groupHandler = null;
      anyHandler = null;
      heartbeatHandler = null;
      connectedHandler = null;
      disconnectedHandler = null;
      errorHandler = null;
      try {
        wsClient.disconnect();
      } catch {
        // ignore disconnect races
      }
      wsClient = null;
    }
    await Promise.allSettled([...pendingReceipts]);
    if (!running && onMessage === stoppedHandler) onMessage = null;
  }

  return {
    start,
    stop,
    send,
    messageDeliveryFacts: () => ({ replaySafety: "unsafe" }),
    reply: {
      deliveryFacts: () => ({ replaySafety: "unsafe" }),
      openReplyStream: async (target) => outbound.openReplyStream(target.recipient),
      sendReply: async (target) => {
        const mentionUserIds =
          target.senderId && /^group:/iu.test(target.recipient) ? [target.senderId] : undefined;
        return await sendOutbound({
          recipient: target.recipient,
          content: { type: "markdown", text: target.text },
          ...(target.deliveryId ? { deliveryId: target.deliveryId } : {}),
          ...(mentionUserIds ? { mentionUserIds } : {}),
        });
      },
      recoverReply: async (target) => {
        await outbound.recoverReply({
          recipient: target.recipient,
          text: target.text,
          recovery: target.recovery,
        });
      },
    },
    image,
    interaction,
    status: () => {
      const liveState = wsClient
        ? infoflowConnectionState(wsClient.getState(), running)
        : connectionState;
      return {
        state: connectionError ? "degraded" : liveState,
        ...(connectionError ? { error: connectionError } : {}),
      };
    },
  };
}

function infoflowApiBaseUrl(endpoint: string): string {
  return /\/api\/v\d+$/u.test(endpoint) ? endpoint : `${endpoint}/api/v1`;
}

function isAuthenticatedInfoflowImageUrl(url: URL): boolean {
  return (
    url.hostname.toLowerCase() === INFOFLOW_IMAGE_DOWNLOAD_HOST &&
    url.pathname === INFOFLOW_IMAGE_DOWNLOAD_PATH
  );
}

function infoflowMessageDetailRequest(
  inbound: InfoflowNormalizedInbound,
  agentId: string | undefined,
): GetMessageOptions | undefined {
  const msgId = inbound.message_id?.trim();
  if (!msgId) return undefined;
  if (inbound.chat_type === "group") {
    const receiverId = inbound.chat_id?.trim();
    if (!receiverId) return undefined;
    return { fromId: inbound.user_id, receiverId, receiverType: 2, msgId };
  }
  if (!agentId) return undefined;
  return { fromId: inbound.user_id, receiverId: agentId, receiverType: 7, msgId };
}

function infoflowContentFromMessageDetail(
  detail: MessageDetail,
): ReturnType<typeof normalizeInfoflowContent> | undefined {
  const source = detail.content;
  const content =
    source && typeof source === "object" && !Array.isArray(source) ? source : undefined;
  const body = Array.isArray(source)
    ? source
    : Array.isArray(content?.blocks)
      ? content.blocks
      : Array.isArray(content?.body)
        ? content.body
        : Array.isArray(content?.items)
          ? content.items
          : undefined;
  const normalized = normalizeInfoflowContent({
    messageType: detail.subType || detail.msgType,
    ...(body ? { body } : { content: source }),
  });
  return normalized.text ? normalized : undefined;
}

function infoflowMessageDetailImageSources(detail: MessageDetail): ChannelImageSource[] {
  const content =
    detail.content && typeof detail.content === "object" && !Array.isArray(detail.content)
      ? detail.content
      : undefined;
  const body = Array.isArray(detail.content)
    ? detail.content
    : Array.isArray(content?.blocks)
      ? content.blocks
      : Array.isArray(content?.body)
        ? content.body
        : Array.isArray(content?.items)
          ? content.items
          : [];
  return infoflowImageSources({ body });
}

function uniqueInfoflowImageSources(sources: ChannelImageSource[]): ChannelImageSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = "url" in source ? `url:${source.url}` : `data:${source.data}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extract temporary image sources without copying them into normalized metadata. */
export function infoflowImageSources(
  event: EventMessage<NormalizedEventData> | Record<string, unknown>,
): ChannelImageSource[] {
  const data = ((event as { data?: unknown }).data ?? event) as Record<string, unknown>;
  const raw = ((data.raw as unknown) ?? data) as Record<string, unknown>;
  const message =
    raw.message && typeof raw.message === "object" && !Array.isArray(raw.message)
      ? (raw.message as Record<string, unknown>)
      : undefined;
  const body = Array.isArray(message?.body)
    ? message.body
    : Array.isArray(raw.body)
      ? raw.body
      : Array.isArray(data.body)
        ? data.body
        : [];
  const bodySources = body.flatMap((entry) => infoflowImageSource(entry));
  if (bodySources.length > 0) return bodySources;

  const messageType = scalarString(
    data.msgType ?? raw.MsgType ?? raw.msgType ?? raw.msgtype ?? (event as { type?: unknown }).type,
  ).toLowerCase();
  if (!messageType.includes("image")) return [];
  return infoflowImageSource(raw.Content ?? raw.content ?? data.content);
}

function infoflowImageSource(value: unknown): ChannelImageSource[] {
  const parsed = parseInfoflowImageContent(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  const type = scalarString(record.type).toLowerCase();
  if (type && type !== "image" && type !== "img") return [];
  const url = scalarString(
    record.downloadurl ?? record.downloadUrl ?? record.download_url ?? record.url,
  ).trim();
  const rawData = scalarString(record.content ?? record.base64 ?? record.data).trim();
  const data = rawData.startsWith("data:image/") || looksLikeImageBase64(rawData) ? rawData : "";
  if (!url && !data) return [];
  const mediaType = scalarString(
    record.mimeType ?? record.mimetype ?? record.mediaType ?? record.imageType ?? record.fileType,
  ).trim();
  const name = scalarString(
    record.fileName ?? record.filename ?? record.name ?? record.imageName,
  ).trim();
  const sizeValue = record.size ?? record.fileSize;
  const size =
    typeof sizeValue === "number" && Number.isFinite(sizeValue) && sizeValue >= 0
      ? sizeValue
      : undefined;
  return [
    {
      ...(url ? { url } : { data }),
      mediaType: mediaType || imageMediaTypeFromDataUrl(data) || "image/jpeg",
      ...(name ? { name } : {}),
      ...(size !== undefined ? { size } : {}),
    },
  ];
}

function parseInfoflowImageContent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { content: value };
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { content: value };
  }
}

function looksLikeImageBase64(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9+/=_-]+$/u.test(value);
}

function imageMediaTypeFromDataUrl(value: string): string | undefined {
  return /^data:([^;,]+);base64,/iu.exec(value)?.[1];
}

function infoflowConnectionState(state: string, running: boolean): ChannelConnectionState {
  if (state === "connected" || state === "connecting" || state === "reconnecting") return state;
  return running ? "reconnecting" : "stopped";
}

function infoflowEventError(event: unknown): string {
  if (event instanceof Error) return event.message;
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const record = event as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (record.data instanceof Error) return record.data.message;
  }
  return "Infoflow websocket error";
}

function scalarString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

/** Convert SDK event → Spark transport raw shape expected by InfoflowAdapter. */
export function normalizeInfoflowSdkEvent(
  event: EventMessage<NormalizedEventData>,
  options: { agentId?: string } = {},
): InfoflowNormalizedInbound | null {
  const data = ((event as { data?: unknown }).data ?? event) as Record<string, unknown>;
  const raw = ((data.raw as unknown) ?? data) as Record<string, unknown>;
  const message =
    raw.message && typeof raw.message === "object" && !Array.isArray(raw.message)
      ? (raw.message as Record<string, unknown>)
      : null;
  const chatType =
    data.chatType === "private" || data.chatType === "group"
      ? data.chatType
      : raw.groupid != null || raw.groupId != null || message?.header
        ? "group"
        : raw.FromUserId != null || raw.fromUserId != null || raw.Content != null
          ? "private"
          : undefined;
  if (chatType === "private") {
    const userId = scalarString(raw.FromUserId ?? raw.fromUserId ?? raw.fromuserid).trim();
    const content = normalizeInfoflowContent({
      messageType: scalarString(
        data.msgType ?? raw.MsgType ?? raw.msgType ?? raw.msgtype ?? event.type ?? "text",
      ),
      content: raw.Content ?? raw.content ?? data.content,
    });
    const text = content.text;
    if (!userId || !text) return null;
    const messageId = raw.MsgId ?? raw.msgId ?? raw.MsgId2 ?? raw.msgid2;
    const senderName = raw.FromUserName ?? raw.fromUserName ?? raw.fromusername;
    const eventType = raw.eventtype ?? raw.eventType;
    return {
      user_id: userId,
      text,
      chat_type: "private",
      ...(messageId != null ? { message_id: scalarString(messageId) } : {}),
      ...(content.messageReference ? { message_reference: content.messageReference } : {}),
      ...(eventType != null ? { event_type: scalarString(eventType) } : {}),
      ...(content.contentType ? { content_type: content.contentType } : {}),
      ...(content.attachments.length > 0 ? { attachments: content.attachments } : {}),
      ...(typeof senderName === "string" && senderName.trim()
        ? { sender_name: senderName.trim() }
        : {}),
    };
  }
  if (chatType === "group") {
    const header =
      message?.header && typeof message.header === "object" && !Array.isArray(message.header)
        ? (message.header as Record<string, unknown>)
        : {};
    const groupId = scalarString(raw.groupid ?? raw.groupId ?? header.toid).trim();
    const userId = scalarString(
      header.fromuserid ??
        header.fromUserId ??
        message?.FromUserId ??
        message?.fromUserId ??
        message?.fromuserid ??
        raw.fromUserId ??
        raw.fromuserid ??
        raw.fromid,
    ).trim();
    const body = Array.isArray(message?.body)
      ? message.body
      : Array.isArray(raw.body)
        ? raw.body
        : Array.isArray(data.body)
          ? data.body
          : [];
    const content = normalizeInfoflowContent({
      messageType: scalarString(header.msgtype ?? data.msgType ?? event.type ?? "mixed"),
      body,
      content: data.content,
    });
    const mentionedSelf = detectInfoflowMentionedSelf(raw, header, body, options.agentId);
    const text = content.text;
    if (!groupId || !userId || !text) return null;
    const messageId = header.messageid ?? header.msgid ?? header.clientmsgid ?? raw.msgid2;
    const senderName =
      header.fromusername ??
      header.fromUserName ??
      message?.FromUserName ??
      message?.fromUserName ??
      message?.fromusername ??
      raw.fromUserName ??
      raw.fromusername;
    const eventType = raw.eventtype ?? raw.eventType;
    return {
      user_id: userId,
      text,
      chat_type: "group",
      chat_id: groupId,
      ...(messageId != null ? { message_id: scalarString(messageId) } : {}),
      ...(content.messageReference ? { message_reference: content.messageReference } : {}),
      ...(eventType != null ? { event_type: scalarString(eventType) } : {}),
      ...(content.contentType ? { content_type: content.contentType } : {}),
      ...(content.attachments.length > 0 ? { attachments: content.attachments } : {}),
      ...(typeof senderName === "string" && senderName.trim()
        ? { sender_name: senderName.trim() }
        : {}),
      ...(content.mentions.length > 0 ? { mentions: content.mentions } : {}),
      ...(typeof mentionedSelf === "boolean" ? { mentioned_self: mentionedSelf } : {}),
    };
  }
  return null;
}

/**
 * Build readable text from Infoflow MIXED body parts.
 * AT segments must become `@name` — dropping them leaves holes like `你和 什么关系？`.
 */
export function extractInfoflowBodyContent(body: unknown): {
  text: string;
  mentions: string[];
} {
  if (!Array.isArray(body)) return { text: "", mentions: [] };
  const content = normalizeInfoflowContent({ messageType: "mixed", body });
  return { text: content.text, mentions: content.mentions };
}

/** Fixture/helper normalizer for flat or group payloads (unit tests + FakeChannelTransport). */
export function normalizeInfoflowInbound(
  payload: Record<string, unknown>,
  options: { agentId?: string } = {},
): InfoflowNormalizedInbound | null {
  const groupId = payload.groupid ?? payload.groupId;
  if (groupId != null && payload.message && typeof payload.message === "object") {
    return normalizeInfoflowSdkEvent(
      {
        type: "group.text",
        data: {
          chatType: "group",
          msgType: "text",
          raw: payload,
        },
        timestamp: Date.now(),
      } as EventMessage<NormalizedEventData>,
      options,
    );
  }

  const userId = scalarString(
    payload.FromUserId ??
      payload.fromUserId ??
      payload.fromuserid ??
      payload.from ??
      payload.user_id,
  ).trim();
  const content = normalizeInfoflowContent({
    messageType: scalarString(payload.MsgType ?? payload.msgType ?? payload.msgtype ?? "text"),
    content: payload.Content ?? payload.content ?? payload.Text ?? payload.text ?? payload.mes,
  });
  const text = content.text;
  if (!userId || !text) return null;
  const messageId = payload.MsgId ?? payload.msgid ?? payload.messageid;
  const eventType = payload.eventtype ?? payload.eventType;
  const senderName =
    payload.FromUserName ?? payload.fromUserName ?? payload.fromusername ?? payload.sender_name;
  return {
    user_id: userId,
    text,
    chat_type: "private",
    ...(messageId != null ? { message_id: scalarString(messageId) } : {}),
    ...(content.messageReference ? { message_reference: content.messageReference } : {}),
    ...(eventType != null ? { event_type: scalarString(eventType) } : {}),
    ...(content.contentType ? { content_type: content.contentType } : {}),
    ...(content.attachments.length > 0 ? { attachments: content.attachments } : {}),
    ...(typeof senderName === "string" && senderName.trim()
      ? { sender_name: senderName.trim() }
      : {}),
  };
}

function detectInfoflowMentionedSelf(
  raw: Record<string, unknown>,
  header: Record<string, unknown>,
  body: unknown[],
  agentId: string | undefined,
): boolean | undefined {
  const explicit = raw.mentioned_self ?? raw.mentionedSelf;
  if (typeof explicit === "boolean") return explicit;

  const expectedAgentId = agentId?.trim();
  if (!expectedAgentId) return undefined;
  const directTargets: string[] = [];
  let hasRobotMention = false;
  for (const item of body) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const type = scalarString(entry.type).trim().toUpperCase();
    if (type !== "AT" && type !== "@") continue;
    const robotId = scalarString(entry.robotid ?? entry.robotId).trim();
    if (robotId) hasRobotMention = true;
    const target = scalarString(
      entry.userid ?? entry.userId ?? entry.robotid ?? entry.robotId ?? entry.atuserid,
    ).trim();
    if (target) directTargets.push(target);
  }
  if (directTargets.includes(expectedAgentId)) return true;

  const at =
    header.at && typeof header.at === "object" && !Array.isArray(header.at)
      ? (header.at as Record<string, unknown>)
      : null;
  const robotTargets = Array.isArray(at?.atrobotids)
    ? at.atrobotids.map((value) => scalarString(value).trim()).filter(Boolean)
    : [];
  if (robotTargets.includes(expectedAgentId)) return true;

  // Infoflow uses different ids for an app agent and its robot account. When
  // this event is routed to the configured agent, a robot AT in the body is the
  // remaining reliable signal that the bot itself was mentioned.
  const routedAgentId = scalarString(raw.targetAgentId ?? raw.agentid).trim();
  return routedAgentId === expectedAgentId && (hasRobotMention || robotTargets.length > 0)
    ? true
    : undefined;
}
