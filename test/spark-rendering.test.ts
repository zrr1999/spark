import assert from "node:assert/strict";
import test from "node:test";

import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";

import type { Component, TUI } from "../apps/spark-tui/src/tui/pi-tui-adapter.ts";

import { SparkKeybindings } from "../apps/spark-tui/src/host/keybindings.ts";
import { SparkHostRuntime } from "../apps/spark-tui/src/host/runtime.ts";
import type { SparkHostMessageRenderer } from "../apps/spark-tui/src/host/types.ts";
import { createSparkDaemonNativeCommands } from "../apps/spark-tui/src/cli/daemon.ts";
import {
  createSparkNativeUiTransport,
  SparkNativeSession,
  SparkNativeTuiApp,
} from "../apps/spark-tui/src/native-tui.ts";

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

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

void test("SparkNativeSession responder context streams assistant chunks without duplicate final text", async () => {
  const session = new SparkNativeSession(async (_input, context) => {
    context.appendAssistantChunk?.("hello");
    context.appendAssistantChunk?.(" world");
    return "final duplicate should be ignored";
  });

  await session.submit("go");
  await waitUntil(() => !session.isProcessing);

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

  let rendered = stripAnsi(app.render(80).join("\n"));
  assert.match(rendered, /✓ tool:impl_status \[success\] — long tool output • folded/);
  assert.match(rendered, /thinking • hidden/);
  assert.doesNotMatch(rendered, /hidden reasoning trace/);

  assert.equal(app.toggleTools(), true);
  assert.equal(app.toggleThinking(), true);
  rendered = stripAnsi(app.render(80).join("\n"));
  assert.match(rendered, /┌─ ✓ tool:impl_status \[success\]/);
  assert.match(rendered, /│ long tool output/);
  assert.match(rendered, /└─ Ctrl\+O collapse/);
  assert.match(rendered, /thinking> hidden reasoning trace/);
});

void test("SparkNativeSession merges pending and completed tool previews by toolCallId", () => {
  const session = new SparkNativeSession();
  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "tool-call:read-1",
    role: "tool",
    text: "calling read",
    status: "pending",
    toolCallId: "read-1",
    toolName: "read",
    createdAt: "2026-07-07T00:00:01.000Z",
    metadata: {},
  });
  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "tool-result:read-1",
    role: "tool",
    text: "read ok",
    status: "done",
    toolCallId: "read-1",
    toolName: "read",
    createdAt: "2026-07-07T00:00:02.000Z",
    metadata: {},
  });

  const toolMessages = session.messages.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.text, "read ok");
  assert.equal(toolMessages[0]?.viewId, "tool-result:read-1");
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

