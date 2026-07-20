import {
  ConfigManager,
  HttpClient,
  InfoFlowError,
  LogLevel,
  MessageApi,
  StreamingCardApi,
  TokenManager,
  type StreamingCardSession,
} from "@core-workspace/infoflow-sdk-nodejs";
import { chunkInfoflowText, INFOFLOW_MAX_CARD_TEXT_LENGTH } from "./infoflow-text.ts";
import type { InfoflowAdapterConfig } from "./types.ts";
import {
  channelDeliveryNotSent,
  channelDeliveryOutcomeUnknown,
  type ChannelDeliveryReceipt,
  type ChannelDeliveryResult,
  type ChannelReplyRecovery,
  type ChannelReplyStream,
} from "./reply.ts";

const DEFAULT_INFOFLOW_API_HOST = "https://api.im.baidu.com";
const INFOFLOW_STREAM_RECOVERY_KIND = "infoflow.streaming-card.v1";
const INFOFLOW_STREAM_FINALIZE_TIMEOUT_MS = 30_000;
const INFOFLOW_STREAM_FINALIZE_POLL_MS = 10;
const INFOFLOW_STREAM_FINALIZE_ATTEMPTS = 5;
const INFOFLOW_STREAM_OVERFLOW_NOTICE =
  "\n\n> 回答超出如流卡片上限，完整内容请在后续消息或 Spark Cockpit 查看。";

export type InfoflowOutboundContent =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "image"; base64: string };

export interface InfoflowQuoteReply {
  messageId: string;
  preview: string;
  /** Required by Infoflow group quote replies; this is the robot IM id, not app agent id. */
  robotImId?: string;
  /** Required by Infoflow private quote replies. */
  secondaryMessageId?: string;
  /** Private quote sender uid. The platform convention is "0" when omitted. */
  senderId?: string;
}

export interface InfoflowOutboundSendInput {
  recipient: string;
  content: InfoflowOutboundContent;
  /** Stable local identity; Infoflow exposes no server idempotency key for this API. */
  deliveryId?: string;
  /** Group-only human user ids to mention. */
  mentionUserIds?: string[];
  mentionAll?: boolean;
  reply?: InfoflowQuoteReply;
}

export type InfoflowReplyStream = ChannelReplyStream;

interface InfoflowSdkMessageApi {
  sendToUser(
    userId: string,
    content: string | { content: string },
    msgtype?: "text" | "md" | "image" | "richtext",
    reply?: Array<{ content: string; uid: string; msgid: string; msgid2: string }>,
  ): Promise<unknown>;
  sendToGroup(
    groupId: string,
    content: string | { content: string },
    msgtype?: "TEXT" | "MD" | "IMAGE",
    reply?: { messageid: string; preview: string; imid: string },
  ): Promise<unknown>;
  sendToGroupWithOptions(input: {
    groupId: string;
    msgtype: "TEXT" | "MD" | "IMAGE";
    body: Array<{
      type: "TEXT" | "MD" | "IMAGE" | "AT";
      content?: string;
      atall?: boolean;
      atuserids?: string[];
    }>;
    reply?: { messageid: string; preview: string; imid: string };
  }): Promise<unknown>;
}

type InfoflowStreamingSession = Pick<
  StreamingCardSession,
  | "start"
  | "appendText"
  | "appendReasoning"
  | "notifyToolStart"
  | "notifyToolResult"
  | "complete"
  | "fail"
>;

export interface InfoflowSdkClientLike {
  im: {
    message: InfoflowSdkMessageApi;
    streamingCard: {
      createSession(input: {
        to: string;
        answerFormat?: "text" | "markdown";
      }): InfoflowStreamingSession;
      update(input: {
        to: string;
        modifyToken: string;
        contents: Record<string, { type: "text"; content: string }>;
        groupVersion?: number;
      }): Promise<{ ok: boolean; error?: string }>;
    };
  };
}

export interface InfoflowSdkOutbound {
  send(input: InfoflowOutboundSendInput): Promise<void>;
  /** Receipt-aware seam used by the durable registry. */
  sendWithReceipt?(input: InfoflowOutboundSendInput): Promise<ChannelDeliveryResult>;
  openReplyStream(
    recipient: string,
    options?: { answerFormat?: "text" | "markdown" },
  ): Promise<InfoflowReplyStream | undefined>;
  recoverReply(input: {
    recipient: string;
    text: string;
    recovery: ChannelReplyRecovery;
  }): Promise<void>;
}

