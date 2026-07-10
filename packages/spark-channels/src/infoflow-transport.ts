import { createHash, randomUUID } from "node:crypto";
import {
  LogLevel,
  Logger,
  WSClient,
  type EventMessage,
  type NormalizedEventData,
} from "@core-workspace/infoflow-sdk-nodejs";
import type { ChannelTransport, InfoflowAdapterConfig } from "./types.ts";

export const DEFAULT_INFOFLOW_API_HOST = "https://api.im.baidu.com";
/** Nykore/OpenClaw-aligned default gateway host for WS endpoint allocation. */
export const DEFAULT_INFOFLOW_WS_GATEWAY = "infoflow-open-gateway.baidu.com";

const TOKEN_PATH = "/api/v1/auth/app_access_token";
const PRIVATE_SEND_PATH = "/api/v1/app/message/send";
const GROUP_SEND_PATH = "/api/v1/robot/msg/groupmsgsend";

export function signInfoflowAppSecret(appSecret: string): string {
  return createHash("md5").update(appSecret).digest("hex").toLowerCase();
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
  sender_name?: string;
};

/**
 * Infoflow transport aligned with nyakore:
 * - inbound via official `@core-workspace/infoflow-sdk-nodejs` WSClient
 * - outbound via direct HTTP (same token/send paths as nyakore's infoflow-direct)
 */
export function createInfoflowTransport(
  config: InfoflowAdapterConfig,
  options: { fetchImpl?: typeof fetch } = {},
): ChannelTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiHost = ensureHttpsHost(config.endpoint ?? DEFAULT_INFOFLOW_API_HOST);
  const appKey = config.app_key?.trim() ?? "";
  const appSecret = config.app_secret?.trim() ?? "";
  const wsGateway = config.ws_gateway?.trim() || DEFAULT_INFOFLOW_WS_GATEWAY;
  const appAgentId = config.app_agent_id?.trim();

  let tokenCache: { token: string; expireAt: number } | null = null;
  let refreshPromise: Promise<string> | null = null;
  let wsClient: WSClient | null = null;
  let onMessage: ((raw: unknown) => void) | null = null;
  let running = false;
  let privateHandler: ((event: EventMessage<NormalizedEventData>) => void) | null = null;
  let groupHandler: ((event: EventMessage<NormalizedEventData>) => void) | null = null;
  let anyHandler: ((event: EventMessage<NormalizedEventData>) => void) | null = null;

  async function getToken(): Promise<string> {
    if (!appKey || !appSecret) {
      throw new Error("Infoflow transport requires app_key and app_secret");
    }
    if (tokenCache && Date.now() < tokenCache.expireAt - 5 * 60_000) {
      return tokenCache.token;
    }
    if (refreshPromise) return await refreshPromise;
    refreshPromise = fetchToken();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function fetchToken(): Promise<string> {
    const response = await fetchImpl(`${apiHost}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_key: appKey,
        app_secret: signInfoflowAppSecret(appSecret),
      }),
    });
    const text = await response.text();
    let data: {
      code?: string;
      message?: string;
      errmsg?: string;
      data?: { app_access_token?: string; expire?: number };
    };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new Error(`Infoflow token response was not JSON (HTTP ${response.status})`);
    }
    const token = data.data?.app_access_token;
    if (data.code !== "ok" || !token) {
      throw new Error(
        `Infoflow token failed: ${String(data.message ?? data.errmsg ?? data.code ?? "unknown")}`,
      );
    }
    const expireSeconds = typeof data.data?.expire === "number" ? data.data.expire : 7200;
    tokenCache = { token, expireAt: Date.now() + expireSeconds * 1000 };
    return token;
  }

  async function send(recipient: string, text: string): Promise<void> {
    const target = recipient.replace(/^infoflow:/i, "").trim();
    if (!target) throw new Error("Infoflow recipient is required");
    const token = await getToken();
    const groupMatch = target.match(/^group:(\d+)$/i);
    if (groupMatch) {
      await sendGroup(Number(groupMatch[1]), text, token);
      return;
    }
    await sendPrivate(target, text, token);
  }

  async function sendPrivate(toUser: string, content: string, token: string): Promise<void> {
    const payload: Record<string, unknown> = {
      touser: toUser,
      msgtype: "text",
      text: { content },
    };
    if (appAgentId) payload.agentid = appAgentId;
    await postAuthorized(`${apiHost}${PRIVATE_SEND_PATH}`, payload, token);
  }

  async function sendGroup(groupId: number, content: string, token: string): Promise<void> {
    // Nykore/official shape: header.toid + totype + TEXT body (not top-level groupid).
    const payload: Record<string, unknown> = {
      message: {
        header: {
          toid: groupId,
          totype: "GROUP",
          msgtype: "TEXT",
          clientmsgid: Date.now(),
          role: "robot",
        },
        body: [{ type: "TEXT", content }],
      },
    };
    await postAuthorized(`${apiHost}${GROUP_SEND_PATH}`, payload, token);
  }

  async function postAuthorized(
    url: string,
    payload: Record<string, unknown>,
    token: string,
  ): Promise<void> {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer-${token}`,
        "Content-Type": "application/json; charset=utf-8",
        LOGID: randomUUID(),
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data: {
      code?: string;
      message?: string;
      errmsg?: string;
      errcode?: number;
      data?: { errcode?: number; errmsg?: string; message?: string };
    };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new Error(`Infoflow send response was not JSON (HTTP ${response.status})`);
    }
    if (typeof data.code === "string" && data.code !== "ok") {
      throw new Error(`Infoflow send failed: ${String(data.message ?? data.errmsg ?? data.code)}`);
    }
    const nested = data.data && typeof data.data === "object" ? data.data : undefined;
    const errcode =
      typeof data.errcode === "number"
        ? data.errcode
        : typeof nested?.errcode === "number"
          ? nested.errcode
          : undefined;
    if (typeof errcode === "number" && errcode !== 0) {
      throw new Error(
        `Infoflow send failed: ${String(nested?.errmsg ?? nested?.message ?? data.errmsg ?? errcode)}`,
      );
    }
    if (!response.ok) {
      throw new Error(`Infoflow send HTTP ${response.status}`);
    }
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
    const normalized = normalizeInfoflowSdkEvent(event);
    if (!normalized) {
      console.error(`[spark-channels] infoflow skipped sdk event type=${String(event.type ?? "")}`);
      return;
    }
    console.error(
      `[spark-channels] infoflow inbound ${normalized.chat_type} textChars=${normalized.text.length}`,
    );
    onMessage?.(normalized);
  }

  async function start(handler: (raw: unknown) => void): Promise<void> {
    if (running) return;
    if (!appKey || !appSecret) {
      throw new Error("Infoflow ingress requires app_key and app_secret");
    }
    onMessage = handler;
    running = true;
    const logger = new Logger(LogLevel.info, "spark-infoflow");
    // Official SDK docs use appKey + autoRegister (default true). Older 0.1.7
    // connected for heartbeat but never called /imRobot/updateReCallUrl, so
    // private/group DATA frames were never pushed to this connection.
    wsClient = new WSClient({
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
      console.error("[spark-channels] infoflow websocket connected");
    });
    wsClient.on("disconnected", () => {
      console.error("[spark-channels] infoflow websocket disconnected");
    });
    wsClient.on("error", (event) => {
      console.error("[spark-channels] infoflow websocket error", event);
    });
    await wsClient.connect();
    console.error("[spark-channels] infoflow websocket connect() resolved");
  }

  async function stop(): Promise<void> {
    running = false;
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

  return { start, stop, send };
}

function scalarString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

/** Convert SDK event → Spark transport raw shape expected by InfoflowAdapter. */
export function normalizeInfoflowSdkEvent(
  event: EventMessage<NormalizedEventData>,
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
    const text = scalarString(raw.Content ?? raw.content ?? data.content).trim();
    if (!userId || !text) return null;
    const messageId = raw.MsgId ?? raw.msgId ?? raw.MsgId2 ?? raw.msgid2;
    const senderName = raw.FromUserName ?? raw.fromUserName ?? raw.fromusername;
    return {
      user_id: userId,
      text,
      chat_type: "private",
      ...(messageId != null ? { message_id: scalarString(messageId) } : {}),
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
      header.fromuserid ?? header.fromUserId ?? raw.fromUserId ?? raw.fromuserid,
    ).trim();
    const body = Array.isArray(message?.body)
      ? message.body
      : Array.isArray(raw.body)
        ? raw.body
        : [];
    const textParts: string[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const type = scalarString(entry.type).toUpperCase();
      if (type === "TEXT" || type === "MD" || type === "MARKDOWN") {
        if (typeof entry.content === "string") textParts.push(entry.content);
        continue;
      }
      if (type === "AT" || type === "@") {
        const name = scalarString(entry.name ?? entry.userid ?? entry.robotid).trim();
        if (name) textParts.push(`@${name}`);
      }
    }
    const text =
      textParts.join("").replace(/\s+/g, " ").trim() || scalarString(data.content).trim();
    if (!groupId || !userId || !text) return null;
    const messageId = header.messageid ?? header.msgid ?? header.clientmsgid ?? raw.msgid2;
    const senderName =
      header.fromusername ?? header.fromUserName ?? raw.fromUserName ?? raw.fromusername;
    return {
      user_id: userId,
      text,
      chat_type: "group",
      chat_id: groupId,
      ...(messageId != null ? { message_id: scalarString(messageId) } : {}),
      ...(typeof senderName === "string" && senderName.trim()
        ? { sender_name: senderName.trim() }
        : {}),
    };
  }
  return null;
}