void test("SparkNativeTuiApp records protocol cockpit state and renders Spark panels", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  app.applyViewModelEvent({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.snapshot",
    session: {
      version: SPARK_PROTOCOL_VERSION,
      sessionId: "native-cockpit-session",
      status: "idle",
      messages: [],
      tools: [],
      runs: [
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "role-run-reviewer",
          kind: "role",
          title: "reviewer audit",
          status: "running",
          progress: 0.5,
          artifactRefs: ["artifact:review-verdict"],
          metadata: { reviewer: "reviewer", outcome: "pending" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "workflow-run-release",
          kind: "workflow",
          title: "release readiness workflow",
          status: "queued",
          artifactRefs: [],
          metadata: { selector: "builtin:release-readiness" },
        },
      ],
      tasks: [
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "task:cockpit",
          title: "Build cockpit",
          status: "running",
          todos: [
            { id: "todo-1", content: "wire task board", status: "done", notes: [] },
            { id: "todo-2", content: "wire evidence panel", status: "in_progress", notes: [] },
          ],
          runRefs: ["role-run-reviewer"],
          artifactRefs: ["artifact:evidence"],
          metadata: {},
        },
      ],
      artifacts: [
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "artifact:review-verdict",
          title: "Reviewer verdict",
          kind: "record",
          format: "json",
          status: "approved",
          producer: "review",
          preview: "approved with evidence",
          metadata: { outcome: "approved" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "artifact:graft-patch",
          title: "Graft patch status",
          kind: "record",
          format: "json",
          status: "candidate",
          producer: "task",
          preview: "patch:abc123",
          metadata: {
            patchRef: "patch:abc123",
            candidateRef: "candidate:def456",
            base: "HEAD",
            graftStatus: "validated",
          },
        },
      ],
      metadata: {},
    },
  });

  await app.handleInteractionRequest({
    version: SPARK_PROTOCOL_VERSION,
    kind: "workflowPicker",
    requestId: "workflow-picker-1",
    title: "Pick a workflow",
    prompt: "Choose a saved workflow",
    options: [
      {
        selector: "builtin:release-readiness",
        label: "Release readiness",
        description: "Run release preflight",
        metadata: {},
      },
    ],
    metadata: {},
  });

  assert.deepEqual(app.cockpitSnapshot(), {
    activePanel: undefined,
    sessionId: "native-cockpit-session",
    sessionStatus: "idle",
    workflows: 1,
    workflowRuns: 1,
    roleRuns: 1,
    tasks: 1,
    artifacts: 2,
    reviews: 2,
    graftItems: 1,
    interactions: 1,
  });

  assert.equal(await app.submitInput("/cockpit"), "command");
  assert.equal(app.cockpitSnapshot().activePanel, "overview");
  let rendered = app.render(120).join("\n");
  assert.match(rendered, /Spark cockpit: overview/);
  assert.match(rendered, /Workflow picker\/progress: 1 option\(s\), 1 workflow run\(s\)/);
  assert.match(rendered, /Role-run board: 1 role run\(s\), 1 interaction\(s\)/);
  assert.match(rendered, /Graft provenance\/patch status: 1 item\(s\)/);

  assert.equal(await app.submitInput("/workflows"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Spark cockpit: workflows/);
  assert.match(rendered, /picker workflow-picker-1: Pick a workflow/);
  assert.match(rendered, /builtin:release-readiness: Release readiness/);

  assert.equal(await app.submitInput("/runs"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Spark cockpit: role\/run board/);
  assert.match(rendered, /role role-run-reviewer \[running\] 50% artifacts=1 reviewer audit/);

  assert.equal(await app.submitInput("/tasks"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Spark cockpit: task\/project board/);
  assert.match(rendered, /task:cockpit \[running\] todos=1\/2 evidence=1 Build cockpit/);

  assert.equal(await app.submitInput("/artifacts"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Spark cockpit: artifacts\/evidence/);
  assert.match(
    rendered,
    /artifact:review-verdict \[record\/json\] producer=review status=approved Reviewer verdict/,
  );

  assert.equal(await app.submitInput("/reviews"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Spark cockpit: reviewer verdicts/);
  assert.match(rendered, /artifact:review-verdict \[approved\] Reviewer verdict/);

  assert.equal(await app.submitInput("/graft"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Spark cockpit: Graft provenance\/patch status/);
  assert.match(
    rendered,
    /patch=patch:abc123 candidate=candidate:def456 base=HEAD status=validated/,
  );
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

void test("SparkNativeTuiApp renders component widget factories natively", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  app.setWidget(
    "spark-status",
    (
      tui: { terminal: { columns: number } },
      theme: { fg(color: string, text: string): string },
    ) => ({
      render: () => [theme.fg("accent", `◆ Spark status width=${tui.terminal.columns}`)],
      invalidate: () => undefined,
    }),
    { placement: "aboveEditor" },
  );

  const rendered = app.render(100).join("\n");
  assert.match(rendered, /◆ Spark status width=100/);
  assert.doesNotMatch(rendered, /component factory is not supported/);
});

void test("SparkNativeTuiApp provides strikethrough fallback to component widgets", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  app.setWidget(
    "spark-status",
    (_tui: { terminal: { columns: number } }, theme: { strikethrough(text: string): string }) => ({
      render: () => [`done=${theme.strikethrough("task")}`],
    }),
    { placement: "aboveEditor" },
  );

  const rendered = app.render(100).join("\n");
  assert.match(rendered, /done=.*task/);
  assert.doesNotMatch(rendered, /widget render failed/);
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

void test("SparkNativeTuiApp installs Ctrl+O/Ctrl+T and cockpit keybindings", async () => {
  const session = new SparkNativeSession();
  const keybindings = new SparkKeybindings();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, { keybindings });

  assert.equal(app.areToolsExpanded(), false);
  assert.equal(app.isThinkingExpanded(), false);
  assert.equal(app.cockpitSnapshot().activePanel, undefined);
  assert.equal(await keybindings.executeKey("ctrl+o", {}), true);
  assert.equal(await keybindings.executeKey("ctrl+t", {}), true);
  assert.equal(await keybindings.executeKey("ctrl+k", {}), true);
  assert.equal(app.areToolsExpanded(), true);
  assert.equal(app.isThinkingExpanded(), true);
  assert.equal(app.cockpitSnapshot().activePanel, "overview");
  assert.equal(await keybindings.executeKey("shift+ctrl+k", {}), true);
  assert.equal(app.cockpitSnapshot().activePanel, "workflows");
});

void test("SparkNativeTuiApp handles local slash commands without submitting to responder", async () => {
  let responderCalls = 0;
  const session = new SparkNativeSession(() => {
    responderCalls += 1;
    return "unexpected";
  });
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    slashCommands: {
      status: {
        description: "show daemon status",
        handler: () => "daemon: running",
      },
    },
  });

  assert.equal(await app.submitInput("/help"), "command");
  assert.equal(await app.submitInput("/status"), "command");

  const rendered = app.render(100).join("\n");
  assert.equal(responderCalls, 0);
  assert.match(rendered, /Everyday:/);
  assert.match(rendered, /- \/plan — plan durable project work/);
  assert.match(rendered, /Advanced:/);
  assert.match(rendered, /- \/goal — run reviewer-gated autonomous goal work/);
  assert.match(rendered, /Other registered:/);
  assert.match(rendered, /\/status — show daemon status/);
  assert.match(
    rendered,
    /\/cockpit \[overview\|workflows\|runs\|tasks\|artifacts\|reviews\|graft\|off\]/,
  );
  assert.match(rendered, /Ctrl\+K — toggle Spark cockpit overview/);
  assert.match(rendered, /daemon: running/);
});

void test("SparkNativeTuiApp /clear keeps the welcome banner and removes old transcript", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  session.addToolMessage({ toolName: "read", text: "old output" });
  assert.match(app.render(100).join("\n"), /tool:read/);

  assert.equal(await app.submitInput("/clear"), "command");
  const rendered = app.render(100).join("\n");
  assert.doesNotMatch(rendered, /tool:read/);
  assert.doesNotMatch(rendered, /old output/);
  assert.match(rendered, /Transcript cleared/);
  assert.match(rendered, /Spark native TUI is running/);
});

void test("SparkNativeTuiApp /stop aborts the active turn and discards late responses", async () => {
  let resolveResponse: ((value: string) => void) | undefined;
  let sawAbort = false;
  const session = new SparkNativeSession((_input, context) => {
    context.signal?.addEventListener("abort", () => {
      sawAbort = true;
    });
    return new Promise<string>((resolve) => {
      resolveResponse = resolve;
    });
  });
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  assert.equal(await app.submitInput("long turn"), "started");
  assert.equal(session.isProcessing, true);
  assert.equal(await app.submitInput("queued follow-up"), "queued");
  assert.equal(session.queuedCount, 1);

  assert.equal(await app.submitInput("/stop dogfood test"), "command");
  assert.equal(session.isProcessing, false);
  assert.equal(session.queuedCount, 0);
  assert.equal(sawAbort, true);

  resolveResponse?.("late assistant response");
  await new Promise((resolve) => setImmediate(resolve));

  const rendered = app.render(100).join("\n");
  assert.match(rendered, /Stopped current Spark turn \(dogfood test\)/);
  assert.doesNotMatch(rendered, /late assistant response/);
});

void test("SparkNativeSession maps transcript to and from Spark session view models", () => {
  const session = new SparkNativeSession();
  session.addToolMessage({ toolName: "read", text: "ok", status: "success" });
  session.appendAssistantChunk("streaming");

  const view = session.toSessionView("session-view");
  assert.equal(view.version, SPARK_PROTOCOL_VERSION);
  assert.equal(view.sessionId, "session-view");
  assert.equal(view.messages.at(-1)?.status, "streaming");
  assert.equal(
    view.messages.some((message) => message.role === "tool" && message.toolName === "read"),
    true,
  );

  const restored = new SparkNativeSession();
  restored.applySessionView({
    version: SPARK_PROTOCOL_VERSION,
    sessionId: "restored",
    status: "idle",
    messages: [
      {
        version: SPARK_PROTOCOL_VERSION,
        id: "m1",
        role: "assistant",
        text: "from view",
        status: "done",
        metadata: {},
      },
    ],
    tools: [],
    runs: [],
    tasks: [],
    artifacts: [],
    metadata: {},
  });

  assert.equal(restored.messages.length, 1);
  assert.equal(restored.messages[0]?.role, "assistant");
  assert.equal(restored.messages[0]?.text, "from view");
});

void test("SparkNativeSession orders view messages chronologically", () => {
  const session = new SparkNativeSession();
  session.applySessionView({
    version: SPARK_PROTOCOL_VERSION,
    sessionId: "ordered",
    status: "idle",
    messages: [
      {
        version: SPARK_PROTOCOL_VERSION,
        id: "later",
        role: "assistant",
        text: "second",
        status: "done",
        createdAt: "2026-07-07T00:00:02.000Z",
        metadata: {},
      },
      {
        version: SPARK_PROTOCOL_VERSION,
        id: "earlier",
        role: "tool",
        text: "first",
        status: "done",
        createdAt: "2026-07-07T00:00:01.000Z",
        metadata: {},
      },
    ],
    tools: [],
    runs: [],
    tasks: [],
    artifacts: [],
    metadata: {},
  });

  assert.deepEqual(
    session.messages.map((message) => message.text),
    ["first", "second"],
  );

  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "later",
    role: "assistant",
    text: "second updated",
    status: "done",
    createdAt: "2026-07-07T00:00:02.000Z",
    metadata: {},
  });

  assert.deepEqual(
    session.messages.map((message) => message.text),
    ["first", "second updated"],
  );
});

