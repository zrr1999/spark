import WebSocket, { type RawData } from "ws";
import { createQqbotApiClient, resolveQqbotApiBase, type QqbotApiClient } from "./qqbot-api.ts";
import type { ChannelReplyCapability, ChannelReplyStream } from "./reply.ts";
import type { ChannelConnectionState, ChannelTransport, QqbotAdapterConfig } from "./types.ts";
import { parseQqbotRecipient } from "./qqbot-types.ts";

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

export interface QqbotTransportOptions {
  api?: QqbotApiClient;
  webSocketFactory?: (url: string) => WebSocket;
}

/**
 * QQ Bot transport:
 * - inbound via official WebSocket gateway (Identify + heartbeat + dispatch)
 * - outbound via Open Platform HTTP message APIs
 * - C2C streaming replies via stream_messages (group/channel stay one-shot)
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

  const reply: ChannelReplyCapability = {
    async openReplyStream(target) {
      const parsed = (() => {
        try {
          return parseQqbotRecipient(target.recipient);
        } catch {
          return undefined;
        }
      })();
      if (!parsed || parsed.kind !== "c2c") return undefined;
      return createC2CReplyStream({
        api,
        resolveToken,
        openid: parsed.openid,
        msgId: target.messageId,
      });
    },
    async sendReply(input) {
      await sendText(input.recipient, input.text, input.messageId);
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
    async start(handler) {
      if (running) return;
      running = true;
      stopping = false;
      onMessage = handler;
      try {
        await connect();
      } catch (error) {
        running = false;
        onMessage = null;
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

function rawDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function createC2CReplyStream(input: {
  api: QqbotApiClient;
  resolveToken: () => Promise<string>;
  openid: string;
  msgId?: string;
}): ChannelReplyStream {
  let buffer = "";
  let streamMsgId: string | undefined;
  let index = 0;
  let msgSeq = 1;
  let closed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFlush: Promise<void> = Promise.resolve();

  const flush = async (done: boolean): Promise<void> => {
    if (closed && !done) return;
    const token = await input.resolveToken();
    const response = await input.api.sendC2CStreamMessage(token, input.openid, {
      input_mode: "replace",
      input_state: done ? 10 : 1,
      content_type: "markdown",
      content_raw: buffer,
      msg_seq: msgSeq,
      index,
      ...(input.msgId ? { msg_id: input.msgId } : {}),
      ...(streamMsgId ? { stream_msg_id: streamMsgId } : {}),
    });
    msgSeq += 1;
    index += 1;
    if (!streamMsgId && response.id) streamMsgId = response.id;
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      pendingFlush = pendingFlush
        .then(() => flush(false))
        .catch((error) => {
          console.error("[spark-channels] qqbot c2c stream flush failed", error);
        });
    }, 400);
  };

  return {
    appendText(delta) {
      if (closed || !delta) return;
      buffer += delta;
      scheduleFlush();
    },
    notifyToolStart() {
      // QQ C2C stream has no dedicated tool card; keep text-only.
    },
    notifyToolResult() {},
    async complete() {
      if (closed) return;
      closed = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await pendingFlush;
      await flush(true);
    },
    async fail(message) {
      if (closed) return;
      closed = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await pendingFlush;
      if (message.trim()) {
        buffer = buffer.trim() ? `${buffer}\n\n${message}` : message;
      }
      try {
        await flush(true);
      } catch (error) {
        console.error("[spark-channels] qqbot c2c stream fail flush failed", error);
      }
    },
  };
}
