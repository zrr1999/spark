import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerPiRolesTools } from "../packages/pi-roles/src/extension.ts";

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

void test("call_role dry-run resolves builtin roles and returns Pi args", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-tool-dryrun-"));
  const previousBindingHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = dir;
  try {
    const tools = registerRoleToolsForTest();
    const result = await executeCallRole(tools, {
      role: "worker",
      instruction: "Implement a small change.",
      sessionDir: "/tmp/sessions",
    });

    assert.match(
      result.content[0]?.text ?? "",
      /Role call dry-run: worker \(role:builtin-worker\)/,
    );
    assert.match(result.content[0]?.text ?? "", /mode: fresh/);
    const details = result.details as {
      args?: string[];
      dryRun?: boolean;
      role?: { ref?: string };
    };
    assert.equal(details.dryRun, true);
    assert.equal(details.role?.ref, "role:builtin-worker");
    assert.deepEqual(details.args?.slice(0, 6), [
      "--print",
      "--mode",
      "json",
      "--session-dir",
      "/tmp/sessions",
      "--append-system-prompt",
    ]);
  } finally {
    if (previousBindingHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

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

void test("call_role launches fresh role runs when dryRun is false", async () => {
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
        "process.stdout.write(JSON.stringify({ type: 'done', args }) + '\\n');",
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
        dryRun: false,
        mode: "fresh",
        model: "test/model",
        piCommand: fakePi,
        timeoutMs: 5_000,
      },
      dir,
    );

    assert.match(result.content[0]?.text ?? "", /Role call succeeded: worker/);
    const details = result.details as {
      record?: { status?: string; mode?: string };
      jsonEventCount?: number;
    };
    assert.equal(details.record?.status, "succeeded");
    assert.equal(details.record?.mode, "fresh");
    assert.equal(details.jsonEventCount, 1);
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
      dryRun: false,
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
      instruction: "Run with an invalid dryRun flag.",
      dryRun: "false",
    }),
    /call_role dryRun must be a boolean/,
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

function registerRoleToolsForTest(): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  registerPiRolesTools({ registerTool: (config) => tools.set(config.name, config as ToolConfig) });
  return tools;
}

function executeCallRole(
  tools: Map<string, ToolConfig>,
  params: Record<string, unknown>,
  cwd = process.cwd(),
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  return executeRoleTool(tools, "call_role", params, cwd);
}

function executeRoleTool(
  tools: Map<string, ToolConfig>,
  name: string,
  params: Record<string, unknown>,
  cwd = process.cwd(),
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  const tool = tools.get(name);
  assert.ok(tool, `missing ${name} tool`);
  return tool.execute("tool-call", params, new AbortController().signal, () => undefined, { cwd });
}
