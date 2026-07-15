import WebSocket, { type RawData } from "ws";
import { createQqbotApiClient, resolveQqbotApiBase, type QqbotApiClient } from "./qqbot-api.ts";
import type {
  ChannelAskRequest,
  ChannelInteractionAckStatus,
  ChannelInteractionCapability,
  ChannelInteractionEvent,
} from "./interaction.ts";
import {
  normalizeQqbotInteractionEvent,
  type QqbotNormalizedInteraction,
} from "./qqbot-interaction.ts";
import type { ChannelReplyCapability } from "./reply.ts";
import type { ChannelConnectionState, ChannelTransport, QqbotAdapterConfig } from "./types.ts";
import {
  parseQqbotRecipient,
  type QqbotKeyboardPermission,
  type QqbotMessageKeyboard,
} from "./qqbot-types.ts";

const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
} as const;

const FULL_INTENTS =
  INTENTS.PUBLIC_GUILD_MESSAGES |
  INTENTS.DIRECT_MESSAGE |
  INTENTS.GROUP_AND_C2C |
  INTENTS.INTERACTION;

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
// Passive reply slots are deliberately stable across daemon restarts. Even if
// the in-memory budget is lost, one idempotent native ask=2 and final=4 cannot
// collide. Group uses ask=1 and final=5. Later asks remain in Cockpit rather
// than risking the final reply slot.
const QQBOT_C2C_PASSIVE_REPLY_LIMIT = 4;
const QQBOT_GROUP_PASSIVE_REPLY_LIMIT = 5;

export interface QqbotTransportOptions {
  api?: QqbotApiClient;
  webSocketFactory?: (url: string) => WebSocket;
}

/**
 * QQ Bot transport:
 * - inbound via official WebSocket gateway (Identify + heartbeat + dispatch)
 * - outbound via Open Platform HTTP message APIs
 * - final replies only; execution lifecycle stays out of QQ chat
 */