export interface InfoflowSdkOutboundOptions {
  createClient?: (config: InfoflowAdapterConfig) => InfoflowSdkClientLike;
  /** Single-attempt HTTP mutation seam shared by ordinary messages and streaming cards. */
  fetch?: typeof globalThis.fetch;
  /** Test seam; production delegates token caching to the SDK TokenManager. */
  accessTokenProvider?: () => Promise<string>;
}

interface InfoflowHttpRequestOptions {
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  params?: Record<string, InfoflowQueryValue | readonly InfoflowQueryValue[] | null | undefined>;
  data?: unknown;
  headers?: Record<string, string>;
  needToken?: boolean;
  timeout?: number;
  logId?: string;
}

type InfoflowQueryValue = string | number | boolean | bigint;

interface InfoflowHttpResponse<T = unknown> {
  code?: string;
  data?: T & { errcode?: number; errmsg?: string };
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}

/** SDK schema adapter whose public request method never retries a message mutation. */
export class SingleAttemptInfoflowHttpClient extends HttpClient {
  readonly #config: ConfigManager;
  readonly #fetch: typeof globalThis.fetch;
  readonly #accessTokenProvider: () => Promise<string>;

  constructor(
    config: ConfigManager,
    tokenManager: TokenManager,
    options: Pick<InfoflowSdkOutboundOptions, "fetch" | "accessTokenProvider"> = {},
  ) {
    super(config, tokenManager);
    this.#config = config;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#accessTokenProvider =
      options.accessTokenProvider ?? (() => tokenManager.getAccessToken());
  }

