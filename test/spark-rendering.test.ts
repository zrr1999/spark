import assert from "node:assert/strict";
import test from "node:test";

import type { Component, TUI } from "@earendil-works/pi-tui";

import { SparkKeybindings } from "../apps/spark/src/host/keybindings.ts";
import { SparkHostRuntime } from "../apps/spark/src/host/runtime.ts";
import type { SparkHostMessageRenderer } from "../apps/spark/src/host/types.ts";
import {
  createSparkNativeUiTransport,
  SparkNativeSession,
  SparkNativeTuiApp,
} from "../apps/spark/src/native-tui.ts";

function fakeTui(): TUI {
  return {
    requestRender: () => undefined,
    terminal: { rows: 30, cols: 100 },
    addChild: () => undefined,
    removeChild: () => undefined,
    setFocus: () => undefined,
  } as unknown as TUI;
}

function renderMessageContent(content: Parameters<SparkHostMessageRenderer>[0]["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

void test("SparkHostRuntime registers and exposes custom message renderers", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-rendering" });
  const renderer: SparkHostMessageRenderer = (message) => ({
    render: () => [`rendered:${message.customType}:${renderMessageContent(message.content)}`],
  });

  host.registerMessageRenderer("status-update", renderer);

  assert.equal(host.getMessageRenderer("status-update"), renderer);
  assert.deepEqual(
    host.listMessageRenderers().map((entry) => entry.customType),
    ["status-update"],
  );
  assert.throws(() => host.registerMessageRenderer("", renderer), /requires a customType/);
  assert.throws(
    () => host.registerMessageRenderer("bad", undefined as unknown as SparkHostMessageRenderer),
    /requires a renderer function/,
  );
});

void test("SparkNativeSession appends streaming assistant chunks smoothly", () => {
  const session = new SparkNativeSession();
  session.appendAssistantChunk("hello");
  session.appendAssistantChunk(" world");
  session.finishAssistantMessage();

  const assistantMessages = session.messages.filter((message) => message.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0]!.text, "hello world");
  assert.equal(assistantMessages[0]!.streaming, false);
});

void test("SparkNativeTuiApp folds tool output and toggles thinking/tool visibility", () => {
  const session = new SparkNativeSession();
  session.addToolMessage({ toolName: "impl_status", text: "long tool output", status: "success" });
  session.addThinking("hidden reasoning trace");
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  let rendered = app.render(80).join("\n");
  assert.match(rendered, /tool:impl_status \[success\] • folded/);
  assert.doesNotMatch(rendered, /long tool output/);
  assert.match(rendered, /thinking • hidden/);
  assert.doesNotMatch(rendered, /hidden reasoning trace/);

  assert.equal(app.toggleTools(), true);
  assert.equal(app.toggleThinking(), true);
  rendered = app.render(80).join("\n");
  assert.match(rendered, /tool:impl_status \[success\]> long tool output/);
  assert.match(rendered, /thinking> hidden reasoning trace/);
});

void test("SparkNativeTuiApp uses custom message renderers and skips display=false custom messages", () => {
  const session = new SparkNativeSession();
  session.addCustomMessage({
    customType: "status-update",
    content: "green",
    details: { level: "success" },
  });
  session.addCustomMessage({ customType: "status-update", content: "hidden", display: false });
  const renderers = new Map<string, SparkHostMessageRenderer>([
    [
      "status-update",
      (message, options) => ({
        render: () => [
          `custom-render:${renderMessageContent(message.content)}:expanded=${String(options.expanded)}`,
        ],
      }),
    ],
  ]);
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    messageRenderers: renderers,
  });

  const rendered = app.render(80).join("\n");
  assert.match(rendered, /custom-render:green:expanded=true/);
  assert.doesNotMatch(rendered, /hidden/);
});

