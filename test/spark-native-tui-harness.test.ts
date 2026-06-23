import assert from "node:assert/strict";
import test from "node:test";

import { SPARK_PROTOCOL_VERSION } from "../packages/spark-protocol/src/index.ts";
import {
  SparkHostRuntime,
  SparkModelSelector,
  SparkProviderRegistry,
  type ProviderConfig,
  type ProviderModelDefinition,
} from "../apps/spark-tui/src/host/index.ts";
import { createSparkNativeRuntimeSlashCommands } from "../apps/spark-tui/src/native-tui.ts";
import { createSparkNativeTuiHarness } from "./support/spark-native-tui-harness.ts";

void test("Spark native TUI harness submits input and drives exit keys without a real terminal", async () => {
  const harness = createSparkNativeTuiHarness({
    responder: (input) => `ack:${input}`,
  });

  assert.equal(await harness.submit("hello Spark"), "started");
  await harness.flush();

  assert.equal(
    harness.session.messages.some((message) => message.role === "user"),
    true,
  );
  assert.equal(
    harness.session.messages.some(
      (message) => message.role === "assistant" && message.text === "ack:hello Spark",
    ),
    true,
  );
  assert.match(harness.render(), /spark> ack:hello Spark/);

  await harness.press("\x03");
  assert.equal(harness.state.exited, true);
  assert.equal(harness.state.renderRequests.length > 0, true);
});

void test("Spark native TUI editor path submits slash commands from real keystrokes", async () => {
  const invoked: Array<{ name: string; args: string }> = [];
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-native-slash-test", hasUI: true });
  host.registerCommand("plan", {
    description: "Enter Spark plan mode for the current project",
    handler: (args, ctx) => {
      invoked.push({ name: "plan", args });
      ctx.ui?.notify?.(`planned:${args}`, "info");
    },
  });
  host.registerCommand("goal", {
    description: "Set or inspect the current Spark goal",
    handler: (_args, ctx) => ctx.ui?.notify?.("goal routed", "success"),
  });

  const harness = createSparkNativeTuiHarness({
    slashCommands: createSparkNativeRuntimeSlashCommands(host),
  });
  host.setUiTransport({
    notify: (message, level) => harness.session.addSystemMessage(`${level}:${message}`),
  });

  await typeEditorText(harness, "/");
  await harness.flush();
  assert.equal(harness.app.isShowingAutocomplete(), true);
  assert.match(harness.render(), /plan\s+Enter Spark plan mode for the current project/);
  assert.match(harness.render(), /goal\s+Set or inspect the current Spark goal/);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/help");
  assert.match(harness.render(), /\/plan — Enter Spark plan mode for the current project/);
  assert.match(harness.render(), /\/goal — Set or inspect the current Spark goal/);

  await submitEditorText(harness, "/plan close slash gap");
  assert.deepEqual(invoked, [{ name: "plan", args: "close slash gap" }]);
  assert.match(harness.render(), /system> info:planned:close slash gap/);
});

void test("Spark native TUI routes /model through native slash command and model selector overlay", async () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider(
    "fake",
    fakeProvider("fake", [fakeModel("model-a"), fakeModel("model-b")]),
  );
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const selector = new SparkModelSelector({
    registry,
    config: { extensions: [], providers: [] },
    saveConfig: () => undefined,
    picker: async (state) => {
      assert.equal(state.active?.modelId, "model-a");
      return { providerName: "fake", modelId: "model-b" };
    },
  });
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-native-model-command", hasUI: true });
  host.registerCommand("model", {
    description: "Switch or inspect the active Spark model",
    argumentHint: "[provider/model|model-id]",
    getArgumentCompletions: (prefix) =>
      selector
        .getPickerState()
        .items.map((item) => ({
          value: `${item.providerName}/${item.modelId}`,
          label: `${item.providerName}/${item.modelId}${item.active ? " (active)" : ""}`,
          description: item.description,
        }))
        .filter((item) => item.value.includes(prefix)),
    async handler(args, ctx) {
      const requested = args.trim();
      const selection = requested
        ? await selector.select(
            requested.includes("/")
              ? {
                  providerName: requested.slice(0, requested.indexOf("/")),
                  modelId: requested.slice(requested.indexOf("/") + 1),
                }
              : { providerName: "fake", modelId: requested },
          )
        : await selector.openPicker(ctx as Parameters<typeof selector.openPicker>[0]);
      ctx.ui?.notify?.(`Model: ${selection?.providerName}/${selection?.modelId}`, "info");
    },
  });
  const harness = createSparkNativeTuiHarness({
    slashCommands: createSparkNativeRuntimeSlashCommands(host),
  });
  host.setUiTransport({
    notify: (message, level) => harness.session.addSystemMessage(`${level}:${message}`),
    custom: <T>() => ({ providerName: "fake", modelId: "model-b" }) as T,
  });

  await typeEditorText(harness, "/model ");
  await harness.flush();
  assert.equal(harness.app.isShowingAutocomplete(), true);
  assert.match(harness.render(), /fake\/model-a/);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/model");
  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-b" });
  assert.match(harness.render(), /system> info:Model: fake\/model-b/);

  await submitEditorText(harness, "/model fake/model-a");
  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-a" });
  assert.doesNotMatch(harness.render(), /Unknown command: \/model/);
});

