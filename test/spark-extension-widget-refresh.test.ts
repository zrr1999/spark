import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sparkExtension from "../packages/spark/src/extension/index.ts";
import type { SparkWidgetTheme, SparkWidgetTui } from "../packages/spark/src/ui/spark-widget.ts";
import { TaskGraph, defaultTaskGraphStore } from "spark-tasks";

type SparkPi = Parameters<typeof sparkExtension>[0];
type SparkToolConfig = Parameters<NonNullable<SparkPi["registerTool"]>>[0];
type SparkEventHandler = Parameters<NonNullable<SparkPi["on"]>>[1];
type WidgetComponent = { render(): string[]; invalidate(): void };
type WidgetFactory = (tui: SparkWidgetTui, theme: SparkWidgetTheme) => WidgetComponent;

type WidgetCall = {
  key: string;
  cb: unknown;
  opts?: { placement?: string };
};

type TestSparkContext = {
  cwd: string;
  hasUI: true;
  sessionManager: {
    getSessionFile(): string;
    getLeafId(): string;
  };
  ui: {
    setWidget(key: string, cb: unknown, opts?: { placement?: string }): void;
  };
};

const theme: SparkWidgetTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
};

function isWidgetFactory(value: unknown): value is WidgetFactory {
  return typeof value === "function";
}

function requireTool(tools: Map<string, SparkToolConfig>, name: string): SparkToolConfig {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool registration: ${name}`);
  return tool;
}

async function executeTool(
  tool: SparkToolConfig,
  params: Record<string, unknown>,
  ctx: TestSparkContext,
): Promise<Awaited<ReturnType<SparkToolConfig["execute"]>>> {
  return tool.execute("tool-call", params, new AbortController().signal, () => {}, ctx);
}

void test("Spark extension refreshes SparkWidget after claim and TODO tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-extension-widget-refresh-"));
  try {
    await mkdir(join(dir, ".spark"), { recursive: true });
    const graph = new TaskGraph();
    graph.createThread({ title: "Widget refresh thread", description: "widget refresh" });
    await defaultTaskGraphStore(dir).save(graph);

    const tools = new Map<string, SparkToolConfig>();
    const handlers = new Map<string, SparkEventHandler>();
    const widgetCalls: WidgetCall[] = [];
    let widgetComponent: WidgetComponent | undefined;
    let renderRequests = 0;
    const widgetTui: SparkWidgetTui = {
      terminal: { columns: 160 },
      requestRender() {
        renderRequests += 1;
      },
    };
    const ctx: TestSparkContext = {
      cwd: dir,
      hasUI: true,
      sessionManager: {
        getSessionFile: () => join(dir, "session.json"),
        getLeafId: () => "leaf-widget-refresh",
      },
      ui: {
        setWidget(key, cb, opts) {
          widgetCalls.push({ key, cb, opts });
          widgetComponent = isWidgetFactory(cb) ? cb(widgetTui, theme) : undefined;
        },
      },
    };
    const pi: SparkPi = {
      registerCommand() {},
      registerTool(config) {
        tools.set(config.name, config);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    };
    sparkExtension(pi);

    await executeTool(
      requireTool(tools, "spark_claim_task"),
      {
        title: "Widget refresh task",
        description: "Exercise widget refresh after claim.",
        kind: "implement",
        todos: ["First child TODO"],
      },
      ctx,
    );
    assert.equal(widgetCalls.length, 1);
    assert.equal(widgetCalls[0]?.key, "spark-status");
    assert.deepEqual(widgetCalls[0]?.opts, { placement: "aboveEditor" });
    assert.ok(widgetComponent);
    assert.match(widgetComponent.render().join("\n"), /→ @me Widget refresh task/);
    assert.match(widgetComponent.render().join("\n"), /First child TODO/);

    await handlers.get("tool_execution_end")?.({ toolName: "spark_claim_task" }, ctx);
    assert.equal(renderRequests, 1);

    await executeTool(
      requireTool(tools, "spark_update_task_todos"),
      {
        ops: [
          { op: "done", item: "First child TODO" },
          { op: "append", items: ["Second child TODO"] },
        ],
      },
      ctx,
    );
    assert.equal(widgetCalls.length, 1);
    assert.equal(renderRequests, 2);
    assert.match(widgetComponent.render().join("\n"), /First child TODO/);
    assert.match(widgetComponent.render().join("\n"), /Second child TODO/);

    await handlers.get("tool_execution_end")?.({ toolName: "spark_update_task_todos" }, ctx);
    assert.equal(renderRequests, 3);

    await executeTool(
      requireTool(tools, "spark_update_todos"),
      {
        ops: [{ op: "append", items: ["Independent session TODO"] }],
      },
      ctx,
    );
    assert.equal(widgetCalls.length, 1);
    assert.equal(renderRequests, 4);
    assert.match(widgetComponent.render().join("\n"), /Independent session TODO/);

    await handlers.get("tool_execution_end")?.({ toolName: "spark_update_todos" }, ctx);
    assert.equal(renderRequests, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
