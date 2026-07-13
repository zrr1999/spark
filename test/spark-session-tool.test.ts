import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolConfig } from "@zendev-lab/spark-extension-api";
import { SparkSessionMailStore, sanitizeSessionMailScope } from "@zendev-lab/spark-session";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { registerPiRolesTools } from "../packages/spark-roles/src/extension.ts";
import type { RoleSessionContext } from "../packages/spark-roles/src/session-actions.ts";

const NOW = "2026-07-13T00:00:00.000Z";

type SessionToolResult = Awaited<ReturnType<ToolConfig["execute"]>>;

void test("role tool merges anonymous roles, persistent sessions, and messaging actions", () => {
  const tool = registerTestTool({
    request: async () => assert.fail("request should not run during registration"),
    mailStore: () => assert.fail("mail store should not run during registration"),
  });
  const schema = JSON.stringify(tool.parameters);
  for (const action of [
    "list",
    "get",
    "create",
    "bind",
    "unbind",
    "archive",
    "send",
    "mailto",
    "inbox",
    "read",
    "ack",
  ]) {
    assert.match(schema, new RegExp(action));
  }
  assert.match(tool.description, /Canonical role and session capability/u);
});

void test("role tool routes managed session actions through daemon RPC", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const records = new Map<string, SparkSessionRegistryRecord>([
    ["session:a", sessionRecord("session:a")],
    ["session:b", sessionRecord("session:b")],
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

  const listed = await execute(tool, ctx, { action: "list", resource: "session", limit: 1 });
  assert.equal((listed.details as { sessions: unknown[] }).sessions.length, 1);
  assert.equal((listed.details as { total: number }).total, 2);

  const selected = await execute(tool, ctx, { action: "get", resource: "session" });
  assert.equal(
    (selected.details as { session: { sessionId: string } }).session.sessionId,
    "session:a",
  );

  const created = await execute(tool, ctx, {
    action: "create",
    resource: "session",
    sessionId: "session:new",
    title: "New session",
  });
  assert.equal(
    (created.details as { session: { sessionId: string } }).session.sessionId,
    "session:new",
  );
  assert.deepEqual(calls.find((call) => call.method === "session.create")?.params, {
    sessionId: "session:new",
    title: "New session",
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
      "session.get",
      "workspace.ensure-local",
      "session.create",
      "session.bind",
      "session.unbind",
      "session.archive",
    ],
  );
});

void test("role call uses daemon turn.submit for persistent session continuity", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "session.get") return sessionRecord("session:persistent") as T;
    if (method === "turn.submit")
      return {
        fileName: "turn.json",
        filePath: "/queue/turn.json",
        task: {
          type: "session.run",
          sessionId: "session:persistent",
          prompt: "Continue the investigation",
        },
        observedAt: NOW,
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
  assert.equal((result.details as { sessionPersistence: string }).sessionPersistence, "persistent");
  assert.deepEqual(calls, [
    { method: "session.get", params: { sessionId: "session:persistent" } },
    {
      method: "turn.submit",
      params: {
        sessionId: "session:persistent",
        prompt: "Continue the investigation",
      },
    },
  ]);

  await assert.rejects(
    () =>
      execute(tool, context("session:caller"), {
        action: "call",
        role: "worker",
        sessionId: "session:persistent",
        instruction: "Ambiguous target",
      }),
    /either role for an anonymous call or sessionId for a persistent call/u,
  );
  await assert.rejects(
    () =>
      execute(tool, context("session:caller"), {
        action: "call",
        sessionId: "session:persistent",
        instruction: "Ambiguous options",
        timeoutMs: 5_000,
      }),
    /persistent role call does not accept timeoutMs/u,
  );
  await assert.rejects(
    () =>
      execute(tool, context("session:caller"), {
        action: "call",
        sessionId: "session:persistent",
        instruction: "Invalid reset",
        reset: "yes",
      }),
    /role reset must be a boolean/u,
  );
});