void test("Spark native runtime slash bridge preserves editor helpers and deterministic command errors", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-native-slash-bridge", hasUI: true });
  const sent: string[] = [];
  host.registerCommand("implement", {
    description: "Enter Spark implement mode",
    async handler(args, ctx) {
      await ctx.sendUserMessage?.(`implement:${args}`);
    },
  });
  host.registerCommand("prompt", {
    description: "Prefill editor prompt",
    handler: (_args, ctx) =>
      (ctx.ui as { setEditorText?: (text: string) => void } | undefined)?.setEditorText?.("/plan "),
  });
  host.registerCommand("explode", {
    description: "Raise a command failure",
    handler: () => {
      throw new Error("boom");
    },
  });

  const harness = createSparkNativeTuiHarness({
    slashCommands: createSparkNativeRuntimeSlashCommands(host, {
      sendUserMessage: (content) => void sent.push(content),
    }),
  });
  host.setUiTransport({
    setEditorText: (text) => harness.app.setEditorText(text),
  });

  await submitEditorText(harness, "/implement task frontier");
  assert.deepEqual(sent, ["implement:task frontier"]);

  await submitEditorText(harness, "/prompt");
  assert.match(harness.render(), /\/plan /);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/explode");
  assert.match(harness.render(), /Command \/explode failed: boom/);
});

void test("Spark native TUI surfaces command availability, queued work, stop, and turn errors", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  const harness = createSparkNativeTuiHarness({
    slashCommands: {
      plan: { description: "Enter Spark plan mode", handler: () => "plan routed" },
      status: { description: "Show daemon status", handler: () => "daemon ok" },
    },
    responder: (input) => {
      if (input === "first") {
        return new Promise<string>((resolve) => {
          releaseFirst = resolve;
        });
      }
      if (input === "fail") throw new Error("daemon unavailable");
      return `ack:${input}`;
    },
  });

  assert.match(harness.render(), /native pi-tui host • idle • 2 registered commands/);
  assert.equal(await harness.submit("/help"), "command");
  assert.match(harness.render(), /2 registered host\/daemon commands available/);

  assert.equal(await harness.submit("first"), "started");
  await harness.flush();
  assert.equal(await harness.submit("second"), "queued");
  await harness.flush();
  assert.match(harness.render(), /native pi-tui host • busy • 1 follow-up queued/);
  assert.match(harness.render(), /Queued follow-up #1\. Use \/stop to clear queued work/);

  assert.equal(await harness.submit("/stop dogfood"), "command");
  assert.match(
    harness.render(),
    /Stopped current Spark turn \(dogfood\)\. Cleared 1 queued follow-up/,
  );
  releaseFirst?.("late response ignored");
  await harness.flush();
  assert.doesNotMatch(harness.render(), /late response ignored/);

  assert.equal(await harness.submit("fail"), "started");
  await harness.flush();
  assert.match(
    harness.render(),
    /system> Spark turn failed: daemon unavailable\. Use \/retry to resubmit or \/status to inspect the\s+daemon\./,
  );
});

