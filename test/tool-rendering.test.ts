import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { visibleWidth } from "@zendev-lab/spark-tui/text";

import piAskExtension from "../packages/spark-ask/src/extension.ts";
import { registerSparkCueTools } from "../packages/spark-cue/src/index.ts";
import piGraftExtension from "../packages/spark-graft/src/extension.ts";
import { registerSparkRolesTools } from "../packages/spark-roles/src/extension.ts";
import { registerSparkSessionTool } from "../packages/spark-session/src/extension.ts";
import sparkExtension from "../packages/pi-extension/src/extension/index.ts";

interface RenderTheme {
  fg: (_color: string, text: string) => string;
  bold: (text: string) => string;
}

interface RenderableToolConfig {
  name: string;
  renderCall?: (
    args: Record<string, unknown>,
    theme: RenderTheme,
    context: unknown,
  ) => {
    render(width: number): string[];
  };
}

const plainTheme: RenderTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const snapshotDir = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

test("Spark extension canonical facade tools render parameter-aware tool calls", async () => {
  const tools = registerSparkToolsForRendering();

  assertAllToolsHaveCallRenderers(tools);
  await expect(
    renderCallCases(tools, [
      { name: "task_read", args: { action: "workspace_status", view: "summary", limit: 5 } },
      { name: "task_read", args: { action: "project_list", status: "all" } },
      {
        name: "task_write",
        args: {
          action: "plan",
          tasks: [
            { name: "inspect", title: "Inspect code", description: "Read sources" },
            { name: "implement", title: "Implement rendering", description: "Patch tools" },
          ],
        },
      },
      { name: "assign", args: { dryRun: true, maxConcurrency: 2 } },
      { name: "goal", args: { action: "status" } },
      { name: "phase", args: { action: "plan", focus: "tighten tasks" } },
    ]),
  ).toMatchFileSnapshot(join(snapshotDir, "tool-rendering-spark.txt"));
  assert.equal(tools.has("patch"), false, "patch workflows are owned by spark-graft");
  assert.equal(tools.has("cue_exec"), false, "spark-cue is registered as its own extension");
  assert.deepEqual(
    [...tools.keys()].filter((name) => name.startsWith("spark_")),
    [],
  );

  const longTask = renderCall(
    tools,
    "task_write",
    {
      action: "claim",
      title:
        "请确认 standalone Spark 下一阶段 RFC/实现准备采用的决策 bundle。推荐默认：Project-first with intake artifact；local files are source of truth；manager owns DAG.",
    },
    80,
  );
  assertVisibleWidthAtMost(longTask, 80);
});

