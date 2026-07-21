import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolConfig } from "@zendev-lab/spark-extension-api";
import { SparkSessionMailStore, sanitizeSessionMailScope } from "@zendev-lab/spark-session";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { registerPiSessionTool } from "../packages/spark-session/src/extension.ts";
import type { SparkSessionToolContext } from "../packages/spark-session/src/action-tool.ts";

const NOW = "2026-07-13T00:00:00.000Z";

type SessionToolResult = Awaited<ReturnType<ToolConfig["execute"]>>;

void test("session tool exposes persistent lifecycle, calls, classification, and mail", () => {
  const tool = registerTestTool({
    request: async () => assert.fail("request should not run during registration"),
    mailStore: () => assert.fail("mail store should not run during registration"),
  });
  const schema = JSON.stringify(tool.parameters);
  for (const action of [
    "list",
    "get",
    "create",
    "call",
    "bind",
    "unbind",
    "archive",
    "send",
    "inbox",
    "read",
    "ack",
  ]) {
    assert.match(schema, new RegExp(action));
  }
  assert.match(tool.description, /Canonical persistent session capability/u);
  assert.match(tool.description, /NOT the Cockpit conversation list/u);
  const prompt = tool.promptGuidelines?.join(" ") ?? "";
  assert.match(prompt, /MUST list same-workspace local sessions/u);
  assert.match(prompt, /compare roles semantically/u);
  assert.match(prompt, /only when no existing division of labour owns/u);
  assert.match(prompt, /user's language and existing naming style/u);
  assert.match(prompt, /Cockpit workspace conversations/u);
  assert.match(prompt, /separate projection/u);
  assert.doesNotMatch(prompt, /runtime-ops|verifier/u);
});

void test("session tool routes managed actions through daemon RPC and classifies surfaces", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const records = new Map<string, SparkSessionRegistryRecord>([
    ["session:a", sessionRecord("session:a")],
    [
      "session:b",
      {
        ...sessionRecord("session:b"),
        status: "running",
        bindings: [
          {
            kind: "channel",
            adapter: "infoflow",
            externalKey: "infoflow:user:b",
            boundAt: NOW,
          },
        ],
      },
    ],
  ]);
  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    const input = (params ?? {}) as Record<string, unknown>;
    if (method === "workspace.ensure-local") return { id: "workspace:test" } as T;
    if (method === "session.list") return [...records.values()] as T;
    if (method === "session.get") return records.get(String(input.sessionId)) as T;
    if (method === "session.create") {
      const record = sessionRecord(
        typeof input.sessionId === "string" ? input.sessionId : "session:new",
        {
          title: typeof input.title === "string" ? input.title : undefined,
        },
      );
      records.set(record.sessionId, record);
      return record as T;
    }
    if (method === "session.bind") {
      const current = records.get(String(input.sessionId))!;
      const record = {
        ...current,
        bindings: [
          {
            kind: "channel" as const,
            adapter: "infoflow" as const,
            externalKey: String(input.externalKey),
            boundAt: NOW,
          },
        ],
      };
      records.set(record.sessionId, record);
      return record as T;
    }
    if (method === "session.unbind") {
      const current = records.get(String(input.sessionId))!;
      const record = { ...current, bindings: [] };
      records.set(record.sessionId, record);
      return record as T;
    }
    if (method === "session.archive") {
      const current = records.get(String(input.sessionId))!;
      const record = { ...current, status: "archived" as const };
      records.set(record.sessionId, record);
      return record as T;
    }
    return assert.fail(`unexpected RPC method: ${method}`);
  };
  const tool = registerTestTool({ request, mailStore: () => assert.fail("unexpected mail store") });
  const ctx = context("session:a");

  const listed = await execute(tool, ctx, { action: "list", limit: 2 });
  const listedSessions = (
    listed.details as {
      sessions: Array<{
        sessionId: string;
        surface: string;
        activity: string;
        channelAdapters: string[];
      }>;
    }
  ).sessions;
  assert.deepEqual(
    listedSessions.map((session) => [session.sessionId, session.surface, session.activity]),
    [
      ["session:a", "local", "idle"],
      ["session:b", "channel", "running"],
    ],
  );
  const channelOnly = await execute(tool, ctx, {
    action: "list",
    surface: "channel",
    adapter: "infoflow",
  });
  assert.deepEqual(
    (channelOnly.details as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    ),
    ["session:b"],
  );
  const runningOnly = await execute(tool, ctx, { action: "list", activity: "running" });
  assert.deepEqual(
    (runningOnly.details as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    ),
    ["session:b"],
  );
  const page = await execute(tool, ctx, { action: "list", offset: 1, limit: 1 });
  assert.deepEqual(
    (page.details as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    ),
    ["session:b"],
  );

  const selected = await execute(tool, ctx, { action: "get" });
  assert.equal(
    (selected.details as { session: { sessionId: string } }).session.sessionId,
    "session:a",
  );

  await assert.rejects(
    execute(tool, ctx, { action: "create" }),
    /requires role as a stable division of labour/u,
  );

  const created = await execute(tool, ctx, {
    action: "create",
    sessionId: "session:new",
    role: "Verifier",
  });
  assert.equal(
    (created.details as { session: { sessionId: string } }).session.sessionId,
    "session:new",
  );
  assert.deepEqual(calls.find((call) => call.method === "session.create")?.params, {
    sessionId: "session:new",
    title: "Verifier",
    role: "Verifier",
    cwd: "/workspace/test",
    scope: { kind: "workspace", workspaceId: "workspace:test" },
    workspaceId: "workspace:test",
  });

  await execute(tool, ctx, {
    action: "bind",
    sessionId: "session:new",
    externalKey: "infoflow:user:u1",
  });
  await execute(tool, ctx, {
    action: "unbind",
    sessionId: "session:new",
    externalKey: "infoflow:user:u1",
  });
  const archived = await execute(tool, ctx, {
    action: "archive",
    sessionId: "session:new",
  });
  assert.equal((archived.details as { session: { status: string } }).session.status, "archived");
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "session.list",
      "session.list",
      "session.list",
      "session.list",
      "session.get",
      "workspace.ensure-local",
      "session.create",
      "session.bind",
      "session.unbind",
      "session.archive",
    ],
  );
});

