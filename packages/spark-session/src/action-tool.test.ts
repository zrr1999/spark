import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { executeSparkSessionAction } from "./action-tool.ts";
import { SparkSessionMailStore } from "./mail-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createMailStore(): Promise<SparkSessionMailStore> {
  const sparkHome = await mkdtemp(join(tmpdir(), "spark-session-action-"));
  roots.push(sparkHome);
  return new SparkSessionMailStore({ sparkHome });
}

function session(
  sessionId: string,
  bindings: SparkSessionRegistryRecord["bindings"] = [],
): SparkSessionRegistryRecord {
  return {
    sessionId,
    scope: { kind: "workspace", workspaceId: "workspace-routing" },
    workspaceId: "workspace-routing",
    status: "ready",
    bindings,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

describe("session list and inbox progressive disclosure", () => {
  it("pages whole compact session records with an explicit continuation", async () => {
    const longTitle = "x".repeat(600);
    const records = [
      { ...session("sess_first"), title: longTitle, updatedAt: "2026-07-15T02:00:00.000Z" },
      { ...session("sess_second"), title: "Second", updatedAt: "2026-07-15T01:00:00.000Z" },
    ];
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return records;
      throw new Error(`unexpected RPC method: ${method}`);
    });

    const first = await executeSparkSessionAction(
      {
        action: "list",
        toolCallId: "list-page-1",
        params: { limit: 1, offset: 0 },
        signal: new AbortController().signal,
        ctx: {},
      },
      { request: request as never },
    );
    const firstText = first.content[0]!.text;
    expect(firstText).toContain(`role=${JSON.stringify(longTitle)}`);
    expect(firstText).toContain("next offset=1; remaining=1; use session get for details.");
    expect(first.details).toMatchObject({ offset: 0, limit: 1, total: 2 });

    const second = await executeSparkSessionAction(
      {
        action: "list",
        toolCallId: "list-page-2",
        params: { limit: 1, offset: 1 },
        signal: new AbortController().signal,
        ctx: {},
      },
      { request: request as never },
    );
    expect(second.content[0]!.text).toContain("sess_second");
    expect(second.content[0]!.text).toContain("next offset=none; remaining=0");
  });

  it("pages whole inbox summaries and points to read for full details", async () => {
    const mailStore = await createMailStore();
    await mailStore.send({
      toSessionId: "sess_inbox",
      fromSessionId: "sess_sender",
      body: "first ".repeat(100),
    });
    await mailStore.send({
      toSessionId: "sess_inbox",
      fromSessionId: "sess_sender",
      body: "second detail",
    });

    const first = await executeSparkSessionAction(
      {
        action: "inbox",
        toolCallId: "inbox-page-1",
        params: { limit: 1, offset: 0 },
        signal: new AbortController().signal,
        ctx: { sessionId: "sess_inbox" },
      },
      { mailStore: () => mailStore },
    );
    const text = first.content[0]!.text;
    expect(text).toContain(
      "next offset=1; remaining=1; use session read for full message details.",
    );
    expect(text.split("\n")[1]!.length).toBeLessThan(300);
    expect(first.details).toMatchObject({ offset: 0, limit: 1, total: 2 });
  });
});

