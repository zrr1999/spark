import type { QqbotApiClient } from "./qqbot-api.ts";
import type { ChannelReplyStream, ChannelReplyTarget } from "./reply.ts";

const QQBOT_STREAM_FLUSH_MS = 500;

export interface QqbotC2CReplyStreamOptions {
  api: QqbotApiClient;
  resolveToken: () => Promise<string>;
  openid: string;
  messageId: string;
  /** Reserve the durable final passive-reply sequence on first network flush. */
  reserveFinalSeq: () => number;
  /** Test seam for flush scheduling. */
  flushDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
}

/**
 * QQ C2C native stream_messages surface: one markdown body that replaces in
 * place until input_state=10. Group/channel have no equivalent API.
 */
export function createQqbotC2CReplyStream(options: QqbotC2CReplyStreamOptions): ChannelReplyStream {
  const flushDelayMs = options.flushDelayMs ?? QQBOT_STREAM_FLUSH_MS;
  const schedule =
    options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelSchedule =
    options.cancelSchedule ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let answer = "";
  let index = 0;
  let streamMsgId: string | undefined;
  let msgSeq: number | undefined;
  let pendingTimer: unknown;
  let flushChain: Promise<void> = Promise.resolve();
  let finished = false;

  const enqueueFlush = (final: boolean, content: string) => {
    flushChain = flushChain.then(async () => {
      if (finished && !final) return;
      const raw = ensureStreamMarkdown(content);
      if (!raw.trim() && !final) return;
      msgSeq ??= options.reserveFinalSeq();
      const token = await options.resolveToken();
      const response = await options.api.sendC2CStreamMessage(token, options.openid, {
        input_mode: "replace",
        input_state: final ? 10 : 1,
        content_type: "markdown",
        content_raw: raw,
        event_id: options.messageId,
        msg_id: options.messageId,
        msg_seq: msgSeq,
        index,
        ...(streamMsgId ? { stream_msg_id: streamMsgId } : {}),
      });
      index += 1;
      const nextId = response.id?.trim();
      if (nextId) streamMsgId = nextId;
      if (final) finished = true;
    });
    return flushChain;
  };

  const scheduleFlush = () => {
    if (finished || pendingTimer !== undefined) return;
    pendingTimer = schedule(() => {
      pendingTimer = undefined;
      void enqueueFlush(false, answer).catch((error) => {
        console.error("[spark-channels] qqbot c2c stream flush failed", error);
      });
    }, flushDelayMs);
  };

  const clearPending = () => {
    if (pendingTimer === undefined) return;
    cancelSchedule(pendingTimer);
    pendingTimer = undefined;
  };

  return {
    answerMode: "inline",
    appendText(delta) {
      if (finished || !delta) return;
      answer += delta;
      scheduleFlush();
    },
    // Keep tool/progress off the C2C stream body; Cockpit/TUI remain the
    // process surfaces. The stream only carries the final answer prose.
    notifyToolStart() {},
    notifyToolResult() {},
    async complete() {
      clearPending();
      await enqueueFlush(true, answer);
    },
    async fail(message) {
      clearPending();
      const failureText = message.trim() || "处理失败，请稍后重试";
      if (!answer.trim()) answer = failureText;
      await enqueueFlush(true, answer);
    },
  };
}

export function tryCreateQqbotC2CReplyStream(input: {
  target: ChannelReplyTarget;
  api: QqbotApiClient;
  resolveToken: () => Promise<string>;
  reserveFinalSeq: (messageId: string) => number | undefined;
}): ChannelReplyStream | undefined {
  const recipient = input.target.recipient.trim();
  const messageId = input.target.messageId?.trim();
  if (!messageId) return undefined;
  const match = /^c2c:(.+)$/iu.exec(recipient);
  const openid = match?.[1]?.trim();
  if (!openid) return undefined;
  return createQqbotC2CReplyStream({
    api: input.api,
    resolveToken: input.resolveToken,
    openid,
    messageId,
    reserveFinalSeq: () => {
      const msgSeq = input.reserveFinalSeq(messageId);
      if (msgSeq === undefined) {
        throw new Error("qqbot passive reply budget exhausted before c2c stream");
      }
      return msgSeq;
    },
  });
}

/** QQ final stream frames require a trailing newline for markdown. */
function ensureStreamMarkdown(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "\n";
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}