  override async request<T = unknown>(
    options: InfoflowHttpRequestOptions,
  ): Promise<InfoflowHttpResponse<T>> {
    const {
      path,
      method = "GET",
      params,
      data,
      headers: suppliedHeaders = {},
      needToken = true,
      timeout = this.#config.getTimeout(),
      logId = generateInfoflowLogId(),
    } = options;
    const url = new URL(`${this.#config.getBaseUrl()}${path}`);
    appendInfoflowQuery(url, params);
    const headers = new Headers(suppliedHeaders);
    if (needToken) {
      let accessToken: string;
      try {
        accessToken = await this.#accessTokenProvider();
      } catch (error) {
        throw channelDeliveryNotSent(error);
      }
      headers.set("Authorization", `Bearer-${accessToken}`);
    }
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    headers.set("LOGID", logId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      // Every failure from this point is outcome-unknown: the write may have reached Infoflow.
      const response = await this.#fetch(url, {
        method,
        headers,
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: controller.signal,
      });
      const text = await response.text();
      const result = text ? parseInfoflowMessageResponse<T>(text) : {};
      if (!response.ok) {
        throw new Error(
          `Infoflow message request failed with HTTP ${response.status}: ${response.statusText}`,
        );
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Outer card status (star row). Inner details row uses a different label. */
export const INFOFLOW_STREAM_DONE_LABEL = "已完成";
/** Details / expandable row label — must not duplicate the outer done label. */
export const INFOFLOW_STREAM_DETAILS_LABEL = "处理过程";

/**
 * SDK-schema Infoflow outbound. Ordinary message mutations use the SDK's
 * `MessageApi` with a single-attempt HTTP client so Spark remains the only
 * retry-policy owner; streaming cards retain the official
 * `StreamingCardApi` / `StreamingCardSession` lifecycle on the same transport.
 */
export function createInfoflowSdkOutbound(
  config: InfoflowAdapterConfig,
  options: InfoflowSdkOutboundOptions = {},
): InfoflowSdkOutbound {
  let client: InfoflowSdkClientLike | undefined;
  const getClient = () =>
    (client ??= options.createClient
      ? options.createClient(config)
      : createSingleAttemptInfoflowClient(config, options));
  const getMessageApi = () => getClient().im.message;
  const sendWithReceipt = async (
    input: InfoflowOutboundSendInput,
  ): Promise<ChannelDeliveryResult> => {
    let activeMessageApi: InfoflowSdkMessageApi;
    try {
      activeMessageApi = getMessageApi();
    } catch (error) {
      // Credential validation and client construction are pre-dispatch.
      throw channelDeliveryNotSent(error);
    }
    // One durable delivery owns at most one non-idempotent Infoflow mutation.
    // The installed SDK does not document an ordinary-message size limit or a
    // caller-provided idempotency key, so splitting here would make a partial
    // success impossible to retry safely.
    return await sendWithSdk(activeMessageApi, input);
  };

  return {
    async send(input) {
      await sendWithReceipt(input);
    },
    sendWithReceipt,
    async openReplyStream(recipient, streamOptions = {}) {
      const to = normalizeRecipient(recipient).platformRecipient;
      const answerFormat = streamOptions.answerFormat ?? "markdown";
      const session = getClient().im.streamingCard.createSession({
        to,
        answerFormat,
      });
      let started: boolean;
      try {
        started = await session.start();
      } catch (error) {
        throw channelDeliveryOutcomeUnknown(error);
      }
      if (!started) {
        // The official SDK catches every create failure (including a response
        // timeout after the request may have arrived) and collapses it to
        // `false`. A normal-message fallback could therefore create both a card
        // and a message. Fail closed instead.
        throw channelDeliveryOutcomeUnknown(
          new Error("Infoflow streaming card create outcome is unknown"),
        );
      }
      return wrapInfoflowReplyStream(session, infoflowStreamRecovery(session, to, answerFormat), {
        sendOverflow: async (text) => {
          await sendWithSdk(getMessageApi(), {
            recipient,
            content: answerFormat === "text" ? { type: "text", text } : { type: "markdown", text },
          });
        },
      });
    },
    async recoverReply(input) {
      const recovery = parseInfoflowStreamRecovery(input.recovery);
      const to = normalizeRecipient(input.recipient).platformRecipient;
      if (recovery.to !== to) {
        throw new Error("Infoflow stream recovery recipient does not match reply target");
      }
      const { primary, overflow } = partitionInfoflowStreamText(input.text);
      const answerField = recovery.answerFormat === "text" ? "ai_text" : "ai_markdown";
      const result = await getClient().im.streamingCard.update({
        to,
        modifyToken: recovery.modifyToken,
        contents: {
          [answerField]: {
            type: "text",
            // Keep the readable prefix. The SDK's own truncate keeps the tail,
            // which hides the start of long replies; recovery must not repeat that.
            content: overflow ? `${primary}${INFOFLOW_STREAM_OVERFLOW_NOTICE}` : primary,
          },
          status_info: { type: "text", content: INFOFLOW_STREAM_DETAILS_LABEL },
          think_status_text: { type: "text", content: INFOFLOW_STREAM_DONE_LABEL },
          status_info_1_install: { type: "text", content: "1" },
          flex_item_status_info_1_install: { type: "text", content: "1" },
          dc_print_end: { type: "text", content: "1" },
        },
        ...(to.startsWith("group:")
          ? {
              // The API requires a caller-maintained monotonically increasing
              // version. Epoch seconds remain within signed 32-bit range today,
              // while the durable retry backoff guarantees a later retry gets a
              // newer value if the platform update succeeded but local ack did not.
              groupVersion: Math.max(recovery.nextGroupVersion, Math.floor(Date.now() / 1_000)),
            }
          : {}),
      });
      if (!result.ok) {
        throw new Error(`Infoflow stream recovery failed: ${result.error ?? "update failed"}`);
      }
      // A recovery handle proves only that the card can be updated. It cannot
      // prove whether the prior completion already sent an ordinary overflow
      // message before a crash or lost local acknowledgement, so replaying the
      // overflow here could duplicate it. The full answer remains in Spark's
      // durable session and the card points users to Cockpit.
    },
  };
}

export interface WrapInfoflowReplyStreamOptions {
  /** Deliver all answer text past the card budget in one ordinary mutation. */
  sendOverflow?: (text: string) => Promise<void>;
}

/**
 * Infoflow's streaming template nests process details under the outer status row.
 * Keep the inner process installed so one outer disclosure click reveals it, and
 * keep the completed outer/inner labels distinct.
 *
 * The card is the single user-visible reply for the first budgeted chunk:
 * progress, tools, reasoning, and the final answer update in place. Overflow
 * past {@link INFOFLOW_MAX_CARD_TEXT_LENGTH} is sent as at most one follow-up
 * message. The daemon skips a second sendReply when this stream completes
 * successfully.
 */
export function wrapInfoflowReplyStream(
  session: InfoflowStreamingSession,
  deliveryRecovery?: ChannelReplyRecovery,
  options: WrapInfoflowReplyStreamOptions = {},
): InfoflowReplyStream {
  patchStreamingCardPresentation(session);
  let answerText = "";
  const mutableAnswer = session as InfoflowStreamingSession & { answerText?: string };

  const setAnswerText = (text: string) => {
    answerText = text;
    mutableAnswer.answerText = text;
  };

  return {
    ...(deliveryRecovery ? { deliveryRecovery } : {}),
    answerMode: "inline",
    // Execution commentary belongs in thinking_aio — mixing it into ai_markdown
    // burns the 6000-char card budget and makes mid-stream truncations worse.
    appendProgress: (delta) => session.appendReasoning(delta),
    appendText: (delta) => {
      if (!delta) return;
      answerText += delta;
      session.appendText(delta);
    },
    replaceText: (text) => {
      answerText = text;
      mutableAnswer.answerText = text;
      const schedule = (session as InfoflowStreamSessionState & { scheduleFlush?: () => void })
        .scheduleFlush;
      if (typeof schedule === "function") schedule.call(session);
    },
    appendReasoning: (delta) => session.appendReasoning(delta),
    notifyToolStart: (input) => session.notifyToolStart(input),
    notifyToolResult: (text) => session.notifyToolResult(text),
    complete: async (label) => {
      const doneLabel = label?.trim() || INFOFLOW_STREAM_DONE_LABEL;
      const { primary, overflow } = partitionInfoflowStreamText(answerText);
      // Force the card to keep the readable prefix. The SDK truncate keeps the
      // tail, which would hide the start of long Chinese/Markdown replies.
      setAnswerText(overflow ? `${primary}${INFOFLOW_STREAM_OVERFLOW_NOTICE}` : primary);
      await finalizeInfoflowStream(session, { doneLabel });
      if (overflow) {
        if (!options.sendOverflow) {
          throw channelDeliveryOutcomeUnknown(
            new Error("Infoflow stream overflow sender is unavailable"),
          );
        }
        try {
          await options.sendOverflow(overflow);
        } catch (error) {
          // The card already exists, so even a pre-dispatch overflow failure is
          // not a `not-sent` failure for the overall inline delivery. Never let
          // the daemon fall back to a second full-answer message.
          throw channelDeliveryOutcomeUnknown(error);
        }
      }
    },
    fail: async (message) => {
      await finalizeInfoflowStream(session, { error: message });
    },
  };
}

type InfoflowStreamSessionState = InfoflowStreamingSession & {
  isFlushing?: unknown;
  flushQueued?: unknown;
  flushTimer?: ReturnType<typeof setTimeout> | null;
  cancelFlushTimer?: () => void;
  flushNow?: (opts: { final?: boolean; doneLabel?: string; error?: string }) => Promise<void>;
  done?: boolean;
  failed?: boolean;
  updateFailCount?: number;
  answerText?: string;
};

/**
 * The official SDK can drop a final flush when `complete()` races an in-flight
 * throttled update: it sets `done=true`, queues via `flushQueued`, then the
 * in-flight flush refuses to re-run final because `done` is already set. Cancel
 * the throttle timer, wait for idle, and retry `flushNow({ final: true })`.
 */
async function finalizeInfoflowStream(
  session: InfoflowStreamingSession,
  opts: { doneLabel?: string; error?: string },
): Promise<void> {
  const state = session as InfoflowStreamSessionState;
  cancelInfoflowFlushTimer(state);
  await waitForInfoflowStreamIdle(session);

  if (typeof state.flushNow === "function") {
    state.done = true;
    state.failed = false;
    state.updateFailCount = 0;
    const finalOpts = opts.error
      ? { final: true as const, error: opts.error }
      : { final: true as const, doneLabel: opts.doneLabel ?? INFOFLOW_STREAM_DONE_LABEL };
    for (let attempt = 0; attempt < INFOFLOW_STREAM_FINALIZE_ATTEMPTS; attempt += 1) {
      state.flushQueued = false;
      await state.flushNow(finalOpts);
      await waitForInfoflowStreamIdle(session);
      if (state.flushQueued !== true) break;
    }
    if (state.flushQueued === true) {
      throw new Error("Infoflow stream finalization lost the final card update to a flush race");
    }
  } else if (opts.error) {
    await session.fail(opts.error);
  } else {
    await session.complete(opts.doneLabel ?? INFOFLOW_STREAM_DONE_LABEL);
  }

  assertInfoflowStreamFinalUpdate(session, opts.error ? "failure" : "completion");
}

function cancelInfoflowFlushTimer(state: InfoflowStreamSessionState): void {
  if (typeof state.cancelFlushTimer === "function") {
    state.cancelFlushTimer();
    return;
  }
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
}

async function waitForInfoflowStreamIdle(session: InfoflowStreamingSession): Promise<void> {
  const state = session as InfoflowStreamSessionState;
  const deadline = Date.now() + INFOFLOW_STREAM_FINALIZE_TIMEOUT_MS;
  while (state.isFlushing === true) {
    if (Date.now() >= deadline) {
      throw new Error("Infoflow stream finalization timed out waiting for an in-flight update");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, INFOFLOW_STREAM_FINALIZE_POLL_MS));
  }
}

function assertInfoflowStreamFinalUpdate(
  session: InfoflowStreamingSession,
  operation: "completion" | "failure",
): void {
  const state = session as InfoflowStreamingSession & {
    failed?: unknown;
    updateFailCount?: unknown;
  };
  if (
    state.failed === true ||
    (typeof state.updateFailCount === "number" && state.updateFailCount > 0)
  ) {
    throw new Error(`Infoflow stream ${operation} update failed`);
  }
}

function infoflowStreamRecovery(
  session: InfoflowStreamingSession,
  to: string,
  answerFormat: "text" | "markdown",
): ChannelReplyRecovery | undefined {
  const state = session as InfoflowStreamingSession & {
    modifyToken?: unknown;
    groupVersion?: unknown;
  };
  if (typeof state.modifyToken !== "string" || !state.modifyToken.trim()) return undefined;
  const groupVersion =
    typeof state.groupVersion === "number" && Number.isFinite(state.groupVersion)
      ? Math.floor(state.groupVersion)
      : 111;
  return {
    kind: INFOFLOW_STREAM_RECOVERY_KIND,
    data: {
      to,
      modifyToken: state.modifyToken,
      answerFormat,
      nextGroupVersion: Math.max(112, groupVersion + 1),
    },
  };
}

function parseInfoflowStreamRecovery(recovery: ChannelReplyRecovery): {
  to: string;
  modifyToken: string;
  answerFormat: "text" | "markdown";
  nextGroupVersion: number;
} {
  const { data } = recovery;
  if (
    recovery.kind !== INFOFLOW_STREAM_RECOVERY_KIND ||
    typeof data.to !== "string" ||
    typeof data.modifyToken !== "string" ||
    (data.answerFormat !== "text" && data.answerFormat !== "markdown") ||
    typeof data.nextGroupVersion !== "number" ||
    !Number.isFinite(data.nextGroupVersion)
  ) {
    throw new Error("Invalid Infoflow stream recovery handle");
  }
  return {
    to: data.to,
    modifyToken: data.modifyToken,
    answerFormat: data.answerFormat,
    nextGroupVersion: Math.floor(data.nextGroupVersion),
  };
}

type StreamingCardContentsNode = { type: string; content: string };
type StreamingCardBuildContents = (opts: {
  final?: boolean;
  doneLabel?: string;
  error?: string;
}) => Record<string, StreamingCardContentsNode>;

function patchStreamingCardPresentation(session: InfoflowStreamingSession): void {
  const mutable = session as typeof session & {
    buildContents?: StreamingCardBuildContents;
    __sparkPatchedPresentation?: boolean;
  };
  if (mutable.__sparkPatchedPresentation) return;
  const original = mutable.buildContents;
  if (typeof original !== "function") {
    // Fake/test sessions may omit private SDK helpers; public stream methods still work.
    mutable.__sparkPatchedPresentation = true;
    return;
  }
  mutable.buildContents = (opts) => {
    const contents = original.call(mutable, opts);
    contents.status_info_1_install = { type: "text", content: "1" };
    contents.flex_item_status_info_1_install = { type: "text", content: "1" };
    if (opts.final && !opts.error) {
      const doneLabel = opts.doneLabel?.trim() || INFOFLOW_STREAM_DONE_LABEL;
      contents.think_status_text = { type: "text", content: doneLabel };
      contents.status_info = { type: "text", content: INFOFLOW_STREAM_DETAILS_LABEL };
    }
    return contents;
  };
  mutable.__sparkPatchedPresentation = true;
}

function partitionInfoflowStreamText(text: string): { primary: string; overflow: string } {
  const normalized = text.replace(/\r\n/gu, "\n").trim();
  if (!normalized) return { primary: "", overflow: "" };
  if (normalized.length <= INFOFLOW_MAX_CARD_TEXT_LENGTH) {
    return { primary: normalized, overflow: "" };
  }
  const cardBudget = INFOFLOW_MAX_CARD_TEXT_LENGTH - INFOFLOW_STREAM_OVERFLOW_NOTICE.length;
  const primary = chunkInfoflowText(normalized, cardBudget)[0] ?? normalized;
  if (primary.length === normalized.length) return { primary, overflow: "" };
  // `chunkInfoflowText` always returns a trimmed prefix. Slice the original
  // normalized text at that prefix so the remainder stays one message instead
  // of becoming several independently retryable side effects.
  return {
    primary,
    overflow: normalized.slice(primary.length).trimStart(),
  };
}

function createSingleAttemptInfoflowClient(
  config: InfoflowAdapterConfig,
  options: Pick<InfoflowSdkOutboundOptions, "fetch" | "accessTokenProvider">,
): InfoflowSdkClientLike {
  const appKey = required(config.app_key, "app_key");
  const appSecret = required(config.app_secret, "app_secret");
  const agentId = required(config.app_agent_id, "app_agent_id");
  const configManager = new ConfigManager({
    appKey,
    appSecret,
    baseUrl: infoflowApiBaseUrl(config.endpoint),
    loggerLevel: LogLevel.warn,
  });
  const tokenManager = new TokenManager(configManager);
  const httpClient = new SingleAttemptInfoflowHttpClient(configManager, tokenManager, options);
  const logger = configManager.getLogger();
  return {
    im: {
      message: new MessageApi(httpClient, logger, agentId),
      streamingCard: new StreamingCardApi(httpClient, logger),
    },
  };
}

async function sendWithSdk(
  client: InfoflowSdkClientLike | InfoflowSdkMessageApi,
  input: InfoflowOutboundSendInput,
): Promise<ChannelDeliveryResult> {
  const messageApi = "im" in client ? client.im.message : client;
  let send: () => Promise<unknown>;
  try {
    send = prepareInfoflowSdkSend(messageApi, input);
  } catch (error) {
    // All validation in prepareInfoflowSdkSend happens before provider dispatch.
    throw channelDeliveryNotSent(error);
  }
  const receipt = normalizeInfoflowReceipt(await send());
  return { replaySafety: "unsafe", receipt };
}

function prepareInfoflowSdkSend(
  messageApi: InfoflowSdkMessageApi,
  input: InfoflowOutboundSendInput,
): () => Promise<unknown> {
  const target = normalizeRecipient(input.recipient);
  const content = input.content;
  if (target.kind === "private") {
    if (input.mentionAll || input.mentionUserIds?.length) {
      throw new Error("Infoflow mentions are supported only for group messages");
    }
    const reply = privateReply(input.reply);
    switch (content.type) {
      case "text":
        return () => messageApi.sendToUser(target.id, content.text, "text", reply);
      case "markdown":
        return () => messageApi.sendToUser(target.id, { content: content.text }, "md", reply);
      case "image":
        return () => messageApi.sendToUser(target.id, { content: content.base64 }, "image", reply);
    }
  }

  const reply = groupReply(input.reply);
  const mentions = uniqueNonEmpty(input.mentionUserIds ?? []);
  if (input.mentionAll || mentions.length > 0) {
    if (content.type === "image") {
      throw new Error("Infoflow image messages cannot be combined with mentions");
    }
    const type = content.type === "markdown" ? "MD" : "TEXT";
    return () =>
      messageApi.sendToGroupWithOptions({
        groupId: target.id,
        msgtype: type,
        body: [
          {
            type: "AT",
            ...(input.mentionAll ? { atall: true } : { atall: false, atuserids: mentions }),
          },
          { type, content: content.text },
        ],
        ...(reply ? { reply } : {}),
      });
  }

  switch (content.type) {
    case "text":
      return () => messageApi.sendToGroup(target.id, content.text, "TEXT", reply);
    case "markdown":
      return () => messageApi.sendToGroup(target.id, { content: content.text }, "MD", reply);
    case "image":
      return () => messageApi.sendToGroup(target.id, { content: content.base64 }, "IMAGE", reply);
  }
}

function generateInfoflowLogId(): string {
  return `${Date.now()}${Math.random().toString().slice(2, 11)}`;
}

function parseInfoflowMessageResponse<T>(text: string): InfoflowHttpResponse<T> {
  const bigintSafeText = text.replace(
    /"(messageid|msgseqid)"\s*:\s*(-?\d{15,})/gu,
    (_match, field: string, value: string) => `"${field}":"${value}"`,
  );
  return JSON.parse(bigintSafeText) as InfoflowHttpResponse<T>;
}

function appendInfoflowQuery(
  url: URL,
  params:
    | Record<string, InfoflowQueryValue | readonly InfoflowQueryValue[] | null | undefined>
    | undefined,
): void {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) url.searchParams.append(key, String(entry));
      continue;
    }
    url.searchParams.set(key, String(value as InfoflowQueryValue));
  }
}

