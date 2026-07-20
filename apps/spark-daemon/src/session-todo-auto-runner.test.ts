import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { defaultTaskTodoStore } from "@zendev-lab/spark-tasks";
import { describe, expect, it, vi } from "vitest";

import {
  reconcileIdleSessionTodos,
  SESSION_TODO_AUTO_SOURCE_KIND,
  sessionTodoStateDigest,
} from "./session-todo-auto-runner.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

describe("idle session TODO reconciliation", () => {
  it("queues one durable continuation for an idle session and freezes model defaults", async () => {
    const harness = createHarness();
    const session = localSession("sess_todo", harness.cwd);
    await saveTodos(harness.cwd, session.sessionId, [
      { id: "todo-a", displayNumber: 4, content: "Implement the fix", status: "in_progress" },
      { id: "todo-b", displayNumber: 5, content: "Run verification", status: "pending" },
    ]);
    const recordTurnQueued = vi.fn(async () => session);
    const modelControl = {
      effectiveModel: vi.fn(async () => ({ providerName: "provider", modelId: "model" })),
      effectiveThinkingLevel: vi.fn(async () => "high" as const),
      prepareModel: vi.fn(async () => undefined),
    };

    try {
      await expect(
        reconcileIdleSessionTodos({
          invocationStore: harness.store,
          sessionRegistry: { list: async () => [session], recordTurnQueued },
          modelControl,
        }),
      ).resolves.toEqual({ examined: 1, submitted: 1, errors: [] });

      const [invocation] = harness.store.listPendingForSession(session.sessionId);
      expect(invocation).toMatchObject({
        status: "queued",
        sourceKind: SESSION_TODO_AUTO_SOURCE_KIND,
        task: {
          type: "session.run",
          sessionId: session.sessionId,
          cwd: harness.cwd,
          model: "provider/model",
          thinkingLevel: "high",
          actor: "spark-daemon-session-todo",
          messageMetadata: {
            sessionTodo: { mode: "auto", itemIds: ["todo-a", "todo-b"] },
          },
        },
      });
      expect(invocation?.prompt).toContain("#4 [in_progress] Implement the fix");
      expect(invocation?.prompt).toContain("#5 [pending] Run verification");
      expect(recordTurnQueued).toHaveBeenCalledWith(session.sessionId);
      expect(modelControl.prepareModel).toHaveBeenCalledWith({
        providerName: "provider",
        modelId: "model",
      });
    } finally {
      harness.close();
    }
  });

  it("does not spin when an automatic turn leaves the TODO state unchanged", async () => {
    const harness = createHarness();
    const session = localSession("sess_stable", harness.cwd);
    const todos = [
      { id: "todo-a", content: "Finish durable work", status: "in_progress" as const },
    ];
    await saveTodos(harness.cwd, session.sessionId, todos);
    const sessionRegistry = {
      list: async () => [session],
      recordTurnQueued: async () => session,
    };

    try {
      await reconcileIdleSessionTodos({
        invocationStore: harness.store,
        sessionRegistry,
      });
      const [first] = harness.store.listPendingForSession(session.sessionId);
      expect(first).toBeDefined();
      harness.store.claimNext("worker", "2026-07-20T00:00:01.000Z");
      harness.store.complete(first!.invocationId, {
        status: "succeeded",
        now: "2026-07-20T00:00:02.000Z",
      });

      await expect(
        reconcileIdleSessionTodos({ invocationStore: harness.store, sessionRegistry }),
      ).resolves.toEqual({ examined: 1, submitted: 0, errors: [] });
      expect(harness.store.listPage({ sessionId: session.sessionId }).total).toBe(1);
      expect(first?.idempotencyKey).toBe(
        `session.todo:${sessionTodoStateDigest(session.sessionId, todos)}`,
      );
    } finally {
      harness.close();
    }
  });

  it("queues the next continuation only after the checklist makes state progress", async () => {
    const harness = createHarness();
    const session = localSession("sess_progress", harness.cwd);
    const sessionRegistry = {
      list: async () => [session],
      recordTurnQueued: async () => session,
    };
    await saveTodos(harness.cwd, session.sessionId, [
      { id: "todo-a", content: "First", status: "in_progress" },
      { id: "todo-b", content: "Second", status: "pending" },
    ]);

    try {
      await reconcileIdleSessionTodos({ invocationStore: harness.store, sessionRegistry });
      const [first] = harness.store.listPendingForSession(session.sessionId);
      harness.store.claimNext("worker", "2026-07-20T00:00:01.000Z");
      harness.store.complete(first!.invocationId, {
        status: "succeeded",
        now: "2026-07-20T00:00:02.000Z",
      });
      await saveTodos(harness.cwd, session.sessionId, [
        { id: "todo-a", content: "First", status: "done" },
        { id: "todo-b", content: "Second", status: "in_progress" },
      ]);

      await expect(
        reconcileIdleSessionTodos({ invocationStore: harness.store, sessionRegistry }),
      ).resolves.toEqual({ examined: 1, submitted: 1, errors: [] });
      expect(harness.store.listPage({ sessionId: session.sessionId }).total).toBe(2);
      expect(harness.store.listPendingForSession(session.sessionId)[0]?.prompt).toContain(
        "[in_progress] Second",
      );
    } finally {
      harness.close();
    }
  });

  it("skips busy, blocked-only, and fenced sessions while continuing channel TODOs", async () => {
    const harness = createHarness();
    const busy = localSession("sess_busy", harness.cwd);
    const blocked = localSession("sess_blocked", harness.cwd);
    const channel: SparkSessionRegistryRecord = {
      ...localSession("sess_channel", harness.cwd),
      bindings: [
        {
          kind: "channel",
          adapter: "qqbot",
          externalKey: "qqbot:user:123",
          boundAt: "2026-07-20T00:00:00.000Z",
        },
      ],
    };
    await saveTodos(harness.cwd, busy.sessionId, [
      { id: "todo-busy", content: "Wait for current turn", status: "in_progress" },
    ]);
    await saveTodos(harness.cwd, blocked.sessionId, [
      { id: "todo-blocked", content: "Needs input", status: "blocked" },
    ]);
    await saveTodos(harness.cwd, channel.sessionId, [
      { id: "todo-channel", content: "Owned by channel", status: "in_progress" },
    ]);
    harness.store.submit({
      sessionId: busy.sessionId,
      prompt: "user turn",
      task: { type: "session.run", sessionId: busy.sessionId, prompt: "user turn" },
    });
    const recordTurnQueued = vi.fn(async () => busy);

    try {
      await expect(
        reconcileIdleSessionTodos({
          invocationStore: harness.store,
          sessionRegistry: {
            list: async () => [busy, blocked, channel],
            recordTurnQueued,
          },
        }),
      ).resolves.toEqual({ examined: 3, submitted: 1, errors: [] });
      expect(recordTurnQueued).toHaveBeenCalledOnce();
      expect(recordTurnQueued).toHaveBeenCalledWith(channel.sessionId);
      expect(harness.store.listPendingForSession(channel.sessionId)[0]).toMatchObject({
        sourceKind: SESSION_TODO_AUTO_SOURCE_KIND,
        task: {
          sessionId: channel.sessionId,
          messageMetadata: { origin: { host: "daemon" } },
        },
      });
      expect(harness.store.listPendingForSession(channel.sessionId)[0]?.task).not.toHaveProperty(
        "channelReply",
      );

      await expect(
        reconcileIdleSessionTodos({
          invocationStore: harness.store,
          sessionRegistry: { list: async () => [blocked], recordTurnQueued },
          canAdmit: () => false,
        }),
      ).resolves.toEqual({ examined: 1, submitted: 0, errors: [] });
    } finally {
      harness.close();
    }
  });
});

function createHarness() {
  const cwd = mkdtempSync(join(tmpdir(), "spark-session-todo-auto-"));
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  return {
    cwd,
    db,
    store: new SparkInvocationStore(db),
    close() {
      db.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function localSession(sessionId: string, cwd: string): SparkSessionRegistryRecord {
  return {
    sessionId,
    scope: { kind: "workspace", workspaceId: "workspace-test" },
    workspaceId: "workspace-test",
    cwd,
    status: "ready",
    bindings: [],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

async function saveTodos(
  cwd: string,
  sessionId: string,
  todos: Parameters<ReturnType<typeof defaultTaskTodoStore>["saveSessionTodos"]>[1],
) {
  await defaultTaskTodoStore(cwd).saveSessionTodos(`session:${sessionId}`, todos);
}