describe("persistent session channel routing", () => {
  it("locks an asynchronous request result to its originating adapter binding", async () => {
    const mailStore = await createMailStore();
    const origin = session("sess_origin", [
      {
        kind: "channel",
        adapter: "qqbot",
        externalKey: "qqbot:user:42",
        adapterId: "qq-main",
        adapterAccountIdentity: "channel-account:qqbot:main",
      },
      { kind: "channel", adapter: "infoflow", externalKey: "infoflow:user:42" },
    ]);
    const worker = session("sess_worker");
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "session.get") {
        const sessionId = (params as { sessionId: string }).sessionId;
        return sessionId === origin.sessionId ? origin : worker;
      }
      if (method === "turn.submit") {
        return {
          invocationId: "inv_routing",
          status: "queued",
          acceptedAt: "2026-07-15T00:00:00.000Z",
        };
      }
      throw new Error(`unexpected RPC method: ${method}`);
    });

    await executeSparkSessionAction(
      {
        action: "send",
        toolCallId: "tool-routing",
        params: {
          toSessionId: worker.sessionId,
          kind: "request",
          message: "Investigate and report back",
        },
        signal: new AbortController().signal,
        ctx: {
          sessionId: origin.sessionId,
          sessionSurface: "channel",
          sessionSource: "channel",
          channelBinding: {
            workspaceId: "workspace-qq-A",
            adapter: "qqbot",
            adapterId: "qq-main-A",
            adapterAccountIdentity: "channel-account:qqbot:A",
            externalKey: "qqbot:user:A",
            recipient: "c2c:user:A",
          },
        },
      },
      { request: request as never, mailStore: () => mailStore },
    );

    const [requestMessage] = await mailStore.list(worker.sessionId, { includeAcked: true });
    expect(requestMessage?.originBinding).toEqual({
      workspaceId: "workspace-qq-A",
      adapter: "qqbot",
      adapterId: "qq-main-A",
      adapterAccountIdentity: "channel-account:qqbot:A",
      externalKey: "qqbot:user:A",
      recipient: "c2c:user:A",
    });
    const driftedBinding = {
      workspaceId: "workspace-infoflow-B",
      adapter: "infoflow",
      adapterId: "info-main-B",
      externalKey: "infoflow:user:B",
      recipient: "user:B",
    };
    expect(requestMessage?.originBinding).not.toMatchObject(driftedBinding);
    expect(request).toHaveBeenCalledWith(
      "turn.submit",
      expect.objectContaining({
        sessionId: worker.sessionId,
        originBinding: {
          workspaceId: "workspace-qq-A",
          adapter: "qqbot",
          adapterId: "qq-main-A",
          adapterAccountIdentity: "channel-account:qqbot:A",
          externalKey: "qqbot:user:A",
          recipient: "c2c:user:A",
        },
        messageMetadata: expect.objectContaining({
          sessionMail: expect.objectContaining({
            fromSessionId: origin.sessionId,
            toSessionId: worker.sessionId,
            kind: "request",
            notifyOnCompletion: true,
          }),
        }),
      }),
      expect.anything(),
    );

    await expect(
      executeSparkSessionAction(
        {
          action: "send",
          toolCallId: "tool-routing-result",
          params: {
            toSessionId: origin.sessionId,
            kind: "notification",
            message: "Research complete",
          },
          signal: new AbortController().signal,
          ctx: {
            sessionId: worker.sessionId,
            sessionSurface: "local",
            sessionSource: "session",
          },
        },
        { request: request as never, mailStore: () => mailStore },
      ),
    ).resolves.toMatchObject({ details: { executionTriggered: false } });
    expect(await mailStore.list(origin.sessionId, { includeAcked: true })).toHaveLength(1);
  });
});