function normalizeInfoflowReceipt(receipt: unknown): ChannelDeliveryReceipt {
  if (typeof receipt !== "object" || receipt === null) {
    throw new Error("Infoflow SDK send returned no durable message receipt");
  }
  const record = receipt as Record<string, unknown>;
  if (typeof record.msgkey === "string" && record.msgkey.trim()) {
    return { messageKey: record.msgkey };
  }
  const messageId = infoflowReceiptId(record.messageid);
  const messageSequence = infoflowReceiptId(record.msgseqid);
  if (messageId !== undefined && messageSequence !== undefined) {
    return { messageId, messageSequence };
  }
  // The request completed but the receipt is malformed; its external outcome is unknown.
  throw new Error("Infoflow SDK send returned no durable message receipt");
}

function infoflowReceiptId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : undefined;
}

function privateReply(
  reply: InfoflowQuoteReply | undefined,
): Array<{ content: string; uid: string; msgid: string; msgid2: string }> | undefined {
  if (!reply) return undefined;
  const msgid2 = required(reply.secondaryMessageId, "reply.secondaryMessageId");
  return [
    {
      content: required(reply.preview, "reply.preview"),
      uid: reply.senderId?.trim() || "0",
      msgid: required(reply.messageId, "reply.messageId"),
      msgid2,
    },
  ];
}