void test("Spark native TUI harness captures resize-safe golden render sections", () => {
  const harness = createSparkNativeTuiHarness({ cols: 34 });
  harness.session.appendAssistantChunk(
    "streaming response with enough content to wrap across narrow widths",
  );
  harness.session.addToolMessage({
    toolName: "read",
    toolCallId: "tc-1",
    status: "success",
    text: "first line\nsecond line with wider details",
  });
  harness.session.addThinking("hidden chain of implementation notes");

  const narrowLines = harness.renderLines(34);
  assert.equal(
    narrowLines.every((line) => visibleWidth(line) <= 34),
    true,
    "narrow render should respect the requested width",
  );
  assert.match(narrowLines.join("\n"), /spark> streaming response/);
  assert.match(narrowLines.join("\n"), /tool:read \[success\] • folded/);
  assert.match(narrowLines.join("\n"), /thinking • hidden/);

  harness.app.toggleTools();
  harness.app.toggleThinking();
  const wideLines = harness.renderLines(88);
  const wideText = wideLines.join("\n");
  assert.equal(
    wideLines.every((line) => visibleWidth(line) <= 88),
    true,
    "wide render should respect the requested width",
  );
  assert.match(wideText, /tool:read \[success\] \(tc-1\)> first line/);
  assert.match(wideText, /second line with wider details/);
  assert.match(wideText, /thinking> hidden chain of implementation notes/);
});

void test("Spark cockpit renders shared workflow, run, task, artifact, review, and Graft view models", async () => {
  const harness = createSparkNativeTuiHarness({ cols: 120 });

  harness.app.applyViewModelEvent({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.snapshot",
    session: {
      version: SPARK_PROTOCOL_VERSION,
      sessionId: "session:dogfood",
      title: "Dogfood cockpit session",
      status: "streaming",
      messages: [],
      tools: [],
      runs: [
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "run:release-readiness",
          kind: "workflow",
          title: "Release readiness workflow",
          status: "running",
          progress: 0.5,
          artifactRefs: [],
          metadata: { selector: "builtin:review" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "role:reviewer",
          kind: "role",
          title: "Reviewer pass",
          status: "running",
          progress: 0.4,
          artifactRefs: ["artifact:review-ok"],
          metadata: { reviewer: "goal", outcome: "approved" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "task:graft-apply",
          kind: "task",
          title: "Apply Graft patch",
          status: "succeeded",
          artifactRefs: ["artifact:graft-patch"],
          metadata: { patchRef: "patch:abc", graftStatus: "admitted" },
        },
      ],
      tasks: [
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "task:spark-cockpit-superpowers",
          name: "spark-cockpit-superpowers",
          title: "Spark cockpit superpowers",
          kind: "implement",
          status: "running",
          projectRef: "proj:demo",
          todos: [
            { id: "map", content: "Map data surfaces", status: "done", notes: [] },
            { id: "render", content: "Render cockpit panels", status: "in_progress", notes: [] },
          ],
          runRefs: ["run:release-readiness"],
          artifactRefs: ["artifact:review-ok"],
          metadata: {},
        },
      ],
      artifacts: [
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "artifact:review-ok",
          title: "Reviewer verdict for cockpit task",
          kind: "record",
          format: "json",
          status: "approved",
          producer: "review",
          preview: "reviewer approved task finish evidence",
          metadata: { outcome: "approved", reviewer: "spark-reviewer" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "artifact:graft-patch",
          title: "Graft patch provenance",
          kind: "record",
          format: "json",
          status: "admitted",
          producer: "task",
          preview: "candidate:abc patch:abc",
          metadata: {
            candidateRef: "candidate:abc",
            patchRef: "patch:abc",
            graftStatus: "admitted",
          },
        },
      ],
      metadata: {},
    },
  });

  assert.deepEqual(harness.app.cockpitSnapshot(), {
    activePanel: undefined,
    sessionId: "session:dogfood",
    sessionStatus: "streaming",
    workflows: 1,
    workflowRuns: 1,
    roleRuns: 1,
    tasks: 1,
    artifacts: 2,
    reviews: 2,
    graftItems: 2,
    interactions: 0,
  });

  assert.equal(harness.app.toggleCockpitPanel("overview"), true);
  assert.match(harness.render(), /Workflow picker\/progress: 1 option\(s\), 1 workflow run\(s\)/);
  assert.match(harness.render(), /Role-run board: 1 role run\(s\), 0 interaction\(s\)/);

  assert.equal(await harness.submit("/runs"), "command");
  assert.equal(harness.app.cockpitSnapshot().activePanel, "runs");
  assert.match(harness.render(), /role role:reviewer \[running\] 40% artifacts=1 Reviewer pass/);
  assert.match(
    harness.render(),
    /workflow run:release-readiness \[running\] 50% Release readiness workflow/,
  );
  assert.match(harness.render(), /Actions: \/workflow-inspect run:release-readiness/);
  assert.match(harness.render(), /\/workflow-pause run:release-readiness/);
  assert.match(harness.render(), /\/workflow-stop run:release-readiness/);
  assert.match(harness.render(), /\/workflow-save run:release-readiness/);

  assert.equal(await harness.submit("/tasks"), "command");
  assert.match(
    harness.render(),
    /task:spark-cockpit-superpowers \[running\] todos=1\/2 evidence=1 Spark cockpit superpowers/,
  );

  assert.equal(await harness.submit("/artifacts"), "command");
  assert.match(
    harness.render(),
    /artifact:review-ok \[record\/json\] producer=review status=approved Reviewer verdict/,
  );
  assert.match(
    harness.render(),
    /artifact:graft-patch \[record\/json\] producer=task status=admitted Graft patch provenance/,
  );

  assert.equal(await harness.submit("/reviews"), "command");
  assert.match(
    harness.render(),
    /artifact:review-ok \[approved\] Reviewer verdict for cockpit task/,
  );
  assert.match(harness.render(), /role:role:reviewer \[approved\] Reviewer pass/);

  assert.equal(await harness.submit("/graft"), "command");
  assert.match(
    harness.render(),
    /artifact:graft-patch patch=patch:abc candidate=candidate:abc status=admitted/,
  );
  assert.match(harness.render(), /task:task:graft-apply patch=patch:abc status=admitted/);
});