/** Fixture/helper normalizer for flat or group payloads (unit tests + FakeChannelTransport). */
export function normalizeInfoflowInbound(
  payload: Record<string, unknown>,
): InfoflowNormalizedInbound | null {
  const groupId = payload.groupid ?? payload.groupId;
  if (groupId != null && payload.message && typeof payload.message === "object") {
    return normalizeInfoflowSdkEvent({
      type: "group.text",
      data: {
        chatType: "group",
        msgType: "text",
        raw: payload,
      },
      timestamp: Date.now(),
    } as EventMessage<NormalizedEventData>);
  }

  const userId = scalarString(
    payload.FromUserId ??
      payload.fromUserId ??
      payload.fromuserid ??
      payload.from ??
      payload.user_id,
  ).trim();
  const textValue =
    payload.Content ?? payload.content ?? payload.Text ?? payload.text ?? payload.mes;
  const text =
    typeof textValue === "string"
      ? textValue.trim()
      : textValue && typeof textValue === "object" && !Array.isArray(textValue)
        ? scalarString((textValue as { content?: unknown }).content).trim()
        : "";
  if (!userId || !text) return null;
  const messageId = payload.MsgId ?? payload.msgid ?? payload.messageid;
  const senderName =
    payload.FromUserName ?? payload.fromUserName ?? payload.fromusername ?? payload.sender_name;
  return {
    user_id: userId,
    text,
    chat_type: "private",
    ...(messageId != null ? { message_id: scalarString(messageId) } : {}),
    ...(typeof senderName === "string" && senderName.trim()
      ? { sender_name: senderName.trim() }
      : {}),
  };
}
