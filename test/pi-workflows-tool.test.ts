import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerPiWorkflowTool } from "@zendev-lab/pi-workflows/extension";
import { workspaceWorkflowDir } from "@zendev-lab/pi-workflows";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};
interface ToolConfig {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: { cwd?: string },
  ): Promise<ToolResult>;
}

void test("workflow tool lists builtins and reads saved workspace scripts from controlled roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflows-tool-"));
  try {
    await mkdir(workspaceWorkflowDir(dir), { recursive: true });
    await writeFile(
      join(workspaceWorkflowDir(dir), "release-check.js"),
      `export const meta = {
        name: "Release Check",
        description: "Check release readiness.",
        stages: [{ title: "Inspect" }, { title: "Verify" }],
      };
      throw new Error("discovery must not execute workflow bodies");`,
      "utf8",
    );

    const tools = new Map<string, ToolConfig>();
    registerPiWorkflowTool({
      registerTool: (config) => tools.set(config.name, config as ToolConfig),
    });

    const listed = await executeTool(
      tools,
      "workflow",
      { action: "list", includeUser: false },
      dir,
    );
    assert.match(toolText(listed), /builtin:research/);
    assert.match(toolText(listed), /workspace:release-check/);
    assert.match(toolText(listed), /Release Check/);

    const read = await executeTool(
      tools,
      "workflow",
      { action: "read", selector: "workspace:release-check", includeUser: false, maxChars: 80 },
      dir,
    );
    assert.match(toolText(read), /Check release readiness/);
    assert.match(toolText(read), /export const meta/);
    assert.equal((read.details as { truncated?: boolean }).truncated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("workflow tool rejects inline/freeform selectors", async () => {
  const tools = new Map<string, ToolConfig>();
  registerPiWorkflowTool({
    registerTool: (config) => tools.set(config.name, config as ToolConfig),
  });

  await assert.rejects(
    () => executeTool(tools, "workflow", { action: "read", selector: "inline:do-things" }),
    /workflow selector must be builtin:<id>, workspace:<id>, or user:<id>/,
  );
  await assert.rejects(
    () => executeTool(tools, "workflow", { action: "read", selector: "workspace:../escape" }),
    /workflow id/,
  );
});

function executeTool(
  tools: Map<string, ToolConfig>,
  name: string,
  params: Record<string, unknown>,
  cwd = "/tmp/pi-workflows-tool-test",
): Promise<ToolResult> {
  const tool = tools.get(name);
  assert.ok(tool, `missing ${name} tool`);
  return tool.execute("tool-call", params, new AbortController().signal, () => undefined, { cwd });
}

function toolText(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}
