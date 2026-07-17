import { describe, expect, it, vi } from "vitest";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";

import { assignCompletedSessionTitle } from "./session-title.ts";

const model = { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" };

describe("completed session title assignment", () => {
  it("normalizes a bounded model title and persists it through compare-and-set", async () => {
    const session = localSession();
    const escape = String.fromCodePoint(0x1b);
    const bidiOverride = String.fromCodePoint(0x202e);
    const generateSessionTitle = vi.fn(
      async () =>
        `${escape}[31m# 标题：修复 daemon 启动${escape}[0m${bidiOverride}\n不要输出这一行`,
    );
    const setTitleIfMissing = vi.fn(async () => ({ ...session, title: "修复 daemon 启动" }));

    await assignCompletedSessionTitle(
      { sessionId: session.sessionId, prompt: "daemon 为什么启动失败？", model },
      {
        modelControl: { generateSessionTitle },
        sessionRegistry: { get: async () => session, setTitleIfMissing },
      },
    );

    expect(generateSessionTitle).toHaveBeenCalledWith({
      prompt: "daemon 为什么启动失败？",
      model,
    });
    expect(setTitleIfMissing).toHaveBeenCalledWith(session.sessionId, "修复 daemon 启动");
  });

  it("removes terminal control sequences from the mechanical fallback", async () => {
    const session = localSession("sess_control_fallback");
    const escape = String.fromCodePoint(0x1b);
    const setTitleIfMissing = vi.fn(async () => session);

    await assignCompletedSessionTitle(
      {
        sessionId: session.sessionId,
        prompt: `${escape}[2J- 修复 daemon 启动。继续运行。`,
        model,
      },
      {
        modelControl: { generateSessionTitle: async () => undefined },
        sessionRegistry: { get: async () => session, setTitleIfMissing },
      },
    );

    expect(setTitleIfMissing).toHaveBeenCalledWith(session.sessionId, "修复 daemon 启动");
  });

  it("uses a mechanical first-sentence fallback when the leaf degrades or throws", async () => {
    const session = localSession();
    const setTitleIfMissing = vi.fn(async () => session);
    const logError = vi.fn();

    await assignCompletedSessionTitle(
      {
        sessionId: session.sessionId,
        prompt: "Investigate daemon startup. Then add a regression test.",
        model,
      },
      {
        modelControl: { generateSessionTitle: async () => undefined },
        sessionRegistry: { get: async () => session, setTitleIfMissing },
        logError,
      },
    );
    expect(setTitleIfMissing).toHaveBeenLastCalledWith(
      session.sessionId,
      "Investigate daemon startup",
    );

    await assignCompletedSessionTitle(
      { sessionId: session.sessionId, prompt: "修复标题生成。不要重放主任务。", model },
      {
        modelControl: {
          generateSessionTitle: async () => {
            throw new Error("provider unavailable");
          },
        },
        sessionRegistry: { get: async () => session, setTitleIfMissing },
        logError,
      },
    );
    expect(setTitleIfMissing).toHaveBeenLastCalledWith(session.sessionId, "修复标题生成");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("using fallback"));
  });

  it("does not persist a fallback title after the owning invocation is cancelled", async () => {
    const session = localSession("sess_cancelled_title");
    const controller = new AbortController();
    const setTitleIfMissing = vi.fn(async () => session);
    const logError = vi.fn();
    const generateSessionTitle = vi.fn(
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

    const assignment = assignCompletedSessionTitle(
      {
        sessionId: session.sessionId,
        prompt: "Do not name this cancelled invocation.",
        model,
        signal: controller.signal,
      },
      {
        modelControl: { generateSessionTitle },
        sessionRegistry: { get: async () => session, setTitleIfMissing },
        logError,
      },
    );
    await vi.waitFor(() => expect(generateSessionTitle).toHaveBeenCalledOnce());

    controller.abort(new Error("invocation cancelled"));

    await expect(assignment).resolves.toBeUndefined();
    expect(setTitleIfMissing).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("skips existing, channel-bound, and archived sessions before calling the model", async () => {
    const generateSessionTitle = vi.fn(async () => "Unused");
    const setTitleIfMissing = vi.fn(async (sessionId: string) => localSession(sessionId));
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
      await assignCompletedSessionTitle(
        { sessionId: session.sessionId, prompt: "unused", model },
        {
          modelControl: { generateSessionTitle },
          sessionRegistry: { get: async () => session, setTitleIfMissing },
        },
      );
    }

    expect(generateSessionTitle).not.toHaveBeenCalled();
    expect(setTitleIfMissing).not.toHaveBeenCalled();
  });

  it("keeps title persistence failure advisory", async () => {
    const logError = vi.fn();
    await expect(
      assignCompletedSessionTitle(
        { sessionId: "sess_failure", prompt: "Keep the main turn successful", model },
        {
          modelControl: { generateSessionTitle: async () => "Main turn stays successful" },
          sessionRegistry: {
            get: async () => localSession("sess_failure"),
            setTitleIfMissing: async () => {
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