function groupReply(
  reply: InfoflowQuoteReply | undefined,
): { messageid: string; preview: string; imid: string } | undefined {
  if (!reply) return undefined;
  return {
    messageid: required(reply.messageId, "reply.messageId"),
    preview: required(reply.preview, "reply.preview"),
    imid: required(reply.robotImId, "reply.robotImId"),
  };
}

function normalizeRecipient(recipient: string): {
  kind: "private" | "group";
  id: string;
  platformRecipient: string;
} {
  const target = recipient.replace(/^infoflow:/iu, "").trim();
  if (!target) throw new Error("Infoflow recipient is required");
  const group = target.match(/^group:(.+)$/iu);
  if (!group) return { kind: "private", id: target, platformRecipient: target };
  const id = group[1]?.trim();
  if (!id) throw new Error("Infoflow group recipient is required");
  return { kind: "group", id, platformRecipient: `group:${id}` };
}

function infoflowApiBaseUrl(endpoint: string | undefined): string {
  const raw = endpoint?.trim().replace(/\/+$/u, "") || DEFAULT_INFOFLOW_API_HOST;
  const host = /^https?:\/\//u.test(raw) ? raw : `https://${raw}`;
  return /\/api\/v\d+$/u.test(host) ? host : `${host}/api/v1`;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function required(value: string | undefined, field: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`Infoflow SDK outbound requires ${field}`);
  return text;
}

/** Keep SDK diagnostics recognizable without leaking token or HTTP payloads. */
export function infoflowSdkErrorMessage(error: unknown): string {
  if (error instanceof InfoFlowError) return `Infoflow SDK error ${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
