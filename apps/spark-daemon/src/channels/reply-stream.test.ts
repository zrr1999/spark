import { SPARK_PROTOCOL_VERSION, type SparkDaemonEvent } from "@zendev-lab/spark-protocol";
import type { ChannelReplyStream } from "@zendev-lab/spark-channels";
import { describe, expect, it, vi } from "vitest";
import { ChannelReplyEventProjector } from "./reply-stream.ts";

function stream() {
  const appendText = vi.fn();
  const notifyToolStart = vi.fn();
  const notifyToolResult = vi.fn();
  const complete = vi.fn(async () => undefined);
  const fail = vi.fn(async () => undefined);
  const target: ChannelReplyStream = {
    appendText,
    notifyToolStart,
    notifyToolResult,
    complete,
    fail,
  };
  return { target, appendText, notifyToolStart, notifyToolResult, complete, fail };
}

function messageEvent(message: {
  id: string;
  role: "assistant" | "tool" | "thinking";
  text: string;
  status: "pending" | "streaming" | "done" | "error";
  toolName?: string;
}): SparkDaemonEvent {
  return {
    version: SPARK_PROTOCOL_VERSION,
    type: "daemon.view_event",
    source: "daemon",
    emittedAt: "2026-07-13T00:00:00.000Z",
    sessionId: "sess",
    invocationId: "inv",
    metadata: {},
    view: {
      version: SPARK_PROTOCOL_VERSION,
      type: "session.message",
      sessionId: "sess",
      message: { version: SPARK_PROTOCOL_VERSION, metadata: {}, ...message },
    },
  };
}

describe("ChannelReplyEventProjector", () => {
  it("turns accumulated assistant views into text deltas", () => {
    const { target, appendText } = stream();
    const projector = new ChannelReplyEventProjector(target);

    projector.observe(
      messageEvent({ id: "assistant-1", role: "assistant", text: "你", status: "streaming" }),
    );
    projector.observe(
      messageEvent({ id: "assistant-1", role: "assistant", text: "你好", status: "streaming" }),
    );
    projector.observe(
      messageEvent({ id: "assistant-1", role: "assistant", text: "你好", status: "done" }),
    );

    expect(appendText).toHaveBeenNthCalledWith(1, "你");
    expect(appendText).toHaveBeenNthCalledWith(2, "好");
  });

  it("exposes only safe tool lifecycle summaries", () => {
    const { target, appendText, notifyToolStart, notifyToolResult } = stream();
    const projector = new ChannelReplyEventProjector(target);

    projector.observe(
      messageEvent({
        id: "tool-call:1",
        role: "tool",
        text: "secret input",
        status: "pending",
        toolName: "cue_exec",
      }),
    );
    projector.observe(
      messageEvent({
        id: "tool-result:1",
        role: "tool",
        text: "private output",
        status: "done",
        toolName: "cue_exec",
      }),
    );

    expect(notifyToolStart).toHaveBeenCalledWith({ name: "cue_exec", phase: "执行中" });
    expect(notifyToolResult).toHaveBeenCalledWith("cue_exec 完成");
    expect(appendText).not.toHaveBeenCalled();
  });

  it("ignores thinking and reconciles missing final visible text", () => {
    const { target, appendText, notifyToolStart } = stream();
    const projector = new ChannelReplyEventProjector(target);

    projector.observe(
      messageEvent({ id: "thinking-1", role: "thinking", text: "hidden", status: "streaming" }),
    );
    projector.appendFinalText("最终回答");

    expect(appendText).toHaveBeenCalledWith("最终回答");
    expect(notifyToolStart).not.toHaveBeenCalled();
  });
});
