import {
  SPARK_PROTOCOL_VERSION,
  type SparkDaemonEvent,
  type SparkMessageView,
} from "@zendev-lab/spark-protocol";
import type { ChannelReplyStream } from "@zendev-lab/spark-channels";
import { describe, expect, it, vi } from "vitest";
import { ChannelReplyEventProjector } from "./reply-stream.ts";

function stream(answerMode?: ChannelReplyStream["answerMode"]) {
  const appendText = vi.fn();
  const appendProgress = vi.fn();
  const appendReasoning = vi.fn();
  const notifyToolStart = vi.fn();
  const notifyToolResult = vi.fn();
  const complete = vi.fn(async () => undefined);
  const fail = vi.fn(async () => undefined);
  const target: ChannelReplyStream = {
    ...(answerMode ? { answerMode } : {}),
    appendText,
    appendProgress,
    appendReasoning,
    notifyToolStart,
    notifyToolResult,
    complete,
    fail,
  };
  return {
    target,
    appendText,
    appendProgress,
    appendReasoning,
    notifyToolStart,
    notifyToolResult,
    complete,
    fail,
  };
}

function messageEvent(
  message: Omit<SparkMessageView, "version" | "metadata"> & {
    metadata?: SparkMessageView["metadata"];
  },
): SparkDaemonEvent {
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
      message: { version: SPARK_PROTOCOL_VERSION, ...message, metadata: message.metadata ?? {} },
    },
  };
}

