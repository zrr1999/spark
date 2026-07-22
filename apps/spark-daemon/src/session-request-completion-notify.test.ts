import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  notifySessionRequestCompletion,
  renderSessionRequestCompletionPrompt,
  SESSION_REQUEST_COMPLETION_SOURCE_KIND,
} from "./session-request-completion-notify.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

describe("session request completion notify", () => {
  it("submits one durable sender continuation for wait=accepted request completions", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender", harness.cwd);
    const target = localSession("sess_target", harness.cwd);
    const recordTurnQueued = vi.fn(async () => sender);
    const modelControl = {
      effectiveModel: vi.fn(async () => ({ providerName: "provider", modelId: "model" })),
      effectiveThinkingLevel: vi.fn(async () => "medium" as const),
      prepareModel: vi.fn(async () => undefined),
    };

    const source = harness.store.submit({
      sessionId: target.sessionId,
      prompt: "do delegated work",
      task: {
        type: "session.run",
        sessionId: target.sessionId,
        prompt: "do delegated work",
        cwd: harness.cwd,
        messageMetadata: {
          sessionMail: {
            messageId: "mail:req-1",
            kind: "request",
            intent: "work.request",
            fromSessionId: sender.sessionId,
            toSessionId: target.sessionId,
            notifyOnCompletion: true,
          },
        },
      },
    });

    try {
      await expect(
        notifySessionRequestCompletion(
          {
            invocationStore: harness.store,
            sessionRegistry: {
              get: async (sessionId) => (sessionId === sender.sessionId ? sender : target),
              recordTurnQueued,
            },
            modelControl,
          },
          {
            invocation: source,
            task: source.task as never,
            completion: {
              status: "succeeded",
              result: { assistantText: "investigation complete" },
            },
          },
        ),
      ).resolves.toMatchObject({ submitted: true });

      const [wake] = harness.store.listPendingForSession(sender.sessionId);
      expect(wake).toMatchObject({
        status: "queued",
        sourceKind: SESSION_REQUEST_COMPLETION_SOURCE_KIND,
        sourceRef: source.invocationId,
        task: {
          type: "session.run",
          sessionId: sender.sessionId,
          cwd: harness.cwd,
          model: "provider/model",
          thinkingLevel: "medium",
          actor: "spark-daemon-session-request-completion",
          messageMetadata: {
            sessionRequestCompletion: {
              sourceInvocationId: source.invocationId,
              sourceSessionId: target.sessionId,
              messageId: "mail:req-1",
              status: "succeeded",
            },
          },
        },
      });
      expect(wake?.prompt).toContain("investigation complete");
      expect(wake?.prompt).toContain(source.invocationId);
      expect(recordTurnQueued).toHaveBeenCalledWith(sender.sessionId);

      await expect(
        notifySessionRequestCompletion(
          {
            invocationStore: harness.store,
            sessionRegistry: {
              get: async (sessionId) => (sessionId === sender.sessionId ? sender : target),
              recordTurnQueued,
            },
          },
          {
            invocation: source,
            task: source.task as never,
            completion: {
              status: "succeeded",
              result: { assistantText: "investigation complete" },
            },
          },
        ),
      ).resolves.toMatchObject({ submitted: false, skippedReason: "already_notified" });
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it("skips wake when notifyOnCompletion is false", async () => {
    const harness = createHarness();
    const sender = localSession("sess_sender", harness.cwd);
    const target = localSession("sess_target", harness.cwd);
    const source = harness.store.submit({
      sessionId: target.sessionId,
      prompt: "blocking request",
      task: {
        type: "session.run",
        sessionId: target.sessionId,
        prompt: "blocking request",
        messageMetadata: {
          sessionMail: {
            messageId: "mail:req-2",
            kind: "request",
            fromSessionId: sender.sessionId,
            toSessionId: target.sessionId,
            notifyOnCompletion: false,
          },
        },
      },
    });

    try {
      await expect(
        notifySessionRequestCompletion(
          {
            invocationStore: harness.store,
            sessionRegistry: {
              get: async (sessionId) => (sessionId === sender.sessionId ? sender : target),
              recordTurnQueued: async () => sender,
            },
          },
          {
            invocation: source,
            task: source.task as never,
            completion: { status: "succeeded", result: { assistantText: "done" } },
          },
        ),
      ).resolves.toMatchObject({ submitted: false, skippedReason: "notify_disabled" });
      expect(harness.store.listPendingForSession(sender.sessionId)).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("renders a synthesis prompt with failure details", () => {
    const prompt = renderSessionRequestCompletionPrompt({
      mail: {
        messageId: "mail:fail",
        kind: "request",
        intent: "work.request",
        fromSessionId: "sess_sender",
        toSessionId: "sess_target",
      },
      targetSessionId: "sess_target",
      sourceInvocationId: "inv_fail",
      completion: {
        status: "failed",
        errorCode: "TOOL_ERROR",
        errorMessage: "boom",
      },
    });
    expect(prompt).toContain("Status: failed");
    expect(prompt).toContain("TOOL_ERROR: boom");
    expect(prompt).toContain("Do not claim the delegated work is still running");
  });
});

function createHarness() {
  const cwd = mkdtempSync(join(tmpdir(), "spark-session-request-completion-"));
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