void test("Spark cockpit supports selectable workflow run keyboard controls", async () => {
  const invoked: Array<{ name: string; args: string }> = [];
  const slashCommands = Object.fromEntries(
    ["inspect", "pause", "resume", "stop", "restart", "save", "ack"].map((action) => [
      `workflow-${action}`,
      {
        description: `Workflow ${action}`,
        handler: (args: string) => {
          invoked.push({ name: `workflow-${action}`, args });
          return `handled:${action}:${args}`;
        },
      },
    ]),
  );
  const harness = createSparkNativeTuiHarness({ cols: 140, slashCommands });
  harness.app.applyViewModelEvent({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.snapshot",
    session: {
      version: SPARK_PROTOCOL_VERSION,
      sessionId: "session:workflow-controls",
      status: "idle",
      messages: [],
      tools: [],
      runs: [
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "run:first",
          kind: "workflow",
          title: "First workflow",
          status: "running",
          progress: 0.25,
          artifactRefs: [],
          metadata: { dynamicStatus: "running" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "run:second",
          kind: "workflow",
          title: "Second workflow",
          status: "running",
          progress: 0.75,
          artifactRefs: [],
          metadata: { dynamicStatus: "paused" },
        },
      ],
      tasks: [],
      artifacts: [],
      metadata: {},
    },
  });

  assert.equal(await harness.submit("/runs"), "command");
  assert.match(harness.render(), /▸─ workflow run:first \[running\] 25% First workflow/);
  assert.match(harness.render(), /Keys: ↑\/↓ or j\/k select workflow run/);

  await harness.press("j");
  assert.match(harness.render(), /Selected: run:second \[paused\]/);
  assert.match(harness.render(), /▸─ workflow run:second \[paused\] 75% Second workflow/);
  assert.match(harness.render(), /\/workflow-resume run:second/);

  await harness.press("i");
  assert.deepEqual(invoked.at(-1), { name: "workflow-inspect", args: "run:second" });
  await harness.press("u");
  assert.deepEqual(invoked.at(-1), { name: "workflow-resume", args: "run:second" });
  await harness.press("x");
  assert.deepEqual(invoked.at(-1), { name: "workflow-stop", args: "run:second" });

  await harness.press("k");
  assert.match(harness.render(), /Selected: run:first \[running\]/);
  await harness.press("p");
  assert.deepEqual(invoked.at(-1), { name: "workflow-pause", args: "run:first" });
  await harness.press("r");
  assert.deepEqual(invoked.at(-1), { name: "workflow-restart", args: "run:first" });
  await harness.press("s");
  assert.deepEqual(invoked.at(-1), { name: "workflow-save", args: "run:first" });
  await harness.press("a");
  assert.deepEqual(invoked.at(-1), { name: "workflow-ack", args: "run:first" });

  await harness.press("\x1B");
  assert.equal(harness.app.cockpitSnapshot().activePanel, undefined);
});