void test("SparkHostRuntime and native UI transport round-trip interaction protocol", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    interactionHandler: (request) => {
      if (request.kind === "askFlow") {
        return {
          version: SPARK_PROTOCOL_VERSION,
          kind: "askFlow",
          requestId: request.requestId,
          status: "answered",
          answers: { plan: { values: ["a"] } },
          nextAction: "resume",
          metadata: {},
        };
      }
      if (request.kind === "modelSelect") {
        return {
          version: SPARK_PROTOCOL_VERSION,
          kind: "modelSelect",
          requestId: request.requestId,
          status: "answered",
          selection: { providerName: "baidu-oneapi", modelId: "claude-opus-4.8" },
          metadata: {},
        };
      }
      return {
        version: SPARK_PROTOCOL_VERSION,
        kind: request.kind,
        requestId: request.requestId,
        status: "answered",
        approved: true,
        metadata: {},
      };
    },
  });
  const runtime = new SparkHostRuntime({ cwd: "/tmp/spark-interaction", hasUI: true });
  runtime.setUiTransport(createSparkNativeUiTransport(app, session));

  const ask = await runtime.requestInteraction({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "req-ask",
    kind: "askFlow",
    title: "Choose plan",
    mode: "decision",
    questions: [
      {
        id: "plan",
        prompt: "Which plan?",
        type: "single",
        required: true,
        defaultValues: [],
        options: [{ value: "a", label: "Plan A" }],
      },
    ],
    metadata: {},
  });
  const model = await runtime.requestInteraction({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "req-model",
    kind: "modelSelect",
    title: "Select model",
    options: [
      {
        value: "baidu-oneapi/claude-opus-4.8",
        providerName: "baidu-oneapi",
        modelId: "claude-opus-4.8",
        active: true,
        metadata: {},
      },
    ],
    metadata: {},
  });
  const approval = await runtime.requestInteraction({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "req-tool",
    kind: "toolApproval",
    title: "Run edit?",
    toolName: "edit",
    approveLabel: "Approve",
    rejectLabel: "Reject",
    metadata: {},
  });

  assert.equal(ask.kind, "askFlow");
  assert.equal(ask.status, "answered");
  assert.equal(model.kind, "modelSelect");
  assert.equal(model.status, "answered");
  assert.equal(approval.kind, "toolApproval");
  assert.equal(approval.status, "answered");
  assert.equal("approved" in approval ? approval.approved : false, true);
});