export function createQqbotTransport(
  config: QqbotAdapterConfig,
  options: QqbotTransportOptions = {},
): ChannelTransport {
  const api =
    options.api ??
    createQqbotApiClient({
      baseUrl: resolveQqbotApiBase(config.api_environment),
    });
  const webSocketFactory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));

  let onMessage: ((raw: unknown) => void) | null = null;
  let onInteraction: ((event: ChannelInteractionEvent) => void | Promise<void>) | null = null;
  let running = false;
  let connectionState: ChannelConnectionState = "stopped";
  let connectionError: string | undefined;
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let stopping = false;
  const passiveReplyBudget = createQqbotPassiveReplyBudget();

  async function resolveToken(): Promise<string> {
    const appId = config.app_id?.trim();
    const clientSecret = config.client_secret?.trim();
    if (!appId || !clientSecret) {
      throw new Error("qqbot requires app_id and client_secret");
    }
    return await api.getAccessToken(appId, clientSecret);
  }

  async function sendText(recipient: string, text: string, msgId?: string): Promise<void> {
    const token = await resolveToken();
    const target = parseQqbotRecipient(recipient);
    switch (target.kind) {
      case "c2c":
        await api.sendC2CMessage(token, target.openid, text, msgId);
        return;
      case "group":
        await api.sendGroupMessage(token, target.groupOpenid, text, msgId);
        return;
      case "channel":
        await api.sendChannelMessage(token, target.channelId, text, msgId);
        return;
      default: {
        const unexpected: never = target;
        throw new Error(`unsupported qqbot recipient: ${String(unexpected)}`);
      }
    }
  }

  async function sendFinalReply(recipient: string, text: string, msgId?: string): Promise<void> {
    const target = parseQqbotRecipient(recipient);
    const content = text.trim();
    const token = await resolveToken();
    const reservation = reservePassiveReplyForTarget(passiveReplyBudget, target, msgId, "final");
    if (!reservation) throw new Error("qqbot passive reply budget exhausted before final reply");
    switch (target.kind) {
      case "c2c":
        await api.sendC2CMarkdownMessage(token, target.openid, content, msgId, reservation.msgSeq);
        return;
      case "group":
        await api.sendGroupMarkdownMessage(
          token,
          target.groupOpenid,
          content,
          msgId,
          reservation.msgSeq,
        );
        return;
      case "channel":
        // Channel custom Markdown remains invitation-gated. Preserve the
        // assistant's original reply body through the supported text API.
        await api.sendChannelMessage(token, target.channelId, content, msgId);
        return;
      default: {
        const unexpected: never = target;
        throw new Error(`unsupported qqbot recipient: ${String(unexpected)}`);
      }
    }
  }

  const reply: ChannelReplyCapability = {
    async openReplyStream() {
      // QQ exposes no native collapsible execution surface. Returning no
      // stream keeps commentary, reasoning, and tool lifecycle off the chat
      // while the daemon still delivers the final assistant reply below.
      return undefined;
    },
    async sendReply(input) {
      await sendFinalReply(input.recipient, input.text, input.messageId);
    },
  };

  const interaction: ChannelInteractionCapability = {
    async sendAsk(recipient, request) {
      const target = parseQqbotRecipient(recipient);
      if (target.kind === "channel") {
        throw new Error(
          "qqbot native asks currently support c2c and group recipients only; channel buttons require platform invitation",
        );
      }
      const keyboard = buildAskKeyboard(request, target.kind);
      const token = await resolveToken();
      const reservation = reservePassiveReplyForTarget(
        passiveReplyBudget,
        target,
        request.messageId,
        "ask",
      );
      if (!reservation) {
        throw new Error("qqbot passive reply budget reserved for the final answer");
      }
      const messageRequest = {
        markdown: { content: request.prompt },
        keyboard,
        ...(request.messageId ? { msg_id: request.messageId } : {}),
        ...(reservation.msgSeq ? { msg_seq: reservation.msgSeq } : {}),
      };
      const response =
        target.kind === "c2c"
          ? await api.sendC2CMarkdownKeyboardMessage(token, target.openid, messageRequest)
          : await api.sendGroupMarkdownKeyboardMessage(token, target.groupOpenid, messageRequest);
      return response.id ? { messageId: response.id } : {};
    },
    async ackInteraction(interactionId, status = "success") {
      const token = await resolveToken();
      await api.acknowledgeInteraction(token, interactionId, qqbotAckCode(status));
    },
  };

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function clearReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function cleanupSocket(): void {
    clearHeartbeat();
    if (ws) {
      try {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // ignore close errors during teardown
      }
      ws = null;
    }
  }

  function scheduleReconnect(): void {
    if (stopping || !running) return;
    clearReconnect();
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    reconnectAttempt += 1;
    connectionState = "reconnecting";
    reconnectTimer = setTimeout(() => {
      void connect().catch((error) => {
        connectionState = "degraded";
        connectionError = error instanceof Error ? error.message : String(error);
        scheduleReconnect();
      });
    }, delay);
  }

  async function connect(): Promise<void> {
    cleanupSocket();
    connectionState = "connecting";
    connectionError = undefined;
    const token = await resolveToken();
    const gatewayUrl = await api.getGatewayUrl(token);
    const socket = webSocketFactory(gatewayUrl);
    ws = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      socket.on("open", () => {
        // Wait for Hello (op 10) before considering identify complete.
      });

      socket.on("message", (data) => {
        let payload: { op?: number; s?: number | null; t?: string; d?: unknown };
        try {
          payload = JSON.parse(rawDataToText(data)) as typeof payload;
        } catch {
          return;
        }
        if (typeof payload.s === "number") lastSeq = payload.s;

        switch (payload.op) {
          case 10: {
            const interval =
              payload.d && typeof payload.d === "object" && !Array.isArray(payload.d)
                ? Number((payload.d as { heartbeat_interval?: number }).heartbeat_interval)
                : NaN;
            if (sessionId && lastSeq !== null) {
              socket.send(
                JSON.stringify({
                  op: 6,
                  d: {
                    token: `QQBot ${token}`,
                    session_id: sessionId,
                    seq: lastSeq,
                  },
                }),
              );
            } else {
              socket.send(
                JSON.stringify({
                  op: 2,
                  d: {
                    token: `QQBot ${token}`,
                    intents: FULL_INTENTS,
                    shard: [0, 1],
                  },
                }),
              );
            }
            clearHeartbeat();
            if (Number.isFinite(interval) && interval > 0) {
              heartbeatTimer = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ op: 1, d: lastSeq }));
                }
              }, interval);
            }
            ok();
            break;
          }
          case 0: {
            const eventType = payload.t?.trim();
            if (eventType === "READY") {
              const ready = payload.d as { session_id?: string } | undefined;
              if (ready?.session_id) sessionId = ready.session_id;
              connectionState = "connected";
              connectionError = undefined;
              reconnectAttempt = 0;
              return;
            }
            if (eventType === "RESUMED") {
              connectionState = "connected";
              connectionError = undefined;
              reconnectAttempt = 0;
              return;
            }
            if (eventType === "INTERACTION_CREATE") {
              const rawEvent = {
                event_type: eventType,
                d: payload.d,
              };
              const normalized = normalizeQqbotInteractionEvent(rawEvent);
              const event = normalized ? toChannelInteractionEvent(normalized) : undefined;
              if (event) {
                try {
                  const handled = onInteraction?.(event);
                  if (handled) {
                    void handled.catch((error: unknown) => {
                      console.error("[spark-channels] qqbot interaction callback failed", error);
                    });
                  }
                } catch (error) {
                  console.error("[spark-channels] qqbot interaction callback failed", error);
                }
              }
              return;
            }
            if (
              eventType === "C2C_MESSAGE_CREATE" ||
              eventType === "GROUP_AT_MESSAGE_CREATE" ||
              eventType === "GROUP_MESSAGE_CREATE" ||
              eventType === "AT_MESSAGE_CREATE" ||
              eventType === "MESSAGE_CREATE"
            ) {
              onMessage?.({
                event_type: eventType,
                d: payload.d,
              });
            }
            break;
          }
          case 7: {
            // Reconnect requested by gateway.
            cleanupSocket();
            scheduleReconnect();
            break;
          }
          case 9: {
            // Invalid session — drop resume state.
            sessionId = null;
            lastSeq = null;
            cleanupSocket();
            scheduleReconnect();
            break;
          }
          default:
            break;
        }
      });

      socket.on("error", (error) => {
        connectionError = error.message;
        fail(error instanceof Error ? error : new Error(String(error)));
      });

      socket.on("close", () => {
        clearHeartbeat();
        if (stopping || !running) {
          connectionState = "stopped";
          return;
        }
        connectionState = "reconnecting";
        scheduleReconnect();
      });
    });
  }

  return {
    reply,
    interaction,
    async start(handler, interactionHandler) {
      if (running) return;
      running = true;
      stopping = false;
      onMessage = handler;
      onInteraction = interactionHandler ?? null;
      try {
        await connect();
      } catch (error) {
        running = false;
        onMessage = null;
        onInteraction = null;
        connectionState = "stopped";
        connectionError = error instanceof Error ? error.message : String(error);
        cleanupSocket();
        throw error;
      }
    },
    async stop() {
      stopping = true;
      running = false;
      onMessage = null;
      onInteraction = null;
      clearReconnect();
      cleanupSocket();
      connectionState = "stopped";
    },
    async send(recipient, text) {
      await sendText(recipient, text);
    },
    status() {
      return {
        state: connectionState,
        ...(connectionError ? { error: connectionError } : {}),
      };
    },
  };
}

