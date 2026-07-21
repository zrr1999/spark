import WebSocket, { type RawData } from "ws";
import {
  materializeChannelImages,
  type ChannelImage,
  type ChannelImageSource,
} from "./channel-images.ts";
import {
  createQqbotApiClient,
  resolveQqbotApiBase,
  type QqbotApiClient,
  type QqbotMessageResponse,
} from "./qqbot-api.ts";
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
import {
  channelDeliveryNotSent,
  type ChannelDeliveryFacts,
  type ChannelDeliveryReceipt,
  type ChannelDeliveryResult,
  type ChannelReplyCapability,
  type ChannelReplyTarget,
} from "./reply.ts";
import { QQBOT_MARKDOWN_MAX_BYTES, chunkQqbotMarkdownText } from "./qqbot-markdown.ts";
import { tryCreateQqbotC2CReplyStream } from "./qqbot-reply-stream.ts";
import type { ChannelConnectionState, ChannelTransport, QqbotAdapterConfig } from "./types.ts";
import {
  parseQqbotRecipient,
  type QqbotKeyboardPermission,
  type QqbotMessageKeyboard,
} from "./qqbot-types.ts";
import { scheduledReconnectDelayWithJitter } from "./reconnect-delay.ts";

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
const DEFAULT_QQBOT_CONNECT_TIMEOUT_MS = 30_000;
// Passive reply slots are deliberately stable across daemon restarts. Even if
// the in-memory budget is lost, one idempotent native ask=2 and final=4 cannot
// collide. Group uses ask=1 and final=5. Later asks remain in Cockpit rather
// than risking the final reply slot.
const QQBOT_C2C_PASSIVE_REPLY_LIMIT = 4;
const QQBOT_GROUP_PASSIVE_REPLY_LIMIT = 5;

export interface QqbotTransportOptions {
  api?: QqbotApiClient;
  /** Test seam for downloading platform-issued inbound image URLs. */
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  /** Deadline through Identify/Resume until READY or RESUMED is received. */
  connectTimeoutMs?: number;
  /** Test seam; production retries remain capped at 60 seconds forever. */
  reconnectDelaysMs?: readonly number[];
  /** Test seam for equal-jitter reconnect delays. */
  reconnectRandom?: () => number;
  /** Load the daemon-owned resumable cursor before the first gateway connect. */
  loadCursor?: () => QqbotGatewayCursor | null | Promise<QqbotGatewayCursor | null>;
  /** Persist a durable cursor, or clear an invalidated gateway session. */
  saveCursor?: (cursor: QqbotGatewayCursor | null) => void | Promise<void>;
}

export interface QqbotGatewayCursor {
  sessionId: string;
  lastSeq: number;
}

type QqbotGatewayPayload = { op?: number; s?: number | null; t?: string; d?: unknown };