void test("native UI transport consumes view model events without concrete TUI protocol types", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  const ui = createSparkNativeUiTransport(app, session);

  ui.publishView?.({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.message",
    sessionId: "native-session",
    message: {
      version: SPARK_PROTOCOL_VERSION,
      id: "message-1",
      role: "assistant",
      text: "hello from event",
      status: "done",
      metadata: {},
    },
  });
  ui.publishView?.({
    version: SPARK_PROTOCOL_VERSION,
    type: "run.update",
    run: {
      version: SPARK_PROTOCOL_VERSION,
      id: "run:1",
      kind: "daemon",
      status: "running",
      summary: "cache read=64 write=16",
      artifactRefs: [],
      metadata: { costUsd: 0.42, totalTokens: 4100, contextWindow: 10000 },
    },
  });

  const rendered = stripAnsi(app.render(100).join("\n"));
  assert.match(rendered, /spark> hello from event/);
  assert.doesNotMatch(rendered, /custom:run-view>/);
  assert.match(rendered, /native pi-tui host .*daemon running: cache read=64 write=16/);
  assert.match(rendered, /native pi-tui host .*cache read=64 write=16/);
  assert.match(rendered, /Enter submit .* cache 80% · \$0\.42 · ctx 41%/);
});

void test("native UI transport prints task completion evidence summaries", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  const ui = createSparkNativeUiTransport(app, session);

  ui.publishView?.({
    version: SPARK_PROTOCOL_VERSION,
    type: "artifact.update",
    artifact: {
      version: SPARK_PROTOCOL_VERSION,
      ref: "artifact:review",
      title: "Review verdict",
      kind: "record",
      format: "json",
      status: "passed",
      producer: "review",
      metadata: { outcome: "passed" },
    },
  });
  ui.publishView?.({
    version: SPARK_PROTOCOL_VERSION,
    type: "task.update",
    task: {
      version: SPARK_PROTOCOL_VERSION,
      ref: "task:visible",
      title: "Visible evidence task",
      status: "done",
      todos: [],
      runRefs: [],
      artifactRefs: ["artifact:review", "artifact:trace"],
      metadata: {},
    },
  });

  const rendered = stripAnsi(app.render(120).join("\n"));
  assert.match(
    rendered,
    /✔ task done · 2 artifacts · review passed · cockpit:\/\/tasks\/task%3Avisible/,
  );
});

