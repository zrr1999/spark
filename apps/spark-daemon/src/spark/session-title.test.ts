import { describe, expect, it, vi } from "vitest";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";

import { assignCompletedSessionRole } from "./session-title.ts";

const model = { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" };

describe("completed session role assignment", () => {
  it("normalizes a bounded model role and persists it through compare-and-set", async () => {
    const session = localSession();
    const escape = String.fromCodePoint(0x1b);
    const bidiOverride = String.fromCodePoint(0x202e);
    const generateSessionRole = vi.fn(
      async () => `${escape}[31m# 职责：运行维护${escape}[0m${bidiOverride}\n不要输出这一行`,
    );
    const setRoleIfMissing = vi.fn(async () => ({
      ...session,
      title: "运行维护",
      role: "运行维护",
    }));

    await assignCompletedSessionRole(
      { sessionId: session.sessionId, prompt: "daemon 为什么启动失败？", model },
      {
        modelControl: { generateSessionRole },
        sessionRegistry: { get: async () => session, setRoleIfMissing },
      },
    );

    expect(generateSessionRole).toHaveBeenCalledWith({
      prompt: "daemon 为什么启动失败？",
      model,
    });
    expect(setRoleIfMissing).toHaveBeenCalledWith(session.sessionId, "运行维护");
  });

  it("removes terminal control sequences from the mechanical fallback", async () => {
    const session = localSession("sess_control_fallback");
    const escape = String.fromCodePoint(0x1b);
    const setRoleIfMissing = vi.fn(async () => session);

    await assignCompletedSessionRole(
      {
        sessionId: session.sessionId,
        prompt: `${escape}[2J- 修复 daemon 启动。继续运行。`,
        model,
      },
      {
        modelControl: { generateSessionRole: async () => undefined },
        sessionRegistry: { get: async () => session, setRoleIfMissing },
      },
    );

    expect(setRoleIfMissing).toHaveBeenCalledWith(session.sessionId, "运行维护");
  });

  it("uses a stable responsibility fallback when the leaf degrades or throws", async () => {
    const session = localSession();
    const setRoleIfMissing = vi.fn(async () => session);
    const logError = vi.fn();

    await assignCompletedSessionRole(
      {
        sessionId: session.sessionId,
        prompt: "Investigate daemon startup. Then add a regression test.",
        model,
      },
      {
        modelControl: { generateSessionRole: async () => undefined },
        sessionRegistry: { get: async () => session, setRoleIfMissing },
        logError,
      },
    );
    expect(setRoleIfMissing).toHaveBeenLastCalledWith(session.sessionId, "Runtime Operations");

    await assignCompletedSessionRole(
      { sessionId: session.sessionId, prompt: "修复标题生成。不要重放主任务。", model },
      {
        modelControl: {
          generateSessionRole: async () => {
            throw new Error("provider unavailable");
          },
        },
        sessionRegistry: { get: async () => session, setRoleIfMissing },
        logError,
      },
    );
    expect(setRoleIfMissing).toHaveBeenLastCalledWith(session.sessionId, "通用执行");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("using fallback"));
  });

  it("does not persist a fallback role after the owning invocation is cancelled", async () => {
    const session = localSession("sess_cancelled_title");
    const controller = new AbortController();
    const setRoleIfMissing = vi.fn(async () => session);
    const logError = vi.fn();
    const generateSessionRole = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<string>((_resolve, reject) => {
          const rejectWithReason = () => reject(signal?.reason ?? new Error("cancelled"));
          if (signal?.aborted) {
            rejectWithReason();
            return;
          }
          signal?.addEventListener("abort", rejectWithReason, { once: true });
        }),
    );

    const assignment = assignCompletedSessionRole(
      {
        sessionId: session.sessionId,
        prompt: "Do not name this cancelled invocation.",
        model,
        signal: controller.signal,
      },
      {
        modelControl: { generateSessionRole },
        sessionRegistry: { get: async () => session, setRoleIfMissing },
        logError,
      },
    );
    await vi.waitFor(() => expect(generateSessionRole).toHaveBeenCalledOnce());

    controller.abort(new Error("invocation cancelled"));

    await expect(assignment).resolves.toBeUndefined();
    expect(setRoleIfMissing).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("persists the deterministic fallback when only the advisory leaf times out", async () => {
    const session = localSession("sess_role_timeout");
    const controller = new AbortController();
    const setRoleIfMissing = vi.fn(async () => session);
    const generateSessionRole = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<string>((_resolve, reject) => {
          const rejectWithReason = () => reject(signal?.reason ?? new Error("cancelled"));
          if (signal?.aborted) rejectWithReason();
          else signal?.addEventListener("abort", rejectWithReason, { once: true });
        }),
    );

    const assigning = assignCompletedSessionRole(
      {
        sessionId: session.sessionId,
        prompt: "修复 daemon 启动",
        model,
        signal: controller.signal,
      },
      {
        modelControl: { generateSessionRole },
        sessionRegistry: { get: async () => session, setRoleIfMissing },
      },
    );
    await vi.waitFor(() => expect(generateSessionRole).toHaveBeenCalledOnce());
    controller.abort(new DOMException("role deadline", "TimeoutError"));
    await assigning;

    expect(setRoleIfMissing).toHaveBeenCalledWith(session.sessionId, "运行维护");
  });

  it("skips existing, channel-bound, and archived sessions before calling the model", async () => {
    const generateSessionRole = vi.fn(async () => "Unused");
    const setRoleIfMissing = vi.fn(async (sessionId: string) => localSession(sessionId));
    for (const session of [
      { ...localSession("sess_titled"), title: "Existing" },
      {
        ...localSession("sess_channel"),
        bindings: [
          {
            kind: "channel" as const,
            adapter: "infoflow" as const,
            externalKey: "infoflow:user:alice",
            boundAt: "2026-07-10T00:00:00.000Z",
          },
        ],
      },
      { ...localSession("sess_archived"), status: "archived" as const },
    ]) {
      await assignCompletedSessionRole(
        { sessionId: session.sessionId, prompt: "unused", model },
        {
          modelControl: { generateSessionRole },
          sessionRegistry: { get: async () => session, setRoleIfMissing },
        },
      );
    }

    expect(generateSessionRole).not.toHaveBeenCalled();
    expect(setRoleIfMissing).not.toHaveBeenCalled();
  });

  it("keeps title persistence failure advisory", async () => {
    const logError = vi.fn();
    await expect(
      assignCompletedSessionRole(
        { sessionId: "sess_failure", prompt: "Keep the main turn successful", model },
        {
          modelControl: { generateSessionRole: async () => "Generalist" },
          sessionRegistry: {
            get: async () => localSession("sess_failure"),
            setRoleIfMissing: async () => {
              throw new Error("registry unavailable");
            },
          },
          logError,
        },
      ),
    ).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("failed to persist"));
  });
});

function localSession(sessionId = "sess_title"): SparkSessionRegistryRecord {
  return {
    sessionId,
    scope: { kind: "workspace", workspaceId: "workspace-title" },
    workspaceId: "workspace-title",
    status: "ready",
    bindings: [],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:01:00.000Z",
  };
}
