import { describe, expect, it, vi } from "vitest";
import { SPARK_PROTOCOL_VERSION, type SparkDaemonEvent } from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import type { SparkDaemonSessionRunTask, SparkDaemonTaskExecutionContext } from "../core/types.ts";
import {
  createSparkDaemonQueueTaskExecutor,
  executeSparkDaemonSessionRunTask,
} from "./session-run.ts";

const paths = resolveSparkPaths({
  app: "daemon",
  env: { HOME: "/tmp/spark-daemon-session-run-test" },
});

function context(
  task: SparkDaemonSessionRunTask,
  emitted: SparkDaemonEvent[] = [],
): SparkDaemonTaskExecutionContext {
  return {
    fileName: "turn.json",
    queueEntry: {
      fileName: "turn.json",
      filePath: "/tmp/turn.json",
      payload: { enqueuedAt: "2026-07-10T08:00:00.000Z", task },
    },
    invocationId: "invocation-1",
    signal: new AbortController().signal,
    emitEvent: (event) => {
      emitted.push(event);
    },
  };
}

describe("daemon native session execution", () => {
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
      | { prompt?: string; systemPrompt?: string }
      | undefined;
    expect(input?.prompt).toBe("@神经蛙 你叫什么名字");
    expect(input?.systemPrompt).toContain(
      "Current conversation surface: Infoflow (如流) group chat",
    );
    expect(input?.systemPrompt).toContain("Use platform-supplied sender metadata for identity");
    expect(input?.systemPrompt).toContain("Dynamic context checkpoint: infoflow-message.");
    expect(input?.systemPrompt).toContain('senderId: "zhanrongrui"');
    expect(input?.systemPrompt).toContain('groupId: "10838226"');
    expect(input?.systemPrompt).toContain('messageId: "1870319775739153405"');
    expect(input?.systemPrompt).not.toContain("@神经蛙 你叫什么名字");
    expect(input?.systemPrompt).not.toContain("You are handling an Infoflow");
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
    const executor = createSparkDaemonQueueTaskExecutor({
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
    const executor = createSparkDaemonQueueTaskExecutor({
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
    const executor = createSparkDaemonQueueTaskExecutor({
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
