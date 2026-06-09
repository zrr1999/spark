import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import piAskExtension from "../packages/pi-ask/src/extension.ts";
import { registerPiCueTools } from "../packages/pi-cue/src/index.ts";
import piGraftExtension from "../packages/pi-graft/src/extension.ts";
import { registerPiRolesTools } from "../packages/pi-roles/src/extension.ts";
import sparkExtension from "../packages/spark/src/extension/index.ts";

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

void test("Spark extension canonical facade tools render parameter-aware tool calls", () => {
  const tools = registerSparkToolsForRendering();

  assertAllToolsHaveCallRenderers(tools);
  assert.equal(
    renderCall(tools, "task", { action: "status", view: "full", limit: 5 }),
    "task action=status",
  );
  assert.equal(
    renderCall(tools, "task", { action: "project_list", status: "all" }),
    "task action=project_list",
  );
  assert.equal(
    renderCall(tools, "task", {
      action: "plan",
      tasks: [
        { name: "inspect", title: "Inspect code", description: "Read sources" },
        { name: "implement", title: "Implement rendering", description: "Patch tools" },
      ],
    }),
    "task action=plan",
  );
  assert.equal(renderCall(tools, "goal", { action: "status" }), "goal action=status");
  assert.equal(tools.has("patch"), false, "patch workflows are owned by pi-graft");
  assert.equal(tools.has("cue_exec"), false, "pi-cue is registered as its own extension");
  assert.deepEqual(
    [...tools.keys()].filter((name) => name.startsWith("spark_")),
    [],
  );

  const longTask = renderCall(
    tools,
    "task",
    {
      action: "claim",
      title:
        "请确认 standalone Spark 下一阶段 RFC/实现准备采用的决策 bundle。推荐默认：Project-first with intake artifact；local files are source of truth；manager owns DAG.",
    },
    80,
  );
  assertVisibleWidthAtMost(longTask, 80);
});

