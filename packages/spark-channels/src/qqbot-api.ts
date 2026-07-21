/**
 * Thin QQ Bot Open Platform HTTP client (App Access Token + message APIs).
 * Protocol behavior aligned with tencent-connect/openclaw-qqbot; no OpenClaw dependency.
 */

import type { QqbotMarkdownKeyboardMessageRequest } from "./qqbot-types.ts";

export const QQBOT_API_PRODUCTION_BASE = "https://api.sgroup.qq.com";
export const QQBOT_API_SANDBOX_BASE = "https://sandbox.api.sgroup.qq.com";

export const QQBOT_API_BASE =
  (typeof process !== "undefined" ? process.env.QQBOT_BASE_URL?.replace(/\/+$/, "") : undefined) ||
  QQBOT_API_PRODUCTION_BASE;

export const QQBOT_TOKEN_URL = `${
  (typeof process !== "undefined"
    ? process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, "")
    : undefined) || "https://bots.qq.com"
}/app/getAppAccessToken`;

export const QQBOT_USER_AGENT = "SparkQQBot/0.1.0";
export const DEFAULT_QQBOT_REQUEST_TIMEOUT_MS = 30_000;

export class QqbotRequestTimeoutError extends Error {
  readonly code = "QQBOT_REQUEST_TIMEOUT";
  readonly method: string;
  readonly url: string;
  readonly timeoutMs: number;

  constructor(method: string, url: string, timeoutMs: number) {
    super(`QQ Bot request timed out after ${timeoutMs}ms: ${method} ${url}`);
    this.name = "QqbotRequestTimeoutError";
    this.method = method;
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export function resolveQqbotApiBase(
  environment: "production" | "sandbox" | undefined = "production",
): string {
  if (typeof process !== "undefined" && process.env.QQBOT_BASE_URL?.trim()) {
    return process.env.QQBOT_BASE_URL.replace(/\/+$/, "");
  }
  return environment === "sandbox" ? QQBOT_API_SANDBOX_BASE : QQBOT_API_PRODUCTION_BASE;
}
export interface QqbotMessageResponse {
  id?: string;
  timestamp?: number | string;
}

export interface QqbotMediaUploadResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
}

export type QqbotImageUploadSource = { url: string; data?: never } | { url?: never; data: string };

export interface QqbotStreamMessageRequest {
  input_mode: "replace";
  input_state: 1 | 10;
  content_type: "markdown";
  content_raw: string;
  event_id: string;
  msg_id: string;
  msg_seq: number;
  index: number;
  stream_msg_id?: string;
}

export type QqbotInteractionAckCode = 0 | 1 | 2 | 3 | 4 | 5;

export interface QqbotApiClient {
  /** Allocate a collision-free sequence for one passive-reply source message. */
  nextMessageSequence(messageId?: string): number;
  getAccessToken(appId: string, clientSecret: string): Promise<string>;
  getGatewayUrl(accessToken: string): Promise<string>;
  sendC2CMessage(
    accessToken: string,
    openid: string,
    content: string,
    msgId?: string,
  ): Promise<QqbotMessageResponse>;
  sendGroupMessage(
    accessToken: string,
    groupOpenid: string,
    content: string,
    msgId?: string,
  ): Promise<QqbotMessageResponse>;
  uploadC2CImage(
    accessToken: string,
    openid: string,
    source: QqbotImageUploadSource,
  ): Promise<QqbotMediaUploadResponse>;
  uploadGroupImage(
    accessToken: string,
    groupOpenid: string,
    source: QqbotImageUploadSource,
  ): Promise<QqbotMediaUploadResponse>;
  sendC2CImageMessage(
    accessToken: string,
    openid: string,
    fileInfo: string,
    content?: string,
    msgId?: string,
    msgSeq?: number,
  ): Promise<QqbotMessageResponse>;
  sendGroupImageMessage(
    accessToken: string,
    groupOpenid: string,
    fileInfo: string,
    content?: string,
    msgId?: string,
    msgSeq?: number,
  ): Promise<QqbotMessageResponse>;
  sendC2CMarkdownMessage(
    accessToken: string,
    openid: string,
    content: string,
    msgId?: string,
    msgSeq?: number,
  ): Promise<QqbotMessageResponse>;
  sendGroupMarkdownMessage(
    accessToken: string,
    groupOpenid: string,
    content: string,
    msgId?: string,
    msgSeq?: number,
  ): Promise<QqbotMessageResponse>;
  sendC2CMarkdownKeyboardMessage(
    accessToken: string,
    openid: string,
    request: QqbotMarkdownKeyboardMessageRequest,
  ): Promise<QqbotMessageResponse>;
  sendGroupMarkdownKeyboardMessage(
    accessToken: string,
    groupOpenid: string,
    request: QqbotMarkdownKeyboardMessageRequest,
  ): Promise<QqbotMessageResponse>;
  sendChannelMessage(
    accessToken: string,
    channelId: string,
    content: string,
    msgId?: string,
  ): Promise<QqbotMessageResponse>;
  /** Guild/sub-channel only: fetch one message by id for quote preview enrichment. */
  getChannelMessage(
    accessToken: string,
    channelId: string,
    messageId: string,
  ): Promise<QqbotChannelMessage | undefined>;
  sendC2CStreamMessage(
    accessToken: string,
    openid: string,
    req: QqbotStreamMessageRequest,
  ): Promise<QqbotMessageResponse>;
  acknowledgeInteraction(
    accessToken: string,
    interactionId: string,
    code?: QqbotInteractionAckCode,
  ): Promise<void>;
}

export interface QqbotChannelMessage {
  id?: string;
  content?: string;
  author?: {
    id?: string;
    username?: string;
  };
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

export function createQqbotApiClient(
  options: {
    fetchImpl?: typeof fetch;
    /** OpenAPI host; defaults to production (or `QQBOT_BASE_URL` when set). */
    baseUrl?: string;
    /** Application deadline shared by token, gateway, and OpenAPI requests. */
    requestTimeoutMs?: number;
  } = {},
): QqbotApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = (options.baseUrl ?? QQBOT_API_BASE).replace(/\/+$/, "");
  const requestTimeoutMs = normalizeRequestTimeoutMs(options.requestTimeoutMs);
  const tokenCache = new Map<string, TokenCacheEntry>();
  const inflight = new Map<string, Promise<string>>();
  const messageSequences = new Map<string, { next: number; touchedAt: number }>();

