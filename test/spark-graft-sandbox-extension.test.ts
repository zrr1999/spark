import assert from "node:assert/strict";
import { test } from "vitest";

import {
  registerSparkGraftExtension,
  registerSparkGraftSandboxExtension,
  type SparkGraftHostApi,
  type SparkGraftSessionContext,
  type SparkGraftToolContext,
  type SparkGraftToolDefinition,
  type SparkGraftToolResult,
} from "../packages/spark-graft/src/index.ts";

const SANDBOX_STATE_ENTRY = "spark-graft-sandbox-state";

type ExtensionHandler = (event: unknown, ctx: unknown) => unknown;

type SessionStartHandler = (event: unknown, ctx: SparkGraftSessionContext) => unknown;

function createFakePi(initialEntries: unknown[] = []) {
  const tools = new Map<string, SparkGraftToolDefinition>();
  const entries = [...initialEntries];
  const handlers = new Map<string, ExtensionHandler[]>();
  const pi: SparkGraftHostApi = {
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
  tool: SparkGraftToolDefinition | undefined,
  name: string,
  params: Record<string, unknown>,
  ctx: SparkGraftToolContext,
): Promise<SparkGraftToolResult> {
  assert.ok(tool, `expected ${name} to be registered`);
  return tool.execute(name, params, undefined, undefined, ctx);
}

async function emitSessionStart(
  handlers: Map<string, ExtensionHandler[]>,
  ctx: SparkGraftSessionContext,
): Promise<void> {
  for (const handler of handlers.get("session_start") ?? []) {
    await (handler as SessionStartHandler)({ reason: "startup" }, ctx);
  }
}

test("normal spark-graft entrypoint does not register sandbox or built-in file overrides", () => {
  const { pi, tools } = createFakePi();
  registerSparkGraftExtension(pi);

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

test("sandbox stateful tools request sequential execution to avoid scratch races", () => {
  const { pi, tools } = createFakePi();
  registerSparkGraftSandboxExtension(pi);

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

test("sandbox file overrides expose explicit prompt metadata", () => {
  const { pi, tools } = createFakePi();
  registerSparkGraftSandboxExtension(pi);

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

test("sandbox entrypoint layers sandbox state tools over normal spark-graft", async () => {
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
  registerSparkGraftSandboxExtension(pi);

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
  assert.match(
    status.content[0].text,
    /file-tool names read\/write\/edit\/grep\/find\/ls remain sandbox overrides/,
  );
  assert.deepEqual(status.details?.state, restoredState);
  assert.deepEqual(status.details?.profile, {
    treeBackendPreference: "auto",
    sandboxOverridesRemainRegistered: true,
    restoreBuiltInsBy: "reload_without_sandbox_entrypoint",
    reloadGuidance:
      "Reload or restart Pi without @zendev-lab/spark-graft/sandbox, and do not use --no-builtin-tools if ordinary Pi built-ins should be available.",
  });

  const exit = await executeTool(
    tools.get("graft_sandbox_exit"),
    "graft_sandbox_exit",
    {},
    { cwd: "/repo" },
  );
  assert.match(exit.content[0].text, /Exited Graft sandbox and cleared sandbox state/);
  assert.match(exit.content[0].text, /remain sandbox overrides in this loaded profile/);
  assert.match(exit.content[0].text, /do not use --no-builtin-tools/);
  assert.equal(exit.details?.sandbox, false);
  assert.deepEqual(exit.details?.profile, status.details?.profile);
  assert.deepEqual(entries.at(-1), {
    type: "custom",
    customType: SANDBOX_STATE_ENTRY,
    data: { state: null },
  });

  const inactiveStatus = await executeTool(
    tools.get("graft_sandbox_status"),
    "graft_sandbox_status",
    {},
    { cwd: "/repo" },
  );
  assert.match(inactiveStatus.content[0].text, /GRAFT SANDBOX INACTIVE/);
  assert.match(inactiveStatus.content[0].text, /still owns file-tool override names/);
  assert.equal(inactiveStatus.details?.sandbox, false);
  assert.deepEqual(inactiveStatus.details?.profile, status.details?.profile);
});

test("sandbox tool-call guardrails block obvious shell file I/O bypasses", async () => {
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
  registerSparkGraftSandboxExtension(pi);
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

test("sandbox file overrides reject path escapes before graft execution", async () => {
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
  registerSparkGraftSandboxExtension(pi);
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