/**
 * QQ Bot transport:
 * - inbound via official WebSocket gateway (Identify + heartbeat + dispatch)
 * - outbound via Open Platform HTTP message APIs
 * - C2C replies use native stream_messages (one message, in-place updates)
 * - group/channel replies stay one final markdown/text message (no stream API)
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
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_QQBOT_CONNECT_TIMEOUT_MS;
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new Error("qqbot connectTimeoutMs must be a positive finite number");
  }
  const reconnectDelays =
    options.reconnectDelaysMs?.length === 0
      ? RECONNECT_DELAYS_MS
      : (options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS);
  const reconnectRandom = options.reconnectRandom ?? Math.random;

  let onMessage: ((raw: unknown) => void) | null = null;
  let onInteraction: ((event: ChannelInteractionEvent) => void | Promise<void>) | null = null;
  let running = false;
  let connectionState: ChannelConnectionState = "stopped";
  let connectionError: string | undefined;
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let awaitingHeartbeatAck = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let connectionGeneration = 0;
  let cancelPendingConnect: ((error: Error) => void) | null = null;
  let accessTokenForRedaction: string | undefined;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let cursorLoaded = false;
  let stopping = false;
  const passiveReplyBudget = createQqbotPassiveReplyBudget();

  async function resolveToken(): Promise<string> {
    const appId = config.app_id?.trim();
    const clientSecret = config.client_secret?.trim();
    if (!appId || !clientSecret) {
      throw new Error("qqbot requires app_id and client_secret");
    }
    const token = await api.getAccessToken(appId, clientSecret);
    accessTokenForRedaction = token;
    return token;
  }

  async function deliveryToken(): Promise<string> {
    try {
      return await resolveToken();
    } catch (error) {
      // Credential validation/token acquisition cannot have emitted a message.
      throw channelDeliveryNotSent(error);
    }
  }

  function deliveryTarget(recipient: string): ReturnType<typeof parseQqbotRecipient> {
    try {
      return parseQqbotRecipient(recipient);
    } catch (error) {
      throw channelDeliveryNotSent(error);
    }
  }

  async function loadCursorOnce(): Promise<void> {
    if (cursorLoaded) return;
    const cursor = (await options.loadCursor?.()) ?? null;
    if (cursor) {
      const loadedSessionId = cursor.sessionId.trim();
      if (!loadedSessionId || !Number.isSafeInteger(cursor.lastSeq) || cursor.lastSeq < 0) {
        throw new Error("qqbot loadCursor returned an invalid gateway cursor");
      }
      sessionId = loadedSessionId;
      lastSeq = cursor.lastSeq;
    }
    cursorLoaded = true;
  }

  async function sendText(recipient: string, text: string): Promise<ChannelDeliveryResult> {
    const target = deliveryTarget(recipient);
    const token = await deliveryToken();
    let response: QqbotMessageResponse;
    switch (target.kind) {
      case "c2c":
        response = await api.sendC2CMessage(token, target.openid, text);
        break;
      case "group":
        response = await api.sendGroupMessage(token, target.groupOpenid, text);
        break;
      case "channel":
        response = await api.sendChannelMessage(token, target.channelId, text);
        break;
      default: {
        const unexpected: never = target;
        throw new Error(`unsupported qqbot recipient: ${String(unexpected)}`);
      }
    }
    return qqbotDeliveryResult({ replaySafety: "unsafe" }, response);
  }

  async function sendMarkdownChunk(
    token: string,
    target: ReturnType<typeof parseQqbotRecipient>,
    content: string,
    msgId: string | undefined,
    msgSeq: number | undefined,
  ): Promise<QqbotMessageResponse> {
    switch (target.kind) {
      case "c2c":
        return await api.sendC2CMarkdownMessage(token, target.openid, content, msgId, msgSeq);
      case "group":
        return await api.sendGroupMarkdownMessage(
          token,
          target.groupOpenid,
          content,
          msgId,
          msgSeq,
        );
      case "channel":
        // Channel custom Markdown remains invitation-gated. Preserve the
        // assistant's original reply body through the supported text API.
        return await api.sendChannelMessage(token, target.channelId, content, msgId);
      default: {
        const unexpected: never = target;
        throw new Error(`unsupported qqbot recipient: ${String(unexpected)}`);
      }
    }
  }

  async function sendFinalReply(
    recipient: string,
    text: string,
    msgId?: string,
  ): Promise<ChannelDeliveryResult> {
    let target: ReturnType<typeof parseQqbotRecipient>;
    let chunks: string[];
    let sequences: Array<number | undefined>;
    try {
      target = parseQqbotRecipient(recipient);
      chunks = chunkQqbotMarkdownText(text, QQBOT_MARKDOWN_MAX_BYTES);
      if (chunks.length === 0) throw new Error("qqbot final reply requires non-empty content");
      const reservation = reservePassiveReplyForTarget(passiveReplyBudget, target, msgId, "final");
      if (!reservation) throw new Error("qqbot passive reply budget exhausted before final reply");
      sequences = stableFinalReplySequences(target, msgId, chunks.length, reservation.msgSeq);
    } catch (error) {
      throw channelDeliveryNotSent(error);
    }
    const token = await deliveryToken();
    let response: QqbotMessageResponse | undefined;
    for (const [index, chunk] of chunks.entries()) {
      response = await sendMarkdownChunk(token, target, chunk, msgId, sequences[index]);
    }
    return qqbotDeliveryResult(
      qqbotReplyDeliveryFacts({ recipient, messageId: msgId }),
      response ?? {},
    );
  }

  const reply: ChannelReplyCapability = {
    deliveryFacts: qqbotReplyDeliveryFacts,
    async openReplyStream(target) {
      // Native in-place streaming exists only for C2C. Group/channel fall back
      // to a single durable sendReply from the daemon outbox.
      const parsed = parseQqbotRecipient(target.recipient);
      let reservedStreamOverflowSeqs: number[] = [];
      return tryCreateQqbotC2CReplyStream({
        target,
        api,
        resolveToken,
        reserveFinalSeq: (messageId) => {
          if (parsed.kind !== "c2c") return undefined;
          const reservation = reservePassiveReplyForTarget(
            passiveReplyBudget,
            parsed,
            messageId,
            "final",
          );
          return reservation?.msgSeq;
        },
        sendFollowUpMarkdown:
          parsed.kind === "c2c"
            ? async (content) => {
                const messageId = target.messageId?.trim();
                const msgSeq = reservedStreamOverflowSeqs.shift();
                if (msgSeq === undefined) {
                  throw channelDeliveryNotSent(
                    new Error("qqbot passive reply budget exhausted before stream follow-up"),
                  );
                }
                const token = await deliveryToken();
                await sendMarkdownChunk(token, parsed, content, messageId, msgSeq);
              }
            : undefined,
        reserveFollowUpSeqs:
          parsed.kind === "c2c"
            ? (count) => {
                if (count === 0) return true;
                const messageId = target.messageId?.trim();
                const reservations = reservePassiveOverflowForTarget(
                  passiveReplyBudget,
                  parsed,
                  messageId,
                  count,
                );
                if (!reservations?.every(({ msgSeq }) => msgSeq !== undefined)) return false;
                reservedStreamOverflowSeqs = reservations.map(({ msgSeq }) => msgSeq!);
                return true;
              }
            : undefined,
      });
    },
    async sendReply(input) {
      return await sendFinalReply(input.recipient, input.text, input.messageId);
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
        request.idempotencyKey,
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

  const image: NonNullable<ChannelTransport["image"]> = {
    async sendImage(input) {
      let target: ReturnType<typeof parseQqbotRecipient>;
      let source: { url: string } | { data: string };
      try {
        target = parseQqbotRecipient(input.recipient);
        if (target.kind === "channel") {
          throw new Error("qqbot image messages currently support c2c and group recipients only");
        }
        const url = input.image.url?.trim();
        if (url) {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:") throw new Error("qqbot image URL must use HTTPS");
          source = { url: parsed.toString() };
        } else {
          const [materialized] = await materializeChannelImages([input.image]);
          if (!materialized) throw new Error("qqbot image could not be materialized");
          source = { data: materialized.data };
        }
      } catch (error) {
        throw channelDeliveryNotSent(error);
      }

      const token = await deliveryToken();
      let upload: Awaited<ReturnType<QqbotApiClient["uploadC2CImage"]>>;
      try {
        upload =
          target.kind === "c2c"
            ? await api.uploadC2CImage(token, target.openid, source)
            : await api.uploadGroupImage(token, target.groupOpenid, source);
        if (!upload.file_info?.trim()) throw new Error("QQ Bot image upload omitted file_info");
      } catch (error) {
        // srv_send_msg=false: upload failure cannot have emitted a chat message.
        throw channelDeliveryNotSent(error);
      }

      const msgSeq = input.messageId ? api.nextMessageSequence(input.messageId) : undefined;
      const response =
        target.kind === "c2c"
          ? await api.sendC2CImageMessage(
              token,
              target.openid,
              upload.file_info,
              input.caption,
              input.messageId,
              msgSeq,
            )
          : await api.sendGroupImageMessage(
              token,
              target.groupOpenid,
              upload.file_info,
              input.caption,
              input.messageId,
              msgSeq,
            );
      return qqbotDeliveryResult(
        input.messageId
          ? qqbotReplyDeliveryFacts({
              recipient: input.recipient,
              messageId: input.messageId,
            })
          : { replaySafety: "unsafe" },
        response,
      );
    },
  };

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    awaitingHeartbeatAck = false;
  }

  function clearReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function cleanupSocket(cancelReason?: Error): void {
    clearHeartbeat();
    const cancel = cancelPendingConnect;
    cancelPendingConnect = null;
    cancel?.(cancelReason ?? new Error("qqbot websocket connection superseded"));
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
    const delay = scheduledReconnectDelayWithJitter(
      reconnectAttempt + 1,
      reconnectDelays,
      reconnectRandom,
    );
    reconnectAttempt += 1;
    const attempt = reconnectAttempt;
    connectionState = "reconnecting";
    console.error(
      `[spark-channels] qqbot supervised reconnect scheduled attempt=${attempt} delayMs=${delay}`,
    );
    reconnectTimer = setTimeout(() => {
      void connect().catch((error) => {
        if (stopping || !running) return;
        connectionState = "degraded";
        connectionError = sanitizeQqbotConnectionError(error, sensitiveLogValues());
        console.error(
          `[spark-channels] qqbot supervised reconnect failed attempt=${attempt}` +
            ` error=${JSON.stringify(connectionError)}`,
        );
        scheduleReconnect();
      });
    }, delay);
  }

  async function connect(): Promise<void> {
    const reconnectAttemptAtStart = reconnectAttempt;
    const generation = ++connectionGeneration;
    cleanupSocket(new Error("qqbot websocket connection superseded"));
    connectionState = "connecting";
    connectionError = undefined;
    await loadCursorOnce();
    assertConnectAttemptActive(generation);
    const token = await resolveToken();
    assertConnectAttemptActive(generation);
    const gatewayUrl = await api.getGatewayUrl(token);
    assertConnectAttemptActive(generation);
    const socket = webSocketFactory(gatewayUrl);
    ws = socket;

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let readyConfirmed = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let dispatchChain = Promise.resolve();
        const isCurrentSocket = () =>
          running && !stopping && generation === connectionGeneration && ws === socket;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          if (cancelPendingConnect === fail) cancelPendingConnect = null;
          reject(error);
        };
        const ok = () => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          if (cancelPendingConnect === fail) cancelPendingConnect = null;
          resolve();
        };
        const failSocket = (error: Error, label: string) => {
          if (!isCurrentSocket()) return;
          connectionState = "degraded";
          connectionError = sanitizeQqbotConnectionError(error, sensitiveLogValues());
          console.error(
            `[spark-channels] qqbot ${label} failed` + ` error=${JSON.stringify(connectionError)}`,
          );
          const reconnectDirectly = readyConfirmed;
          cleanupSocket(error);
          // Before READY/RESUMED, cleanup rejects this connect attempt and its
          // supervisor schedules exactly one retry. Afterwards we own it here.
          if (reconnectDirectly) scheduleReconnect();
        };
        const commitDurableSequence = async (
          payload: QqbotGatewayPayload,
          nextSessionId: string | null = sessionId,
        ) => {
          if (typeof payload.s !== "number") {
            if (isCurrentSocket()) sessionId = nextSessionId;
            return;
          }
          if (options.saveCursor) {
            if (!nextSessionId) {
              throw new Error("qqbot cannot persist a gateway sequence without a session id");
            }
            await options.saveCursor({ sessionId: nextSessionId, lastSeq: payload.s });
          }
          if (!isCurrentSocket()) return;
          sessionId = nextSessionId;
          lastSeq = payload.s;
        };
        const handleDispatch = async (payload: QqbotGatewayPayload) => {
          if (!isCurrentSocket()) return;
          const eventType = payload.t?.trim();
          if (eventType === "READY") {
            const ready = payload.d as { session_id?: string } | undefined;
            const readySessionId = ready?.session_id?.trim() || null;
            await commitDurableSequence(payload, readySessionId);
            if (!isCurrentSocket()) return;
            readyConfirmed = true;
            connectionState = "connected";
            connectionError = undefined;
            if (reconnectAttemptAtStart > 0) {
              console.error(
                `[spark-channels] qqbot supervised reconnect succeeded attempt=${reconnectAttemptAtStart}`,
              );
            }
            reconnectAttempt = 0;
            ok();
            return;
          }
          if (eventType === "RESUMED") {
            await commitDurableSequence(payload);
            if (!isCurrentSocket()) return;
            readyConfirmed = true;
            connectionState = "connected";
            connectionError = undefined;
            if (reconnectAttemptAtStart > 0) {
              console.error(
                `[spark-channels] qqbot supervised reconnect succeeded attempt=${reconnectAttemptAtStart}`,
              );
            }
            reconnectAttempt = 0;
            ok();
            return;
          }
          if (eventType === "INTERACTION_CREATE") {
            const normalized = normalizeQqbotInteractionEvent({
              event_type: eventType,
              d: payload.d,
            });
            const event = normalized ? toChannelInteractionEvent(normalized) : undefined;
            if (event) await onInteraction?.(event);
            // Settlement may span an async SQLite transaction. Only advance
            // the resumable sequence after that durable boundary succeeds.
            if (isCurrentSocket()) await commitDurableSequence(payload);
            return;
          }
          if (
            eventType === "C2C_MESSAGE_CREATE" ||
            eventType === "GROUP_AT_MESSAGE_CREATE" ||
            eventType === "GROUP_MESSAGE_CREATE" ||
            eventType === "AT_MESSAGE_CREATE" ||
            eventType === "MESSAGE_CREATE"
          ) {
            const images = await materializeQqbotInboundImages(payload.d, options.fetchImpl);
            const raw = {
              event_type: eventType,
              d: appendQqbotMaterializedImages(payload.d, images),
            };
            onMessage?.(await enrichQqbotChannelQuotePreview(api, resolveToken, raw));
          }
          if (isCurrentSocket()) await commitDurableSequence(payload);
        };
        const enqueueDispatch = (payload: QqbotGatewayPayload) => {
          // Gateway dispatch sequence is ordered. Serializing callbacks keeps a
          // later event from committing past an unsettled interaction.
          dispatchChain = dispatchChain
            .then(async () => await handleDispatch(payload))
            .catch((error: unknown) => {
              failSocket(
                error instanceof Error ? error : new Error(String(error)),
                payload.t === "INTERACTION_CREATE"
                  ? "durable interaction settlement"
                  : "durable inbound receipt",
              );
            });
        };

        timeout = setTimeout(() => {
          fail(
            new Error(
              `qqbot websocket did not receive READY or RESUMED within ${connectTimeoutMs}ms`,
            ),
          );
        }, connectTimeoutMs);
        cancelPendingConnect = fail;

        socket.on("open", () => {
          // Readiness is fenced by READY/RESUMED after Identify/Resume.
        });

        socket.on("message", (data) => {
          let payload: QqbotGatewayPayload;
          try {
            payload = JSON.parse(rawDataToText(data)) as QqbotGatewayPayload;
          } catch {
            return;
          }

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
                  if (socket.readyState !== WebSocket.OPEN) return;
                  if (awaitingHeartbeatAck) {
                    failSocket(new Error("qqbot websocket heartbeat ACK timed out"), "heartbeat");
                    return;
                  }
                  try {
                    socket.send(JSON.stringify({ op: 1, d: lastSeq }));
                    awaitingHeartbeatAck = true;
                  } catch (error) {
                    failSocket(
                      error instanceof Error ? error : new Error(String(error)),
                      "heartbeat send",
                    );
                  }
                }, interval);
              }
              break;
            }
            case 0:
              enqueueDispatch(payload);
              break;
            case 7:
              failSocket(new Error("qqbot gateway requested reconnect"), "gateway reconnect");
              break;
            case 11:
              awaitingHeartbeatAck = false;
              break;
            case 9: {
              dispatchChain = dispatchChain
                .then(async () => {
                  await options.saveCursor?.(null);
                  if (!isCurrentSocket()) return;
                  sessionId = null;
                  lastSeq = null;
                  failSocket(new Error("qqbot gateway rejected the session"), "session resume");
                })
                .catch((error: unknown) => {
                  failSocket(
                    error instanceof Error ? error : new Error(String(error)),
                    "cursor invalidation",
                  );
                });
              break;
            }
            default:
              break;
          }
        });

        socket.on("error", (error) => {
          connectionError = error.message;
          if (readyConfirmed) {
            failSocket(error instanceof Error ? error : new Error(String(error)), "websocket");
            return;
          }
          fail(error instanceof Error ? error : new Error(String(error)));
        });

        socket.on("close", () => {
          clearHeartbeat();
          if (stopping || !running) {
            connectionState = "stopped";
            return;
          }
          if (!readyConfirmed) {
            fail(new Error("qqbot websocket closed before READY or RESUMED"));
            return;
          }
          connectionState = "reconnecting";
          scheduleReconnect();
        });
      });
    } catch (error) {
      if (ws === socket) cleanupSocket();
      throw error;
    }
  }

  function assertConnectAttemptActive(generation: number): void {
    if (running && !stopping && generation === connectionGeneration) return;
    throw new Error("qqbot websocket connection attempt was cancelled");
  }

  function sensitiveLogValues(): readonly (string | undefined)[] {
    return [config.client_secret, accessTokenForRedaction];
  }

  return {
    reply,
    interaction,
    image,
    messageDeliveryFacts: () => ({ replaySafety: "unsafe" }),
    async start(handler, interactionHandler) {
      if (running) return;
      running = true;
      stopping = false;
      onMessage = handler;
      onInteraction = interactionHandler ?? null;
      // Arming the supervised connector is the startup boundary. External
      // Gateway Hello latency must not hold daemon admission/restart readiness.
      void connect().catch((error) => {
        if (stopping || !running) return;
        connectionState = "degraded";
        connectionError = sanitizeQqbotConnectionError(error, sensitiveLogValues());
        console.error(
          `[spark-channels] qqbot initial connect failed` +
            ` error=${JSON.stringify(connectionError)}`,
        );
        scheduleReconnect();
      });
    },
    async stop() {
      stopping = true;
      running = false;
      connectionGeneration += 1;
      onMessage = null;
      onInteraction = null;
      clearReconnect();
      cleanupSocket(new Error("qqbot websocket stopped"));
      connectionState = "stopped";
      connectionError = undefined;
    },
    async send(recipient, text) {
      return await sendText(recipient, text);
    },
    status() {
      return {
        state: connectionState,
        ...(connectionError ? { error: connectionError } : {}),
      };
    },
  };
}

/** QQ events expose temporary attachment URLs; materialize them before cursor commit. */
export async function materializeQqbotInboundImages(
  value: unknown,
  fetchImpl?: typeof fetch,
): Promise<ChannelImage[]> {
  const sources = qqbotImageSources(value);
  if (sources.length === 0) return [];
  return await materializeChannelImages(sources, {
    fetchImpl,
    onError: (error) => {
      console.error(`[spark-channels] qqbot image skipped: ${error.message}`);
    },
  });
}