void test("native UI transport returns blocked protocol responses without handler", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  const ui = createSparkNativeUiTransport(app, session);

  const response = await ui.interaction?.({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "req-tool",
    kind: "toolApproval",
    title: "Run edit?",
    toolName: "edit",
    approveLabel: "Approve",
    rejectLabel: "Reject",
    metadata: {},
  });

  assert.equal(response?.status, "blocked");
  assert.equal(response?.kind, "toolApproval");
  assert.equal(response && "approved" in response ? response.approved : undefined, false);
  assert.match(
    stripAnsi(app.render(100).join("\n")),
    /custom:interaction-request> toolApproval: Run edit\?/,
  );
});

void test("SparkNativeTuiApp /retry resubmits the previous user prompt", async () => {
  const prompts: string[] = [];
  const session = new SparkNativeSession((input) => {
    prompts.push(input);
    return `ack:${input}`;
  });
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  assert.equal(await app.submitInput("first prompt"), "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await app.submitInput("/retry"), "command");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(prompts, ["first prompt", "first prompt"]);
  assert.match(app.render(100).join("\n"), /Retrying: first prompt/);
});

void test("Spark daemon native slash commands render status, start, and queue summaries", async () => {
  let started = false;
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    slashCommands: createSparkDaemonNativeCommands({
      startService: () => {
        started = true;
      },
      daemonStatus: async () => ({
        observedAt: "2026-06-22T00:00:00.000Z",
        servers: [{ url: "ws://local", workspaceCount: 2, wsConnected: true }],
        queue: { inbox: 1, processed: 2, failed: 3 },
      }),
      daemonQueue: async (_paths, params) => ({
        state: params.state ?? "inbox",
        entries: [
          {
            fileName: "task.json",
            filePath: "/tmp/task.json",
            payload: {
              enqueuedAt: "2026-06-22T00:00:00.000Z",
              task: { type: "session.run", sessionId: "session-1", prompt: "hello" },
              processedAt: "2026-06-22T00:00:01.000Z",
              result: { text: "done" },
            },
          },
        ],
        observedAt: "2026-06-22T00:00:00.000Z",
      }),
    }),
  });

  assert.equal(await app.submitInput("/start"), "command");
  assert.equal(await app.submitInput("/status"), "command");
  assert.equal(await app.submitInput("/queue failed"), "command");

  const rendered = app.render(100).join("\n");
  assert.equal(started, true);
  assert.match(rendered, /daemon: running/);
  assert.match(rendered, /queue: inbox=1 processed=2 failed=3/);
  assert.match(rendered, /server: ws:\/\/local workspaces=2 ws=connected/);
  assert.match(rendered, /queue:failed entries=1/);
  assert.match(rendered, /task\.json • session-1 • hello • result=\{"text":"done"\}/);
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}