void test("channel sessions can inspect same-workspace local and channel sessions", async () => {
  const channelCurrent: SparkSessionRegistryRecord = {
    ...sessionRecord("session:channel"),
    bindings: [
      {
        kind: "channel",
        adapter: "infoflow",
        externalKey: "infoflow:group:channel",
        boundAt: NOW,
      },
    ],
  };
  const localTarget = sessionRecord("session:local");
  const channelPeer: SparkSessionRegistryRecord = {
    ...sessionRecord("session:channel-peer"),
    bindings: [
      {
        kind: "channel",
        adapter: "qqbot",
        externalKey: "qqbot:group:peer",
        boundAt: NOW,
      },
    ],
  };
  const otherWorkspace: SparkSessionRegistryRecord = {
    ...sessionRecord("session:other-workspace"),
    scope: { kind: "workspace", workspaceId: "workspace:other" },
    workspaceId: "workspace:other",
  };
  const records = new Map(
    [channelCurrent, localTarget, channelPeer, otherWorkspace].map((record) => [
      record.sessionId,
      record,
    ]),
  );
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "session.get") {
      return records.get(String((params as { sessionId?: string }).sessionId)) as T;
    }
    if (method === "session.list") return [...records.values()] as T;
    return assert.fail(`unexpected RPC method: ${method}`);
  };
  const tool = registerTestTool({ request, mailStore: () => assert.fail("unexpected mail store") });
  const ctx = { ...context(channelCurrent.sessionId), sessionSurface: "channel" as const };

  const listed = await execute(tool, ctx, { action: "list" });
  assert.deepEqual(
    (listed.details as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    ),
    [channelCurrent.sessionId, localTarget.sessionId, channelPeer.sessionId],
  );
  assert.deepEqual(calls.find((call) => call.method === "session.list")?.params, {
    scope: { kind: "workspace", workspaceId: "workspace:test" },
    workspaceId: "workspace:test",
    includeArchived: false,
  });

  const selected = await execute(tool, ctx, {
    action: "get",
    sessionId: localTarget.sessionId,
  });
  assert.equal(
    (selected.details as { session: { sessionId: string } }).session.sessionId,
    localTarget.sessionId,
  );
  const selectedChannel = await execute(tool, ctx, {
    action: "get",
    sessionId: channelPeer.sessionId,
  });
  assert.equal(
    (selectedChannel.details as { session: { surface: string } }).session.surface,
    "channel",
  );
  await assert.rejects(
    () => execute(tool, ctx, { action: "get", sessionId: otherWorkspace.sessionId }),
    /must be sessions in the current workspace/u,
  );
  await assert.rejects(
    () => execute(tool, ctx, { action: "list", scope: "daemon" }),
    /their own workspace only/u,
  );
  const channelOnly = await execute(tool, ctx, { action: "list", surface: "channel" });
  assert.deepEqual(
    (channelOnly.details as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    ),
    [channelCurrent.sessionId, channelPeer.sessionId],
  );

  for (const action of ["create", "call", "bind", "unbind", "archive"] as const) {
    await assert.rejects(
      () => execute(tool, ctx, { action }),
      new RegExp(`cannot use session action=${action}`, "u"),
    );
  }
});

