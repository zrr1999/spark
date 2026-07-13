import {
  LogLevel,
  Logger,
  WSClient,
  type EventMessage,
  type NormalizedEventData,
} from "@core-workspace/infoflow-sdk-nodejs";
import { normalizeInfoflowContent, type InfoflowAttachment } from "./infoflow-content.ts";
import { createInfoflowSdkOutbound, type InfoflowSdkOutbound } from "./infoflow-sdk-outbound.ts";
import type { ChannelConnectionState, ChannelTransport, InfoflowAdapterConfig } from "./types.ts";

export const DEFAULT_INFOFLOW_API_HOST = "https://api.im.baidu.com";
/** Nykore/OpenClaw-aligned default gateway host for WS endpoint allocation. */
export const DEFAULT_INFOFLOW_WS_GATEWAY = "infoflow-open-gateway.baidu.com";

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
  event_type?: string;
  content_type?: string;
  attachments?: InfoflowAttachment[];
  sender_name?: string;
  mentions?: string[];
  mentioned_self?: boolean;
};

/**
 * Infoflow transport aligned with nyakore:
 * - inbound via official `@core-workspace/infoflow-sdk-nodejs` WSClient
 * - outbound via official SDK Client/TokenManager/InfoFlowError
 */
export function createInfoflowTransport(
  config: InfoflowAdapterConfig,
  options: { outbound?: InfoflowSdkOutbound; wsClientFactory?: () => WSClient } = {},
): ChannelTransport {
  const apiHost = ensureHttpsHost(config.endpoint ?? DEFAULT_INFOFLOW_API_HOST);
  const appKey = config.app_key?.trim() ?? "";
  const appSecret = config.app_secret?.trim() ?? "";
  const wsGateway = config.ws_gateway?.trim() || DEFAULT_INFOFLOW_WS_GATEWAY;
  const appAgentId = config.app_agent_id?.trim();
  const outbound = options.outbound ?? createInfoflowSdkOutbound(config);

  let wsClient: WSClient | null = null;
  let onMessage: ((raw: unknown) => void) | null = null;
  let running = false;
  let connectionState: ChannelConnectionState = "stopped";
  let connectionError: string | undefined;
  let privateHandler: ((event: EventMessage<NormalizedEventData>) => void) | null = null;
  let groupHandler: ((event: EventMessage<NormalizedEventData>) => void) | null = null;
  let anyHandler: ((event: EventMessage<NormalizedEventData>) => void) | null = null;

  async function send(recipient: string, text: string): Promise<void> {
    await outbound.send({ recipient, content: { type: "text", text } });
  }

  function handleSdkEvent(event: EventMessage<NormalizedEventData>): void {
    if (
      event.type === "connected" ||
      event.type === "disconnected" ||
      event.type === "error" ||
      event.type === "heartbeat"
    ) {
      return;
    }
    const normalized = normalizeInfoflowSdkEvent(event, { agentId: appAgentId });
    if (!normalized) {
      console.error(`[spark-channels] infoflow skipped sdk event type=${String(event.type ?? "")}`);
      return;
    }
    console.error(
      `[spark-channels] infoflow inbound ${normalized.chat_type}` +
        ` textChars=${normalized.text.length}` +
        (normalized.mentions?.length ? ` mentions=${JSON.stringify(normalized.mentions)}` : ""),
    );
    onMessage?.(normalized);
  }

  async function start(handler: (raw: unknown) => void): Promise<void> {
    if (running) return;
    if (!appKey || !appSecret || !appAgentId) {
      throw new Error("Infoflow ingress requires app_key, app_secret, and app_agent_id");
    }
    onMessage = handler;
    running = true;
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
      });
    privateHandler = (event) => {
      try {
        handleSdkEvent(event);
      } catch (error) {
        console.error("[spark-channels] infoflow private handler failed", error);
      }
    };
    groupHandler = (event) => {
      try {
        handleSdkEvent(event);
      } catch (error) {
        console.error("[spark-channels] infoflow group handler failed", error);
      }
    };
    anyHandler = (event: EventMessage<NormalizedEventData>) => {
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
    wsClient.on("private.*", privateHandler);
    wsClient.on("group.*", groupHandler);
    wsClient.on("*", anyHandler);
    wsClient.on("connected", () => {
      connectionState = "connected";
      connectionError = undefined;
      console.error("[spark-channels] infoflow websocket connected");
    });
    wsClient.on("disconnected", () => {
      connectionState = running ? "reconnecting" : "stopped";
      console.error("[spark-channels] infoflow websocket disconnected");
    });
    wsClient.on("error", (event) => {
      connectionState = "degraded";
      connectionError = infoflowEventError(event);
      console.error("[spark-channels] infoflow websocket error", event);
    });
    try {
      await wsClient.connect();
      connectionState = infoflowConnectionState(wsClient.getState(), running);
      console.error("[spark-channels] infoflow websocket connect() resolved");
    } catch (error) {
      running = false;
      connectionState = "degraded";
      connectionError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async function stop(): Promise<void> {
    running = false;
    connectionState = "stopped";
    connectionError = undefined;
    onMessage = null;
    if (wsClient) {
      if (privateHandler) wsClient.off("private.*", privateHandler);
      if (groupHandler) wsClient.off("group.*", groupHandler);
      if (anyHandler) wsClient.off("*", anyHandler);
      privateHandler = null;
      groupHandler = null;
      anyHandler = null;
      try {
        wsClient.disconnect();
      } catch {
        // ignore disconnect races
      }
      wsClient = null;
    }
  }

  return {
    start,
    stop,
    send,
    reply: {
      openReplyStream: async (target) => outbound.openReplyStream(target.recipient),
      sendReply: async (target) => {
        const mentionUserIds =
          target.senderId && /^group:/iu.test(target.recipient) ? [target.senderId] : undefined;
        await outbound.send({
          recipient: target.recipient,
          content: { type: "markdown", text: target.text },
          ...(mentionUserIds ? { mentionUserIds } : {}),
        });
      },
    },
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
