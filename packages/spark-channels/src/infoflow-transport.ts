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
  mentions?: string[];
  mentioned_self?: boolean;
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
    const normalized = normalizeInfoflowSdkEvent(event, { agentId: appAgentId });
    if (!normalized) {
      console.error(`[spark-channels] infoflow skipped sdk event type=${String(event.type ?? "")}`);
      return;
    }
    console.error(
      `[spark-channels] infoflow inbound ${normalized.chat_type}` +
        ` textChars=${normalized.text.length}` +
        ` preview=${JSON.stringify(normalized.text.slice(0, 120))}` +
        (normalized.mentions?.length ? ` mentions=${JSON.stringify(normalized.mentions)}` : ""),
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
        : Array.isArray(data.body)
          ? data.body
          : [];
    const extracted = extractInfoflowBodyContent(body);
    const mentionedSelf = detectInfoflowMentionedSelf(raw, header, body, options.agentId);
    const text = extracted.text || scalarString(data.content).trim();
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
      ...(extracted.mentions.length > 0 ? { mentions: extracted.mentions } : {}),
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
  const parts: string[] = [];
  const mentions: string[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const type = scalarString(entry.type).toUpperCase();
    if (type === "AT" || type === "@") {
      const label = scalarString(
        entry.name ?? entry.display ?? entry.displayname ?? entry.userid ?? entry.robotid,
      )
        .trim()
        .replace(/^@+/u, "");
      if (!label) continue;
      const display = `@${label}`;
      mentions.push(label);
      const previous = parts.at(-1);
      if (previous && !/[ \t\n]$/u.test(previous)) parts.push(" ");
      parts.push(display);
      parts.push(" ");
      continue;
    }
    if (type === "TEXT" || type === "MD" || type === "MARKDOWN" || type === "") {
      const rawContent =
        typeof entry.content === "string"
          ? entry.content
          : typeof entry.text === "string"
            ? entry.text
            : "";
      if (!rawContent) continue;
      const previous = parts.at(-1);
      if (previous === " " && /^[ \t]+/u.test(rawContent)) parts.pop();
      parts.push(rawContent);
    }
  }
  const text = parts
    .join("")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
  return { text, mentions };
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
