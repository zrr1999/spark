import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerPiContextTool } from "@zendev-lab/pi-context/extension";
import { registerPiRecallTool } from "@zendev-lab/pi-recall/extension";

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

void test("context tool lists and previews registered providers within budgets", async () => {
  const tools = new Map<string, ToolConfig>();
  registerPiContextTool(
    { registerTool: (config) => tools.set(config.name, config as ToolConfig) },
    {
      providers: [
        {
          id: "test.provider",
          label: "Test provider",
          description: "Provides deterministic test context.",
          defaultBudgetChars: 20,
          async render() {
            return "abcdefghijklmnopqrstuvwxyz";
          },
        },
      ],
    },
  );

  const listed = await executeTool(tools, "context", { action: "list" });
  assert.match(toolText(listed), /test\.provider/);

  const preview = await executeTool(tools, "context", {
    action: "preview",
    providerIds: ["test.provider"],
    budgetChars: 8,
  });
  assert.match(toolText(preview), /abcdefg…/);
  const bundle = (preview.details?.bundles as Array<{ truncated?: boolean }> | undefined)?.[0];
  assert.equal(bundle?.truncated, true);

  await assert.rejects(
    () => executeTool(tools, "context", { action: "preview", providerIds: ["freeform"] }),
    /unknown context provider/,
  );
});

void test("recall tool records, searches, lists, and rejects explicit scoped candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-recall-tool-"));
  try {
    const tools = new Map<string, ToolConfig>();
    registerPiRecallTool({
      registerTool: (config) => tools.set(config.name, config as ToolConfig),
    });

    const recorded = await executeTool(
      tools,
      "recall",
      {
        action: "record_candidate",
        scope: "workspace",
        text: "Prefer explicit candidate recall over automatic memory writes.",
        reason: "User requested controlled recall semantics.",
        evidenceRefs: ["artifact:test"],
      },
      dir,
    );
    assert.match(toolText(recorded), /Recorded recall candidate recall:/);
    const id = (recorded.details?.candidate as { id?: string } | undefined)?.id;
    assert.ok(id);

    const searched = await executeTool(
      tools,
      "recall",
      { action: "search", scope: "workspace", query: "candidate recall" },
      dir,
    );
    assert.match(toolText(searched), /explicit candidate recall/);

    const rejected = await executeTool(
      tools,
      "recall",
      { action: "reject", scope: "workspace", id, reason: "No longer needed." },
      dir,
    );
    assert.match(toolText(rejected), /Rejected recall candidate/);

    const listed = await executeTool(
      tools,
      "recall",
      { action: "list", scope: "workspace", includeRejected: true },
      dir,
    );
    assert.match(toolText(listed), /\[rejected\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("recall tool uses injected host-owned store paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-recall-paths-"));
  try {
    const explicitPath = join(dir, "recall", "workspace.json");
    const tools = new Map<string, ToolConfig>();
    registerPiRecallTool(
      { registerTool: (config) => tools.set(config.name, config as ToolConfig) },
      { storePaths: { workspace: explicitPath } },
    );

    await executeTool(
      tools,
      "recall",
      {
        action: "record_candidate",
        scope: "workspace",
        text: "Use a host-owned recall store path.",
        reason: "Avoid package-level storage ownership leaks.",
      },
      dir,
    );

    const stored = JSON.parse(await readFile(explicitPath, "utf8")) as {
      candidates?: Array<{ text?: string }>;
    };
    assert.equal(stored.candidates?.[0]?.text, "Use a host-owned recall store path.");
    await assert.rejects(() => readFile(join(dir, ".spark", "recall-candidates.json"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function executeTool(
  tools: Map<string, ToolConfig>,
  name: string,
  params: Record<string, unknown>,
  cwd = "/tmp/pi-context-recall-test",
): Promise<ToolResult> {
  const tool = tools.get(name);
  assert.ok(tool, `missing ${name} tool`);
  return tool.execute("tool-call", params, new AbortController().signal, () => undefined, { cwd });
}

function toolText(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}