const DEFAULT_UNSUPPORTED_BUTTON_TEXT = "当前 QQ 版本不支持此操作，请升级后重试";

function buildAskKeyboard(
  request: ChannelAskRequest,
  targetKind: "c2c" | "group",
): QqbotMessageKeyboard {
  if (!request.prompt.trim()) {
    throw new Error("qqbot native ask prompt must not be empty");
  }
  if (request.options.length === 0 || request.options.length > 25) {
    throw new Error("qqbot native ask requires between 1 and 25 options");
  }

  // A C2C keyboard is already scoped to one peer. QQ rejects openids in
  // specify_user_ids for C2C buttons before emitting INTERACTION_CREATE.
  // Keep sender-scoped native permissions for groups; daemon callback routing
  // still verifies the persisted actorId and recipient for every scene.
  const permission = targetKind === "c2c" ? ({ type: 2 } as const) : qqbotPermission(request);
  const seenIds = new Set<string>();
  const buttons = request.options.map((option, index) => {
    if (!option.label.trim()) throw new Error(`qqbot ask option ${index + 1} has an empty label`);
    if (!option.data.trim())
      throw new Error(`qqbot ask option ${index + 1} has empty callback data`);
    const id = option.id?.trim() || String(index + 1);
    if (seenIds.has(id)) throw new Error(`qqbot ask has duplicate option id: ${id}`);
    seenIds.add(id);
    return {
      id,
      render_data: {
        label: option.label,
        visited_label: option.label,
        style: 0 as const,
      },
      action: {
        type: 1 as const,
        permission,
        data: option.data,
        unsupport_tips: request.unsupportedText?.trim() || DEFAULT_UNSUPPORTED_BUTTON_TEXT,
      },
    };
  });

  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push({ buttons: buttons.slice(index, index + 5) });
  }
  return { content: { rows } };
}

