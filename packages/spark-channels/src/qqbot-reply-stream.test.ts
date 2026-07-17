import { describe, expect, it, vi } from "vitest";
import type { QqbotApiClient } from "./qqbot-api.ts";
import { createQqbotC2CReplyStream } from "./qqbot-reply-stream.ts";

describe("qqbot C2C reply stream", () => {
  it("replaces one markdown body and finishes with input_state 10", async () => {
    const sendC2CStreamMessage = vi
      .fn()
      .mockResolvedValueOnce({ id: "stream-1" })
      .mockResolvedValueOnce({ id: "stream-1" });
    const reserveFinalSeq = vi.fn(() => 4);
    const api = { sendC2CStreamMessage } as unknown as QqbotApiClient;
    const timers: Array<() => void> = [];
    const stream = createQqbotC2CReplyStream({
      api,
      resolveToken: async () => "token",
      openid: "user-1",
      messageId: "source-1",
      reserveFinalSeq,
      flushDelayMs: 1,
      schedule: (callback) => {
        timers.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancelSchedule: () => {
        timers.length = 0;
      },
    });

    stream.appendText("你好");
    expect(reserveFinalSeq).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    timers[0]?.();
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
});
