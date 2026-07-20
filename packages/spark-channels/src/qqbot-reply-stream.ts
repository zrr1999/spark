import type { QqbotApiClient } from "./qqbot-api.ts";
import { QQBOT_MARKDOWN_MAX_BYTES, chunkQqbotMarkdownText } from "./qqbot-markdown.ts";
import {
  channelDeliveryNotSent,
  type ChannelReplyStream,
  type ChannelReplyTarget,
} from "./reply.ts";

const QQBOT_STREAM_FLUSH_MS = 500;
/** Platform stream frames idle out if no update arrives for too long during tool waits. */
const QQBOT_STREAM_KEEPALIVE_MS = 10_000;

export interface QqbotC2CReplyStreamOptions {
  api: QqbotApiClient;
  resolveToken: () => Promise<string>;
  openid: string;
  messageId: string;
  /** Reserve the durable final passive-reply sequence on first network flush. */
  reserveFinalSeq: () => number;
  /** Test seam for flush scheduling. */
  flushDelayMs?: number;
  keepaliveDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  /**
   * Optional follow-up sender used when the final answer exceeds one markdown
   * frame. The stream finalizes the first chunk in place; remaining chunks are
   * delivered as ordinary passive markdown replies.
   */
  sendFollowUpMarkdown?: (content: string) => Promise<void>;
}

/**
 * QQ C2C native stream_messages surface: one markdown body that replaces in
 * place until input_state=10. Group/channel have no equivalent API.
 */
export function createQqbotC2CReplyStream(options: QqbotC2CReplyStreamOptions): ChannelReplyStream {
  const flushDelayMs = options.flushDelayMs ?? QQBOT_STREAM_FLUSH_MS;
  const keepaliveDelayMs = options.keepaliveDelayMs ?? QQBOT_STREAM_KEEPALIVE_MS;
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
  let keepaliveTimer: unknown;
  let flushChain: Promise<void> = Promise.resolve();
  let finished = false;
  let lastFlushError: unknown;

  const enqueueFlush = (final: boolean, content: string, keepalive = false) => {
    const run = async () => {
      if (finished && !final) return;
      const raw = ensureStreamMarkdown(content);
      if (!raw.trim() && !final && !keepalive) return;
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
      lastFlushError = undefined;
      if (final) finished = true;
    };

    // Keep the serial chain alive after intermediate failures so `complete()`
    // can still deliver the terminal input_state=10 frame with the full answer.
    // Callers await `attempt` for the real error; never leave a second rejected
    // promise on `flushChain` (that becomes an unhandled rejection).
    const attempt = flushChain.then(run, run);
    flushChain = attempt.catch((error) => {
      lastFlushError = error;
      if (!final) {
        console.error("[spark-channels] qqbot c2c stream flush failed", error);
      }
    });
    return attempt;
  };

  const clearPending = () => {
    if (pendingTimer !== undefined) {
      cancelSchedule(pendingTimer);
      pendingTimer = undefined;
    }
  };

  const clearKeepalive = () => {
    if (keepaliveTimer === undefined) return;
    cancelSchedule(keepaliveTimer);
    keepaliveTimer = undefined;
  };

  const armKeepalive = () => {
    if (finished) return;
    clearKeepalive();
    keepaliveTimer = schedule(() => {
      keepaliveTimer = undefined;
      if (finished) return;
      void enqueueFlush(false, answer, true).catch(() => {
        // enqueueFlush already records/logs intermediate failures.
      });
      armKeepalive();
    }, keepaliveDelayMs);
  };

  const scheduleFlush = () => {
    if (finished || pendingTimer !== undefined) return;
    pendingTimer = schedule(() => {
      pendingTimer = undefined;
      void enqueueFlush(false, answer).catch(() => {
        // enqueueFlush already records/logs intermediate failures.
      });
    }, flushDelayMs);
    armKeepalive();
  };

  const finalizeWithOptionalFollowUps = async (fullAnswer: string) => {
    clearPending();
    clearKeepalive();
    const chunks = chunkQqbotMarkdownText(fullAnswer, QQBOT_MARKDOWN_MAX_BYTES);
    const primary = chunks[0] ?? "";
    answer = primary;
    try {
      await enqueueFlush(true, primary);
    } catch (error) {
      // Prefer the freshest terminal failure; fall back to last intermediate.
      throw error ?? lastFlushError;
    }
    const followUps = chunks.slice(1);
    if (followUps.length === 0) return;
    if (!options.sendFollowUpMarkdown) {
      console.error(
        "[spark-channels] qqbot c2c stream truncated long reply; follow-up sender unavailable",
        { omittedChunks: followUps.length },
      );
      return;
    }
    for (const chunk of followUps) {
      await options.sendFollowUpMarkdown(chunk);
    }
  };

  return {
    answerMode: "inline",
    appendText(delta) {
      if (finished || !delta) return;
      answer += delta;
      scheduleFlush();
    },
    replaceText(text) {
      if (finished) return;
      answer = text;
      scheduleFlush();
    },
    // Keep tool/progress off the C2C stream body; Cockpit/TUI remain the
    // process surfaces. Still refresh the frame so long tool waits do not
    // idle-out the platform stream before final delivery.
    notifyToolStart() {
      armKeepalive();
      if (!answer.trim()) return;
      void enqueueFlush(false, answer, true).catch(() => undefined);
    },
    notifyToolResult() {
      armKeepalive();
      if (!answer.trim()) return;
      void enqueueFlush(false, answer, true).catch(() => undefined);
    },
    async complete() {
      await finalizeWithOptionalFollowUps(answer);
    },
    async fail(message) {
      const failureText = message.trim() || "处理失败，请稍后重试";
      if (!answer.trim()) answer = failureText;
      await finalizeWithOptionalFollowUps(answer);
    },
  };
}

export function tryCreateQqbotC2CReplyStream(input: {
  target: ChannelReplyTarget;
  api: QqbotApiClient;
  resolveToken: () => Promise<string>;
  reserveFinalSeq: (messageId: string) => number | undefined;
  sendFollowUpMarkdown?: (content: string) => Promise<void>;
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
    sendFollowUpMarkdown: input.sendFollowUpMarkdown,
    reserveFinalSeq: () => {
      const msgSeq = input.reserveFinalSeq(messageId);
      if (msgSeq === undefined) {
        throw channelDeliveryNotSent(
          new Error("qqbot passive reply budget exhausted before c2c stream"),
        );
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
