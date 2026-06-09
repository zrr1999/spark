import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import piGraftExtension from "../packages/pi-graft/src/extension.ts";
import { GRAFT_PATCH_ALLOWED_TOOLS } from "../packages/pi-graft/src/patch-tool.ts";

interface ToolConfig {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: {
      cwd: string;
      sessionManager?: { getSessionFile?: () => string | undefined };
      ui?: {
        notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
        input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
      };
    },
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

void test("graft_patch runs worker with Graft-only tools and upward-clarification guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graft-patch-tool-"));
  const previousHome = process.env.PI_ROLES_HOME;
  process.env.PI_ROLES_HOME = dir;
  try {
    const fakePi = join(dir, "fake-pi.mjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--list-models' && args[1] === 'test/model') process.exit(0);",
        "const toolsIndex = args.indexOf('--tools');",
        "const tools = toolsIndex >= 0 ? args[toolsIndex + 1] : '';",
        "const promptIndex = args.indexOf('--append-system-prompt');",
        "const prompt = promptIndex >= 0 ? args[promptIndex + 2] : '';",
        "if (!tools) process.exit(11);",
        "if (tools.split(',').some((tool) => !tool.startsWith('graft_'))) process.exit(12);",
        "if (tools.includes('graft_cli_exec')) process.exit(13);",
        'if (!prompt.includes("Graft\'s patch tool")) process.exit(14);',
        "if (!prompt.includes('Do not edit the working tree directly')) process.exit(15);",
        "if (!prompt.includes('ask upward for clarification')) process.exit(16);",
        "const text = `Graft patch child ok tools=${tools} fork=${args.includes('--fork')}`;",
        "const message = { role: 'assistant', content: [{ type: 'text', text }] };",
        "process.stdout.write(JSON.stringify({ type: 'message_end', message, args }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const tools = registerGraftToolsForTest();
    const patch = tools.get("graft_patch");
    assert.ok(patch, "missing graft_patch tool");
    assert.equal(tools.has("patch"), false, "graft must not expose bare patch tool");

    const result = await patch.execute(
      "tool-call",
      {
        instruction: "Create a Graft candidate for the requested change.",
        piCommand: fakePi,
        model: "test/model",
      },
      new AbortController().signal,
      () => undefined,
      {
        cwd: dir,
        sessionManager: { getSessionFile: () => join(dir, "session.jsonl") },
      },
    );

    assert.match(
      result.content[0]?.text ?? "",
      /Graft patch run succeeded: graft_patch via worker/,
    );
    assert.match(result.content[0]?.text ?? "", /fork=true/);
    const details = result.details as {
      allowedTools: string[];
      record: { mode?: string };
    };
    assert.deepEqual(details.allowedTools, [...GRAFT_PATCH_ALLOWED_TOOLS]);
    assert.equal(new Set<string>(details.allowedTools).has("graft_cli_exec"), false);
    assert.equal(details.record.mode, "forked");
  } finally {
    if (previousHome === undefined) delete process.env.PI_ROLES_HOME;
    else process.env.PI_ROLES_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});

function registerGraftToolsForTest(): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  piGraftExtension({
    registerTool: (config) => tools.set(config.name, config as ToolConfig),
    registerCommand: () => undefined,
    on: () => undefined,
  });
  return tools;
}