void test("standalone Pi ask, cue, and role tools render parameter-aware tool calls", () => {
  const askTools = new Map<string, RenderableToolConfig>();
  piAskExtension({
    registerTool: (config) => askTools.set(config.name, config),
  });
  assertAllToolsHaveCallRenderers(askTools);
  assert.deepEqual([...askTools.keys()].sort(), ["ask"]);
  assert.equal(
    renderCall(askTools, "ask", {
      action: "flow",
      title: "Choose scope",
      questions: [{ id: "scope", prompt: "What next?" }],
    }),
    "ask action=flow Choose scope 1q",
  );
  assert.equal(
    renderCall(askTools, "ask", {
      action: "ask",
      title: "Choose scope",
      questions: [{ id: "scope", prompt: "What next?" }],
    }),
    "ask action=ask Choose scope 1q",
  );

  const cueTools = registerCueToolsForRendering();
  assertAllToolsHaveCallRenderers(cueTools);
  assert.deepEqual([...cueTools.keys()].sort(), [
    "cue_exec",
    "cue_history",
    "cue_jobs",
    "cue_run",
    "cue_schedule",
    "cue_scope",
    "cue_script",
    "script_eval",
    "script_run",
  ]);
  assert.equal(
    renderCall(cueTools, "cue_jobs", { action: "status", id: "J12", tail_bytes: 4096 }),
    "cue_jobs action=status id=J12 tail=4096",
  );
  assert.equal(
    renderCall(cueTools, "cue_jobs", { action: "list", status: "running", limit: 5 }),
    "cue_jobs action=list status=running limit=5",
  );
  assert.equal(
    renderCall(cueTools, "cue_jobs", { action: "wait", id: "J12", timeout: 30, tail_bytes: 4096 }),
    "cue_jobs action=wait id=J12 timeout=30s tail=4096",
  );
  assert.equal(
    renderCall(cueTools, "cue_scope", {
      action: "list",
      limit: 3,
      includeEnv: true,
      tail_bytes: 2048,
    }),
    "cue_scope action=list limit=3 include-env tail=2048",
  );
  assert.equal(
    renderCall(cueTools, "cue_history", { id: "J12", limit: 10, tail_bytes: 4096 }),
    "cue_history J12 limit=10 tail=4096",
  );
  assert.equal(
    renderCall(cueTools, "cue_schedule", {
      action: "add",
      schedule: "every 5m",
      command: "pnpm test",
    }),
    'cue_schedule action=add schedule="every 5m" command="pnpm test"',
  );
  assert.equal(
    renderCall(cueTools, "cue_run", { path: "scripts/build.cue", timeout: 30, tail_bytes: 4096 }),
    "cue_run path=scripts/build.cue timeout=30s tail=4096",
  );
  assert.equal(
    renderCall(cueTools, "cue_script", {
      script: 'job run { command: "echo ok" }',
      pathLabel: "inline.cue",
      timeout: 30,
      tail_bytes: 4096,
    }),
    "cue_script inline=1line(s) label=inline.cue timeout=30s tail=4096",
  );

  assert.equal(
    renderCall(cueTools, "script_run", {
      language: "python",
      path: "scripts/smoke.py",
      timeout: 30,
      tail_bytes: 4096,
    }),
    "script_run lang=python path=scripts/smoke.py timeout=30s tail=4096",
  );
  assert.equal(
    renderCall(cueTools, "script_eval", {
      language: "python",
      script: 'print("ok")',
      pathLabel: "inline.py",
      timeout: 30,
      tail_bytes: 4096,
    }),
    "script_eval lang=python inline=1line(s) label=inline.py timeout=30s tail=4096",
  );

  const longRun = renderCall(
    cueTools,
    "cue_exec",
    {
      command:
        "pnpm exec node -e \"import('@earendil-works/pi-tui').then(m=>console.log(m.visibleWidth('你好'))).catch(e=>{console.error(e);process.exit(1)})\"",
      cwd: "/Users/zhanrongrui/workspace/zrr1999/pi-spark",
    },
    80,
  );
  assertVisibleWidthAtMost(longRun, 80);

  const roleTools = new Map<string, RenderableToolConfig>();
  registerPiRolesTools({
    registerTool: (config) => roleTools.set(config.name, config),
  });
  assertAllToolsHaveCallRenderers(roleTools);
  assert.deepEqual([...roleTools.keys()].sort(), ["role"]);
  assert.equal(
    renderCall(roleTools, "role", { action: "list", source: "builtin" }),
    "role action=list",
  );
  assert.equal(
    renderCall(roleTools, "role", { action: "get", role: "worker" }),
    "role action=get worker",
  );
  assert.equal(
    renderCall(roleTools, "role", { action: "create", id: "repo-inspector" }),
    "role action=create id=repo-inspector",
  );
  assert.equal(
    renderCall(roleTools, "role", { action: "call", role: "worker" }),
    "role action=call worker",
  );

  const graftTools = registerGraftToolsForRendering();
  assert.equal(
    renderCall(graftTools, "graft_patch", {
      instruction: "Create a narrow candidate for the requested fix.",
      mode: "forked",
      model: "test/model",
    }),
    'graft_patch "Create a narrow candidate for the requested fix." mode=forked model=test/model',
  );
  assert.equal(
    renderCall(graftTools, "graft_repo", {
      action: "add",
      repoId: "pi-spark",
      url: "https://github.com/zrr1999/pi-spark.git",
    }),
    "graft_repo action=add repo=pi-spark url=https://github.com/zrr1999/pi-spark.git",
  );

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
  registerPiCueTools({
    registerTool: (config) => tools.set(config.name, config),
    on: () => undefined,
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    setActiveTools: () => undefined,
  });
  return tools;
}

function registerGraftToolsForRendering(): Map<string, RenderableToolConfig> {
  const tools = new Map<string, RenderableToolConfig>();
  piGraftExtension({
    registerTool: (config) => tools.set(config.name, config),
    registerCommand: () => undefined,
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
