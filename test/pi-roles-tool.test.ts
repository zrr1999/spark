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
