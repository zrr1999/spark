import { describe, expect, it, vi } from "vitest";
import { SPARK_PROTOCOL_VERSION, type SparkDaemonEvent } from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import type { SparkDaemonSessionRunTask, SparkDaemonTaskExecutionContext } from "../core/types.ts";
import {
  channelReplyDeliveryForCompletion,
  createChannelAwareTaskExecutor,
  createSparkDaemonTaskExecutor,
  executeSparkDaemonSessionRunTask,
} from "./session-run.ts";

const paths = resolveSparkPaths({
  app: "daemon",
  env: { HOME: "/tmp/spark-daemon-session-run-test" },
});

function context(
  _task: SparkDaemonSessionRunTask,
  emitted: SparkDaemonEvent[] = [],
): SparkDaemonTaskExecutionContext {
  return {
    invocationId: "invocation-1",
    signal: new AbortController().signal,
    emitEvent: (event) => {
      emitted.push(event);
    },
  };
}

describe("daemon native session execution", () => {
  it("leaves daemon execution timeout ownership with the pausable scheduler", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_scheduler_timeout",
      prompt: "wait for scheduler",
    };
    const executionContext = context(task);
    executionContext.timeoutMs = 10;

    await executeSparkDaemonSessionRunTask(task, executionContext, { paths, executeSession });

    expect(executeSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ timeoutMs: expect.anything() }),
    );
  });

  it("streams display-safe assistant text and tool lifecycle to a channel reply card", async () => {
    const appendText = vi.fn();
    const notifyToolStart = vi.fn();
    const notifyToolResult = vi.fn();
    const complete = vi.fn(async () => undefined);
    const sendReply = vi.fn(async () => undefined);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_stream",
      prompt: "请执行",
      channelReply: {
        workspaceId: "workspace-infoflow",
        adapterId: "infoflow",
        recipient: "group:10838226",
      },
      channelContext: {
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        messageId: "message-1",
      },
    };
    const executeSession = vi.fn(async (input: { onEvent?: (event: unknown) => unknown }) => {
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "assistant-1",
            role: "assistant",
            text: "你",
            status: "streaming",
            metadata: {},
          },
        },
      });
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "tool-call:1",
            role: "tool",
            text: "private tool input",
            status: "pending",
            toolName: "cue_exec",
            metadata: {},
          },
        },
      });
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "assistant-1",
            role: "assistant",
            text: "你好",
            status: "done",
            metadata: {},
          },
        },
      });
      return { assistantText: "你好" };
    });
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => executeSession,
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          appendText,
          notifyToolStart,
          notifyToolResult,
          complete,
          fail: vi.fn(async () => undefined),
        })),
        sendReply,
      },
    });

    await executor(task, context(task));

    expect(appendText.mock.calls).toEqual([["你"], ["好"]]);
    expect(notifyToolStart).toHaveBeenCalledWith({ name: "cue_exec", phase: "执行中" });
    expect(notifyToolResult).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("已完成");
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("completes a separate execution stream before sending the final channel reply", async () => {
    const appendText = vi.fn();
    const appendProgress = vi.fn();
    const notifyToolStart = vi.fn();
    const complete = vi.fn(async () => undefined);
    const sendReply = vi.fn(async () => undefined);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_qq_separate",
      prompt: "请检查",
      channelReply: {
        workspaceId: "workspace-qq",
        adapterId: "qqbot",
        recipient: "c2c:user-1",
      },
      channelContext: {
        externalKey: "qqbot:c2c:user-1",
        senderId: "user-1",
        messageId: "message-1",
      },
    };
    const executeSession = vi.fn(async (input: { onEvent?: (event: unknown) => unknown }) => {
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
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
          },
        },
      });
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "tool-call:1",
            role: "tool",
            text: "private input",
            status: "pending",
            toolName: "cue_exec",
            metadata: {},
          },
        },
      });
      return { assistantText: "检查完成" };
    });
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => executeSession,
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          answerMode: "separate" as const,
          appendText,
          appendProgress,
          notifyToolStart,
          notifyToolResult: vi.fn(),
          complete,
          fail: vi.fn(async () => undefined),
        })),
        sendReply,
      },
    });

    await executor(task, context(task));

    expect(appendProgress).toHaveBeenCalledWith("先检查目录");
    expect(notifyToolStart).toHaveBeenCalledWith({ name: "cue_exec", phase: "执行中" });
    expect(appendText).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith("已完成");
    expect(sendReply).not.toHaveBeenCalled();
    expect(
      channelReplyDeliveryForCompletion(task, "invocation-1", "final", {
        assistantText: "检查完成",
      }),
    ).toMatchObject({ text: "检查完成", idempotencyKey: "channel.reply:final:invocation-1" });
  });

  it("leaves final delivery to the scheduler transaction when a stream is unavailable", async () => {
    const sendReply = vi.fn(async () => undefined);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_fallback",
      prompt: "原始消息",
      channelReply: {
        workspaceId: "workspace-infoflow",
        adapterId: "infoflow",
        recipient: "group:10838226",
      },
      channelContext: {
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        messageId: "message-1",
      },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "**完成**" }),
      channelIngress: {
        openReplyStream: vi.fn(async () => undefined),
        sendReply,
      },
    });

    await executor(task, context(task));

    expect(sendReply).not.toHaveBeenCalled();
    expect(
      channelReplyDeliveryForCompletion(task, "invocation-1", "final", {
        assistantText: "**完成**",
      }),
    ).toMatchObject({
      target: {
        recipient: "group:10838226",
        senderId: "zhanrongrui",
        messageId: "message-1",
        preview: "原始消息",
      },
      text: "**完成**",
    });
  });

  it("builds one stable final delivery intent from the terminal result", async () => {
    const sendReply = vi.fn(async () => {
      throw new Error("direct delivery must not run");
    });
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_outbox",
      prompt: "finish this",
      channelReply: {
        workspaceId: "workspace-qq",
        adapterId: "qqbot",
        recipient: "c2c:user-1",
      },
      channelContext: {
        externalKey: "qqbot:c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
      },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "done" }),
      channelIngress: {
        openReplyStream: vi.fn(async () => undefined),
        sendReply,
      },
    });

    await executor(task, context(task));

    expect(sendReply).not.toHaveBeenCalled();
    expect(
      channelReplyDeliveryForCompletion(task, "invocation-1", "final", {
        assistantText: "done",
      }),
    ).toEqual({
      kind: "final",
      idempotencyKey: "channel.reply:final:invocation-1",
      invocationId: "invocation-1",
      sessionId: "sess_channel_outbox",
      workspaceId: "workspace-qq",
      adapterId: "qqbot",
      externalKey: "qqbot:c2c:user-1",
      target: {
        recipient: "c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
        preview: "finish this",
      },
      text: "done",
    });
  });

  it("does not couple model success to a direct platform send attempt", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_delivery_failure",
      prompt: "finish this",
      channelReply: {
        workspaceId: "workspace-infoflow",
        adapterId: "infoflow",
        recipient: "alice",
      },
      channelContext: { externalKey: "infoflow:user:alice", senderId: "alice" },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "done" }),
      channelIngress: {
        openReplyStream: vi.fn(async () => undefined),
        sendReply: vi.fn(async () => {
          throw new Error("platform unavailable");
        }),
      },
    });

    await expect(executor(task, context(task))).resolves.toMatchObject({ assistantText: "done" });
  });

  it("builds a stable channel-visible failure intent for scheduler commit", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_model_failure",
      prompt: "fail visibly",
      channelReply: {
        workspaceId: "workspace-qq",
        adapterId: "qqbot",
        recipient: "c2c:user-1",
      },
      channelContext: {
        externalKey: "qqbot:c2c:user-1",
        senderId: "user-1",
        messageId: "source-message-1",
      },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => {
        throw new Error("provider failed");
      },
      channelIngress: {
        openReplyStream: vi.fn(async () => undefined),
        sendReply: vi.fn(async () => undefined),
      },
    });
    const emitted: SparkDaemonEvent[] = [];

    await expect(executor(task, context(task, emitted))).rejects.toThrow("provider failed");
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "daemon.view_event",
        sessionId: task.sessionId,
        invocationId: "invocation-1",
        view: expect.objectContaining({
          type: "session.message",
          message: expect.objectContaining({
            id: "invocation:invocation-1:failure",
            role: "system",
            text: "provider failed",
            status: "error",
          }),
        }),
      }),
    );
    expect(channelReplyDeliveryForCompletion(task, "invocation-1", "failure")).toMatchObject({
      kind: "failure",
      idempotencyKey: "channel.reply:failure:invocation-1",
      text: "处理失败，请稍后重试",
    });
  });

  it("does not duplicate a failure already projected by the agent loop", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_streamed_failure",
      prompt: "fail after the loop starts",
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async (input) => {
        await input.onEvent?.({
          type: "view_event",
          event: {
            version: SPARK_PROTOCOL_VERSION,
            type: "session.message",
            sessionId: task.sessionId,
            message: {
              version: SPARK_PROTOCOL_VERSION,
              id: "loop-error",
              role: "system",
              text: "stream failed",
              status: "error",
              metadata: {},
            },
          },
        });
        throw new Error("stream failed");
      },
    });
    const emitted: SparkDaemonEvent[] = [];

    await expect(executor(task, context(task, emitted))).rejects.toThrow("stream failed");

    const failures = emitted.filter(
      (event) =>
        event.type === "daemon.view_event" &&
        event.view.type === "session.message" &&
        event.view.message.status === "error",
    );
    expect(failures).toHaveLength(1);
  });

  it("never leaves a successful channel turn without a visible reply", () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_empty",
      prompt: "finish silently",
      channelReply: {
        workspaceId: "workspace-qq",
        adapterId: "qqbot",
        recipient: "c2c:user-1",
      },
    };

    expect(channelReplyDeliveryForCompletion(task, "invocation-empty", "final", {})).toMatchObject({
      kind: "final",
      idempotencyKey: "channel.reply:final:invocation-empty",
      text: "处理完成，但未生成可展示的回复",
    });
  });

  it("does not let streaming card completion failure block the durable answer path", async () => {
    const sendReply = vi.fn(async () => undefined);
    const acknowledge = vi.fn();
    const rerouteToMessage = vi.fn();
    const stage = vi.fn(() => ({
      deliveryId: "channel.reply:invocation-1",
      invocationId: "invocation-1",
      sessionId: "sess_channel_complete_fallback",
      workspaceId: "workspace-infoflow",
      adapterId: "infoflow",
      target: { recipient: "alice", senderId: "alice", preview: "go" },
      text: "done",
      deliveryMode: "inline-stream" as const,
      status: "sending" as const,
      attemptCount: 0,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_complete_fallback",
      prompt: "go",
      channelReply: {
        workspaceId: "workspace-infoflow",
        adapterId: "infoflow",
        recipient: "alice",
      },
      channelContext: { externalKey: "infoflow:user:alice", senderId: "alice" },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "done" }),
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          appendText: vi.fn(),
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete: vi.fn(async () => {
            throw new Error("card update failed");
          }),
          fail: vi.fn(async () => undefined),
        })),
        sendReply,
      },
      channelReplyDelivery: {
        stage,
        acknowledge,
        defer: vi.fn(),
        rerouteToMessage,
      },
    });

    try {
      await expect(executor(task, context(task))).resolves.toMatchObject({ assistantText: "done" });
      await Promise.resolve();
      expect(sendReply).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("durable answer remains queued"),
        expect.any(Error),
      );
      expect(stage).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryMode: "inline-stream", text: "done" }),
      );
      expect(rerouteToMessage).toHaveBeenCalledWith("channel.reply:invocation-1");
      expect(rerouteToMessage.mock.invocationCallOrder[0]).toBeLessThan(
        sendReply.mock.invocationCallOrder[0]!,
      );
      expect(acknowledge).toHaveBeenCalledWith("channel.reply:invocation-1");
    } finally {
      error.mockRestore();
    }
  });

  it("does not duplicate a completed stream when local delivery acknowledgement fails", async () => {
    const sendReply = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const acknowledge = vi.fn(() => {
      throw new Error("ack write failed");
    });
    const defer = vi.fn();
    const stage = vi.fn(() => ({
      deliveryId: "channel.reply:invocation-1",
      invocationId: "invocation-1",
      sessionId: "sess_channel_ack_failure",
      workspaceId: "workspace-infoflow",
      adapterId: "infoflow",
      target: { recipient: "alice" },
      text: "done",
      deliveryMode: "inline-stream" as const,
      recovery: {
        kind: "infoflow.streaming-card.v1",
        data: { modifyToken: "token-1" },
      },
      status: "sending" as const,
      attemptCount: 0,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    }));
    const recovery = {
      kind: "infoflow.streaming-card.v1",
      data: { modifyToken: "token-1" },
    };
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_ack_failure",
      prompt: "go",
      channelReply: {
        workspaceId: "workspace-infoflow",
        adapterId: "infoflow",
        recipient: "alice",
      },
      channelContext: { externalKey: "infoflow:user:alice", senderId: "alice" },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "done" }),
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          deliveryRecovery: recovery,
          appendText: vi.fn(),
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete,
          fail: vi.fn(async () => undefined),
        })),
        sendReply,
      },
      channelReplyDelivery: {
        stage,
        acknowledge,
        defer,
        rerouteToMessage: vi.fn(),
      },
    });

    await expect(executor(task, context(task))).rejects.toMatchObject({
      code: "CHANNEL_REPLY_DELIVERY_PENDING",
      deliveryId: "channel.reply:invocation-1",
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryMode: "inline-stream", recovery, text: "done" }),
    );
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(defer).toHaveBeenCalledWith("channel.reply:invocation-1", expect.any(Error));
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("uses streamed final text when the host result omits assistantText", async () => {
    const appendText = vi.fn();
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_stream_result_fallback",
      prompt: "go",
      channelReply: {
        workspaceId: "workspace-infoflow",
        adapterId: "infoflow",
        recipient: "alice",
      },
      channelContext: { externalKey: "infoflow:user:alice", senderId: "alice" },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async (input) => {
        await input.onEvent?.({
          type: "view_event",
          event: {
            version: SPARK_PROTOCOL_VERSION,
            type: "session.message",
            sessionId: task.sessionId,
            message: {
              version: SPARK_PROTOCOL_VERSION,
              id: "assistant-fallback",
              role: "assistant",
              text: "流式最终答案",
              status: "done",
              metadata: {},
            },
          },
        });
        return {};
      },
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          appendText,
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete,
          fail,
        })),
        sendReply: vi.fn(async () => undefined),
      },
    });

    await expect(executor(task, context(task))).resolves.toEqual({});
    expect(appendText).toHaveBeenCalledWith("流式最终答案");
    expect(complete).toHaveBeenCalledWith("已完成");
    expect(fail).not.toHaveBeenCalled();
  });

  it("fails a channel invocation that produces no deliverable assistant text", async () => {
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const sendReply = vi.fn(async () => undefined);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_empty",
      prompt: "go",
      channelReply: {
        workspaceId: "workspace-infoflow",
        adapterId: "infoflow",
        recipient: "alice",
      },
      channelContext: { externalKey: "infoflow:user:alice", senderId: "alice" },
    };
    const executor = createChannelAwareTaskExecutor({
      paths,
      createSparkHeadlessSessionExecutor: () => async () => ({ assistantText: "   " }),
      channelIngress: {
        openReplyStream: vi.fn(async () => ({
          appendText: vi.fn(),
          notifyToolStart: vi.fn(),
          notifyToolResult: vi.fn(),
          complete,
          fail,
        })),
        sendReply,
      },
    });

    await expect(executor(task, context(task))).rejects.toMatchObject({
      code: "CHANNEL_REPLY_EMPTY",
    });
    expect(fail).toHaveBeenCalledWith("未生成可发送的回复，请稍后重试");
    expect(complete).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("keeps the Infoflow user message clean and supplies channel facts through prompt layers", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_infoflow",
      prompt: "@神经蛙 你叫什么名字",
      channelReply: {
        workspaceId: "workspace-infoflow",
        adapterId: "infoflow",
        recipient: "group:10838226",
      },
      channelContext: {
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        senderName: "詹荣瑞",
        chatId: "10838226",
        messageId: "1870319775739153405",
        eventType: "MESSAGE_RECEIVE",
        contentType: "mixed",
        attachments: [{ kind: "image", reference: "image-fid-1" }],
        mentions: ["神经蛙"],
        mentionedSelf: true,
      },
    };
    const executeSession = vi.fn(async (_input: unknown) => ({ assistantText: "我叫神经蛙。" }));

    await executeSparkDaemonSessionRunTask(task, context(task), {
      paths,
      executeSession,
    });

    const input = executeSession.mock.calls[0]?.[0] as
      | {
          prompt?: string;
          systemPrompt?: string;
          messageMetadata?: Record<string, unknown>;
          sessionSource?: string;
          approvalMethod?: string;
          sessionSurface?: string;
          allowedTools?: readonly string[];
        }
      | undefined;
    expect(input?.prompt).toBe("@神经蛙 你叫什么名字");
    expect(input?.approvalMethod).toBe("auto");
    expect(input?.sessionSurface).toBe("channel");
    expect(input?.allowedTools).toEqual(["session", "ask", "context", "todo"]);
    expect(input?.systemPrompt).toContain(
      "Current conversation surface: Infoflow (如流) group chat",
    );
    expect(input?.systemPrompt).toContain("Use platform-supplied sender metadata for identity");
    expect(input?.systemPrompt).toContain("Dynamic context checkpoint: infoflow-message.");
    expect(input?.systemPrompt).toContain(
      "Message-platform sessions expose only a bounded safe tool surface",
    );
    expect(input?.systemPrompt).toContain('session({ action: "list", scope: "workspace" })');
    expect(input?.systemPrompt).toContain('session({ action: "send", kind: "request", toSessionId');
    expect(input?.systemPrompt).toContain("a local surface=local target");
    expect(input?.systemPrompt).toContain('senderId: "zhanrongrui"');
    expect(input?.systemPrompt).toContain('groupId: "10838226"');
    expect(input?.systemPrompt).toContain('messageId: "1870319775739153405"');
    expect(input?.systemPrompt).toContain('eventType: "MESSAGE_RECEIVE"');
    expect(input?.systemPrompt).toContain('contentType: "mixed"');
    expect(input?.systemPrompt).toContain('"reference":"image-fid-1"');
    expect(input?.sessionSource).toBe("channel");
    expect(input?.messageMetadata).toEqual({
      origin: {
        kind: "user",
        host: "channel",
        surface: "channel",
        adapter: "infoflow",
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        senderName: "詹荣瑞",
      },
      channel: {
        adapter: "infoflow",
        externalKey: "infoflow:group:10838226",
        senderId: "zhanrongrui",
        senderName: "詹荣瑞",
        chatId: "10838226",
        messageId: "1870319775739153405",
        eventType: "MESSAGE_RECEIVE",
        contentType: "mixed",
        attachments: [{ kind: "image", reference: "image-fid-1" }],
      },
    });
    expect(input?.systemPrompt).not.toContain("@神经蛙 你叫什么名字");
    expect(input?.systemPrompt).not.toContain("You are handling an Infoflow");
  });

  it("passes the exact originating channel binding to the headless session", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_qq_origin",
      prompt: "research this",
      channelReply: {
        workspaceId: "workspace-qq",
        adapterId: "qqbot",
        recipient: "qq:user:42",
      },
      channelContext: {
        externalKey: "qqbot:user:42",
        senderId: "42",
      },
    };

    await executeSparkDaemonSessionRunTask(task, context(task), { paths, executeSession });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionSurface: "channel",
        channelBinding: {
          adapter: "qqbot",
          externalKey: "qqbot:user:42",
        },
      }),
    );
  });

  it("keeps direct session requests exact and projects their execution source as session", async () => {
    const messageMetadata = {
      origin: {
        kind: "session",
        sessionId: "sess_sender",
        surface: "local",
        host: "tui",
      },
      sessionMail: {
        messageId: "mail:request-1",
        kind: "request",
        intent: "work.request",
        fromSessionId: "sess_sender",
        toSessionId: "sess_target",
      },
    };
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));

    await executeSparkDaemonSessionRunTask(
      {
        type: "session.run",
        sessionId: "sess_target",
        prompt: "Run exactly this request",
        messageMetadata,
      },
      context({
        type: "session.run",
        sessionId: "sess_target",
        prompt: "Run exactly this request",
      }),
      { paths, executeSession },
    );

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Run exactly this request",
        messageMetadata,
        sessionSource: "session",
      }),
    );
  });

  it("adds a daemon origin to generic queued turns", async () => {
    const executeSession = vi.fn(async () => ({ assistantText: "done" }));
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_daemon",
      prompt: "generic daemon turn",
    };

    await executeSparkDaemonSessionRunTask(task, context(task), { paths, executeSession });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "generic daemon turn",
        sessionSource: "daemon",
        messageMetadata: {
          origin: { kind: "user", host: "daemon", surface: "local" },
        },
      }),
    );
  });

  it("keeps channel-bound sessions restricted on non-channel submitted turns", async () => {
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_channel_bound",
      prompt: "run this locally",
    };
    const executeSession = vi.fn(async () => ({ assistantText: "forwarded" }));

    await executeSparkDaemonSessionRunTask(task, context(task), {
      paths,
      executeSession,
      sessionRegistry: {
        get: vi.fn(
          async () =>
            ({
              bindings: [
                {
                  kind: "channel",
                  adapter: "feishu",
                  externalKey: "feishu:chat:oc_1",
                },
              ],
            }) as never,
        ),
        recordRun: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
      },
    });

    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionSurface: "channel",
        allowedTools: ["session", "ask", "context", "todo"],
        systemPrompt: expect.stringContaining(
          'kind: "request", toSessionId, intent, message }) to queue work on a local surface=local target',
        ),
      }),
    );
  });

  it("indexes the durable transcript and preserves task routing on streamed view events", async () => {
    const emitted: SparkDaemonEvent[] = [];
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => ({}) as never);
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_streamed",
      prompt: "hello",
      cwd: "/workspace/frozen",
      workspaceBindingId: "binding-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
    };
    const executeSession = vi.fn(async (input: { onEvent?: (event: unknown) => unknown }) => {
      await input.onEvent?.({
        type: "view_event",
        event: {
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: task.sessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: "assistant-1",
            role: "assistant",
            text: "done",
            status: "done",
            metadata: {},
          },
        },
      });
      return {
        sessionId: task.sessionId,
        sessionPath: "/daemon/sessions/sess_streamed.jsonl",
        assistantText: "done",
        eventsStreamed: true,
      };
    });
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: { recordTurnQueued, recordTurnSettled, recordRun },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });

    await expect(executor(task, context(task, emitted))).resolves.toMatchObject({
      sessionPath: "/daemon/sessions/sess_streamed.jsonl",
    });
    expect(recordTurnQueued).toHaveBeenCalledWith(task.sessionId);
    expect(recordRun).toHaveBeenCalledWith({
      sessionId: task.sessionId,
      sessionPath: "/daemon/sessions/sess_streamed.jsonl",
    });
    expect(recordTurnSettled).not.toHaveBeenCalled();
    expect(executeSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace/frozen" }),
    );
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "daemon.view_event",
        sessionId: task.sessionId,
        workspaceId: "workspace-1",
        projectId: "project-1",
        invocationId: "invocation-1",
        metadata: { workspaceBindingId: "binding-1" },
      }),
    ]);
  });

  it("names an untitled local session only after its completed transcript is indexed", async () => {
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => ({}) as never);
    const setTitleIfMissing = vi.fn(async (_sessionId: string, title: string) => ({
      sessionId: task.sessionId,
      scope: { kind: "workspace" as const, workspaceId: "workspace-title" },
      workspaceId: "workspace-title",
      title,
      status: "ready" as const,
      bindings: [],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:02:00.000Z",
      sessionPath: "/daemon/sessions/sess_auto_title.jsonl",
    }));
    let resolveTitle!: (title: string) => void;
    const generateSessionTitle = vi.fn(
      async () => await new Promise<string>((resolve) => (resolveTitle = resolve)),
    );
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_auto_title",
      prompt: "Diagnose why the daemon does not start.",
      model: "baidu-oneapi/gpt-5.6-sol",
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      modelControl: {
        effectiveModel: vi.fn(async () => ({
          providerName: "baidu-oneapi",
          modelId: "gpt-5.6-sol",
        })),
        prepareModel: vi.fn(async () => undefined),
        generateSessionTitle,
      },
      sessionRegistry: {
        get: vi.fn(async () => ({
          sessionId: task.sessionId,
          scope: { kind: "workspace" as const, workspaceId: "workspace-title" },
          workspaceId: "workspace-title",
          status: "ready" as const,
          bindings: [],
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:01:00.000Z",
          sessionPath: "/daemon/sessions/sess_auto_title.jsonl",
        })),
        setTitleIfMissing,
        recordTurnQueued,
        recordTurnSettled,
        recordRun,
      },
      createSparkHeadlessSessionExecutor: () => async () => ({
        sessionId: task.sessionId,
        sessionPath: "/daemon/sessions/sess_auto_title.jsonl",
        assistantText: "done",
      }),
    });

    const emitted: SparkDaemonEvent[] = [];
    await expect(executor(task, context(task, emitted))).resolves.toMatchObject({
      assistantText: "done",
    });
    expect(recordRun).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(generateSessionTitle).toHaveBeenCalledWith({
        prompt: task.prompt,
        model: { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" },
        signal: expect.any(AbortSignal),
      }),
    );
    // The main invocation has already resolved while the advisory title leaf is pending.
    expect(setTitleIfMissing).not.toHaveBeenCalled();
    resolveTitle("Daemon startup diagnosis");
    await vi.waitFor(() =>
      expect(setTitleIfMissing).toHaveBeenCalledWith(task.sessionId, "Daemon startup diagnosis"),
    );
    await vi.waitFor(() =>
      expect(emitted).toContainEqual(
        expect.objectContaining({
          type: "daemon.session.updated",
          sessionId: task.sessionId,
          title: "Daemon startup diagnosis",
        }),
      ),
    );
    expect(recordRun.mock.invocationCallOrder[0]).toBeLessThan(
      generateSessionTitle.mock.invocationCallOrder[0]!,
    );
  });

  it("does not name a session when transcript indexing fails", async () => {
    const generateSessionTitle = vi.fn(async () => "Unused title");
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_title_index_failure",
      prompt: "This should keep the mechanical sidebar fallback.",
      model: "baidu-oneapi/gpt-5.6-sol",
    };
    const executor = createSparkDaemonTaskExecutor({
      paths,
      modelControl: {
        effectiveModel: vi.fn(async () => ({
          providerName: "baidu-oneapi",
          modelId: "gpt-5.6-sol",
        })),
        prepareModel: vi.fn(async () => undefined),
        generateSessionTitle,
      },
      sessionRegistry: {
        get: vi.fn(async () => undefined),
        setTitleIfMissing: vi.fn(async () => ({}) as never),
        recordTurnQueued: vi.fn(async () => ({}) as never),
        recordTurnSettled: vi.fn(async () => ({}) as never),
        recordRun: vi.fn(async () => {
          throw new Error("registry unavailable");
        }),
      },
      createSparkHeadlessSessionExecutor: () => async () => ({
        sessionId: task.sessionId,
        sessionPath: "/daemon/sessions/sess_title_index_failure.jsonl",
        assistantText: "completed once",
      }),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(executor(task, context(task))).resolves.toMatchObject({
        assistantText: "completed once",
        registryPersistence: { status: "failed" },
      });
      expect(generateSessionTitle).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("processes an already-committed turn with a durable warning when registry indexing fails", async () => {
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => {
      throw new Error("registry disk unavailable");
    });
    const executeSession = vi.fn(async () => ({
      sessionId: "sess_warning",
      sessionPath: "/daemon/sessions/sess_warning.jsonl",
      assistantText: "done once",
    }));
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: { recordTurnQueued, recordTurnSettled, recordRun },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_warning",
      prompt: "run once",
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(executor(task, context(task))).resolves.toMatchObject({
        assistantText: "done once",
        registryPersistence: {
          status: "failed",
          message: expect.stringContaining("registry disk unavailable"),
        },
      });
      expect(executeSession).toHaveBeenCalledTimes(1);
      expect(recordTurnSettled).toHaveBeenCalledWith(task.sessionId);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("failed to index completed session sess_warning"),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("settles a committed turn that returns no transcript path without replaying it", async () => {
    const recordTurnQueued = vi.fn(async () => ({}) as never);
    const recordTurnSettled = vi.fn(async () => ({}) as never);
    const recordRun = vi.fn(async () => ({}) as never);
    const executeSession = vi.fn(async () => ({
      sessionId: "sess_missing_path",
      assistantText: "done once",
    }));
    const executor = createSparkDaemonTaskExecutor({
      paths,
      sessionRegistry: { recordTurnQueued, recordTurnSettled, recordRun },
      createSparkHeadlessSessionExecutor: () => executeSession,
    });
    const task: SparkDaemonSessionRunTask = {
      type: "session.run",
      sessionId: "sess_missing_path",
      prompt: "run once",
    };

    await expect(executor(task, context(task))).resolves.toMatchObject({
      registryPersistence: {
        status: "failed",
        message: expect.stringContaining("without a native sessionPath"),
      },
    });
    expect(executeSession).toHaveBeenCalledTimes(1);
    expect(recordRun).not.toHaveBeenCalled();
    expect(recordTurnSettled).toHaveBeenCalledWith(task.sessionId);
  });
});
