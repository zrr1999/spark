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

void test("run_role dry-run resolves builtin roles and returns Pi args", async () => {
  const tools = registerRoleToolsForTest();
  const result = await executeRunRole(tools, {
    role: "worker",
    instruction: "Implement a small change.",
    sessionDir: "/tmp/sessions",
  });

  assert.match(result.content[0]?.text ?? "", /Role dry-run: worker \(role:builtin-worker\)/);
  assert.match(result.content[0]?.text ?? "", /mode: fresh/);
  const details = result.details as { args?: string[]; dryRun?: boolean; role?: { ref?: string } };
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
});

void test("run_role launches fresh role runs when dryRun is false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-roles-tool-"));
  try {
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (!args.includes('--print')) process.exit(10);",
        "process.stdout.write(JSON.stringify({ type: 'done', args }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const tools = registerRoleToolsForTest();
    const result = await executeRunRole(
      tools,
      {
        role: "worker",
        instruction: "Run the fake worker.",
        dryRun: false,
        mode: "fresh",
        piCommand: fakePi,
        timeoutMs: 5_000,
      },
      dir,
    );

    assert.match(result.content[0]?.text ?? "", /Role run succeeded: worker/);
    const details = result.details as {
      result?: { record?: { status?: string; mode?: string }; jsonEvents?: unknown[] };
    };
    assert.equal(details.result?.record?.status, "succeeded");
    assert.equal(details.result?.record?.mode, "fresh");
    assert.equal(details.result?.jsonEvents?.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("run_role forked mode requires explicit parent session", async () => {
  const tools = registerRoleToolsForTest();
  await assert.rejects(
    executeRunRole(tools, {
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

function executeRunRole(
  tools: Map<string, ToolConfig>,
  params: Record<string, unknown>,
  cwd = process.cwd(),
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  const tool = tools.get("run_role");
  assert.ok(tool, "missing run_role tool");
  return tool.execute("tool-call", params, new AbortController().signal, () => undefined, { cwd });
}