void test("session call uses daemon turn.submit for persistent continuity", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "session.get") return sessionRecord("session:persistent") as T;
    if (method === "turn.submit")
      return {
        invocationId: "inv_persistentcall",
        status: "queued",
        acceptedAt: NOW,
      } as T;
    return assert.fail(`unexpected RPC method: ${method}`);
  };
  const tool = registerTestTool({ request, mailStore: () => assert.fail("unexpected mail store") });

  const result = await execute(tool, context("session:caller"), {
    action: "call",
    sessionId: "session:persistent",
    instruction: "Continue the investigation",
  });
  assert.match(toolText(result), /Queued persistent Spark session call/u);
  assert.match(toolText(result), /invocation inv_persistentcall was accepted/u);
  assert.equal((result.details as { sessionPersistence: string }).sessionPersistence, "persistent");
  assert.deepEqual(calls, [
    { method: "session.get", params: { sessionId: "session:persistent" } },
    {
      method: "turn.submit",
      params: {
        sessionId: "session:persistent",
        prompt: "Continue the investigation",
        messageMetadata: {
          origin: {
            kind: "session",
            sessionId: "session:caller",
            surface: "local",
            host: "session",
          },
        },
      },
    },
  ]);

  await assert.rejects(
    () =>
      execute(
        tool,
        { ...context("session:caller"), sessionSurface: "channel" },
        {
          action: "call",
          sessionId: "session:persistent",
          instruction: "Channel sessions must forward",
        },
      ),
    /message-platform sessions cannot use session action=call/u,
  );
  await assert.rejects(
    () =>
      execute(tool, context("session:caller"), {
        action: "call",
        sessionId: "session:persistent",
        instruction: "Ambiguous options",
        timeoutMs: 5_000,
      }),
    /session call does not accept timeoutMs/u,
  );
  await assert.rejects(
    () =>
      execute(tool, context("session:caller"), {
        action: "call",
        sessionId: "session:persistent",
        instruction: "Invalid reset",
        reset: "yes",
      }),
    /session reset must be a boolean/u,
  );
});