void test("Spark cockpit records workflow picker requests and exposes slash command navigation", async () => {
  const harness = createSparkNativeTuiHarness({ cols: 110 });

  const response = await harness.app.handleInteractionRequest({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "pick-workflow",
    kind: "workflowPicker",
    title: "Choose a Spark workflow",
    prompt: "Pick a workflow for the next foreground step.",
    source: "test",
    options: [
      {
        selector: "builtin:research",
        label: "Research",
        description: "Gather context before implementation.",
        phaseCount: 5,
        metadata: {},
      },
      {
        selector: "builtin:review",
        label: "Review",
        description: "Audit implementation evidence.",
        phaseCount: 4,
        metadata: {},
      },
    ],
    metadata: {},
  });

  assert.equal(response.status, "blocked");
  assert.equal(response.kind, "workflowPicker");
  assert.deepEqual(harness.app.cockpitSnapshot(), {
    activePanel: undefined,
    sessionId: undefined,
    sessionStatus: undefined,
    workflows: 2,
    workflowRuns: 0,
    roleRuns: 0,
    tasks: 0,
    artifacts: 0,
    reviews: 0,
    graftItems: 0,
    interactions: 1,
  });

  assert.equal(await harness.submit("/workflows"), "command");
  assert.equal(harness.app.cockpitSnapshot().activePanel, "workflows");
  const workflows = harness.render();
  assert.match(workflows, /picker pick-workflow: Choose a Spark workflow \(2 option\(s\)\)/);
  assert.match(
    workflows,
    /picker builtin:research: Research — Gather context before implementation\./,
  );
  assert.match(workflows, /picker builtin:review: Review — Audit implementation evidence\./);

  assert.equal(harness.app.cycleCockpitPanel(), "runs");
  assert.equal(harness.app.cockpitSnapshot().activePanel, "runs");

  assert.equal(await harness.submit("/cockpit off"), "command");
  assert.equal(harness.app.cockpitSnapshot().activePanel, undefined);

  assert.equal(await harness.submit("/help"), "command");
  assert.match(
    harness.render(),
    /\/cockpit \[overview\|workflows\|runs\|tasks\|artifacts\|reviews\|graft\|off\]/,
  );
  assert.match(
    harness.render(),
    /Ctrl\+K — toggle Spark cockpit overview; Shift\+Ctrl\+K — cycle cockpit panels/,
  );
});

async function typeEditorText(
  harness: ReturnType<typeof createSparkNativeTuiHarness>,
  text: string,
): Promise<void> {
  for (const char of text) await harness.press(char);
}

async function submitEditorText(
  harness: ReturnType<typeof createSparkNativeTuiHarness>,
  text: string,
): Promise<void> {
  harness.app.setEditorText(text);
  await harness.press("\r");
}

const fakeStream: ProviderConfig["streamSimple"] = () => ({}) as unknown;

function fakeModel(id: string): ProviderModelDefinition {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}

function fakeProvider(name: string, models: ProviderModelDefinition[]): ProviderConfig {
  return {
    name,
    baseUrl: `https://${name}.test`,
    api: "anthropic-messages",
    streamSimple: fakeStream,
    models,
  };
}

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "gu");

function visibleWidth(line: string): number {
  return line.replace(ANSI_ESCAPE_PATTERN, "").length;
}

void test("Spark native TUI harness exercises fallback modal stack lifecycle", async () => {
  const harness = createSparkNativeTuiHarness();
  const modal = {
    render: () => ["approval modal"],
    invalidate: () => undefined,
  };

  const result = harness.app.custom<string>(
    (_tui, _theme, _keybindings, done) => {
      queueMicrotask(() => done("approved"));
      return modal;
    },
    { overlay: false },
  );

  assert.deepEqual(harness.state.children, [modal]);
  assert.equal(harness.state.focused, modal);

  assert.equal(await result, "approved");
  assert.deepEqual(harness.state.children, []);
  assert.equal(harness.state.focused, harness.app);
  assert.equal(harness.state.renderRequests.length > 0, true);
});