test("standalone Pi ask, cue, and role tools render parameter-aware tool calls", async () => {
  const askTools = new Map<string, RenderableToolConfig>();
  piAskExtension({
    registerTool: (config) => askTools.set(config.name, config),
  });
  assertAllToolsHaveCallRenderers(askTools);
  assert.deepEqual([...askTools.keys()].sort(), ["ask"]);
  await expect(
    renderCallCases(askTools, [
      {
        name: "ask",
        args: {
          action: "flow",
          title: "Choose scope",
          questions: [{ id: "scope", prompt: "What next?" }],
        },
      },
      {
        name: "ask",
        args: {
          action: "ask",
          title: "Choose scope",
          questions: [{ id: "scope", prompt: "What next?" }],
        },
      },
    ]),
  ).toMatchFileSnapshot(join(snapshotDir, "tool-rendering-ask.txt"));

  const cueTools = registerCueToolsForRendering();
  assertAllToolsHaveCallRenderers(cueTools);
  assert.deepEqual([...cueTools.keys()].sort(), [
    "cue_exec",
    "cue_history",
    "cue_jobs",
    "cue_resources",
    "cue_run",
    "cue_schedule",
    "cue_scope",
    "cue_script",
    "script_eval",
    "script_run",
  ]);
  await expect(
    renderCallCases(cueTools, [
      { name: "cue_jobs", args: { action: "status", id: "J12", tail_bytes: 4096 } },
      { name: "cue_jobs", args: { action: "list", status: "running", limit: 5 } },
      {
        name: "cue_jobs",
        args: { action: "wait", id: "J12", timeout: 30, tail_bytes: 4096 },
      },
      {
        name: "cue_scope",
        args: { action: "list", limit: 3, includeEnv: true, tail_bytes: 2048 },
      },
      { name: "cue_history", args: { id: "J12", limit: 10, tail_bytes: 4096 } },
      {
        name: "cue_schedule",
        args: { action: "add", schedule: "every 5m", command: "pnpm test" },
      },
      { name: "cue_run", args: { path: "scripts/build.cue", timeout: 30, tail_bytes: 4096 } },
      {
        name: "cue_script",
        args: {
          script: 'job run { command: "echo ok" }',
          pathLabel: "inline.cue",
          timeout: 30,
          tail_bytes: 4096,
        },
      },
      {
        name: "script_run",
        args: { language: "python", path: "scripts/smoke.py", timeout: 30, tail_bytes: 4096 },
      },
      {
        name: "script_eval",
        args: {
          language: "python",
          script: 'print("ok")',
          pathLabel: "inline.py",
          timeout: 30,
          tail_bytes: 4096,
        },
      },
    ]),
  ).toMatchFileSnapshot(join(snapshotDir, "tool-rendering-cue.txt"));

  const longRun = renderCall(
    cueTools,
    "cue_exec",
    {
      command:
        "pnpm exec node -e \"import('@zendev-lab/spark-tui/text').then(m=>console.log(m.visibleWidth('你好'))).catch(e=>{console.error(e);process.exit(1)})\"",
      cwd: "/Users/zhanrongrui/workspace/zrr1999/spark",
    },
    80,
  );
  assertVisibleWidthAtMost(longRun, 80);

  const roleTools = new Map<string, RenderableToolConfig>();
  registerSparkRolesTools({
    registerTool: (config) => roleTools.set(config.name, config),
  });
  assertAllToolsHaveCallRenderers(roleTools);
  assert.deepEqual([...roleTools.keys()].sort(), ["role"]);
  await expect(
    renderCallCases(roleTools, [
      { name: "role", args: { action: "list", source: "builtin" } },
      { name: "role", args: { action: "get", role: "worker" } },
      { name: "role", args: { action: "create", id: "repo-inspector" } },
      { name: "role", args: { action: "call", role: "worker" } },
    ]),
  ).toMatchFileSnapshot(join(snapshotDir, "tool-rendering-role.txt"));

  const sessionTools = new Map<string, RenderableToolConfig>();
  registerSparkSessionTool({
    registerTool: (config) => sessionTools.set(config.name, config),
  });
  assertAllToolsHaveCallRenderers(sessionTools);
  assert.deepEqual([...sessionTools.keys()], ["session"]);
  assert.match(
    renderCall(sessionTools, "session", { action: "list", surface: "local" }, 80),
    /session action=list surface=local/u,
  );
  assert.match(
    renderCall(
      sessionTools,
      "session",
      { action: "send", kind: "request", toSessionId: "session:worker" },
      80,
    ),
    /session action=send to=session:worker kind=request/u,
  );

  const graftTools = registerGraftToolsForRendering();
  await expect(
    renderCallCases(graftTools, [
      {
        name: "graft_repo",
        args: {
          action: "add",
          repoId: "spark",
          url: "https://github.com/zrr1999/spark.git",
        },
      },
    ]),
  ).toMatchFileSnapshot(join(snapshotDir, "tool-rendering-graft.txt"));

  const longAsk = renderCall(
    askTools,
    "ask",
    {
      action: "ask",
      title: "测试一个很长的 ask 标题，用来确认中文宽字符不会撑爆 TUI 渲染行",
      questions: [{ id: "scope", prompt: "What next?" }],
    },
    80,
  );
  assertVisibleWidthAtMost(longAsk, 80);
});

function registerSparkToolsForRendering(): Map<string, RenderableToolConfig> {
  const tools = new Map<string, RenderableToolConfig>();
  sparkExtension({
    registerCommand: () => undefined,
    registerTool: (config) => tools.set(config.name, config),
    on: () => undefined,
    sendMessage: () => undefined,
  });
  return tools;
}

function registerCueToolsForRendering(): Map<string, RenderableToolConfig> {
  const tools = new Map<string, RenderableToolConfig>();
  registerSparkCueTools({
    registerTool: (config) => tools.set(config.name, config),
    on: () => undefined,
    getActiveTools: () => [...tools.keys()],
    setActiveTools: () => undefined,
  });
  return tools;
}

function registerGraftToolsForRendering(): Map<string, RenderableToolConfig> {
  const tools = new Map<string, RenderableToolConfig>();
  piGraftExtension({
    registerTool: (config) => tools.set(config.name, config),
    on: () => undefined,
  });
  return tools;
}

function assertAllToolsHaveCallRenderers(tools: Map<string, RenderableToolConfig>): void {
  assert.ok(tools.size > 0, "expected registered tools");
  for (const tool of tools.values()) {
    assert.equal(typeof tool.renderCall, "function", `${tool.name} should define renderCall`);
  }
}

function renderCallCases(
  tools: Map<string, RenderableToolConfig>,
  cases: Array<{ name: string; args: Record<string, unknown>; width?: number }>,
): string {
  return `${cases
    .map(({ name, args, width }) => [`# ${name}`, renderCall(tools, name, args, width)].join("\n"))
    .join("\n\n")}\n`;
}

function renderCall(
  tools: Map<string, RenderableToolConfig>,
  name: string,
  args: Record<string, unknown>,
  width = 200,
): string {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool: ${name}`);
  assert.ok(tool.renderCall, `${name} missing renderCall`);
  return tool.renderCall(args, plainTheme, {}).render(width).join("\n");
}

function assertVisibleWidthAtMost(line: string, width: number): void {
  const renderedWidth = visibleWidth(line);
  assert.ok(renderedWidth <= width, `rendered call too wide: ${renderedWidth} > ${width}`);
}
