import {
  Client,
  InfoFlowError,
  LogLevel,
  type StreamingCardSession,
} from "@core-workspace/infoflow-sdk-nodejs";
import type { InfoflowAdapterConfig } from "./types.ts";
import type { ChannelReplyStream } from "./reply.ts";

const DEFAULT_INFOFLOW_API_HOST = "https://api.im.baidu.com";

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

export interface InfoflowSdkClientLike {
  im: {
    message: InfoflowSdkMessageApi;
    streamingCard: {
      createSession(input: {
        to: string;
        answerFormat?: "text" | "markdown";
      }): Pick<
        StreamingCardSession,
        | "start"
        | "appendText"
        | "appendReasoning"
        | "notifyToolStart"
        | "notifyToolResult"
        | "complete"
        | "fail"
      >;
    };
  };
}

export interface InfoflowSdkOutbound {
  send(input: InfoflowOutboundSendInput): Promise<void>;
  openReplyStream(
    recipient: string,
    options?: { answerFormat?: "text" | "markdown" },
  ): Promise<InfoflowReplyStream | undefined>;
}

export interface InfoflowSdkOutboundOptions {
  createClient?: (config: InfoflowAdapterConfig) => InfoflowSdkClientLike;
}

/** Outer card status (star row). Inner details row uses a different label. */
export const INFOFLOW_STREAM_DONE_LABEL = "已完成";
/** Details / expandable row label — must not duplicate the outer done label. */
export const INFOFLOW_STREAM_DETAILS_LABEL = "处理过程";

/**
 * SDK-owned Infoflow outbound. `Client` owns TokenManager/cache/retry and emits
 * `InfoFlowError`; Spark deliberately does not duplicate those HTTP concerns.
 */
export function createInfoflowSdkOutbound(
  config: InfoflowAdapterConfig,
  options: InfoflowSdkOutboundOptions = {},
): InfoflowSdkOutbound {
  let client: InfoflowSdkClientLike | undefined;
  const getClient = () => (client ??= (options.createClient ?? createOfficialClient)(config));

  return {
    async send(input) {
      await sendWithSdk(getClient(), input);
    },
    async openReplyStream(recipient, streamOptions = {}) {
      const to = normalizeRecipient(recipient).platformRecipient;
      const session = getClient().im.streamingCard.createSession({
        to,
        answerFormat: streamOptions.answerFormat ?? "markdown",
      });
      if (!(await session.start())) return undefined;
      return wrapInfoflowReplyStream(session);
    },
  };
}

/**
 * Infoflow's StreamingCardSession.complete(label) writes the same label to both
 * `think_status_text` (outer star row) and `status_info` (details / 收起详情 row).
 * Patch the final contents so the details row is not a second "已完成".
 */
export function wrapInfoflowReplyStream(
  session: Pick<
    StreamingCardSession,
    "appendText" | "appendReasoning" | "notifyToolStart" | "notifyToolResult" | "complete" | "fail"
  >,
): InfoflowReplyStream {
  patchStreamingCardFinalLabels(session);
  return {
    appendText: (delta) => session.appendText(delta),
    appendReasoning: (delta) => session.appendReasoning(delta),
    notifyToolStart: (input) => session.notifyToolStart(input),
    notifyToolResult: (text) => session.notifyToolResult(text),
    complete: async (label) => {
      await session.complete(label?.trim() || INFOFLOW_STREAM_DONE_LABEL);
    },
    fail: async (message) => {
      await session.fail(message);
    },
  };
}

type StreamingCardContentsNode = { type: string; content: string };
type StreamingCardBuildContents = (opts: {
  final?: boolean;
  doneLabel?: string;
  error?: string;
}) => Record<string, StreamingCardContentsNode>;

function patchStreamingCardFinalLabels(
  session: Pick<
    StreamingCardSession,
    "appendText" | "appendReasoning" | "notifyToolStart" | "notifyToolResult" | "complete" | "fail"
  >,
): void {
  const mutable = session as typeof session & {
    buildContents?: StreamingCardBuildContents;
    __sparkPatchedFinalLabels?: boolean;
  };
  if (mutable.__sparkPatchedFinalLabels) return;
  const original = mutable.buildContents;
  if (typeof original !== "function") {
    // Fake/test sessions may omit private SDK helpers; complete() still works.
    mutable.__sparkPatchedFinalLabels = true;
    return;
  }
  mutable.buildContents = (opts) => {
    const contents = original.call(mutable, opts);
    if (opts.final && !opts.error) {
      const doneLabel = opts.doneLabel?.trim() || INFOFLOW_STREAM_DONE_LABEL;
      contents.think_status_text = { type: "text", content: doneLabel };
      contents.status_info = { type: "text", content: INFOFLOW_STREAM_DETAILS_LABEL };
    }
    return contents;
  };
  mutable.__sparkPatchedFinalLabels = true;
}

function createOfficialClient(config: InfoflowAdapterConfig): InfoflowSdkClientLike {
  const appKey = required(config.app_key, "app_key");
  const appSecret = required(config.app_secret, "app_secret");
  const agentId = required(config.app_agent_id, "app_agent_id");
  return new Client({
    appKey,
    appSecret,
    agentId,
    baseUrl: infoflowApiBaseUrl(config.endpoint),
    loggerLevel: LogLevel.warn,
  });
}

async function sendWithSdk(
  client: InfoflowSdkClientLike,
  input: InfoflowOutboundSendInput,
): Promise<void> {
  const target = normalizeRecipient(input.recipient);
  if (target.kind === "private") {
    if (input.mentionAll || input.mentionUserIds?.length) {
      throw new Error("Infoflow mentions are supported only for group messages");
    }
    const reply = privateReply(input.reply);
    switch (input.content.type) {
      case "text":
        await client.im.message.sendToUser(target.id, input.content.text, "text", reply);
        return;
      case "markdown":
        await client.im.message.sendToUser(target.id, { content: input.content.text }, "md", reply);
        return;
      case "image":
        await client.im.message.sendToUser(
          target.id,
          { content: input.content.base64 },
          "image",
          reply,
        );
        return;
    }
  }

  const reply = groupReply(input.reply);
  const mentions = uniqueNonEmpty(input.mentionUserIds ?? []);
  if (input.mentionAll || mentions.length > 0) {
    if (input.content.type === "image") {
      throw new Error("Infoflow image messages cannot be combined with mentions");
    }
    const type = input.content.type === "markdown" ? "MD" : "TEXT";
    await client.im.message.sendToGroupWithOptions({
      groupId: target.id,
      msgtype: type,
      body: [
        {
          type: "AT",
          ...(input.mentionAll ? { atall: true } : { atall: false, atuserids: mentions }),
        },
        { type, content: input.content.text },
      ],
      ...(reply ? { reply } : {}),
    });
    return;
  }

  switch (input.content.type) {
    case "text":
      await client.im.message.sendToGroup(target.id, input.content.text, "TEXT", reply);
      return;
    case "markdown":
      await client.im.message.sendToGroup(target.id, { content: input.content.text }, "MD", reply);
      return;
    case "image":
      await client.im.message.sendToGroup(
        target.id,
        { content: input.content.base64 },
        "IMAGE",
        reply,
      );
      return;
  }
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
