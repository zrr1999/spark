import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerPiRolesTools } from "../packages/pi-roles/src/extension.ts";

const DEFAULT_TEST_CWD = "/tmp/pi-roles-tool-default-cwd";

interface ToolConfig {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: { cwd?: string },
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

void test("role spec tools list, get, and create project roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-spec-tools-"));
  try {
    const tools = registerRoleToolsForTest();

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

void test("role action tool dispatches canonical list, get, and create actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-action-tool-"));
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("role spec tools keep patch presets out of builtin role lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-no-patcher-"));
  try {
    const tools = registerRoleToolsForTest();
    const listed = await executeRoleTool(tools, "list_roles", { source: "builtin" }, dir);
    const roleIds = ((listed.details?.roles ?? []) as Array<{ id: string }>).map((role) => role.id);

    assert.deepEqual(roleIds, ["oracle", "planner", "reviewer", "scout", "worker"]);
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

void test("call_role launches fresh role runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-tool-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = dir;
  try {
    const fakePi = join(dir, "fake-pi.mjs");
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
    const result = await executeCallRole(
      tools,
      {
        role: "worker",
        instruction: "Run the fake worker.",
        mode: "fresh",
        model: "test/model",
        piCommand: fakePi,
        timeoutMs: 5_000,
      },
      dir,
    );

    assert.match(result.content[0]?.text ?? "", /Role call succeeded: worker/);
    assert.match(
      result.content[0]?.text ?? "",
      /runRef=run:[^\n]+ · mode=fresh · model=test\/model/,
    );
    assert.match(result.content[0]?.text ?? "", /result:\nFake worker result\./);
    assert.doesNotMatch(result.content[0]?.text ?? "", /lastJsonEvent/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /stdout:\n\{"type":"message_end"/);
    const details = result.details as {
      record?: { status?: string; mode?: string };
      jsonEventCount?: number;
    };
    assert.equal(details.record?.status, "succeeded");
    assert.equal(details.record?.mode, "fresh");
    assert.equal(details.jsonEventCount, 1);

    const canonical = await executeRoleTool(
      tools,
      "role",
      {
        action: "call",
        role: "worker",
        instruction: "Run the fake worker through the canonical role tool.",
        mode: "fresh",
        model: "test/model",
        piCommand: fakePi,
        timeoutMs: 5_000,
      },
      dir,
    );
    assert.match(canonical.content[0]?.text ?? "", /Role call succeeded: worker/);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("call_role does not expose raw JSON protocol fragments as output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-protocol-fragment-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = dir;
  try {
    const fakePi = join(dir, "fake-pi-fragment.mjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--list-models' && args[1] === 'test/model') process.exit(0);",
        'process.stdout.write(\'"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta"}\\n\');',
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const tools = registerRoleToolsForTest();
    const result = await executeCallRole(
      tools,
      {
        role: "worker",
        instruction: "Run the fake worker.",
        model: "test/model",
        piCommand: fakePi,
      },
      dir,
    );

    assert.match(result.content[0]?.text ?? "", /Role call succeeded: worker/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /assistantMessageEvent/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /toolcall_delta/);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("call_role forked mode requires explicit parent session", async () => {
  const tools = registerRoleToolsForTest();
  await assert.rejects(
    executeCallRole(tools, {
      role: "reviewer",
      instruction: "Review with context.",
      mode: "forked",
    }),
    /forked mode requires forkFromSession/,
  );
});

void test("call_role rejects unknown run modes instead of falling back to fresh", async () => {
  const tools = registerRoleToolsForTest();
  await assert.rejects(
    executeCallRole(tools, {
      role: "worker",
      instruction: "Run with an invalid mode.",
      mode: "legacy-mode",
    }),
    /unsupported role run mode/,
  );
});

void test("pi-roles tools require ctx cwd unless call_role cwd is explicit", async () => {
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

  const dir = await mkdtemp(join(tmpdir(), "pi-roles-explicit-cwd-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = dir;
  try {
    const fakePi = await writeFakePi(dir);
    const explicit = await executeRoleToolWithoutCwd(tools, "call_role", {
      role: "worker",
      instruction: "Run with explicit cwd.",
      cwd: dir,
      model: "test/model",
      piCommand: fakePi,
    });
    assert.match(explicit.content[0]?.text ?? "", /Role call succeeded: worker/);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("pi-roles tools reject invalid explicit parameters instead of using defaults", async () => {
  const tools = registerRoleToolsForTest();

  await assert.rejects(
    executeRoleTool(tools, "list_roles", { limit: "many" }),
    /list_roles limit must be a finite number/,
  );
  await assert.rejects(
    executeRoleTool(tools, "list_roles", { source: "managed" }),
    /list_roles source must be builtin, project, or user/,
  );
  await assert.rejects(
    executeRoleTool(tools, "get_role", { role: "worker", includePrompt: "true" }),
    /get_role includePrompt must be a boolean/,
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
      description: "Invalid model should fail.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
      defaultModel: 42,
    }),
    /create_role defaultModel must be a string/,
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
      instruction: "Run with an invalid pi command.",
      piCommand: 42,
    }),
    /call_role piCommand must be a string/,
  );
  await assert.rejects(
    executeCallRole(tools, {
      role: "worker",
      instruction: "Run with an invalid session directory.",
      sessionDir: 42,
    }),
    /call_role sessionDir must be a string/,
  );
  await assert.rejects(
    executeCallRole(tools, {
      role: "reviewer",
      instruction: "Fork with an invalid parent.",
      mode: "forked",
      forkFromSession: 42,
    }),
    /call_role forkFromSession must be a string/,
  );
});

async function writeFakePi(dir: string): Promise<string> {
  const fakePi = join(dir, "fake-pi.mjs");
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
  return fakePi;
}

function registerRoleToolsForTest(): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  registerPiRolesTools({ registerTool: (config) => tools.set(config.name, config as ToolConfig) });
  return tools;
}

function executeCallRole(
  tools: Map<string, ToolConfig>,
  params: Record<string, unknown>,
  cwd = DEFAULT_TEST_CWD,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  return executeRoleTool(tools, "call_role", params, cwd);
}

function executeRoleTool(
  tools: Map<string, ToolConfig>,
  name: string,
  params: Record<string, unknown>,
  cwd = DEFAULT_TEST_CWD,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  const tool = tools.get(name);
  assert.ok(tool, `missing ${name} tool`);
  return tool.execute("tool-call", params, new AbortController().signal, () => undefined, { cwd });
}

function executeRoleToolWithoutCwd(
  tools: Map<string, ToolConfig>,
  name: string,
  params: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  const tool = tools.get(name);
  assert.ok(tool, `missing ${name} tool`);
  return tool.execute("tool-call", params, new AbortController().signal, () => undefined, {});
}