describe("ChannelReplyEventProjector", () => {
  it("preserves unclassified streaming for inline reply surfaces", () => {
    const { target, appendText } = stream();
    const projector = new ChannelReplyEventProjector(target);

    projector.observe(
      messageEvent({
        id: "assistant-1",
        role: "assistant",
        text: "你",
        status: "streaming",
        parts: [
          {
            id: "assistant-1:part:0",
            type: "text",
            text: "你",
            status: "streaming",
            metadata: {},
          },
        ],
      }),
    );
    projector.observe(
      messageEvent({
        id: "assistant-1",
        role: "assistant",
        text: "你好",
        status: "done",
        parts: [
          {
            id: "assistant-1:part:0",
            type: "text",
            text: "你好",
            phase: "final_answer",
            status: "complete",
            metadata: {},
          },
        ],
        metadata: { stopReason: "stop" },
      }),
    );

    expect(appendText.mock.calls).toEqual([["你"], ["好"]]);
  });

  it("separates execution commentary from final answer prose", () => {
    const { target, appendText, appendProgress } = stream();
    const projector = new ChannelReplyEventProjector(target);

    projector.observe(
      messageEvent({
        id: "assistant-progress",
        role: "assistant",
        text: "先检查目录",
        status: "done",
        parts: [
          {
            id: "assistant-progress:part:0",
            type: "text",
            text: "先检查目录",
            phase: "commentary",
            status: "complete",
            metadata: {},
          },
        ],
        metadata: { stopReason: "toolUse" },
      }),
    );
    projector.observe(
      messageEvent({
        id: "assistant-final",
        role: "assistant",
        text: "检查完成",
        status: "done",
        parts: [
          {
            id: "assistant-final:part:0",
            type: "text",
            text: "检查完成",
            phase: "final_answer",
            status: "complete",
            metadata: {},
          },
        ],
        metadata: { stopReason: "stop" },
      }),
    );

    expect(appendProgress).toHaveBeenCalledWith("先检查目录");
    expect(appendText).toHaveBeenCalledWith("检查完成");
  });

  it("keeps final answer text out of a separate execution stream", () => {
    const { target, appendText, appendProgress, notifyToolStart } = stream("separate");
    const projector = new ChannelReplyEventProjector(target);
    projector.observe(
      messageEvent({
        id: "assistant-progress",
        role: "assistant",
        text: "开始检查",
        status: "done",
        parts: [
          {
            id: "assistant-progress:part:0",
            type: "text",
            text: "开始检查",
            phase: "commentary",
            status: "complete",
            metadata: {},
          },
        ],
      }),
    );
    projector.observe(
      messageEvent({
        id: "tool-call:1",
        role: "tool",
        text: "private input",
        status: "pending",
        toolName: "cue_exec",
      }),
    );
    projector.appendFinalText("最终答案");

    expect(appendProgress).toHaveBeenCalledWith("开始检查");
    expect(notifyToolStart).toHaveBeenCalledWith({ name: "cue_exec", phase: "执行中" });
    expect(appendText).not.toHaveBeenCalled();
  });

  it("keeps tool-call markers and thinking parts out of the answer body", () => {
    const { target, appendText, appendProgress, appendReasoning, notifyToolStart } = stream();
    const projector = new ChannelReplyEventProjector(target);

    projector.observe(
      messageEvent({
        id: "assistant-1",
        role: "assistant",
        text: "我来列一下当前目录内容。\n[tool call: cue_exec]",
        status: "done",
        parts: [
          {
            id: "assistant-1:part:0",
            type: "thinking",
            text: "先用 cue_exec 列目录",
            status: "complete",
            metadata: {},
          },
          {
            id: "assistant-1:part:1",
            type: "text",
            text: "我来列一下当前目录内容。",
            status: "complete",
            metadata: {},
          },
          {
            id: "assistant-1:part:2",
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "cue_exec",
            status: "pending",
            metadata: {},
          },
        ],
      }),
    );
    projector.observe(
      messageEvent({
        id: "tool-call:1",
        role: "tool",
        text: "secret input",
        status: "pending",
        toolName: "cue_exec",
      }),
    );

    expect(appendText).not.toHaveBeenCalled();
    expect(appendProgress).toHaveBeenCalledWith("我来列一下当前目录内容。");
    expect(appendReasoning.mock.calls).toEqual([["先用 cue_exec 列目录"]]);
    expect(notifyToolStart).toHaveBeenCalledWith({ name: "cue_exec", phase: "执行中" });
    expect(JSON.stringify(appendText.mock.calls)).not.toMatch(/tool call/);
  });

  it("keeps provider commentary out of both answer and private reasoning streams", () => {
    const { target, appendText, appendReasoning } = stream();
    const projector = new ChannelReplyEventProjector(target);

    projector.observe(
      messageEvent({
        id: "assistant-commentary",
        role: "assistant",
        text: "确认当前目录。",
        status: "done",
        parts: [
          {
            id: "assistant-commentary:part:0",
            type: "text",
            phase: "commentary",
            text: "确认当前目录。",
            status: "complete",
            metadata: {},
          },
          {
            id: "assistant-commentary:part:1",
            type: "tool-call",
            toolCallId: "tc-commentary",
            toolName: "cue_exec",
            status: "pending",
            metadata: {},
          },
        ],
      }),
    );

    expect(appendText).not.toHaveBeenCalled();
    expect(appendReasoning).not.toHaveBeenCalled();
  });

  it("strips legacy tool-call markers when parts are absent", () => {
    const { target, appendText } = stream();
    const projector = new ChannelReplyEventProjector(target);

    projector.observe(
      messageEvent({
        id: "assistant-legacy",
        role: "assistant",
        text: "开始。\n[tool call: cue_exec]当前目录内容：",
        status: "done",
      }),
    );

    expect(appendText).toHaveBeenCalledWith("开始。\n当前目录内容：");
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
        text: "secret output",
        status: "done",
        toolName: "cue_exec",
      }),
    );

    expect(notifyToolStart).toHaveBeenCalledWith({ name: "cue_exec", phase: "执行中" });
    expect(notifyToolResult).toHaveBeenCalledWith("cue_exec 完成");
    expect(appendText).not.toHaveBeenCalled();
  });

  it("appends only the unanswered final-text suffix", () => {
    const { target, appendText } = stream();
    const projector = new ChannelReplyEventProjector(target);
    projector.observe(
      messageEvent({ id: "assistant-1", role: "assistant", text: "你好", status: "done" }),
    );
    projector.appendFinalText("你好，世界");
    expect(appendText.mock.calls).toEqual([["你好"], ["，世界"]]);
  });

  it("replaces stale streamed prose when the final answer is not a prefix", () => {
    const appendText = vi.fn();
    const replaceText = vi.fn();
    const target: ChannelReplyStream = {
      appendText,
      replaceText,
      notifyToolStart: vi.fn(),
      notifyToolResult: vi.fn(),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    const projector = new ChannelReplyEventProjector(target);
    projector.observe(
      messageEvent({
        id: "assistant-partial",
        role: "assistant",
        text: "先看一下目录",
        status: "streaming",
      }),
    );
    projector.observe(
      messageEvent({
        id: "assistant-partial",
        role: "assistant",
        text: "先看一下目录",
        status: "done",
        metadata: { stopReason: "toolUse" },
        parts: [
          {
            id: "assistant-partial:part:0",
            type: "text",
            text: "先看一下目录",
            status: "complete",
            metadata: {},
          },
          {
            id: "assistant-partial:part:1",
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "cue_exec",
            status: "complete",
            metadata: {},
          },
        ],
      }),
    );
    projector.appendFinalText("目录里有三个文件");

    expect(appendText).toHaveBeenCalledWith("先看一下目录");
    expect(replaceText).toHaveBeenCalledWith("目录里有三个文件");
  });
});