describe("blocking session requests", () => {
  const origin = session("sess_origin");
  const worker = session("sess_worker");
  const signal = new AbortController().signal;

  function status(invocationId: string, value: "queued" | "running" | "succeeded" | "failed") {
    return {
      invocationId,
      sessionId: worker.sessionId,
      status: value,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:01.000Z",
      ...(value === "succeeded" || value === "failed"
        ? { finishedAt: "2026-07-17T00:00:01.000Z" }
        : {}),
      eventCursor: 1,
    };
  }

  function baseRequest(handler: (method: string, params: Record<string, unknown>) => unknown) {
    return vi.fn(async (method: string, params: unknown) => {
      if (method === "session.get") {
        return (params as { sessionId: string }).sessionId === origin.sessionId ? origin : worker;
      }
      return await handler(method, params as Record<string, unknown>);
    });
  }

  async function send(
    params: Record<string, unknown>,
    request: ReturnType<typeof baseRequest>,
    mailStore: SparkSessionMailStore,
    extras: { now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
    toolCallId = "blocking-request",
  ) {
    return await executeSparkSessionAction(
      {
        action: "send",
        toolCallId,
        params: { toSessionId: worker.sessionId, message: "do work", ...params },
        signal,
        ctx: { sessionId: origin.sessionId },
      },
      { request: request as never, mailStore: () => mailStore, ...extras },
    );
  }

  it("defaults to notification and rejects notification completion waits", async () => {
    const mailStore = await createMailStore();
    const request = baseRequest((method) => {
      throw new Error(`unexpected RPC method: ${method}`);
    });

    const delivered = await send({}, request, mailStore);
    expect(delivered.details).toMatchObject({
      executionTriggered: false,
      blocking: false,
      wait: "accepted",
      message: { kind: "notification" },
    });
    expect(request).not.toHaveBeenCalledWith("turn.submit", expect.anything(), expect.anything());
    await expect(
      send({ kind: "notification", wait: "completed" }, request, mailStore, {}, "invalid-wait"),
    ).rejects.toThrow("session notification cannot wait for completion");
  });

  it("keeps request wait=accepted asynchronous", async () => {
    const mailStore = await createMailStore();
    const request = baseRequest((method) => {
      if (method === "turn.submit") {
        return {
          invocationId: "inv_accepted",
          status: "queued",
          acceptedAt: "2026-07-17T00:00:00.000Z",
        };
      }
      throw new Error(`unexpected RPC method: ${method}`);
    });

    const result = await send({ kind: "request" }, request, mailStore);
    expect(result.details).toMatchObject({
      blocking: false,
      wait: "accepted",
      submitted: { invocationId: "inv_accepted" },
    });
    expect(request).toHaveBeenCalledWith(
      "turn.submit",
      expect.objectContaining({
        messageMetadata: expect.objectContaining({
          sessionMail: expect.objectContaining({ notifyOnCompletion: true }),
        }),
      }),
      expect.anything(),
    );
  });

  it("disables completion notify for wait=completed requests", async () => {
    const mailStore = await createMailStore();
    const request = baseRequest((method) => {
      if (method === "turn.submit") {
        return {
          invocationId: "inv_waitcompleted",
          status: "queued",
          acceptedAt: "2026-07-17T00:00:00.000Z",
        };
      }
      if (method === "turn.status") return status("inv_waitcompleted", "succeeded");
      if (method === "turn.result") {
        return {
          invocationId: "inv_waitcompleted",
          status: "succeeded",
          assistantText: "done",
          finishedAt: "2026-07-17T00:00:01.000Z",
        };
      }
      throw new Error(`unexpected RPC method: ${method}`);
    });

    await send({ kind: "request", wait: "completed" }, request, mailStore);
    expect(request).toHaveBeenCalledWith(
      "turn.submit",
      expect.objectContaining({
        messageMetadata: expect.objectContaining({
          sessionMail: expect.objectContaining({ notifyOnCompletion: false }),
        }),
      }),
      expect.anything(),
    );
  });

  it("returns a result completed before waiter registration or after daemon restart", async () => {
    const mailStore = await createMailStore();
    const request = baseRequest((method) => {
      if (method === "turn.submit") {
        return {
          invocationId: "inv_durable",
          status: "queued",
          acceptedAt: "2026-07-17T00:00:00.000Z",
        };
      }
      if (method === "turn.status") return status("inv_durable", "succeeded");
      if (method === "turn.result") {
        return {
          invocationId: "inv_durable",
          status: "succeeded",
          assistantText: "durable response",
          finishedAt: "2026-07-17T00:00:01.000Z",
        };
      }
      throw new Error(`unexpected RPC method: ${method}`);
    });

    const result = await send({ kind: "request", wait: "completed" }, request, mailStore);
    expect(result.content[0]?.text).toBe("durable response");
    expect(result.details).toMatchObject({
      blocking: true,
      waitTimedOut: false,
      answer: "durable response",
      invocationId: "inv_durable",
    });
  });

  it("times out without cancelling the persistent invocation", async () => {
    const mailStore = await createMailStore();
    let now = 0;
    const request = baseRequest((method) => {
      if (method === "turn.submit") {
        return {
          invocationId: "inv_timeout",
          status: "queued",
          acceptedAt: "2026-07-17T00:00:00.000Z",
        };
      }
      if (method === "turn.status") return status("inv_timeout", "running");
      throw new Error(`unexpected RPC method: ${method}`);
    });

    const result = await send(
      { kind: "request", wait: "completed", timeoutMs: 1_000 },
      request,
      mailStore,
      { now: () => now, sleep: async (ms) => void (now += ms) },
    );
    expect(result.details).toMatchObject({
      invocationId: "inv_timeout",
      waitTimedOut: true,
      status: { status: "running" },
    });
    expect(request).not.toHaveBeenCalledWith("turn.cancel", expect.anything(), expect.anything());
  });

  it("continues the same accepted invocation after a wait timeout and returns the terminal result exactly once", async () => {
    const mailStore = await createMailStore();
    let now = 0;
    let statusCalls = 0;
    let continuationStarted = false;
    const request = baseRequest((method, params) => {
      if (method === "turn.submit") {
        return {
          invocationId: "inv_continue",
          status: "queued",
          acceptedAt: "2026-07-17T00:00:00.000Z",
        };
      }
      if (method === "turn.status") {
        statusCalls += 1;
        return status(
          "inv_continue",
          continuationStarted && statusCalls >= 2 ? "succeeded" : "running",
        );
      }
      if (method === "turn.result") {
        expect(params).toEqual({ invocationId: "inv_continue" });
        return {
          invocationId: "inv_continue",
          status: "succeeded",
          assistantText: "continued response",
          finishedAt: "2026-07-17T00:00:01.000Z",
        };
      }
      throw new Error(`unexpected RPC method: ${method}`);
    });

    const timedOut = await send(
      { kind: "request", wait: "completed", timeoutMs: 1_000 },
      request,
      mailStore,
      { now: () => now, sleep: async (ms) => void (now += ms) },
      "continue-timeout",
    );
    expect(timedOut.details).toMatchObject({
      invocationId: "inv_continue",
      waitTimedOut: true,
      status: { status: "running" },
    });

    continuationStarted = true;
    const continued = await executeSparkSessionAction(
      {
        action: "send",
        toolCallId: "continue-terminal",
        params: {
          kind: "request",
          wait: "completed",
          invocationId: "inv_continue",
          timeoutMs: 1_000,
        },
        signal,
        ctx: { sessionId: origin.sessionId },
      },
      {
        request: request as never,
        mailStore: () => mailStore,
        sleep: async () => undefined,
        now: () => now,
      },
    );
    expect(continued.content[0]?.text).toBe("continued response");
    expect(continued.details).toMatchObject({
      invocationId: "inv_continue",
      waitTimedOut: false,
      result: { status: "succeeded" },
    });
    expect(request.mock.calls.filter(([method]) => method === "turn.submit")).toHaveLength(1);

    const repeated = await executeSparkSessionAction(
      {
        action: "send",
        toolCallId: "continue-repeat",
        params: {
          kind: "request",
          wait: "completed",
          invocationId: "inv_continue",
          timeoutMs: 1_000,
        },
        signal,
        ctx: { sessionId: origin.sessionId },
      },
      {
        request: request as never,
        mailStore: () => mailStore,
        sleep: async () => undefined,
        now: () => now,
      },
    );
    expect(repeated.content[0]?.text).toBe("continued response");
    expect(repeated.details).toMatchObject({
      invocationId: "inv_continue",
      result: { status: "succeeded" },
    });
  });

  it("continues a timed-out request by invocation id without mail or resubmission", async () => {
    const continuationInvocationId = "inv_continueonly";
    let terminalStatus = false;
    let terminalReads = 0;
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      if (method === "turn.status") {
        expect(params).toEqual({ invocationId: continuationInvocationId });
        if (terminalStatus) terminalReads += 1;
        return status(continuationInvocationId, terminalStatus ? "succeeded" : "running");
      }
      if (method === "turn.result") {
        expect(params).toEqual({ invocationId: continuationInvocationId });
        return {
          invocationId: continuationInvocationId,
          status: "succeeded",
          assistantText: "continued without resubmission",
          finishedAt: "2026-07-17T00:00:01.000Z",
        };
      }
      throw new Error(`unexpected continuation RPC method: ${method} ${JSON.stringify(params)}`);
    });
    const mailStore = vi.fn(() => {
      throw new Error("continuation must not access mail store");
    });
    let now = 0;
    const continuation = async (timeoutMs: number, toolCallId: string) =>
      await executeSparkSessionAction(
        {
          action: "send",
          toolCallId,
          params: {
            kind: "request",
            wait: "completed",
            invocationId: continuationInvocationId,
            timeoutMs,
          },
          signal,
          ctx: { sessionId: origin.sessionId },
        },
        {
          request: request as never,
          mailStore,
          now: () => now,
          sleep: async (ms) => void (now += ms),
        },
      );

    const timedOut = await continuation(1_000, "continuation-timeout");
    expect(timedOut.details).toMatchObject({
      invocationId: continuationInvocationId,
      waitTimedOut: true,
      status: { status: "running" },
    });

    terminalStatus = true;
    const terminal = await continuation(1_000, "continuation-terminal");
    const repeated = await continuation(1_000, "continuation-repeat");
    expect(terminal.content[0]?.text).toBe("continued without resubmission");
    expect(repeated.content[0]?.text).toBe("continued without resubmission");
    expect(terminal.details).toMatchObject({
      invocationId: continuationInvocationId,
      waitTimedOut: false,
    });
    expect(repeated.details).toMatchObject({
      invocationId: continuationInvocationId,
      waitTimedOut: false,
    });
    expect(terminalReads).toBe(2);
    expect(request.mock.calls.filter(([method]) => method === "turn.submit")).toHaveLength(0);
    expect(request.mock.calls.filter(([method]) => method === "session.get")).toHaveLength(0);
    expect(mailStore).not.toHaveBeenCalled();
  });

  it("returns terminal failure details", async () => {
    const mailStore = await createMailStore();
    const request = baseRequest((method) => {
      if (method === "turn.submit") {
        return {
          invocationId: "inv_failed",
          status: "queued",
          acceptedAt: "2026-07-17T00:00:00.000Z",
        };
      }
      if (method === "turn.status") return status("inv_failed", "failed");
      if (method === "turn.result") {
        return {
          invocationId: "inv_failed",
          status: "failed",
          error: { code: "MODEL_ERROR", message: "target failed", retryable: false },
          finishedAt: "2026-07-17T00:00:01.000Z",
        };
      }
      throw new Error(`unexpected RPC method: ${method}`);
    });

    const result = await send({ kind: "request", wait: "completed" }, request, mailStore);
    expect(result.content[0]?.text).toContain("target failed");
    expect(result.details).toMatchObject({
      invocationId: "inv_failed",
      result: { status: "failed", error: { message: "target failed" } },
    });
  });

  it("keeps concurrent requests correlated by invocation id", async () => {
    const mailStore = await createMailStore();
    const invocationByPrompt = new Map([
      ["first", "inv_first"],
      ["second", "inv_second"],
    ]);
    const request = baseRequest((method, params) => {
      if (method === "turn.submit") {
        const invocationId = invocationByPrompt.get(String(params.prompt));
        if (!invocationId) throw new Error("unknown prompt");
        return {
          invocationId,
          status: "queued",
          acceptedAt: "2026-07-17T00:00:00.000Z",
        };
      }
      const invocationId = String(params.invocationId);
      if (method === "turn.status") return status(invocationId, "succeeded");
      if (method === "turn.result") {
        return {
          invocationId,
          status: "succeeded",
          assistantText: `${invocationId} response`,
          finishedAt: "2026-07-17T00:00:01.000Z",
        };
      }
      throw new Error(`unexpected RPC method: ${method}`);
    });

    const [first, second] = await Promise.all([
      send(
        { kind: "request", wait: "completed", message: "first" },
        request,
        mailStore,
        {},
        "concurrent-first",
      ),
      send(
        { kind: "request", wait: "completed", message: "second" },
        request,
        mailStore,
        {},
        "concurrent-second",
      ),
    ]);
    expect(first.details).toMatchObject({
      invocationId: "inv_first",
      answer: "inv_first response",
    });
    expect(second.details).toMatchObject({
      invocationId: "inv_second",
      answer: "inv_second response",
    });
  });
});
