/**
 * Thin QQ Bot Open Platform HTTP client (App Access Token + message APIs).
 * Protocol behavior aligned with tencent-connect/openclaw-qqbot; no OpenClaw dependency.
 */

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

export interface QqbotStreamMessageRequest {
  input_mode: "replace";
  input_state: 1 | 10;
  content_type: "markdown";
  content_raw: string;
  event_id?: string;
  msg_id?: string;
  msg_seq: number;
  index: number;
  stream_msg_id?: string;
}

export interface QqbotApiClient {
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
  sendChannelMessage(
    accessToken: string,
    channelId: string,
    content: string,
    msgId?: string,
  ): Promise<QqbotMessageResponse>;
  sendC2CStreamMessage(
    accessToken: string,
    openid: string,
    req: QqbotStreamMessageRequest,
  ): Promise<QqbotMessageResponse>;
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
  } = {},
): QqbotApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = (options.baseUrl ?? QQBOT_API_BASE).replace(/\/+$/, "");
  const tokenCache = new Map<string, TokenCacheEntry>();
  const inflight = new Map<string, Promise<string>>();

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
        const response = await fetchImpl(QQBOT_TOKEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": QQBOT_USER_AGENT,
          },
          body: JSON.stringify({ appId: normalizedAppId, clientSecret }),
        });
        const raw = await response.text();
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
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": QQBOT_USER_AGENT,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
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

  function nextMsgSeq(msgId?: string): number {
    if (!msgId) return 1;
    const timePart = Date.now() % 100_000_000;
    const random = Math.floor(Math.random() * 65536);
    return (timePart ^ random) % 65536;
  }

  function buildTextBody(content: string, msgId?: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      content,
      msg_type: 0,
      msg_seq: nextMsgSeq(msgId),
    };
    if (msgId) body.msg_id = msgId;
    return body;
  }

  return {
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
    async sendC2CStreamMessage(accessToken, openid, req) {
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
  };
}