void test("session request queues the original message with hidden sender metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-request-tool-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir, now: () => Date.parse(NOW) });
    const requestBody = "\n  Run the focused regression tests  \n";
    await mailStore.send({
      toSessionId: "session:worker",
      fromSessionId: "session:older",
      kind: "notification",
      intent: "work.context",
      body: "Older unread context",
    });
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "session.get") {
        return sessionRecord(String((params as { sessionId?: string }).sessionId)) as T;
      }
      if (method === "turn.submit") {
        const submitted = params as {
          sessionId: string;
          prompt: string;
          messageMetadata: Record<string, unknown>;
        };
        const stored = await mailStore.list(submitted.sessionId);
        assert.equal(stored.length, 2, "request must persist before turn.submit");
        const requestMail = stored.find((message) => message.body === requestBody);
        assert.ok(requestMail);
        assert.equal(submitted.prompt, requestBody);
        assert.deepEqual(submitted.messageMetadata, {
          origin: {
            kind: "session",
            sessionId: "session:caller",
            surface: "local",
            host: "tui",
          },
          sessionMail: {
            messageId: requestMail.id,
            kind: "request",
            intent: "work.request",
            correlationId: requestMail.correlationId,
            fromSessionId: "session:caller",
            toSessionId: "session:worker",
          },
        });
        return { invocationId: "inv_requestturn", status: "queued", acceptedAt: NOW } as T;
      }
      return assert.fail(`unexpected RPC method: ${method}`);
    };
    const tool = registerTestTool({ request, mailStore: () => mailStore });

    const requested = await execute(
      tool,
      { ...context("session:caller"), sessionSource: "tui" },
      {
        action: "send",
        kind: "request",
        toSessionId: "session:worker",
        message: requestBody,
      },
      "call-request-work",
    );
    const details = requested.details as {
      created: boolean;
      executionTriggered: boolean;
      message: { id: string; kind: string; intent: string };
      submitted: { invocationId: string };
    };
    assert.equal(details.created, true);
    assert.equal(details.executionTriggered, true);
    assert.equal(details.message.kind, "request");
    assert.equal(details.message.intent, "work.request");
    assert.equal(details.submitted.invocationId, "inv_requestturn");
    assert.match(toolText(requested), /invocation inv_requestturn was accepted/u);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["session.get", "turn.submit"],
    );

    await assert.rejects(
      () =>
        execute(tool, context("session:caller"), {
          action: "send",
          toSessionId: "session:worker",
          kind: "inform",
          message: "Invalid legacy kind",
        }),
      /kind must be request or notification/u,
    );
    await assert.rejects(
      () =>
        execute(tool, context("session:caller"), {
          action: "send",
          kind: "request",
          toSessionId: "session:worker",
          payload: { task: "payload-only is not a user turn" },
        }),
      /request requires a non-empty message body/u,
    );

    const channelTool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        assert.equal(method, "session.get");
        const sessionId = String((params as { sessionId?: string }).sessionId);
        return {
          ...sessionRecord(sessionId),
          bindings: [
            {
              kind: "channel",
              adapter: "qqbot",
              externalKey: "qqbot:c2c:worker",
              boundAt: NOW,
            },
          ],
        } as T;
      },
      mailStore: () => mailStore,
    });
    await assert.rejects(
      () =>
        execute(channelTool, context("session:caller"), {
          action: "send",
          kind: "request",
          toSessionId: "session:channel-worker",
          message: "Invalid channel target",
        }),
      /request targets must be local sessions/u,
    );

    const archivedTool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        assert.equal(method, "session.get");
        const sessionId = String((params as { sessionId?: string }).sessionId);
        return { ...sessionRecord(sessionId), status: "archived" } as T;
      },
      mailStore: () => mailStore,
    });
    await assert.rejects(
      () =>
        execute(archivedTool, context("session:caller"), {
          action: "send",
          kind: "request",
          toSessionId: "session:archived-worker",
          message: "Invalid archived target",
        }),
      /cannot request archived persistent session/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session request blocks for success and preserves causal invocation metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-request-success-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const calls: Array<{ method: string; params: unknown }> = [];
    let statusReads = 0;
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "session.get") {
          return sessionRecord(String((params as { sessionId?: string }).sessionId)) as T;
        }
        if (method === "turn.submit") {
          return {
            invocationId: "inv_requestsuccess",
            status: "queued",
            acceptedAt: NOW,
          } as T;
        }
        if (method === "turn.status") {
          statusReads += 1;
          return {
            invocationId: "inv_requestsuccess",
            sessionId: "session:worker",
            status: statusReads === 1 ? "running" : "succeeded",
            createdAt: NOW,
            updatedAt: NOW,
            ...(statusReads === 1 ? {} : { finishedAt: NOW }),
            eventCursor: statusReads,
          } as T;
        }
        if (method === "turn.result") {
          return {
            invocationId: "inv_requestsuccess",
            status: "succeeded",
            assistantText: "The build is green.",
            finishedAt: NOW,
          } as T;
        }
        return assert.fail(`unexpected RPC method: ${method}`);
      },
      mailStore: () => mailStore,
      sleep: async () => undefined,
    });

    const result = await execute(
      tool,
      {
        ...context("session:caller"),
        sessionSource: "daemon",
        invocationId: "inv_parent",
      },
      {
        action: "send",
        kind: "request",
        wait: "completed",
        toSessionId: "session:worker",
        message: "Is the build green?",
        timeoutMs: 1_000,
      },
      "call-request-success",
    );

    assert.equal(toolText(result), "The build is green.");
    const details = result.details as {
      blocking: boolean;
      executionTriggered: boolean;
      waitTimedOut: boolean;
      answer: string;
      invocationId: string;
    };
    assert.equal(details.blocking, true);
    assert.equal(details.executionTriggered, true);
    assert.equal(details.waitTimedOut, false);
    assert.equal(details.answer, "The build is green.");
    assert.equal(details.invocationId, "inv_requestsuccess");
    assert.deepEqual(
      calls.find((call) => call.method === "turn.submit")?.params as {
        prompt: string;
        idempotencyKey: string;
        messageMetadata: Record<string, unknown>;
      },
      {
        sessionId: "session:worker",
        prompt: "Is the build green?",
        idempotencyKey: `session.mail:${(result.details as { message: { id: string } }).message.id}`,
        messageMetadata: {
          origin: {
            kind: "session",
            sessionId: "session:caller",
            surface: "local",
            host: "daemon",
          },
          sessionMail: {
            messageId: (result.details as { message: { id: string } }).message.id,
            kind: "request",
            intent: "work.request",
            correlationId: (result.details as { message: { correlationId: string } }).message
              .correlationId,
            fromSessionId: "session:caller",
            toSessionId: "session:worker",
            parentInvocationId: "inv_parent",
          },
        },
      },
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["session.get", "turn.submit", "turn.status", "turn.status", "turn.result"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session request reports terminal failure without retrying or throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-request-failure-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "session.get") {
          return sessionRecord(String((params as { sessionId?: string }).sessionId)) as T;
        }
        if (method === "turn.submit") {
          return {
            invocationId: "inv_requestfailed",
            status: "queued",
            acceptedAt: NOW,
          } as T;
        }
        if (method === "turn.status") {
          return {
            invocationId: "inv_requestfailed",
            sessionId: "session:worker",
            status: "failed",
            createdAt: NOW,
            updatedAt: NOW,
            finishedAt: NOW,
            error: { code: "EXECUTION_FAILED", message: "worker failed" },
            eventCursor: 2,
          } as T;
        }
        if (method === "turn.result") {
          return {
            invocationId: "inv_requestfailed",
            status: "failed",
            error: { code: "EXECUTION_FAILED", message: "worker failed", retryable: false },
            finishedAt: NOW,
          } as T;
        }
        return assert.fail(`unexpected RPC method: ${method}`);
      },
      mailStore: () => mailStore,
    });

    const result = await execute(tool, context("session:caller"), {
      action: "send",
      kind: "request",
      wait: "completed",
      toSessionId: "session:worker",
      message: "Run the check",
    });

    assert.match(toolText(result), /inv_requestfailed failed: worker failed/u);
    assert.equal((result.details as { waitTimedOut: boolean }).waitTimedOut, false);
    assert.equal(
      (result.details as { result: { error: { retryable: boolean } } }).result.error.retryable,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session request timeout stops only the sender wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-request-timeout-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    let now = 0;
    let submitCount = 0;
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "session.get") {
          return sessionRecord(String((params as { sessionId?: string }).sessionId)) as T;
        }
        if (method === "turn.submit") {
          submitCount += 1;
          return {
            invocationId: "inv_requesttimeout",
            status: "queued",
            acceptedAt: NOW,
          } as T;
        }
        if (method === "turn.status") {
          return {
            invocationId: "inv_requesttimeout",
            sessionId: "session:worker",
            status: "running",
            createdAt: NOW,
            updatedAt: NOW,
            eventCursor: 1,
          } as T;
        }
        return assert.fail(`unexpected RPC method: ${method}`);
      },
      mailStore: () => mailStore,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    const timedOut = await execute(tool, context("session:caller"), {
      action: "send",
      kind: "request",
      wait: "completed",
      toSessionId: "session:worker",
      message: "Keep working after I stop waiting",
      timeoutMs: 1_000,
    });
    assert.match(toolText(timedOut), /stopped waiting after 1000ms/u);
    assert.match(toolText(timedOut), /continues asynchronously/u);
    assert.equal((timedOut.details as { waitTimedOut: boolean }).waitTimedOut, true);
    assert.equal((timedOut.details as { status: { status: string } }).status.status, "running");
    assert.equal(submitCount, 1);

    await assert.rejects(
      () =>
        execute(tool, context("session:invalid-timeout"), {
          action: "send",
          kind: "request",
          wait: "completed",
          toSessionId: "session:other",
          message: "Reject before persistence",
          timeoutMs: 999,
        }),
      /request timeoutMs must be between 1000 and 300000/u,
    );
    assert.equal((await mailStore.list("session:other")).length, 0);

    const delegated = await execute(tool, context("session:nested"), {
      action: "send",
      kind: "request",
      wait: "accepted",
      toSessionId: "session:other",
      message: "Delegate asynchronously",
    });
    assert.match(toolText(delegated), /invocation inv_requesttimeout was accepted/u);
    assert.equal(submitCount, 2);
    assert.equal((await mailStore.list("session:other")).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session request preserves durable recovery data when queue acceptance fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-request-failure-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "session.get") {
          return sessionRecord(String((params as { sessionId?: string }).sessionId)) as T;
        }
        if (method === "turn.submit") throw new Error("queue unavailable");
        return assert.fail(`unexpected RPC method: ${method}`);
      },
      mailStore: () => mailStore,
    });

    await assert.rejects(
      () =>
        execute(
          tool,
          context("session:caller"),
          {
            action: "send",
            kind: "request",
            toSessionId: "session:worker",
            message: "Persist even when queueing fails",
          },
          "call-request-failure",
        ),
      /request stored mail:[^ ]+ for session:worker, but invocation acceptance was not confirmed: queue unavailable/u,
    );
    const [stored] = await mailStore.list("session:worker");
    assert.equal(stored?.body, "Persist even when queueing fails");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("channel sessions may request work only from local sessions in their workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-channel-request-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const channelCurrent: SparkSessionRegistryRecord = {
      ...sessionRecord("session:channel"),
      bindings: [
        {
          kind: "channel",
          adapter: "infoflow",
          externalKey: "infoflow:user:channel",
          boundAt: NOW,
        },
      ],
    };
    const localTarget = sessionRecord("session:local");
    const channelTarget: SparkSessionRegistryRecord = {
      ...sessionRecord("session:channel-target"),
      bindings: [
        {
          kind: "channel",
          adapter: "qqbot",
          externalKey: "qqbot:c2c:target",
          boundAt: NOW,
        },
      ],
    };
    const records = new Map(
      [channelCurrent, localTarget, channelTarget].map((record) => [record.sessionId, record]),
    );
    const calls: string[] = [];
    const request = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push(method);
      if (method === "session.get") {
        return records.get(String((params as { sessionId?: string }).sessionId)) as T;
      }
      if (method === "turn.submit") {
        return { invocationId: "inv_channelrequest", status: "queued", acceptedAt: NOW } as T;
      }
      return assert.fail(`unexpected RPC method: ${method}`);
    };
    const tool = registerTestTool({ request, mailStore: () => mailStore });
    const ctx = { ...context(channelCurrent.sessionId), sessionSurface: "channel" as const };

    const requested = await execute(tool, ctx, {
      action: "send",
      kind: "request",
      toSessionId: localTarget.sessionId,
      intent: "work.request",
      message: "Handle this now",
    });
    assert.equal((requested.details as { executionTriggered: boolean }).executionTriggered, true);
    assert.deepEqual(calls, ["session.get", "session.get", "turn.submit"]);

    await assert.rejects(
      () =>
        execute(tool, ctx, {
          action: "send",
          kind: "request",
          toSessionId: channelTarget.sessionId,
          message: "Do not execute on a channel session",
        }),
      /request targets must be local sessions/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session send rejects the removed question mode", async () => {
  const tool = registerTestTool({
    request: async () => assert.fail("question rejection must happen before daemon RPC"),
    mailStore: () => assert.fail("question rejection must happen before mailbox writes"),
  });

  await assert.rejects(
    () =>
      execute(tool, context("session:caller"), {
        action: "send",
        kind: "question",
        toSessionId: "session:target",
        message: "Do not persist this",
      }),
    /session kind must be request or notification/u,
  );
});
void test("session mail uses the host Spark state root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-state-root-"));
  try {
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "session.get") {
          return sessionRecord(String((params as { sessionId: string }).sessionId)) as T;
        }
        if (method === "turn.submit") {
          return {
            invocationId: "inv_stateroot",
            status: "queued",
            acceptedAt: NOW,
          } as T;
        }
        return assert.fail(`unexpected RPC method: ${method}`);
      },
    });
    const ctx = { ...context("session:a"), sparkStateRoot: dir };
    await execute(tool, ctx, {
      action: "send",
      toSessionId: "session:b",
      intent: "work.progress",
      message: "Half complete",
    });
    const stored = await new SparkSessionMailStore({ sparkHome: dir }).list("session:b");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.fromSessionId, "session:a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session inbox is current-session private and supports read and ack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-inbox-tool-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const incoming = await mailStore.send({
      toSessionId: "session:a",
      fromSessionId: "session:b",
      kind: "notification",
      intent: "work.progress",
      payload: { percent: 50 },
      body: "Half complete",
      source: "tool",
    });
    const tool = registerTestTool({
      request: async () => assert.fail("inbox actions must not call daemon RPC"),
      mailStore: () => mailStore,
    });
    const ctx = context("session:a");

    await assert.rejects(
      () => execute(tool, ctx, { action: "inbox", sessionId: "session:b" }),
      /another session's inbox is private/u,
    );
    const listed = await execute(tool, ctx, { action: "inbox" });
    assert.equal((listed.details as { messages: unknown[] }).messages.length, 1);

    const read = await execute(tool, ctx, {
      action: "read",
      messageId: incoming.message.id,
    });
    assert.equal((read.details as { message: { status: string } }).message.status, "read");

    const acked = await execute(tool, ctx, {
      action: "ack",
      messageId: incoming.message.id,
    });
    assert.equal((acked.details as { message: { status: string } }).message.status, "acked");

    const empty = await execute(tool, ctx, { action: "inbox" });
    assert.equal((empty.details as { messages: unknown[] }).messages.length, 0);

    const paged = await execute(tool, ctx, { action: "inbox", offset: 10, limit: 1 });
    assert.equal((paged.details as { offset: number }).offset, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session mailbox paths isolate ids that collide under the legacy sanitizer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-mail-paths-"));
  try {
    const store = new SparkSessionMailStore({ sparkHome: dir });
    assert.notEqual(store.mailboxPath("session:a"), store.mailboxPath("session-a"));
    await store.send({
      toSessionId: "session:a",
      fromSessionId: "session:sender",
      body: "colon target",
    });
    await store.send({
      toSessionId: "session-a",
      fromSessionId: "session:sender",
      body: "dash target",
    });
    assert.deepEqual(
      (await store.list("session:a")).map((message) => message.body),
      ["colon target"],
    );
    assert.deepEqual(
      (await store.list("session-a")).map((message) => message.body),
      ["dash target"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session mailbox reads and migrates legacy v1 paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-mail-legacy-"));
  try {
    const sessionId = "session:legacy";
    const legacyDir = join(dir, "session-mail", "v1", sanitizeSessionMailScope(sessionId));
    const legacyPath = join(legacyDir, "mailbox.json");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        toSessionId: sessionId,
        messages: [
          {
            id: "mail:legacy",
            toSessionId: sessionId,
            fromSessionId: "session:sender",
            kind: "inform",
            subject: null,
            body: "legacy message",
            createdAt: NOW,
            readAt: null,
            ackedAt: null,
            source: "cli",
          },
        ],
      })}\n`,
      "utf8",
    );
    const store = new SparkSessionMailStore({ sparkHome: dir, now: () => Date.parse(NOW) });
    const [legacy] = await store.list(sessionId);
    assert.equal(legacy?.kind, "notification");
    assert.equal(legacy?.intent, "session.mail");
    await store.read(sessionId, "mail:legacy");
    await rm(legacyPath, { force: true });
    assert.equal((await store.get(sessionId, "mail:legacy")).readAt, NOW);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("session mailbox serializes concurrent sends without losing messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-mail-concurrency-"));
  try {
    const store = new SparkSessionMailStore({ sparkHome: dir });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.send({
          toSessionId: "session:target",
          fromSessionId: `session:sender-${index}`,
          kind: "notification",
          intent: "load.test",
          payload: { index },
          idempotencyKey: `load:${index}`,
        }),
      ),
    );
    const messages = await store.list("session:target");
    assert.equal(messages.length, 20);
    assert.equal(new Set(messages.map((message) => message.id)).size, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function registerTestTool(
  deps: NonNullable<Parameters<typeof registerPiSessionTool>[1]>["deps"],
): ToolConfig {
  const tools = new Map<string, ToolConfig>();
  registerPiSessionTool(
    { registerTool: (config) => tools.set(config.name, config as ToolConfig) },
    { deps },
  );
  const tool = tools.get("session");
  assert.ok(tool);
  assert.deepEqual([...tools.keys()], ["session"]);
  return tool;
}

async function execute(
  tool: ToolConfig,
  ctx: SparkSessionToolContext,
  params: Record<string, unknown>,
  toolCallId = `call-${String(params.action)}`,
): Promise<SessionToolResult> {
  return await tool.execute(
    toolCallId,
    params,
    new AbortController().signal,
    () => undefined,
    ctx as never,
  );
}

function context(sessionId: string): SparkSessionToolContext {
  return {
    cwd: "/workspace/test",
    sessionId,
  };
}

function sessionRecord(
  sessionId: string,
  options: { title?: string } = {},
): SparkSessionRegistryRecord {
  return {
    sessionId,
    scope: { kind: "workspace", workspaceId: "workspace:test" },
    workspaceId: "workspace:test",
    status: "ready",
    bindings: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...(options.title ? { title: options.title } : {}),
  };
}

function toolText(result: SessionToolResult): string {
  return result.content.map((item) => item.text).join("\n");
}