/**
 * Guild/sub-channel only: when the event has a message_reference id but no
 * preview text, fetch the referenced message before durable receipt.
 */
export async function enrichQqbotChannelQuotePreview(
  api: Pick<QqbotApiClient, "getChannelMessage">,
  resolveToken: () => Promise<string>,
  raw: unknown,
): Promise<unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const eventType =
    typeof record.event_type === "string"
      ? record.event_type.trim()
      : typeof record.t === "string"
        ? record.t.trim()
        : "";
  if (eventType !== "AT_MESSAGE_CREATE" && eventType !== "MESSAGE_CREATE") return raw;
  const payload =
    record.d && typeof record.d === "object" && !Array.isArray(record.d)
      ? (record.d as Record<string, unknown>)
      : record;
  const channelId = typeof payload.channel_id === "string" ? payload.channel_id.trim() : "";
  const reference =
    payload.message_reference &&
    typeof payload.message_reference === "object" &&
    !Array.isArray(payload.message_reference)
      ? (payload.message_reference as Record<string, unknown>)
      : undefined;
  if (!channelId || !reference) return raw;
  const messageId =
    (typeof reference.message_id === "string" && reference.message_id.trim()) ||
    (typeof reference.messageId === "string" && reference.messageId.trim()) ||
    "";
  const existingPreview =
    (typeof reference.content === "string" && reference.content.trim()) ||
    (typeof reference.preview === "string" && reference.preview.trim()) ||
    (typeof reference.text === "string" && reference.text.trim()) ||
    "";
  if (!messageId || existingPreview) return raw;
  try {
    const token = await resolveToken();
    const fetched = await api.getChannelMessage(token, channelId, messageId);
    const preview = typeof fetched?.content === "string" ? fetched.content.trim() : "";
    if (!preview) return raw;
    return {
      ...record,
      d: {
        ...payload,
        message_reference: {
          ...reference,
          content: preview,
          ...(fetched?.author ? { author: fetched.author } : {}),
          spark_quote_source: "fetched",
        },
      },
    };
  } catch {
    return raw;
  }
}

