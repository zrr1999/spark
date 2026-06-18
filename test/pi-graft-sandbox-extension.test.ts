import assert from "node:assert/strict";
import test from "node:test";

import {
  registerPiGraftExtension,
  registerPiGraftSandboxExtension,
  type PiGraftExtensionApi,
  type PiGraftSessionContext,
  type PiGraftToolContext,
  type PiGraftToolDefinition,
  type PiGraftToolResult,
} from "../packages/pi-graft/src/index.ts";

const SANDBOX_STATE_ENTRY = "pi-graft-sandbox-state";

type ExtensionHandler = (event: unknown, ctx: unknown) => unknown;

type SessionStartHandler = (event: unknown, ctx: PiGraftSessionContext) => unknown;

function createFakePi(initialEntries: unknown[] = []) {
  const tools = new Map<string, PiGraftToolDefinition>();
  const entries = [...initialEntries];
  const handlers = new Map<string, ExtensionHandler[]>();
  const pi: PiGraftExtensionApi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler as ExtensionHandler]);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  };
  return { pi, tools, entries, handlers };
}

async function executeTool(
  tool: PiGraftToolDefinition | undefined,
  name: string,
  params: Record<string, unknown>,
  ctx: PiGraftToolContext,
): Promise<PiGraftToolResult> {
  assert.ok(tool, `expected ${name} to be registered`);
  return tool.execute(name, params, undefined, undefined, ctx);
}

async function emitSessionStart(
  handlers: Map<string, ExtensionHandler[]>,
  ctx: PiGraftSessionContext,
): Promise<void> {
  for (const handler of handlers.get("session_start") ?? []) {
    await (handler as SessionStartHandler)({ reason: "startup" }, ctx);
  }
}

void test("normal pi-graft entrypoint does not register sandbox or built-in file overrides", () => {
  const { pi, tools } = createFakePi();
  registerPiGraftExtension(pi);

  assert.equal(tools.has("graft_read"), true);
  assert.equal(tools.has("graft_sandbox_enter"), false);
  assert.equal(tools.has("graft_sandbox_status"), false);
  assert.equal(tools.has("graft_sandbox_exit"), false);
  assert.equal(tools.has("graft_sandbox_checkpoint"), false);
  assert.equal(tools.has("graft_sandbox_materialize"), false);
  assert.equal(tools.has("graft_sandbox_promote"), false);
  assert.equal(tools.has("grep"), false);
  assert.equal(tools.has("find"), false);
  assert.equal(tools.has("ls"), false);
  assert.equal(tools.has("read"), false);
  assert.equal(tools.has("write"), false);
  assert.equal(tools.has("edit"), false);
  assert.equal(tools.get("graft_read")?.executionMode, undefined);
});

void test("sandbox stateful tools request sequential execution to avoid scratch races", () => {
  const { pi, tools } = createFakePi();
  registerPiGraftSandboxExtension(pi);

  const statefulTools = [
    "graft_sandbox_enter",
    "read",
    "write",
    "edit",
    "graft_sandbox_exit",
    "graft_sandbox_checkpoint",
    "graft_sandbox_materialize",
    "graft_sandbox_promote",
  ];
  for (const toolName of statefulTools) {
    assert.equal(tools.get(toolName)?.executionMode, "sequential", toolName);
  }

  for (const toolName of ["graft_read", "graft_sandbox_status", "grep", "find", "ls"]) {
    assert.equal(tools.get(toolName)?.executionMode, undefined, toolName);
  }
});

void test("sandbox file overrides expose explicit prompt metadata", () => {
  const { pi, tools } = createFakePi();
  registerPiGraftSandboxExtension(pi);

  for (const toolName of ["read", "write", "edit", "grep", "find", "ls"]) {
    const tool = tools.get(toolName);
    assert.ok(tool, `expected ${toolName} to be registered`);
    assert.match(tool.promptSnippet ?? "", /sandbox/i, toolName);
    assert.match(tool.promptSnippet ?? "", /working tree|scratch|changed/i, toolName);
    assert.ok(
      tool.promptGuidelines?.some((guideline) => /working tree/i.test(guideline)),
      toolName,
    );
    assert.ok(
      tool.promptGuidelines?.some((guideline) => /graft_sandbox_enter/i.test(guideline)),
      toolName,
    );
  }
});