void test("SparkNativeTuiApp renders native setStatus and setWidget surfaces", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  app.setStatus("spark-role-runs", "roles: running=1 waiting=1");
  app.setWidget("spark-role-runs", ["◆ Role runs (running=1)", "├─ ▶ worker @role-tui · 2s"], {
    placement: "belowEditor",
  });

  let rendered = app.render(100).join("\n");
  assert.match(rendered, /native pi-tui host • idle • roles: running=1 waiting=1/);
  assert.match(rendered, /◆ Role runs \(running=1\)/);
  assert.match(rendered, /worker @role-tui/);

  app.setStatus("spark-role-runs", undefined);
  app.setWidget("spark-role-runs", undefined, { placement: "belowEditor" });
  rendered = app.render(100).join("\n");
  assert.doesNotMatch(rendered, /roles: running=1/);
  assert.doesNotMatch(rendered, /◆ Role runs/);
});

void test("Spark native UI transport bridges notify, status, widget, and custom", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  const ui = createSparkNativeUiTransport(app, session);

  ui.notify?.("hello", "success");
  ui.setStatus?.("spark-role-runs", "roles: failed=1");
  ui.setWidget?.("spark-role-runs", "role board\nsecond line", { placement: "aboveEditor" });
  const customResult = await (ui.custom?.(
    (_tui: unknown, _theme: unknown, _keybindings: unknown, done: (value: string) => void) => {
      done("custom-result");
      return { render: () => [], invalidate() {} } satisfies Component;
    },
    { overlay: false },
  ) as Promise<string>);

  assert.equal(customResult, "custom-result");
  const rendered = app.render(100).join("\n");
  assert.match(rendered, /custom:notification> success: hello/);
  assert.match(rendered, /roles: failed=1/);
  assert.match(rendered, /role board/);
  assert.match(rendered, /second line/);
});

void test("SparkHostRuntime custom messages reach native registered message renderers", () => {
  const runtime = new SparkHostRuntime({ cwd: "/tmp/spark-rendering", hasUI: true });
  runtime.registerMessageRenderer("spark-role-run-completion", (message) => ({
    render: () => [
      `completion-rendered:${message.customType}:${renderMessageContent(message.content)}`,
    ],
  }));
  const session = new SparkNativeSession();
  const renderers = new Map(
    runtime.listMessageRenderers().map(({ customType, renderer }) => [customType, renderer]),
  );
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    messageRenderers: renderers,
  });
  runtime.setUiTransport(createSparkNativeUiTransport(app, session));

  runtime.sendMessage(
    {
      customType: "spark-role-run-completion",
      content: "researcher completed: run:abc",
      display: true,
      details: { status: "done" },
    },
    { deliverAs: "followUp" },
  );

  assert.equal(runtime.peekOutbox().length, 1, "agent-loop outbox behavior is preserved");
  assert.match(
    app.render(100).join("\n"),
    /completion-rendered:spark-role-run-completion:researcher completed: run:abc/,
  );
});

void test("SparkNativeTuiApp uses a bounded fallback for component widget factories", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  app.setWidget("spark-status", () => undefined, { placement: "aboveEditor" });

  assert.match(
    app.render(100).join("\n"),
    /widget:spark-status component factory is not supported by native spark-cli yet/,
  );
});

void test("SparkNativeTuiApp dispatches app keybindings before editor input", async () => {
  const session = new SparkNativeSession();
  const keybindings = new SparkKeybindings();
  let picked = 0;
  keybindings.register({
    id: "app.modelPicker",
    defaultKey: "ctrl+l",
    description: "Open model picker",
    handler: () => void (picked += 1),
  });
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, { keybindings });

  app.handleInput("\f");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(picked, 1);
});

void test("SparkNativeTuiApp installs Ctrl+O/Ctrl+T toggle handlers into SparkKeybindings", async () => {
  const session = new SparkNativeSession();
  const keybindings = new SparkKeybindings();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, { keybindings });

  assert.equal(app.areToolsExpanded(), false);
  assert.equal(app.isThinkingExpanded(), false);
  assert.equal(await keybindings.executeKey("ctrl+o", {}), true);
  assert.equal(await keybindings.executeKey("ctrl+t", {}), true);
  assert.equal(app.areToolsExpanded(), true);
  assert.equal(app.isThinkingExpanded(), true);
});