function qqbotPermission(request: ChannelAskRequest): QqbotKeyboardPermission {
  const audience = request.audience ?? ({ kind: "everyone" } as const);
  switch (audience.kind) {
    case "everyone":
      return { type: 2 };
    case "admins":
      return { type: 1 };
    case "users": {
      const userIds = audience.userIds;
      const normalized = userIds.map((entry) => entry.trim()).filter(Boolean);
      if (normalized.length === 0) {
        throw new Error("qqbot native ask users audience requires at least one user id");
      }
      return { type: 0, specify_user_ids: [...new Set(normalized)] };
    }
    default: {
      const unexpected: never = audience;
      throw new Error(`unsupported qqbot ask audience: ${String(unexpected)}`);
    }
  }
}

function qqbotAckCode(status: ChannelInteractionAckStatus): 0 | 1 | 2 | 3 | 4 | 5 {
  switch (status) {
    case "success":
      return 0;
    case "failed":
      return 1;
    case "rate_limited":
      return 2;
    case "duplicate":
      return 3;
    case "forbidden":
      return 4;
    case "admins_only":
      return 5;
    default: {
      const unexpected: never = status;
      throw new Error(`unsupported channel interaction acknowledgement: ${String(unexpected)}`);
    }
  }
}

function toChannelInteractionEvent(
  interaction: QqbotNormalizedInteraction,
): ChannelInteractionEvent | undefined {
  if (
    interaction.interactionType !== 11 ||
    !interaction.scene ||
    !interaction.actorId ||
    interaction.callbackToken === undefined
  ) {
    return undefined;
  }

  const scene =
    interaction.scene === "guild" ? "channel" : interaction.scene === "group" ? "group" : "c2c";
  const recipient =
    interaction.scene === "c2c" && interaction.userOpenid
      ? `c2c:${interaction.userOpenid}`
      : interaction.scene === "group" && interaction.groupOpenid
        ? `group:${interaction.groupOpenid}`
        : interaction.scene === "guild" && interaction.channelId
          ? `channel:${interaction.channelId}`
          : undefined;

  return {
    adapter: "qqbot",
    interactionId: interaction.interactionId,
    actorId: interaction.actorId,
    scene,
    ...(recipient ? { recipient } : {}),
    buttonData: interaction.callbackToken,
    ...(interaction.buttonId ? { buttonId: interaction.buttonId } : {}),
    ...(interaction.messageId ? { messageId: interaction.messageId } : {}),
    raw: interaction.raw,
  };
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

type QqbotPassiveReplyKind = "ask" | "final";

interface QqbotPassiveReplyReservation {
  msgSeq?: number;
}

interface QqbotPassiveReplyBudget {
  reserve(
    scope: "c2c" | "group",
    recipient: string,
    messageId: string | undefined,
    kind: QqbotPassiveReplyKind,
  ): QqbotPassiveReplyReservation | undefined;
}

function createQqbotPassiveReplyBudget(): QqbotPassiveReplyBudget {
  const entries = new Map<
    string,
    { askCount: number; finalReserved: boolean; touchedAt: number }
  >();
  return {
    reserve(scope, recipient, messageId, kind) {
      if (!messageId) return {};
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (now - entry.touchedAt >= 60 * 60 * 1000) entries.delete(key);
      }
      const key = `${scope}\0${recipient}\0${messageId}`;
      const entry = entries.get(key) ?? {
        askCount: 0,
        finalReserved: false,
        touchedAt: now,
      };
      const limit =
        scope === "c2c" ? QQBOT_C2C_PASSIVE_REPLY_LIMIT : QQBOT_GROUP_PASSIVE_REPLY_LIMIT;
      if (kind !== "final" && entry.finalReserved) return undefined;
      let msgSeq: number;
      if (kind === "ask") {
        const askLimit = 1;
        if (entry.askCount >= askLimit) return undefined;
        entry.askCount += 1;
        msgSeq = scope === "c2c" ? 2 : 1;
      } else {
        entry.finalReserved = true;
        msgSeq = limit;
      }
      entry.touchedAt = now;
      entries.set(key, entry);
      return { msgSeq };
    },
  };
}

function reservePassiveReplyForTarget(
  budget: QqbotPassiveReplyBudget,
  target: ReturnType<typeof parseQqbotRecipient>,
  messageId: string | undefined,
  kind: QqbotPassiveReplyKind,
): QqbotPassiveReplyReservation | undefined {
  if (target.kind === "c2c") return budget.reserve("c2c", target.openid, messageId, kind);
  if (target.kind === "group") {
    return budget.reserve("group", target.groupOpenid, messageId, kind);
  }
  return {};
}