void test("sandbox entrypoint layers sandbox state tools over normal pi-graft", async () => {
  const restoredState = {
    active: true,
    repoRoot: "/repo",
    repoId: "sandbox",
    workspace: "/graft/workspace",
    workspaceId: "ws:test",
    base: "repo:sandbox@HEAD",
    resolvedBase: "abc123",
    lastScratch: "scratch:abc",
    changedPaths: ["src/example.ts"],
    lastCandidate: "candidate:def",
    lastPatch: "patch:fed",
    lastMaterializedPath: "/graft/workspace/.worktrees/tree",
    lastPromotion: { branch: "graft/demo", commit: "abc123" },
    guardrails: { blockShellFileIo: true, allowValidationCommands: true },
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:01:00.000Z",
  };
  const initialEntries = [
    { type: "custom", customType: SANDBOX_STATE_ENTRY, data: { state: restoredState } },
  ];
  const { pi, tools, entries, handlers } = createFakePi(initialEntries);
  registerPiGraftSandboxExtension(pi);

  assert.equal(tools.has("graft_read"), true);
  assert.equal(tools.has("graft_sandbox_enter"), true);
  assert.equal(tools.has("graft_sandbox_status"), true);
  assert.equal(tools.has("graft_sandbox_exit"), true);
  assert.equal(tools.has("graft_sandbox_checkpoint"), true);
  assert.equal(tools.has("graft_sandbox_materialize"), true);
  assert.equal(tools.has("graft_sandbox_promote"), true);
  assert.equal(tools.has("grep"), true);
  assert.equal(tools.has("find"), true);
  assert.equal(tools.has("ls"), true);
  assert.equal(tools.has("read"), true);
  assert.equal(tools.has("write"), true);
  assert.equal(tools.has("edit"), true);

  await emitSessionStart(handlers, {
    cwd: "/repo",
    sessionManager: { getEntries: () => entries },
  });

  const status = await executeTool(
    tools.get("graft_sandbox_status"),
    "graft_sandbox_status",
    {},
    { cwd: "/repo" },
  );
  assert.match(status.content[0].text, /GRAFT SANDBOX ACTIVE/);
  assert.match(status.content[0].text, /repo: \/repo/);
  assert.match(status.content[0].text, /base: repo:sandbox@HEAD/);
  assert.match(status.content[0].text, /scratch: scratch:abc/);
  assert.deepEqual(status.details?.state, restoredState);

  const exit = await executeTool(
    tools.get("graft_sandbox_exit"),
    "graft_sandbox_exit",
    {},
    { cwd: "/repo" },
  );
  assert.match(exit.content[0].text, /Exited Graft sandbox/);
  assert.equal(exit.details?.sandbox, false);
  assert.deepEqual(entries.at(-1), {
    type: "custom",
    customType: SANDBOX_STATE_ENTRY,
    data: { state: null },
  });
});

void test("sandbox tool-call guardrails block obvious shell file I/O bypasses", async () => {
  const restoredState = {
    active: true,
    repoRoot: "/repo",
    repoId: "sandbox",
    workspace: "/graft/workspace",
    base: "repo:sandbox@HEAD",
    changedPaths: ["src/example.ts"],
    guardrails: { blockShellFileIo: true, allowValidationCommands: true },
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:01:00.000Z",
  };
  const { pi, handlers, entries } = createFakePi([
    { type: "custom", customType: SANDBOX_STATE_ENTRY, data: { state: restoredState } },
  ]);
  registerPiGraftSandboxExtension(pi);
  await emitSessionStart(handlers, { cwd: "/repo", sessionManager: { getEntries: () => entries } });
  const toolCallHandlers = handlers.get("tool_call") ?? [];
  assert.ok(toolCallHandlers.length > 0, "expected sandbox tool_call guardrail handler");

  assert.deepEqual(
    await toolCallHandlers[0]?.(
      { toolName: "cue_exec", args: { command: "cat src/example.ts" } },
      { cwd: "/repo" },
    ),
    {
      block: true,
      reason:
        "Graft sandbox blocked cue_exec: obvious file I/O bypass detected. Use sandbox read/write/edit/grep/find/ls for file access, or checkpoint/materialize/promote for lifecycle operations. Validation commands without direct file I/O (for example test runners) remain allowed.",
    },
  );
  assert.equal(
    await toolCallHandlers[0]?.(
      { toolName: "cue_exec", args: { command: "pnpm test" } },
      { cwd: "/repo" },
    ),
    undefined,
  );
});

void test("sandbox file overrides reject path escapes before graft execution", async () => {
  const restoredState = {
    active: true,
    repoRoot: "/repo",
    repoId: "sandbox",
    workspace: "/graft/workspace",
    base: "repo:sandbox@HEAD",
    changedPaths: [],
    guardrails: { blockShellFileIo: true, allowValidationCommands: true },
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:01:00.000Z",
  };
  const { pi, tools, entries, handlers } = createFakePi([
    { type: "custom", customType: SANDBOX_STATE_ENTRY, data: { state: restoredState } },
  ]);
  registerPiGraftSandboxExtension(pi);
  await emitSessionStart(handlers, { cwd: "/repo", sessionManager: { getEntries: () => entries } });

  await assert.rejects(
    () => executeTool(tools.get("read"), "read", { path: "../secret.txt" }, { cwd: "/repo" }),
    /inside the sandbox virtual repo tree/,
  );
  await assert.rejects(
    () =>
      executeTool(
        tools.get("write"),
        "write",
        { path: "/tmp/secret.txt", content: "secret" },
        { cwd: "/repo" },
      ),
    /inside the sandbox virtual repo tree/,
  );
  await assert.rejects(
    () =>
      executeTool(
        tools.get("edit"),
        "edit",
        { path: ".git/config", edits: [{ oldText: "a", newText: "b" }] },
        { cwd: "/repo" },
      ),
    /inside the sandbox virtual repo tree/,
  );
});