void test("role send follows NNP request/reply causality without executing the target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-tool-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir, now: () => Date.parse(NOW) });
    const requestCalls: string[] = [];
    const request = async <T>(method: string, params?: unknown): Promise<T> => {
      requestCalls.push(method);
      if (method !== "session.get") return assert.fail(`unexpected RPC method: ${method}`);
      const sessionId = String((params as { sessionId?: string }).sessionId);
      return sessionRecord(sessionId) as T;
    };
    const tool = registerTestTool({ request, mailStore: () => mailStore });
    const ctx = context("session:a");

    const sent = await execute(
      tool,
      ctx,
      {
        action: "send",
        toSessionId: "session:b",
        fromSessionId: "session:spoofed",
        intent: "work.request",
        message: "Please inspect the failure",
      },
      "call-send-request",
    );
    const sentDetails = sent.details as {
      created: boolean;
      autoExecuted: boolean;
      message: {
        id: string;
        fromSessionId: string;
        toSessionId: string;
        kind: string;
        intent: string;
        payload: Record<string, unknown>;
      };
    };
    assert.equal(sentDetails.created, true);
    assert.equal(sentDetails.autoExecuted, false);
    assert.equal(sentDetails.message.fromSessionId, "session:a");
    assert.equal(sentDetails.message.toSessionId, "session:b");
    assert.equal(sentDetails.message.kind, "request");
    assert.equal(sentDetails.message.intent, "work.request");
    assert.deepEqual(sentDetails.message.payload, { body: "Please inspect the failure" });
    assert.match(toolText(sent), /not executed or queued; do not poll/u);

    const retried = await execute(
      tool,
      ctx,
      {
        action: "send",
        toSessionId: "session:b",
        intent: "work.request",
        message: "Please inspect the failure",
      },
      "call-send-request",
    );
    assert.equal((retried.details as { created: boolean }).created, false);
    assert.equal(
      (retried.details as { message: { id: string } }).message.id,
      sentDetails.message.id,
    );
    await assert.rejects(
      () =>
        execute(
          tool,
          ctx,
          {
            action: "send",
            toSessionId: "session:c",
            intent: "work.request",
            message: "Please inspect the failure",
          },
          "call-send-request",
        ),
      /idempotency key .* was reused for a different message/u,
    );
    assert.equal((await mailStore.list("session:c")).length, 0);

    const incoming = await mailStore.send({
      toSessionId: "session:a",
      fromSessionId: "session:b",
      kind: "request",
      intent: "work.review",
      payload: { artifact: "artifact:1" },
      correlationId: "corr:review",
      body: "Review this artifact",
      source: "tool",
    });
    const replied = await execute(tool, ctx, {
      action: "send",
      replyToMessageId: incoming.message.id,
      intent: "work.review.completed",
      payload: { accepted: true },
    });
    const reply = (replied.details as { message: Record<string, unknown> }).message;
    assert.equal(reply.toSessionId, "session:b");
    assert.equal(reply.kind, "reply");
    assert.equal(reply.correlationId, "corr:review");
    assert.equal(reply.replyToMessageId, incoming.message.id);
    assert.equal(
      requestCalls.every((method) => method === "session.get"),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("role mail uses the host Spark state root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-state-root-"));
  try {
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        assert.equal(method, "session.get");
        return sessionRecord(String((params as { sessionId: string }).sessionId)) as T;
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

void test("role inbox is current-session private and supports read and ack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-inbox-tool-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const incoming = await mailStore.send({
      toSessionId: "session:a",
      fromSessionId: "session:b",
      kind: "inform",
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
    assert.equal(legacy?.kind, "inform");
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
          kind: "inform",
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
  session: NonNullable<Parameters<typeof registerPiRolesTools>[1]>["session"],
): ToolConfig {
  const tools = new Map<string, ToolConfig>();
  registerPiRolesTools(
    { registerTool: (config) => tools.set(config.name, config as ToolConfig) },
    { session },
  );
  const tool = tools.get("role");
  assert.ok(tool);
  assert.deepEqual([...tools.keys()], ["role"]);
  return tool;
}

async function execute(
  tool: ToolConfig,
  ctx: RoleSessionContext,
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

function context(sessionId: string): RoleSessionContext {
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
