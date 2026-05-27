import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { registerPiAskTools } from "../packages/pi-ask/src/index.ts";
import { registerPiCueTools } from "../packages/pi-cue/src/index.ts";
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

void test("Spark extension tools render parameter-aware tool calls", () => {
  const tools = registerSparkToolsForRendering();

  assertAllToolsHaveCallRenderers(tools);
  assert.equal(
    renderCall(tools, "spark_status", { view: "full", limit: 5 }),
    "spark_status full limit=5",
  );
  assert.equal(
    renderCall(tools, "spark_ask", {
      mode: "decision",
      title: "Proceed with implementation?",
      questions: [
        {
          id: "decision",
          prompt: "Proceed with implementation?",
          options: [
            { id: "yes", label: "Yes", description: "Proceed" },
            { id: "no", label: "No", description: "Stop" },
          ],
        },
        { id: "note", prompt: "Any note?", type: "freeform" },
      ],
    }),
    'spark_ask decision "Proceed with implementation?" 2 questions',
  );
  assert.equal(
    renderCall(tools, "spark_plan_tasks", {
      tasks: [
        { name: "inspect", title: "Inspect code", description: "Read sources" },
        { name: "implement", title: "Implement rendering", description: "Patch tools" },
      ],
    }),
    "spark_plan_tasks 2 tasks @inspect,@implement",
  );
  assert.equal(
    renderCall(tools, "cue_exec", {
      command: "pnpm test",
      background: true,
      timeout: 30,
      cwd: "packages/spark",
    }),
    'cue_exec "pnpm test" background timeout=30s cwd=packages/spark',
  );
  const longAsk = renderCall(
    tools,
    "spark_ask",
    {
      kind: "decision",
      question:
        "请确认 standalone Spark 下一阶段 RFC/实现准备采用的决策 bundle。推荐默认：Project-first with intake artifact；local files are source of truth；manager owns DAG.",
      options: Array.from({ length: 8 }, (_, index) => ({
        id: `o${index}`,
        label: `Option ${index}`,
        description: "Option",
      })),
      defaultOptionId: "accept-recommended",
    },
    80,
  );
  assertVisibleWidthAtMost(longAsk, 80);

  const longFlowAsk = renderCall(
    tools,
    "spark_ask",
    {
      mode: "clarification",
      title: "测试 ask_flow 模式",
      questions: [
        {
          id: "scope",
          prompt:
            "测试 Spark ask_flow 模式：用户明确要求使用 flow 模式，而不是单题 ask。请用 flow 交互收集/确认用途。",
          options: [
            { id: "a", label: "A", description: "选择 A 的详细含义。" },
            { id: "b", label: "B", description: "选择 B 的详细含义。" },
          ],
        },
      ],
    },
    80,
  );
  assertVisibleWidthAtMost(longFlowAsk, 80);
});

void test("standalone Pi ask, cue, and role tools render parameter-aware tool calls", () => {
  const askTools = new Map<string, RenderableToolConfig>();
  registerPiAskTools({
    registerTool: (config) => askTools.set(config.name, config),
  });
  assertAllToolsHaveCallRenderers(askTools);
  assert.equal(
    renderCall(askTools, "ask_user", {
      title: "Choose scope",
      mode: "clarification",
      questions: [{ id: "scope", prompt: "What next?" }],
    }),
    'ask_user title="Choose scope" clarification 1q',
  );

  const cueTools = registerCueToolsForRendering();
  assertAllToolsHaveCallRenderers(cueTools);
  assert.deepEqual([...cueTools.keys()].sort(), [
    "cue_exec",
    "cue_history",
    "cue_jobs",
    "cue_schedule",
    "cue_scope",
  ]);
  assert.equal(
    renderCall(cueTools, "cue_jobs", { action: "status", id: "J12", tail_bytes: 4096 }),
    "cue_jobs status id=J12 tail=4096",
  );
  assert.equal(
    renderCall(cueTools, "cue_jobs", { action: "list", status: "running", limit: 5 }),
    "cue_jobs list status=running limit=5",
  );
  assert.equal(
    renderCall(cueTools, "cue_jobs", { action: "wait", id: "J12", timeout: 30, tail_bytes: 4096 }),
    "cue_jobs wait id=J12 timeout=30s tail=4096",
  );
  assert.equal(
    renderCall(cueTools, "cue_scope", {
      action: "list",
      limit: 3,
      includeEnv: true,
      env_tail_bytes: 2048,
    }),
    "cue_scope list limit=3 include-env env-tail=2048",
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
    'cue_schedule add schedule="every 5m" command="pnpm test"',
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
  assert.equal(renderCall(roleTools, "list_roles", { source: "builtin" }), "list_roles builtin");
  assert.equal(renderCall(roleTools, "get_role", { role: "worker" }), "get_role worker");
  assert.equal(
    renderCall(roleTools, "create_role", {
      id: "repo-inspector",
      description: "Inspect repository state before implementation.",
    }),
    'create_role id=repo-inspector project "Inspect repository state before implementation."',
  );
  assert.equal(
    renderCall(roleTools, "call_role", {
      role: "worker",
      instruction: "Inspect the implementation.",
      mode: "fresh",
      dryRun: true,
      timeoutMs: 1000,
    }),
    "call_role worker fresh dry-run timeout=1000",
  );

  const longAskUser = renderCall(
    askTools,
    "ask_user",
    {
      title: "测试一个很长的 ask_user 标题，用来确认中文宽字符不会撑爆 TUI 渲染行",
      mode: "clarification",
      questions: [{ id: "scope", prompt: "What next?" }],
    },
    80,
  );
  assertVisibleWidthAtMost(longAskUser, 80);
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
