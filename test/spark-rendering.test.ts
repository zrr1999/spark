import assert from "node:assert/strict";
import test from "node:test";

import type { TUI } from "@earendil-works/pi-tui";

import { SparkKeybindings } from "../packages/spark-cli/src/host/keybindings.ts";
import { SparkHostRuntime } from "../packages/spark-cli/src/host/runtime.ts";
import type { SparkHostMessageRenderer } from "../packages/spark-cli/src/host/types.ts";
import { SparkNativeSession, SparkNativeTuiApp } from "../packages/spark-cli/src/native-tui.ts";

function fakeTui(): TUI {
  return { requestRender: () => undefined, terminal: { rows: 30, cols: 100 } } as unknown as TUI;
}

void test("SparkHostRuntime registers and exposes custom message renderers", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-rendering" });
  const renderer: SparkHostMessageRenderer = (message) => ({
    render: () => [`rendered:${message.customType}:${message.content}`],
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
  session.addToolMessage({ toolName: "spark_status", text: "long tool output", status: "success" });
  session.addThinking("hidden reasoning trace");
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  let rendered = app.render(80).join("\n");
  assert.match(rendered, /tool:spark_status \[success\] • folded/);
  assert.doesNotMatch(rendered, /long tool output/);
  assert.match(rendered, /thinking • hidden/);
  assert.doesNotMatch(rendered, /hidden reasoning trace/);

  assert.equal(app.toggleTools(), true);
  assert.equal(app.toggleThinking(), true);
  rendered = app.render(80).join("\n");
  assert.match(rendered, /tool:spark_status \[success\]> long tool output/);
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
        render: () => [`custom-render:${message.content}:expanded=${String(options.expanded)}`],
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