function qqbotImageSources(value: unknown): ChannelImageSource[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const attachments = (value as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((entry): ChannelImageSource[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const mediaType = typeof record.content_type === "string" ? record.content_type.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!mediaType.toLowerCase().startsWith("image/") || !url) return [];
    const size =
      typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0
        ? record.size
        : undefined;
    return [
      {
        url,
        mediaType,
        ...(typeof record.filename === "string" && record.filename.trim()
          ? { name: record.filename.trim() }
          : {}),
        ...(size !== undefined ? { size } : {}),
      },
    ];
  });
}

function appendQqbotMaterializedImages(value: unknown, images: ChannelImage[]): unknown {
  if (images.length === 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return { ...(value as Record<string, unknown>), spark_images: images };
}

function qqbotReplyDeliveryFacts(target: ChannelReplyTarget): ChannelDeliveryFacts {
  let recipient: ReturnType<typeof parseQqbotRecipient>;
  try {
    recipient = parseQqbotRecipient(target.recipient);
  } catch (error) {
    throw channelDeliveryNotSent(error);
  }
  const messageId = target.messageId?.trim();
  // QQ passive replies deduplicate a reused source msg_id + msg_seq pair. The
  // fixed sequences below survive daemon/transport recreation. Proactive and
  // channel sends expose no equivalent server idempotency key.
  return {
    replaySafety:
      messageId && (recipient.kind === "c2c" || recipient.kind === "group")
        ? "deduplicated"
        : "unsafe",
  };
}

function qqbotDeliveryResult(
  facts: ChannelDeliveryFacts,
  response: QqbotMessageResponse,
): ChannelDeliveryResult {
  const receipt = qqbotDeliveryReceipt(response);
  return { ...facts, ...(receipt ? { receipt } : {}) };
}

function qqbotDeliveryReceipt(response: QqbotMessageResponse): ChannelDeliveryReceipt | undefined {
  const messageId = response.id?.trim();
  const timestamp = response.timestamp === undefined ? undefined : String(response.timestamp);
  if (!messageId && !timestamp) return undefined;
  return {
    ...(messageId ? { messageId } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}

function stableFinalReplySequences(
  target: ReturnType<typeof parseQqbotRecipient>,
  messageId: string | undefined,
  chunkCount: number,
  finalSequence: number | undefined,
): Array<number | undefined> {
  if (!messageId || (target.kind !== "c2c" && target.kind !== "group")) {
    return Array.from({ length: chunkCount }, () => undefined);
  }
  const overflow = target.kind === "c2c" ? [1, 3] : [2, 3, 4];
  const sequences = [finalSequence, ...overflow];
  if (chunkCount > sequences.length) {
    throw new Error(
      `qqbot final reply needs ${chunkCount} passive message slots; only ${sequences.length} are available`,
    );
  }
  return sequences.slice(0, chunkCount);
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

function sanitizeQqbotConnectionError(
  error: unknown,
  sensitiveValues: readonly (string | undefined)[],
): string {
  let message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, " ")
    .trim();
  if (!message) message = "unknown error";
  for (const sensitiveValue of sensitiveValues) {
    if (!sensitiveValue) continue;
    message = message.replaceAll(sensitiveValue, "[redacted]");
  }
  message = message
    .replace(/\b(Bearer|QQBot)\s+[^\s,;]+/giu, "$1 [redacted]")
    .replace(
      /((?:access[_ -]?token|client[_ -]?secret|authorization|token|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[redacted]",
    )
    .replace(/([?&](?:access_token|client_secret|token|secret)=)[^&#\s]+/giu, "$1[redacted]");
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

type QqbotPassiveReplyKind = "ask" | "final" | "overflow";

interface QqbotPassiveReplyReservation {
  msgSeq?: number;
}

interface QqbotPassiveReplyBudget {
  reserve(
    scope: "c2c" | "group",
    recipient: string,
    messageId: string | undefined,
    kind: QqbotPassiveReplyKind,
    idempotencyKey?: string,
  ): QqbotPassiveReplyReservation | undefined;
  reserveOverflow(
    scope: "c2c" | "group",
    recipient: string,
    messageId: string | undefined,
    count: number,
  ): QqbotPassiveReplyReservation[] | undefined;
}

function createQqbotPassiveReplyBudget(): QqbotPassiveReplyBudget {
  const entries = new Map<
    string,
    {
      askCount: number;
      askIdempotencyKey?: string;
      finalReserved: boolean;
      usedSeqs: Set<number>;
      touchedAt: number;
      limit: number;
    }
  >();
  return {
    reserve(scope, recipient, messageId, kind, idempotencyKey) {
      if (!messageId) return {};
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (now - entry.touchedAt >= 60 * 60 * 1000) entries.delete(key);
      }
      const limit =
        scope === "c2c" ? QQBOT_C2C_PASSIVE_REPLY_LIMIT : QQBOT_GROUP_PASSIVE_REPLY_LIMIT;
      const key = `${scope}\0${recipient}\0${messageId}`;
      const entry = entries.get(key) ?? {
        askCount: 0,
        finalReserved: false,
        usedSeqs: new Set<number>(),
        touchedAt: now,
        limit,
      };
      if (kind !== "final" && kind !== "overflow" && entry.finalReserved) return undefined;
      let msgSeq: number;
      if (kind === "ask") {
        if (idempotencyKey && entry.askIdempotencyKey === idempotencyKey) {
          entry.touchedAt = now;
          entries.set(key, entry);
          return { msgSeq: scope === "c2c" ? 2 : 1 };
        }
        const askLimit = 1;
        if (entry.askCount >= askLimit) return undefined;
        entry.askCount += 1;
        if (idempotencyKey) entry.askIdempotencyKey = idempotencyKey;
        msgSeq = scope === "c2c" ? 2 : 1;
      } else if (kind === "final") {
        entry.finalReserved = true;
        msgSeq = limit;
      } else {
        const availableSeq = allocateUnusedPassiveSeq(entry.usedSeqs, limit);
        if (availableSeq === undefined) return undefined;
        msgSeq = availableSeq;
      }
      entry.usedSeqs.add(msgSeq);
      entry.touchedAt = now;
      entries.set(key, entry);
      return { msgSeq };
    },
    reserveOverflow(scope, recipient, messageId, count) {
      if (!Number.isSafeInteger(count) || count < 0) return undefined;
      if (count === 0) return [];
      if (!messageId) return Array.from({ length: count }, () => ({}));

      const now = Date.now();
      for (const [key, entry] of entries) {
        if (now - entry.touchedAt >= 60 * 60 * 1000) entries.delete(key);
      }
      const limit =
        scope === "c2c" ? QQBOT_C2C_PASSIVE_REPLY_LIMIT : QQBOT_GROUP_PASSIVE_REPLY_LIMIT;
      const key = `${scope}\0${recipient}\0${messageId}`;
      const entry = entries.get(key) ?? {
        askCount: 0,
        finalReserved: false,
        usedSeqs: new Set<number>(),
        touchedAt: now,
        limit,
      };
      const available = Array.from({ length: limit }, (_, index) => index + 1).filter(
        (sequence) => !entry.usedSeqs.has(sequence),
      );
      if (available.length < count) return undefined;

      const reserved = available.slice(0, count);
      for (const sequence of reserved) entry.usedSeqs.add(sequence);
      entry.touchedAt = now;
      entries.set(key, entry);
      return reserved.map((msgSeq) => ({ msgSeq }));
    },
  };
}

function allocateUnusedPassiveSeq(usedSeqs: Set<number>, limit: number): number | undefined {
  for (let seq = 1; seq <= limit; seq += 1) {
    if (!usedSeqs.has(seq)) return seq;
  }
  return undefined;
}

function reservePassiveReplyForTarget(
  budget: QqbotPassiveReplyBudget,
  target: ReturnType<typeof parseQqbotRecipient>,
  messageId: string | undefined,
  kind: QqbotPassiveReplyKind,
  idempotencyKey?: string,
): QqbotPassiveReplyReservation | undefined {
  if (target.kind === "c2c") {
    return budget.reserve("c2c", target.openid, messageId, kind, idempotencyKey);
  }
  if (target.kind === "group") {
    return budget.reserve("group", target.groupOpenid, messageId, kind, idempotencyKey);
  }
  return {};
}

function reservePassiveOverflowForTarget(
  budget: QqbotPassiveReplyBudget,
  target: ReturnType<typeof parseQqbotRecipient>,
  messageId: string | undefined,
  count: number,
): QqbotPassiveReplyReservation[] | undefined {
  if (target.kind === "c2c") {
    return budget.reserveOverflow("c2c", target.openid, messageId, count);
  }
  if (target.kind === "group") {
    return budget.reserveOverflow("group", target.groupOpenid, messageId, count);
  }
  return Array.from({ length: count }, () => ({}));
}