  async function fetchTextWithDeadline(
    method: string,
    url: string,
    init: RequestInit,
  ): Promise<{ response: Response; raw: string }> {
    const controller = new AbortController();
    const timeoutError = new QqbotRequestTimeoutError(method, url, requestTimeoutMs);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, requestTimeoutMs);
    });
    try {
      const fetchAndConsume = (async () => {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        const raw = await response.text();
        return { response, raw };
      })();
      return await Promise.race([fetchAndConsume, deadline]);
    } catch (error) {
      if (timedOut) throw timeoutError;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
    const normalizedAppId = appId.trim();
    const cached = tokenCache.get(normalizedAppId);
    const refreshAheadMs = cached
      ? Math.min(5 * 60 * 1000, Math.max(0, (cached.expiresAt - Date.now()) / 3))
      : 0;
    if (cached && Date.now() < cached.expiresAt - refreshAheadMs) {
      return cached.token;
    }
    const existing = inflight.get(normalizedAppId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const { response, raw } = await fetchTextWithDeadline("POST", QQBOT_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": QQBOT_USER_AGENT,
          },
          body: JSON.stringify({ appId: normalizedAppId, clientSecret }),
        });
        let data: { access_token?: string; expires_in?: number };
        try {
          data = JSON.parse(raw) as { access_token?: string; expires_in?: number };
        } catch (error) {
          throw new Error(
            `Failed to parse QQ Bot access_token response: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (!response.ok || !data.access_token) {
          throw new Error(
            `Failed to get QQ Bot access_token (status ${response.status}): ${raw.slice(0, 200)}`,
          );
        }
        const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
        tokenCache.set(normalizedAppId, { token: data.access_token, expiresAt });
        return data.access_token;
      } finally {
        inflight.delete(normalizedAppId);
      }
    })();
    inflight.set(normalizedAppId, promise);
    return promise;
  }

  async function apiRequest<T>(
    accessToken: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${apiBase}${path}`;
    const { response, raw } = await fetchTextWithDeadline(method, url, {
      method,
      headers: {
        Authorization: `QQBot ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": QQBOT_USER_AGENT,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let data: unknown = {};
    if (raw.trim()) {
      try {
        data = JSON.parse(raw);
      } catch (error) {
        throw new Error(
          `QQ Bot API ${method} ${path} returned non-JSON (status ${response.status}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (!response.ok) {
      throw new Error(
        `QQ Bot API ${method} ${path} failed (status ${response.status}): ${raw.slice(0, 300)}`,
      );
    }
    return data as T;
  }

  function pruneMessageSequences(now: number): void {
    for (const [key, state] of messageSequences) {
      if (now - state.touchedAt >= 60 * 60 * 1000) messageSequences.delete(key);
    }
  }

  function nextMessageSequence(msgId?: string): number {
    if (!msgId) return 1;
    const now = Date.now();
    pruneMessageSequences(now);
    const state = messageSequences.get(msgId) ?? { next: 1, touchedAt: now };
    const value = state.next;
    state.next += 1;
    state.touchedAt = now;
    messageSequences.set(msgId, state);
    return value;
  }

  function useMessageSequence(msgId: string | undefined, explicit?: number): number {
    if (explicit === undefined) return nextMessageSequence(msgId);
    if (!Number.isSafeInteger(explicit) || explicit <= 0) {
      throw new Error(`QQ Bot msg_seq must be a positive safe integer; got ${explicit}`);
    }
    if (msgId) {
      const now = Date.now();
      pruneMessageSequences(now);
      const state = messageSequences.get(msgId) ?? { next: 1, touchedAt: now };
      state.next = Math.max(state.next, explicit + 1);
      state.touchedAt = now;
      messageSequences.set(msgId, state);
    }
    return explicit;
  }

  function buildTextBody(content: string, msgId?: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      content,
      msg_type: 0,
      msg_seq: nextMessageSequence(msgId),
    };
    if (msgId) body.msg_id = msgId;
    return body;
  }

  function buildImageUploadBody(source: QqbotImageUploadSource): Record<string, unknown> {
    const url = source.url?.trim();
    const data = source.data?.trim();
    if (Boolean(url) === Boolean(data)) {
      throw new Error("QQ Bot image upload requires exactly one of url or data");
    }
    return {
      file_type: 1,
      srv_send_msg: false,
      ...(url ? { url } : { file_data: data }),
    };
  }

  function buildImageMessageBody(
    fileInfo: string,
    content?: string,
    msgId?: string,
    msgSeq?: number,
  ): Record<string, unknown> {
    if (!fileInfo.trim()) throw new Error("QQ Bot image message requires file_info");
    return {
      msg_type: 7,
      media: { file_info: fileInfo },
      msg_seq: useMessageSequence(msgId, msgSeq),
      ...(content?.trim() ? { content: content.trim() } : {}),
      ...(msgId ? { msg_id: msgId } : {}),
    };
  }

  function buildMarkdownKeyboardBody(
    request: QqbotMarkdownKeyboardMessageRequest,
  ): Record<string, unknown> {
    const body = buildMarkdownBody(request.markdown.content, request.msg_id, request.msg_seq);
    return {
      ...body,
      keyboard: request.keyboard,
      ...(request.event_id ? { event_id: request.event_id } : {}),
    };
  }

  function buildMarkdownBody(
    content: string,
    msgId?: string,
    msgSeq?: number,
  ): Record<string, unknown> {
    if (!content.trim()) {
      throw new Error("QQ Bot Markdown message requires non-empty content");
    }
    return {
      markdown: { content },
      msg_type: 2,
      msg_seq: useMessageSequence(msgId, msgSeq),
      ...(msgId ? { msg_id: msgId } : {}),
    };
  }

  return {
    nextMessageSequence,
    getAccessToken,
    async getGatewayUrl(accessToken) {
      const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway");
      if (!data.url?.trim()) throw new Error("QQ Bot /gateway response missing url");
      return data.url;
    },
    async sendC2CMessage(accessToken, openid, content, msgId) {
      return await apiRequest<QqbotMessageResponse>(
        accessToken,
        "POST",
        `/v2/users/${encodeURIComponent(openid)}/messages`,
        buildTextBody(content, msgId),
      );
    },
    async sendGroupMessage(accessToken, groupOpenid, content, msgId) {
      return await apiRequest<QqbotMessageResponse>(
        accessToken,
        "POST",
        `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`,
        buildTextBody(content, msgId),
      );
    },
    async uploadC2CImage(accessToken, openid, source) {
      return await apiRequest<QqbotMediaUploadResponse>(
        accessToken,
        "POST",
        `/v2/users/${encodeURIComponent(openid)}/files`,
        buildImageUploadBody(source),
      );
    },
    async uploadGroupImage(accessToken, groupOpenid, source) {
      return await apiRequest<QqbotMediaUploadResponse>(
        accessToken,
        "POST",
        `/v2/groups/${encodeURIComponent(groupOpenid)}/files`,
        buildImageUploadBody(source),
      );
    },
    async sendC2CImageMessage(accessToken, openid, fileInfo, content, msgId, msgSeq) {
      return await apiRequest<QqbotMessageResponse>(
        accessToken,
        "POST",
        `/v2/users/${encodeURIComponent(openid)}/messages`,
        buildImageMessageBody(fileInfo, content, msgId, msgSeq),
      );
    },
    async sendGroupImageMessage(accessToken, groupOpenid, fileInfo, content, msgId, msgSeq) {
      return await apiRequest<QqbotMessageResponse>(
        accessToken,
        "POST",
        `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`,
        buildImageMessageBody(fileInfo, content, msgId, msgSeq),
      );
    },
    async sendC2CMarkdownMessage(accessToken, openid, content, msgId, msgSeq) {
      return await apiRequest<QqbotMessageResponse>(
        accessToken,
        "POST",
        `/v2/users/${encodeURIComponent(openid)}/messages`,
        buildMarkdownBody(content, msgId, msgSeq),
      );
    },
    async sendGroupMarkdownMessage(accessToken, groupOpenid, content, msgId, msgSeq) {
      return await apiRequest<QqbotMessageResponse>(
        accessToken,
        "POST",
        `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`,
        buildMarkdownBody(content, msgId, msgSeq),
      );
    },
    async sendC2CMarkdownKeyboardMessage(accessToken, openid, request) {
      return await apiRequest<QqbotMessageResponse>(
        accessToken,
        "POST",
        `/v2/users/${encodeURIComponent(openid)}/messages`,
        buildMarkdownKeyboardBody(request),
      );
    },
    async sendGroupMarkdownKeyboardMessage(accessToken, groupOpenid, request) {
      return await apiRequest<QqbotMessageResponse>(
        accessToken,
        "POST",
        `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`,
        buildMarkdownKeyboardBody(request),
      );
    },
    async sendChannelMessage(accessToken, channelId, content, msgId) {
      return await apiRequest<QqbotMessageResponse>(
        accessToken,
        "POST",
        `/channels/${encodeURIComponent(channelId)}/messages`,
        {
          content,
          ...(msgId ? { msg_id: msgId } : {}),
        },
      );
    },
    async getChannelMessage(accessToken, channelId, messageId) {
      const trimmedChannel = channelId.trim();
      const trimmedMessage = messageId.trim();
      if (!trimmedChannel || !trimmedMessage) return undefined;
      try {
        return await apiRequest<QqbotChannelMessage>(
          accessToken,
          "GET",
          `/channels/${encodeURIComponent(trimmedChannel)}/messages/${encodeURIComponent(trimmedMessage)}`,
        );
      } catch {
        return undefined;
      }
    },
    async sendC2CStreamMessage(accessToken, openid, req) {
      useMessageSequence(req.msg_id, req.msg_seq);
      const body: Record<string, unknown> = {
        input_mode: req.input_mode,
        input_state: req.input_state,
        content_type: req.content_type,
        content_raw: req.content_raw,
        msg_seq: req.msg_seq,
        index: req.index,
      };
      if (req.event_id) body.event_id = req.event_id;
      if (req.msg_id) body.msg_id = req.msg_id;
      if (req.stream_msg_id) body.stream_msg_id = req.stream_msg_id;
      return await apiRequest<QqbotMessageResponse>(
        accessToken,
        "POST",
        `/v2/users/${encodeURIComponent(openid)}/stream_messages`,
        body,
      );
    },
    async acknowledgeInteraction(accessToken, interactionId, code = 0) {
      await apiRequest<void>(
        accessToken,
        "PUT",
        `/interactions/${encodeURIComponent(interactionId)}`,
        { code },
      );
    },
  };
}

function normalizeRequestTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_QQBOT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`QQ Bot requestTimeoutMs must be a positive finite number; got ${timeoutMs}`);
  }
  return Math.max(1, Math.floor(timeoutMs));
}
