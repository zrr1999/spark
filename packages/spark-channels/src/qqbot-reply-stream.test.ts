import { describe, expect, it, vi } from "vitest";
import type { QqbotApiClient } from "./qqbot-api.ts";
import { QQBOT_MARKDOWN_MAX_BYTES, chunkQqbotMarkdownText } from "./qqbot-markdown.ts";
import { createQqbotC2CReplyStream, tryCreateQqbotC2CReplyStream } from "./qqbot-reply-stream.ts";
import {
  CHANNEL_DELIVERY_NOT_SENT_ERROR_CODE,
  CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
} from "./reply.ts";

function createManualScheduler() {
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  let nextHandle = 1;
  return {
    timers,
    schedule: (callback: () => void, delayMs: number) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { callback, delayMs });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    cancelSchedule: (handle: unknown) => {
      timers.delete(handle as number);
    },
    flushPending(delayMs?: number) {
      for (const [handle, timer] of [...timers.entries()]) {
        if (delayMs !== undefined && timer.delayMs !== delayMs) continue;
        timers.delete(handle);
        timer.callback();
      }
    },
  };
}

describe("qqbot markdown chunking", () => {
  it("keeps short markdown as one chunk", () => {
    expect(chunkQqbotMarkdownText("你好，世界")).toEqual(["你好，世界"]);
  });

  it("splits oversized markdown on paragraph boundaries", () => {
    const first = "甲".repeat(800);
    const second = "乙".repeat(800);
    const third = "丙".repeat(800);
    const source = `${first}\n\n${second}\n\n${third}`;
    const chunks = chunkQqbotMarkdownText(source, 2_500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n\n")).toBe(source);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 2_500)).toBe(true);
  });
});

describe("qqbot C2C reply stream", () => {
  it("replaces one markdown body and finishes with input_state 10", async () => {
    const sendC2CStreamMessage = vi
      .fn()
      .mockResolvedValueOnce({ id: "stream-1" })
      .mockResolvedValueOnce({ id: "stream-1" });
    const reserveFinalSeq = vi.fn(() => 4);
    const api = { sendC2CStreamMessage } as unknown as QqbotApiClient;
    const scheduler = createManualScheduler();
    const stream = createQqbotC2CReplyStream({
      api,
      resolveToken: async () => "token",
      openid: "user-1",
      messageId: "source-1",
      reserveFinalSeq,
      flushDelayMs: 1,
      keepaliveDelayMs: 60_000,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    stream.appendText("你好");
    expect(reserveFinalSeq).not.toHaveBeenCalled();
    expect([...scheduler.timers.values()].some((timer) => timer.delayMs === 1)).toBe(true);
    scheduler.flushPending(1);
    await vi.waitFor(() => expect(sendC2CStreamMessage).toHaveBeenCalledTimes(1));
    expect(reserveFinalSeq).toHaveBeenCalledTimes(1);
    expect(sendC2CStreamMessage.mock.calls[0]?.[2]).toMatchObject({
      input_state: 1,
      content_raw: "你好\n",
      index: 0,
      msg_seq: 4,
    });

    stream.appendText("，世界");
    await stream.complete();

    expect(sendC2CStreamMessage).toHaveBeenCalledTimes(2);
    expect(reserveFinalSeq).toHaveBeenCalledTimes(1);
    expect(sendC2CStreamMessage.mock.calls[1]?.[2]).toMatchObject({
      input_state: 10,
      content_raw: "你好，世界\n",
      index: 1,
      stream_msg_id: "stream-1",
    });
  });

  it("still sends the final frame after an intermediate flush failure", async () => {
    const sendC2CStreamMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary upstream failure"))
      .mockResolvedValueOnce({ id: "stream-1" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduler = createManualScheduler();
    const stream = createQqbotC2CReplyStream({
      api: { sendC2CStreamMessage } as unknown as QqbotApiClient,
      resolveToken: async () => "token",
      openid: "user-1",
      messageId: "source-1",
      reserveFinalSeq: () => 4,
      flushDelayMs: 1,
      keepaliveDelayMs: 60_000,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    try {
      stream.appendText("前半");
      scheduler.flushPending(1);
      await vi.waitFor(() => expect(sendC2CStreamMessage).toHaveBeenCalledTimes(1));
      stream.appendText("后半");
      await stream.complete();
      expect(sendC2CStreamMessage).toHaveBeenCalledTimes(2);
      expect(sendC2CStreamMessage.mock.calls[1]?.[2]).toMatchObject({
        input_state: 10,
        content_raw: "前半后半\n",
      });
    } finally {
      error.mockRestore();
    }
  });

  it("replaces stale streamed prose before the final frame", async () => {
    const sendC2CStreamMessage = vi.fn().mockResolvedValue({ id: "stream-1" });
    const scheduler = createManualScheduler();
    const stream = createQqbotC2CReplyStream({
      api: { sendC2CStreamMessage } as unknown as QqbotApiClient,
      resolveToken: async () => "token",
      openid: "user-1",
      messageId: "source-1",
      reserveFinalSeq: () => 4,
      flushDelayMs: 60_000,
      keepaliveDelayMs: 60_000,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    stream.appendText("过期前半段");
    stream.replaceText?.("完整最终答案");
    await stream.complete();

    expect(sendC2CStreamMessage).toHaveBeenCalledTimes(1);
    expect(sendC2CStreamMessage.mock.calls[0]?.[2]).toMatchObject({
      input_state: 10,
      content_raw: "完整最终答案\n",
    });
  });

  it("keepalives during tool waits and delivers the tail after timeout-like gaps", async () => {
    const sendC2CStreamMessage = vi.fn().mockResolvedValue({ id: "stream-1" });
    const scheduler = createManualScheduler();
    const stream = createQqbotC2CReplyStream({
      api: { sendC2CStreamMessage } as unknown as QqbotApiClient,
      resolveToken: async () => "token",
      openid: "user-1",
      messageId: "source-1",
      reserveFinalSeq: () => 4,
      flushDelayMs: 60_000,
      keepaliveDelayMs: 10,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    stream.appendText("部分");
    stream.notifyToolStart({ name: "cue_exec", phase: "执行中" });
    await vi.waitFor(() => expect(sendC2CStreamMessage).toHaveBeenCalledTimes(1));
    expect(sendC2CStreamMessage.mock.calls[0]?.[2]).toMatchObject({
      input_state: 1,
      content_raw: "部分\n",
    });

    stream.replaceText?.("部分\n完整尾消息");
    await stream.complete();
    expect(sendC2CStreamMessage.mock.calls.at(-1)?.[2]).toMatchObject({
      input_state: 10,
      content_raw: "部分\n完整尾消息\n",
    });
  });

  it("finalizes the first markdown chunk and sends overflow follow-ups", async () => {
    const sendC2CStreamMessage = vi.fn().mockResolvedValue({ id: "stream-1" });
    const sendFollowUpMarkdown = vi.fn(async (_text: string) => undefined);
    const long = `${"段落一".repeat(400)}\n\n${"段落二".repeat(400)}`;
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(QQBOT_MARKDOWN_MAX_BYTES);
    const chunks = chunkQqbotMarkdownText(long);
    expect(chunks.length).toBeGreaterThan(1);
    const scheduler = createManualScheduler();

    const stream = createQqbotC2CReplyStream({
      api: { sendC2CStreamMessage } as unknown as QqbotApiClient,
      resolveToken: async () => "token",
      openid: "user-1",
      messageId: "source-1",
      reserveFinalSeq: () => 4,
      reserveFollowUpSeqs: () => true,
      sendFollowUpMarkdown,
      flushDelayMs: 60_000,
      keepaliveDelayMs: 60_000,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    stream.appendText(long);
    await stream.complete();

    expect(sendC2CStreamMessage).toHaveBeenCalledTimes(1);
    expect(sendC2CStreamMessage.mock.calls[0]?.[2]).toMatchObject({
      input_state: 10,
      content_raw: `${chunks[0]}\n`,
    });
    expect(sendFollowUpMarkdown.mock.calls.map((call) => call[0])).toEqual(chunks.slice(1));
  });

  it("reserves every long-reply follow-up before sending the terminal frame", async () => {
    const sendC2CStreamMessage = vi.fn().mockResolvedValue({ id: "stream-1" });
    const sendFollowUpMarkdown = vi.fn(async (_text: string) => undefined);
    const reserveFollowUpSeqs = vi.fn(() => false);
    const long = `${"段落一".repeat(400)}\n\n${"段落二".repeat(400)}`;
    const stream = createQqbotC2CReplyStream({
      api: { sendC2CStreamMessage } as unknown as QqbotApiClient,
      resolveToken: async () => "token",
      openid: "user-1",
      messageId: "source-1",
      reserveFinalSeq: () => 4,
      reserveFollowUpSeqs,
      sendFollowUpMarkdown,
      flushDelayMs: 60_000,
      keepaliveDelayMs: 60_000,
    });

    stream.appendText(long);
    await expect(stream.complete()).rejects.toMatchObject({
      code: CHANNEL_DELIVERY_NOT_SENT_ERROR_CODE,
      outcome: "not_sent",
    });
    expect(reserveFollowUpSeqs).toHaveBeenCalledWith(chunkQqbotMarkdownText(long).length - 1);
    expect(sendC2CStreamMessage).not.toHaveBeenCalled();
    expect(sendFollowUpMarkdown).not.toHaveBeenCalled();
  });

  it("fails closed when overflow becomes impossible after an intermediate frame", async () => {
    const sendC2CStreamMessage = vi.fn().mockResolvedValue({ id: "stream-1" });
    const scheduler = createManualScheduler();
    const long = `${"段落一".repeat(400)}\n\n${"段落二".repeat(400)}`;
    const stream = createQqbotC2CReplyStream({
      api: { sendC2CStreamMessage } as unknown as QqbotApiClient,
      resolveToken: async () => "token",
      openid: "user-1",
      messageId: "source-1",
      reserveFinalSeq: () => 4,
      reserveFollowUpSeqs: () => false,
      sendFollowUpMarkdown: async () => undefined,
      flushDelayMs: 60_000,
      keepaliveDelayMs: 60_000,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    stream.appendText("已显示的前缀");
    stream.notifyToolStart({ name: "cue_exec", phase: "执行中" });
    await vi.waitFor(() => expect(sendC2CStreamMessage).toHaveBeenCalledTimes(1));
    stream.replaceText?.(long);

    await expect(stream.complete()).rejects.toMatchObject({
      code: CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE,
      outcome: "unknown",
    });
    expect(sendC2CStreamMessage).toHaveBeenCalledTimes(1);
  });

  it("fails before a terminal frame when a long answer has no follow-up sender", async () => {
    const sendC2CStreamMessage = vi.fn().mockResolvedValue({ id: "stream-1" });
    const long = `${"段落一".repeat(400)}\n\n${"段落二".repeat(400)}`;
    const stream = createQqbotC2CReplyStream({
      api: { sendC2CStreamMessage } as unknown as QqbotApiClient,
      resolveToken: async () => "token",
      openid: "user-1",
      messageId: "source-1",
      reserveFinalSeq: () => 4,
      flushDelayMs: 60_000,
      keepaliveDelayMs: 60_000,
    });

    stream.appendText(long);
    await expect(stream.complete()).rejects.toMatchObject({
      code: CHANNEL_DELIVERY_NOT_SENT_ERROR_CODE,
      outcome: "not_sent",
    });
    expect(sendC2CStreamMessage).not.toHaveBeenCalled();
  });

  it("reports exhausted passive reply capacity as confirmed not sent", async () => {
    const sendC2CStreamMessage = vi.fn(async () => ({ id: "unexpected" }));
    const resolveToken = vi.fn(async () => "token");
    const stream = tryCreateQqbotC2CReplyStream({
      target: { recipient: "c2c:user-1", messageId: "source-1" },
      api: { sendC2CStreamMessage } as unknown as QqbotApiClient,
      resolveToken,
      reserveFinalSeq: () => undefined,
    });

    expect(stream).toBeDefined();
    stream?.appendText("answer");
    await expect(stream?.complete()).rejects.toMatchObject({
      code: CHANNEL_DELIVERY_NOT_SENT_ERROR_CODE,
      outcome: "not_sent",
    });
    expect(resolveToken).not.toHaveBeenCalled();
    expect(sendC2CStreamMessage).not.toHaveBeenCalled();
  });
});
