import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ExtensionRoleRunner } from "@zendev-lab/spark-core";

import { registerSparkRolesTools } from "../packages/spark-roles/src/extension.ts";
import { createDefaultRoleRegistry } from "../packages/spark-roles/src/index.ts";

const DEFAULT_TEST_CWD = "/tmp/spark-roles-tool-default-cwd";

const defaultNativeRoleRunner: ExtensionRoleRunner = async (input) => {
  const text = input.instruction.instruction.includes("without final message")
    ? ""
    : "Fake worker result.";
  const jsonEvents = input.instruction.instruction.includes("without final message")
    ? [{ type: "agent_start" }, { type: "agent_end", messages: [] }]
    : input.instruction.instruction.includes("protocol")
      ? []
      : [
          {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text }] },
          },
        ];
  const stdout = input.instruction.instruction.includes("protocol")
    ? '"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta"}\n'
    : text;
  return {
    record: { ...input.record, status: "succeeded", finishedAt: "2026-06-22T00:00:00.000Z" },
    stdout,
    stderr: "",
    jsonEvents,
  };
};

interface ToolConfig {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: {
      cwd?: string;
      model?: { provider: string; id: string; api?: string };
      runRole?: ExtensionRoleRunner;
    },
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

test("role spec tools list, get, and create project roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-spec-tools-"));
  try {
    const tools = registerRoleToolsForTest();
    assert.deepEqual([...tools.keys()].sort(), ["role"]);

    const created = await executeRoleTool(
      tools,
      "create_role",
      {
        id: "repo-inspector",
        description: "Inspect repository state before implementation.",
        systemPrompt: "You inspect repositories and report concise findings.",
        rationale: "Reusable inspection role for project work.",
        expectedUses: ["repo inspection"],
      },
      dir,
    );
    assert.match(
      created.content[0]?.text ?? "",
      /Role created: repo-inspector \(role:project-[^)]+\)/,
    );

    const listed = await executeRoleTool(tools, "list_roles", { source: "project" }, dir);
    assert.match(listed.content[0]?.text ?? "", /repo-inspector/);

    const got = await executeRoleTool(tools, "get_role", { role: "repo-inspector" }, dir);
    assert.match(got.content[0]?.text ?? "", /systemPrompt: \d+ chars; preview=/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("role action tool dispatches canonical list, get, and create actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-action-tool-"));
  try {
    const tools = registerRoleToolsForTest();
    assert.ok(tools.has("role"), "missing canonical role tool");

    const created = await executeRoleTool(
      tools,
      "role",
      {
        action: "create",
        id: "action-inspector",
        description: "Inspect repository state through the canonical role tool.",
        systemPrompt: "You inspect repositories and report concise findings.",
        rationale: "Reusable inspection role for project work.",
        expectedUses: ["repo inspection"],
      },
      dir,
    );
    assert.match(created.content[0]?.text ?? "", /Role created: action-inspector/);

    const listed = await executeRoleTool(tools, "role", { action: "list", source: "project" }, dir);
    assert.match(listed.content[0]?.text ?? "", /action-inspector/);

    const got = await executeRoleTool(
      tools,
      "role",
      { action: "get", role: "action-inspector" },
      dir,
    );
    assert.match(got.content[0]?.text ?? "", /source: project/);

    assert.throws(
      () => executeRoleTool(tools, "role", { action: "send", toSessionId: "session:b" }, dir),
      /role\.action must be list, get, create, call/u,
    );
    await assert.rejects(
      () =>
        executeRoleTool(
          tools,
          "role",
          {
            action: "call",
            role: "worker",
            sessionId: "session:persistent",
            instruction: "Do not accept persistent session targets here.",
          },
          dir,
        ),
      /role does not manage persistent sessions/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("role action tool manages role model settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-model-action-tool-"));
  const previousBindingHome = process.env.SPARK_HOME;
  process.env.SPARK_HOME = dir;
  try {
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--list-models' && args[1] === 'test/model') process.exit(0);",
        "if (!args.includes('--print')) process.exit(10);",
        "if (!args.includes('--model') || args[args.indexOf('--model') + 1] !== 'test/model') process.exit(11);",
        "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Fake worker result.' }] }, args }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);
    const tools = registerRoleToolsForTest();

    const saved = await executeRoleTool(
      tools,
      "role",
      {
        action: "model_set",
        role: "worker",
        model: "test/model",
        source: "project",
        piCommand: fakePi,
      },
      dir,
    );
    assert.match(saved.content[0]?.text ?? "", /Saved project role model setting for worker/);

    const got = await executeRoleTool(tools, "role", { action: "model_get", role: "worker" }, dir);
    assert.match(got.content[0]?.text ?? "", /test\/model source=project/);
    assert.equal(
      (got.details?.model as { selector?: string } | undefined)?.selector,
      "role:builtin-worker",
    );

    const listed = await executeRoleTool(
      tools,
      "role",
      { action: "model_list", source: "project" },
      dir,
    );
    assert.match(listed.content[0]?.text ?? "", /role:builtin-worker -> test\/model/);

    const called = await executeRoleTool(
      tools,
      "role",
      {
        action: "call",
        role: "worker",
        instruction: "Run with the saved project role model setting.",
        timeoutMs: 5_000,
      },
      dir,
      { model: { provider: "ignored", id: "session", api: "openai-responses" } },
    );
    assert.match(called.content[0]?.text ?? "", /Role call succeeded: worker/);
    assert.match(called.content[0]?.text ?? "", /model=test\/model/);

    const deleted = await executeRoleTool(
      tools,
      "role",
      { action: "model_delete", role: "worker", source: "project" },
      dir,
    );
    assert.match(deleted.content[0]?.text ?? "", /Deleted project role model setting/);

    const afterDelete = await executeRoleTool(
      tools,
      "role",
      { action: "model_get", role: "worker" },
      dir,
    );
    assert.match(afterDelete.content[0]?.text ?? "", /No role model setting/);

    await assert.rejects(
      executeRoleTool(
        tools,
        "role",
        {
          action: "model_set",
          role: "worker",
          model: "missing/model",
          source: "project",
          piCommand: fakePi,
        },
        dir,
      ),
      /model validation failed/,
    );
  } finally {
    if (previousBindingHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("builtin role prompts and direct-call tool copy stay host-neutral", () => {
  const tools = registerRoleToolsForTest();
  const roleToolDescription = tools.get("role")?.description ?? "";
  assert.doesNotMatch(roleToolDescription, /Spark tasks or DAG runs/);
  const roleToolParameters = tools.get("role")?.parameters as
    | { properties?: Record<string, { description?: string }> }
    | undefined;
  assert.match(
    roleToolParameters?.properties?.piCommand?.description ?? "",
    /model_set validation/,
  );

  const registry = createDefaultRoleRegistry({ now: "2026-01-01T00:00:00.000Z" });
  const prompts = registry
    .list({ source: "builtin" })
    .map((role) => role.systemPrompt)
    .join("\n");
  assert.match(prompts, /You are a Pi scout/);
  assert.match(prompts, /report the blocker.*upward/i);
  assert.doesNotMatch(prompts, /available ask tool/);
  assert.doesNotMatch(prompts, /You are a Spark/);
  assert.doesNotMatch(prompts, /Spark ask tools/);
  assert.doesNotMatch(prompts, /Spark project or task/);
});

test("role spec tools keep patch presets out of builtin role lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-no-patcher-"));
  try {
    const tools = registerRoleToolsForTest();
    const listed = await executeRoleTool(tools, "list_roles", { source: "builtin" }, dir);
    const roleIds = ((listed.details?.roles ?? []) as Array<{ id: string }>).map((role) => role.id);

    assert.deepEqual(roleIds, ["reviewer", "scout", "worker"]);
    assert.doesNotMatch(listed.content[0]?.text ?? "", /\bpatcher?\b/);
    await assert.rejects(
      executeRoleTool(tools, "get_role", { role: "patch" }, dir),
      /no role matches: patch/,
    );
    await assert.rejects(
      executeRoleTool(tools, "get_role", { role: "patcher" }, dir),
      /no role matches: patcher/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("call_role launches fresh role runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-tool-"));
  const previousBindingHome = process.env.SPARK_HOME;
  process.env.SPARK_HOME = dir;
  try {
    const tools = registerRoleToolsForTest();
    let capturedNativeInput: Parameters<ExtensionRoleRunner>[0] | undefined;
    const result = await executeCallRole(
      tools,
      {
        role: "worker",
        instruction: "Run the fake worker.",
        launch: "fresh",
        model: "test/model",
        timeoutMs: 5_000,
      },
      dir,
      {
        runRole: async (input) => {
          capturedNativeInput = input;
          return await defaultNativeRoleRunner(input);
        },
      },
    );

    assert.match(result.content[0]?.text ?? "", /Role call succeeded: worker/);
    assert.match(
      result.content[0]?.text ?? "",
      /runRef=run:[^\n]+ · launch=fresh · model=test\/model/,
    );
    assert.match(result.content[0]?.text ?? "", /result:\nFake worker result\./);
    assert.doesNotMatch(result.content[0]?.text ?? "", /lastJsonEvent/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /stdout:\n\{"type":"message_end"/);
    const details = result.details as {
      record?: { status?: string; launch?: string };
      jsonEventCount?: number;
      delivery?: { status?: string; hasFinalAssistantText?: boolean };
    };
    assert.equal(details.record?.status, "succeeded");
    assert.equal(details.record?.launch, "fresh");
    assert.equal(details.jsonEventCount, 1);
    assert.equal(capturedNativeInput?.role.id, "worker");
    assert.match(capturedNativeInput?.role.systemPrompt ?? "", /Pi worker/);
    assert.ok(capturedNativeInput?.role.allowedTools?.includes("edit"));
    assert.equal(capturedNativeInput?.instruction.instruction, "Run the fake worker.");
    assert.equal(capturedNativeInput?.launch, "fresh");
    assert.equal(capturedNativeInput?.noSession, true);
    assert.equal(capturedNativeInput?.sessionPersistence, "anonymous");
    assert.equal(capturedNativeInput?.record.noSession, true);
    assert.equal(capturedNativeInput?.record.sessionPersistence, "anonymous");
    assert.equal(capturedNativeInput?.model, "test/model");
    assert.equal(capturedNativeInput?.timeoutMs, 5_000);
    assert.equal(capturedNativeInput?.cwd, dir);
    assert.equal(details.delivery?.status, "delivered");
    assert.equal(details.delivery?.hasFinalAssistantText, true);

    const canonical = await executeRoleTool(
      tools,
      "role",
      {
        action: "call",
        role: "worker",
        instruction: "Run the fake worker through the canonical role tool.",
        launch: "fresh",
        model: "test/model",
        timeoutMs: 5_000,
      },
      dir,
    );
    assert.match(canonical.content[0]?.text ?? "", /Role call succeeded: worker/);
  } finally {
    if (previousBindingHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("call_role inherits the active session model when no role model is saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-session-model-"));
  const previousBindingHome = process.env.SPARK_HOME;
  process.env.SPARK_HOME = dir;
  try {
    const tools = registerRoleToolsForTest();

    const result = await executeRoleTool(
      tools,
      "role",
      {
        action: "call",
        role: "worker",
        instruction: "Run with the inherited session model.",
        timeoutMs: 5_000,
      },
      dir,
      { model: { provider: "test", id: "model", api: "openai-responses" } },
    );

    assert.match(result.content[0]?.text ?? "", /Role call succeeded: worker/);
    assert.match(result.content[0]?.text ?? "", /model=test\/model/);
  } finally {
    if (previousBindingHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("call_role does not expose raw JSON protocol fragments as output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-protocol-fragment-"));
  const previousBindingHome = process.env.SPARK_HOME;
  process.env.SPARK_HOME = dir;
  try {
    const tools = registerRoleToolsForTest();
    const result = await executeCallRole(
      tools,
      {
        role: "worker",
        instruction: "Run protocol fragment.",
        model: "test/model",
      },
      dir,
    );

    assert.match(result.content[0]?.text ?? "", /Role call succeeded: worker/);
    assert.match(result.content[0]?.text ?? "", /delivery: empty/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /assistantMessageEvent/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /toolcall_delta/);
    assert.equal((result.details as { delivery?: { status?: string } }).delivery?.status, "empty");
  } finally {
    if (previousBindingHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("call_role exposes empty delivery when JSON events have no final assistant message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-empty-delivery-"));
  const previousBindingHome = process.env.SPARK_HOME;
  process.env.SPARK_HOME = dir;
  try {
    const tools = registerRoleToolsForTest();
    const result = await executeCallRole(
      tools,
      {
        role: "worker",
        instruction: "Run without final message.",
        model: "test/model",
      },
      dir,
    );

    assert.match(result.content[0]?.text ?? "", /Role call succeeded: worker/);
    assert.match(
      result.content[0]?.text ?? "",
      /delivery: empty .*no final assistant message found \(2 JSON events captured\)/,
    );
    const details = result.details as {
      record?: { status?: string };
      jsonEventCount?: number;
      delivery?: { status?: string; hasFinalAssistantText?: boolean; jsonEventCount?: number };
    };
    assert.equal(details.record?.status, "succeeded");
    assert.equal(details.jsonEventCount, 2);
    assert.equal(details.delivery?.status, "empty");
    assert.equal(details.delivery?.hasFinalAssistantText, false);
    assert.equal(details.delivery?.jsonEventCount, 2);
  } finally {
    if (previousBindingHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("call_role directs persistent continuity to the session tool", async () => {
  const tools = registerRoleToolsForTest();
  await assert.rejects(
    executeCallRole(tools, {
      role: "reviewer",
      instruction: "Review with context.",
      launch: "forked",
    }),
    /forked launch is not public; use the session tool for continuity/,
  );
});

test("call_role rejects unknown launches instead of falling back to fresh", async () => {
  const tools = registerRoleToolsForTest();
  await assert.rejects(
    executeCallRole(tools, {
      role: "worker",
      instruction: "Run with an invalid launch.",
      launch: "legacy-mode",
    }),
    /unsupported role launch mode/,
  );
});

test("spark-roles tools require ctx cwd unless call_role cwd is explicit", async () => {
  const tools = registerRoleToolsForTest();

  await assert.rejects(
    executeRoleToolWithoutCwd(tools, "list_roles", {}),
    /list_roles requires ctx\.cwd/,
  );
  await assert.rejects(
    executeRoleToolWithoutCwd(tools, "get_role", { role: "worker" }),
    /get_role requires ctx\.cwd/,
  );
  await assert.rejects(
    executeRoleToolWithoutCwd(tools, "create_role", {
      id: "missing-cwd",
      description: "Should not write without a workspace.",
      systemPrompt: "Do not write this role.",
      rationale: "Project role writes require explicit workspace context.",
      expectedUses: ["validation"],
    }),
    /create_role requires ctx\.cwd/,
  );
  await assert.rejects(
    executeRoleToolWithoutCwd(tools, "call_role", {
      role: "worker",
      instruction: "Run without cwd.",
    }),
    /call_role requires ctx\.cwd/,
  );

  const dir = await mkdtemp(join(tmpdir(), "spark-roles-explicit-cwd-"));
  const previousBindingHome = process.env.SPARK_HOME;
  process.env.SPARK_HOME = dir;
  try {
    const explicit = await executeRoleToolWithoutCwd(
      tools,
      "call_role",
      {
        role: "worker",
        instruction: "Run with explicit cwd.",
        cwd: dir,
        model: "test/model",
      },
      { runRole: defaultNativeRoleRunner },
    );
    assert.match(explicit.content[0]?.text ?? "", /Role call succeeded: worker/);
  } finally {
    if (previousBindingHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark-roles tools reject invalid explicit parameters instead of using defaults", async () => {
  const tools = registerRoleToolsForTest();

  await assert.rejects(
    executeRoleTool(tools, "list_roles", { limit: "many" }),
    /list_roles limit must be a finite number/,
  );
  await assert.rejects(
    executeRoleTool(tools, "list_roles", { source: "managed" }),
    /list_roles source must be builtin, extension, project, or user/,
  );

  await assert.rejects(
    executeRoleTool(tools, "get_role", { role: 42 }),
    /get_role role must be a string/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: 42,
      description: "Invalid role id should fail.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
    }),
    /create_role id must be a string/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "missing-description",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
    }),
    /create_role description is required/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "bad-source",
      description: "Invalid role source should fail.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
      source: "workspace",
    }),
    /create_role source must be project or user/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "extension-source",
      description: "Extension roles are package-registered, not user-created.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should reject extension writes.",
      expectedUses: ["validation"],
      source: "extension",
    }),
    /create_role source must be project or user/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "bad-expected-uses",
      description: "Invalid expected uses should fail.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["valid", 42],
    }),
    /create_role expectedUses must be an array of strings/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "bad-allowed-tools",
      description: "Invalid allowed tools should fail.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
      allowedTools: ["read", 42],
    }),
    /create_role allowedTools must be an array of strings/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "bad-model",
      description: "Model fields belong in role model settings.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
      defaultModel: "test/model",
    }),
    /create_role defaultModel is not supported; use role model settings/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "bad-model-alias",
      description: "Model fields belong in role model settings.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
      model: "test/model",
    }),
    /create_role model is not supported; use role model settings/,
  );
  await assert.rejects(
    executeCallRole(tools, {
      role: 42,
      instruction: "Run with an invalid role selector.",
    }),
    /call_role role must be a string/,
  );
  await assert.rejects(
    executeCallRole(tools, {
      role: "worker",
      instruction: 42,
    }),
    /call_role instruction must be a string/,
  );
  await assert.rejects(
    executeCallRole(tools, {
      role: "worker",
      instruction: "Run with an invalid timeout.",
      timeoutMs: "5000",
    }),
    /call_role timeoutMs must be a finite number/,
  );
  await assert.rejects(
    executeCallRole(tools, {
      role: "worker",
      instruction: "Run with removed dryRun flag.",
      dryRun: true,
    }),
    /call_role dryRun is no longer supported/,
  );
  await assert.rejects(
    executeCallRole(tools, {
      role: "worker",
      instruction: "Run with a removed pi command parameter.",
      piCommand: "custom-pi",
    }),
    /call_role piCommand is no longer supported/,
  );
  await assert.rejects(
    executeCallRole(tools, {
      role: "worker",
      instruction: "Run with an invalid session directory.",
      sessionDir: 42,
    }),
    /call_role sessionDir is not supported for anonymous role calls/,
  );
  await assert.rejects(
    executeCallRole(tools, {
      role: "worker",
      instruction: "Run with a persistent-only reset option.",
      reset: true,
    }),
    /call_role reset is not supported; use session action=call/,
  );
  await assert.rejects(
    executeCallRole(tools, {
      role: "reviewer",
      instruction: "Fork with an invalid parent.",
      launch: "forked",
      forkFromSession: 42,
    }),
    /call_role forked launch is not public|call_role forkFromSession is not public/,
  );
});

