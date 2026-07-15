import { describe, expect, it, vi } from "vitest";
import { SPARK_PROTOCOL_VERSION, type SparkDaemonEvent } from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import type { SparkDaemonSessionRunTask, SparkDaemonTaskExecutionContext } from "../core/types.ts";
import {
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
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith("workspace-qq", "qqbot", {
      recipient: "c2c:user-1",
      senderId: "user-1",
      messageId: "message-1",
      preview: "请检查",
      text: "检查完成",
    });
    expect(complete.mock.invocationCallOrder[0]).toBeLessThan(
      sendReply.mock.invocationCallOrder[0]!,
    );
  });

  it("falls back to a rich channel reply when a stream is unavailable", async () => {
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

    expect(sendReply).toHaveBeenCalledWith("workspace-infoflow", "infoflow", {
      recipient: "group:10838226",
      senderId: "zhanrongrui",
      messageId: "message-1",
      preview: "原始消息",
      text: "**完成**",
    });
  });

  it("uses the final fallback when streaming card completion fails", async () => {
    const sendReply = vi.fn(async () => undefined);
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
    });

    try {
      await executor(task, context(task));
      expect(sendReply).toHaveBeenCalledWith(
        "workspace-infoflow",
        "infoflow",
        expect.objectContaining({ recipient: "alice", text: "done" }),
      );
    } finally {
      error.mockRestore();
    }
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
    expect(input?.systemPrompt).toContain(
      'session({ action: "send", kind: "notification", toSessionId',
    );
    expect(input?.systemPrompt).toContain(
      'a local surface=local target with kind="request" for queued work',
    );
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
          'a local surface=local target with kind="request" for queued work',
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