function registerRoleToolsForTest(): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  registerSparkRolesTools({
    registerTool: (config) => tools.set(config.name, config as ToolConfig),
  });
  return tools;
}

function executeCallRole(
  tools: Map<string, ToolConfig>,
  params: Record<string, unknown>,
  cwd = DEFAULT_TEST_CWD,
  ctxExtra: {
    model?: { provider: string; id: string; api?: string };
    runRole?: ExtensionRoleRunner;
  } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  return executeRoleTool(tools, "call_role", params, cwd, ctxExtra);
}

function executeRoleTool(
  tools: Map<string, ToolConfig>,
  name: string,
  params: Record<string, unknown>,
  cwd = DEFAULT_TEST_CWD,
  ctxExtra: {
    model?: { provider: string; id: string; api?: string };
    runRole?: ExtensionRoleRunner;
  } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  const call = canonicalRoleToolCall(name, params);
  const tool = tools.get(call.name);
  assert.ok(tool, `missing ${call.name} tool`);
  return tool.execute("tool-call", call.params, new AbortController().signal, () => undefined, {
    cwd,
    runRole: defaultNativeRoleRunner,
    ...ctxExtra,
  });
}

function executeRoleToolWithoutCwd(
  tools: Map<string, ToolConfig>,
  name: string,
  params: Record<string, unknown>,
  ctxExtra: { runRole?: ExtensionRoleRunner } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  const call = canonicalRoleToolCall(name, params);
  const tool = tools.get(call.name);
  assert.ok(tool, `missing ${call.name} tool`);
  return tool.execute(
    "tool-call",
    call.params,
    new AbortController().signal,
    () => undefined,
    ctxExtra,
  );
}

function canonicalRoleToolCall(
  name: string,
  params: Record<string, unknown>,
): { name: "role"; params: Record<string, unknown> } {
  switch (name) {
    case "role":
      return { name, params };
    case "list_roles":
      return { name: "role", params: { action: "list", ...params } };
    case "get_role":
      return { name: "role", params: { action: "get", ...params } };
    case "create_role":
      return { name: "role", params: { action: "create", ...params } };
    case "call_role":
      return { name: "role", params: { action: "call", ...params } };
    case "model_list_roles":
      return { name: "role", params: { action: "model_list", ...params } };
    case "model_get_role":
      return { name: "role", params: { action: "model_get", ...params } };
    case "model_set_role":
      return { name: "role", params: { action: "model_set", ...params } };
    case "model_delete_role":
      return { name: "role", params: { action: "model_delete", ...params } };
    default:
      throw new Error(`unknown test role tool: ${name}`);
  }
}
