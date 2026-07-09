import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SPARK_PROTOCOL_VERSION } from "../packages/spark-protocol/src/index.ts";
import {
  SparkHostRuntime,
  SparkKeybindings,
  SparkModelSelector,
  SparkProviderRegistry,
  SparkSessionStore,
  type ProviderConfig,
  type ProviderModelDefinition,
} from "../apps/spark-tui/src/host/index.ts";
import {
  SPARK_NATIVE_KERNEL_SLASH_COMMANDS,
  createSparkNativeLocalControlSlashCommands,
  createSparkNativeRuntimeSlashCommands,
} from "../apps/spark-tui/src/native-tui.ts";
import { createSparkPiParitySlashCommands } from "../apps/spark-tui/src/cli/pi-parity-commands.ts";
import { SparkSessionMailStore } from "../apps/spark-tui/src/host/session-mail-store.ts";
import { createSparkNativeTuiHarness } from "./support/spark-native-tui-harness.ts";

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function markerIndexes(lines: string[], pattern: RegExp): number[] {
  return lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
}

function firstMarkerIndex(lines: string[], pattern: RegExp): number {
  const index = markerIndexes(lines, pattern).at(0);
  assert.notEqual(index, undefined, `missing marker ${pattern}`);
  return index!;
}

void test("native TUI kernel slash commands are minimal and resource slash is extension-owned", async () => {
  assert.deepEqual(
    [...SPARK_NATIVE_KERNEL_SLASH_COMMANDS],
    ["help", "exit", "quit", "clear", "reload"],
  );

  const local = createSparkNativeLocalControlSlashCommands();
  assert.equal(local.tasks?.metadata?.source, "extension");
  assert.equal(local.tasks?.metadata?.plane, "server");
  assert.equal(local.tasks?.metadata?.resource, "task");
  assert.equal(local.tasks?.metadata?.canonicalCliTarget, "spark server task list");
  assert.equal(local.task?.metadata?.canonicalCliTarget, "spark server task list");
  assert.equal(local.artifact?.metadata?.canonicalCliTarget, "spark server artifact list");
  assert.equal(local.review?.metadata?.canonicalCliTarget, "spark server review list");
  assert.equal(local.run?.metadata?.canonicalCliTarget, "spark daemon run list");
  assert.equal(local.stop?.metadata?.canonicalCliTarget, "spark daemon run cancel <run>");

  const host = new SparkHostRuntime({ cwd: process.cwd() });
  host.registerCommand("goal", {
    description: "Goal command",
    metadata: {
      source: "extension",
      extensionId: "spark-drive",
      plane: "server",
      resource: "goal",
      verbs: ["status"],
      canonicalCliTarget: "spark server goal status",
    },
    handler: () => undefined,
  });
  host.registerCommand("workflow", {
    description: "Workflow command",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "server",
      resource: "workflow",
      verbs: ["list"],
      canonicalCliTarget: "spark server workflow list",
    },
    handler: () => undefined,
  });
  host.registerCommand("workflow-pause", {
    description: "Workflow pause alias",
    argumentHint: "<runRef>",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "server",
      resource: "workflow",
      verbs: ["pause"],
      canonicalCliTarget: "spark server workflow pause <run>",
      deprecatedAliasFor: "spark server workflow pause <run>",
    },
    handler: () => undefined,
  });
  host.registerCommand("session", {
    description: "Session command",
    argumentHint: "[list]",
    metadata: {
      source: "extension",
      extensionId: "spark-pi-parity",
      plane: "daemon",
      resource: "session",
      verbs: ["show", "list"],
      canonicalCliTarget: "spark daemon session list",
    },
    handler: () => undefined,
  });
  const runtime = createSparkNativeRuntimeSlashCommands(host);
  assert.equal(runtime.goal?.metadata?.source, "extension");
  assert.equal(runtime.goal?.metadata?.extensionId, "spark-drive");
  assert.equal(runtime.goal?.metadata?.canonicalCliTarget, "spark server goal status");

  const slashFixture = {
    "/session list": runtime.session,
    "/task list": local.task,
    "/goal status": runtime.goal,
    "/workflow list": runtime.workflow,
    "/workflow-pause": runtime["workflow-pause"],
    "/review list": local.review,
    "/artifact list": local.artifact,
    "/run list": local.run,
  } as const;
  const expectedTargets = {
    "/session list": "spark daemon session list",
    "/task list": "spark server task list",
    "/goal status": "spark server goal status",
    "/workflow list": "spark server workflow list",
    "/workflow-pause": "spark server workflow pause <run>",
    "/review list": "spark server review list",
    "/artifact list": "spark server artifact list",
    "/run list": "spark daemon run list",
  } as const;
  for (const [input, command] of Object.entries(slashFixture)) {
    assert.equal(command?.metadata?.source, "extension", `${input} is extension-owned`);
    assert.equal(
      command?.metadata?.canonicalCliTarget,
      expectedTargets[input as keyof typeof expectedTargets],
      `${input} canonical target`,
    );
  }

  const harness = createSparkNativeTuiHarness({ slashCommands: { ...runtime, ...local } });
  assert.equal(await harness.submit("/help"), "command");
  const rendered = stripAnsi(harness.render());
  assert.match(rendered, /System\s+\/help/);
  assert.match(rendered, /\/reload — reload extension-owned slash command state/);
  assert.match(rendered, /Extensions\s+\d+ extension commands available/);
  assert.match(rendered, /\/goal — Goal command \[extension\] → spark server goal status/);
  assert.match(
    rendered,
    /\/session \[list\] — Session command \[extension\] → spark daemon session list/,
  );
  assert.match(
    rendered,
    /\/task — open the tasks cockpit panel \[extension\] → spark server task list/,
  );
  assert.match(
    rendered,
    /\/workflow-pause <runRef> — Workflow pause alias \[extension\] → spark server workflow pause\s+<run>/,
  );
  assert.doesNotMatch(rendered, /\/task — .*\[system\]/);
});

void test("Spark native TUI /mailto and /inbox use durable session mail store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-mail-"));
  const sparkHome = join(dir, "spark-home");
  try {
    const sessionStore = new SparkSessionStore({ cwd: join(dir, "workspace-b"), sparkHome });
    await sessionStore.save(
      sessionStore.createSession({ id: "session-b", timestamp: "2026-07-08T00:00:00.000Z" }),
    );
    const services = { cwd: join(dir, "workspace-b"), sessionStore } as never;
    const harness = createSparkNativeTuiHarness({
      slashCommands: createSparkPiParitySlashCommands(services),
    });
    const mailStore = new SparkSessionMailStore({ sparkHome });

    assert.equal(await harness.submit("/mailto session-b hello"), "command");
    let messages = await mailStore.list("session-b");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.body, "hello");
    assert.match(stripAnsi(harness.render()), /Sent mail:/);

    assert.equal(await harness.submit("/inbox"), "command");
    assert.match(stripAnsi(harness.render()), /hello/);
    const messageId = messages[0]!.id;

    assert.equal(await harness.submit(`/inbox ack ${messageId}`), "command");
    assert.match(stripAnsi(harness.render()), /Acknowledged mail:/);
    messages = await mailStore.list("session-b");
    assert.equal(messages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
  assert.match(stripAnsi(harness.render()), /spark> ack:hello Spark/);

  await harness.press("\x03");
  assert.equal(harness.state.exited, true);
  assert.equal(harness.state.renderRequests.length > 0, true);
});

void test("native TUI defaults to workspace session selector when no session target is provided", () => {
  const harness = createSparkNativeTuiHarness({
    cols: 180,
    workspaceSession: {
      mode: "select",
      workspaceDir: "/workspaces/current",
      workspaceHash: "hash-current",
      controlPlaneSessionId: "client-current",
    },
  });
  const rendered = stripAnsi(harness.render());

  assert.match(rendered, /Select Spark session/);
  assert.match(rendered, /workspace: \/workspaces\/current/);
  assert.match(rendered, /workspace hash: hash-current/);
  assert.match(rendered, /control-plane session: client-current/);
  assert.doesNotMatch(rendered, /Spark zellij-native control and Pi replacement validation/);
});

void test("native TUI keeps Pi-like project UI placement when session selector is shown", () => {
  const harness = createSparkNativeTuiHarness({
    cols: 180,
    workspaceSession: {
      mode: "select",
      workspaceDir: "/workspaces/current",
      workspaceHash: "hash-current",
      controlPlaneSessionId: "client-current",
    },
  });
  harness.app.setWidget("project", [
    "Project: Spark daemon-first session UX and Pi/Codex parity hardening",
    "Goal: daemon-first session UX and parity hardening",
    "Ready: @pi-like-project-ui-placement",
  ]);

  const lines = stripAnsi(harness.render()).split("\n");
  const sessionLines = markerIndexes(lines, /Select Spark session/);
  const projectLine = firstMarkerIndex(lines, /Project: Spark daemon-first/);
  const goalLine = firstMarkerIndex(lines, /Goal: daemon-first/);
  const readyLine = firstMarkerIndex(lines, /Ready: @pi-like-project-ui-placement/);

  assert.deepEqual(sessionLines, [2]);
  assert.equal(projectLine, 3);
  assert.equal(goalLine, 4);
  assert.equal(readyLine, 5);
});

void test("native TUI renders compact session status before Pi-like project UI", () => {
  const harness = createSparkNativeTuiHarness({
    cols: 180,
    workspaceSession: {
      mode: "attached",
      workspaceDir: "/workspaces/current",
      workspaceHash: "hash-current",
      controlPlaneSessionId: "client-current",
      attachTarget: "session:attached",
    },
  });
  harness.app.setWidget("project", [
    "Project: Spark daemon-first session UX and Pi/Codex parity hardening",
    "Goal: daemon-first session UX and parity hardening",
    "Ready: @zellij-driven-spark-pi-codex-parity-harness",
  ]);

  const lines = stripAnsi(harness.render()).split("\n");
  const sessionLine = firstMarkerIndex(lines, /Spark session attached/);
  const projectLine = firstMarkerIndex(lines, /Project: Spark daemon-first/);
  assert.equal(sessionLine, 2);
  assert.equal(projectLine, 3);
  assert.equal(
    lines.filter((line) =>
      /Spark session attached|workspace hash: hash-current|attach target: session:attached/.test(
        line,
      ),
    ).length,
    1,
  );
});

void test("native TUI construction does not mutate session lifecycle state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-session-lifecycle-"));
  const goalPath = join(dir, "goal.json");
  const statePath = join(dir, "state.json");
  await writeFile(goalPath, JSON.stringify({ status: "active", goalId: "goal-1" }), "utf8");
  await writeFile(statePath, JSON.stringify({ currentProjectRef: "proj:1" }), "utf8");
  const beforeGoal = await readFile(goalPath, "utf8");
  const beforeState = await readFile(statePath, "utf8");
  try {
    const harness = createSparkNativeTuiHarness({
      workspaceSession: {
        mode: "select",
        workspaceDir: dir,
        workspaceHash: "hash-lifecycle",
        controlPlaneSessionId: "client-lifecycle",
      },
    });
    harness.render();

    assert.equal(await readFile(goalPath, "utf8"), beforeGoal);
    assert.equal(await readFile(statePath, "utf8"), beforeState);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark native TUI renders theme color and live widget animation frames", async () => {
  const harness = createSparkNativeTuiHarness();
  let frame = 0;
  let widgetRequestRender: (() => void) | undefined;

  harness.app.setWidget(
    "animated",
    (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }) => {
      widgetRequestRender = () => tui.requestRender();
      return {
        render: () => [theme.fg("accent", `frame:${frame}`)],
        invalidate() {},
      };
    },
  );

  const firstRender = harness.render();
  assert.match(firstRender, ANSI_PATTERN);
  assert.match(stripAnsi(firstRender), /frame:0/);

  frame = 1;
  widgetRequestRender?.();
  assert.equal(harness.state.renderRequests.length > 0, true);
  assert.match(stripAnsi(harness.render()), /frame:1/);
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
  assert.match(stripAnsi(harness.render()), /plan\s+Enter Spark plan mode for the current project/);
  assert.match(stripAnsi(harness.render()), /goal\s+Set or inspect the current Spark goal/);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/help");
  assert.match(
    stripAnsi(harness.render()),
    /\/plan — Enter Spark plan mode for the current project/,
  );
  assert.match(stripAnsi(harness.render()), /\/goal — Set or inspect the current Spark goal/);

  await submitEditorText(harness, "/plan close slash gap");
  assert.deepEqual(invoked, [{ name: "plan", args: "close slash gap" }]);
  assert.match(stripAnsi(harness.render()), /system> info:planned:close slash gap/);
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
    argumentHint: "[model-id]",
    getArgumentCompletions: (prefix) =>
      selector
        .getPickerState()
        .items.map((item) => ({
          value: item.value,
          label: `${item.modelLabel}${item.active ? " (active)" : ""}`,
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
  assert.match(stripAnsi(harness.render()), /model-a \(active\)/);
  assert.match(stripAnsi(harness.render()), /route fake/);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/model");
  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-b" });
  assert.match(stripAnsi(harness.render()), /system> info:Model: fake\/model-b/);

  await submitEditorText(harness, "/model fake/model-a");
  assert.deepEqual(registry.getActive(), { providerName: "fake", modelId: "model-a" });
  assert.doesNotMatch(stripAnsi(harness.render()), /Unknown command: \/model/);
});

void test("Spark native Pi parity slash commands are discoverable and route representative side effects", async () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake", fakeProvider("fake", [fakeModel("model-a")]));
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const selector = new SparkModelSelector({
    registry,
    config: { extensions: ["ext-a"], providers: ["provider-a"], activeThinkingLevel: "low" },
    saveConfig: async () => undefined,
  });
  const keybindings = new SparkKeybindings();
  const dir = "/tmp/spark-native-pi-parity-commands";
  const slashCommands = createSparkPiParitySlashCommands({
    cwd: dir,
    config: { extensions: ["ext-a"], providers: ["provider-a"], activeThinkingLevel: "low" },
    saveConfig: async () => undefined,
    runtime: new SparkHostRuntime({ cwd: dir, hasUI: true, keybindings }),
    keybindings,
    providerRegistry: registry,
    modelSelector: selector,
    sessionStore: new SparkSessionStore({
      cwd: dir,
      sessionsRoot: "/tmp/spark-native-pi-parity-sessions",
    }),
    skillResolver: {} as never,
    agentLoop: {} as never,
    extensionLoadResult: { outcomes: [] } as never,
    providerLoadResult: { outcomes: [] } as never,
    diagnostics: [],
  });
  const harness = createSparkNativeTuiHarness({ slashCommands, autocompleteBasePath: dir });
  harness.session.appendAssistantChunk("assistant reply to copy");
  harness.session.finishAssistantMessage();

  await typeEditorText(harness, "/s");
  await harness.flush();
  assert.equal(harness.app.isShowingAutocomplete(), true);
  assert.match(stripAnsi(harness.render()), /settings\s+\[set thinking/);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/help");
  for (const command of [
    "settings",
    "scoped-models",
    "export",
    "import",
    "share",
    "copy",
    "name",
    "session",
    "changelog",
    "hotkeys",
    "fork",
    "clone",
    "tree",
    "trust",
    "login",
    "logout",
    "new",
    "compact",
    "resume",
    "reload",
  ]) {
    assert.match(stripAnsi(harness.render()), new RegExp(`/${command}(?: \\[| <| )?.* —`, "u"));
  }
  assert.match(
    stripAnsi(harness.render()),
    /\/reload — reload extension-owned slash command state/,
  );
  assert.match(stripAnsi(harness.render()), /\/resume \[session-id\|path\] —/u);

  await submitEditorText(harness, "/settings");
  assert.match(stripAnsi(harness.render()), /Spark settings:/);
  assert.match(stripAnsi(harness.render()), /active model: fake\/model-a/);

  await submitEditorText(harness, "/settings set thinking high");
  assert.match(stripAnsi(harness.render()), /thinking level set.*high/i);

  await submitEditorText(harness, "/scoped-models");
  assert.match(stripAnsi(harness.render()), /fake/);
  assert.match(stripAnsi(harness.render()), /model-a/);

  await submitEditorText(harness, "/name parity session");
  assert.match(stripAnsi(harness.render()), /Session name set: parity session/);

  await submitEditorText(harness, "/copy");
  assert.match(stripAnsi(harness.render()), /assistant reply to copy/);

  await submitEditorText(harness, "/hotkeys");
  assert.match(stripAnsi(harness.render()), /app.exit/);

  await submitEditorText(harness, "/new");
  assert.match(stripAnsi(harness.render()), /Started a new Spark native transcript/);
  assert.doesNotMatch(stripAnsi(harness.render()), /Unknown command: \/settings/);
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
  assert.match(stripAnsi(harness.render()), /\/plan /);
  harness.app.setEditorText("");

  await submitEditorText(harness, "/explode");
  assert.match(stripAnsi(harness.render()), /Command \/explode failed: boom/);
});

void test("Spark native TUI surfaces command availability, queued work, stop, and turn errors", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  const harness = createSparkNativeTuiHarness({
    slashCommands: {
      plan: { description: "Enter Spark plan mode", handler: () => "plan routed" },
      status: { description: "Show daemon status", handler: () => "daemon ok" },
      ...createSparkNativeLocalControlSlashCommands(),
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

  assert.match(stripAnsi(harness.render()), /native pi-tui host • idle • 16 registered commands/);
  assert.equal(await harness.submit("/help"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /\d+ extension commands? available|\d+ additional registered host\/daemon commands? available/,
  );

  assert.equal(await harness.submit("first"), "started");
  await harness.flush();
  assert.equal(await harness.submit("second"), "queued");
  await harness.flush();
  assert.match(stripAnsi(harness.render()), /native pi-tui host • busy • 1 follow-up queued/);
  assert.match(
    stripAnsi(harness.render()),
    /Queued steering message #1\. Use \/stop to clear queued work/,
  );

  assert.equal(await harness.submit("/stop dogfood"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /Stopped current Spark turn \(dogfood\)\. Restored 1 queued input\(s\) to the editor/,
  );
  releaseFirst?.("late response ignored");
  await harness.flush();
  assert.doesNotMatch(stripAnsi(harness.render()), /late response ignored/);

  assert.equal(await harness.submit("fail"), "started");
  await harness.flush();
  assert.match(
    stripAnsi(harness.render()),
    /system> Spark turn failed: daemon unavailable\. Use \/retry to resubmit or \/status to inspect the\s+daemon\./,
  );
});

void test("Spark native editor expands @file/image refs and bang commands through real submit path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-editor-input-"));
  try {
    await writeFile(join(dir, "note.txt"), "file body from @ reference", "utf8");
    await writeFile(join(dir, "screen.png"), "not-a-real-png-but-path-reference-is-enough", "utf8");
    const submitted: string[] = [];
    const harness = createSparkNativeTuiHarness({
      autocompleteBasePath: dir,
      responder: (input) => {
        submitted.push(input);
        return `ack:${input}`;
      },
    });

    await submitEditorText(harness, "Read @note.txt");
    await harness.flush();
    assert.match(
      submitted.at(-1) ?? "",
      /<file name=".*note\.txt">\nfile body from @ reference\n<\/file>/s,
    );

    await submitEditorText(harness, "Read @note.txt and @screen.png");
    await harness.flush();
    assert.match(
      submitted.at(-1) ?? "",
      /<file name=".*note\.txt">\nfile body from @ reference\n<\/file>/s,
    );
    assert.match(
      submitted.at(-1) ?? "",
      /<image name=".*screen\.png" mime="image\/png" bytes="\d+">data:image\/png;base64,/s,
    );
    assert.match(stripAnsi(harness.render()), /\[inline image data omitted\]/);

    await submitEditorText(harness, `Dragged ${join(dir, "screen.png")}`);
    await harness.flush();
    assert.match(
      submitted.at(-1) ?? "",
      /Dragged <image name=".*screen\.png" mime="image\/png" bytes="\d+">data:image\/png;base64,/s,
    );

    const tooWidePng = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(tooWidePng, 0);
    tooWidePng.writeUInt32BE(5000, 16);
    tooWidePng.writeUInt32BE(1, 20);
    await writeFile(join(dir, "too-wide.png"), tooWidePng);
    const beforeTooWide = submitted.length;
    await submitEditorText(harness, "Inspect @too-wide.png");
    await harness.flush();
    assert.equal(submitted.length, beforeTooWide);
    assert.match(stripAnsi(harness.render()), /max dimension is 4096px/);

    await submitEditorText(harness, "!printf spark-bang");
    await harness.flush();
    assert.match(submitted.at(-1) ?? "", /\$ printf spark-bang\nexit: 0\nspark-bang/);

    const beforeHidden = submitted.length;
    await submitEditorText(harness, "!!printf hidden-bang");
    await harness.flush();
    assert.equal(submitted.length, beforeHidden);
    assert.match(stripAnsi(harness.render()), /tool:shell \[success\]/);
    harness.app.toggleTools();
    assert.match(stripAnsi(harness.render()), /\[hidden shell command completed\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark native editor supports multiline and Pi-style busy queue restore keys", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  const submitted: string[] = [];
  const harness = createSparkNativeTuiHarness({
    responder: (input) => {
      submitted.push(input);
      if (input === "first") {
        return new Promise<string>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return `ack:${input}`;
    },
  });

  await typeEditorText(harness, "line one");
  await harness.press("\u001b[13;2u");
  await typeEditorText(harness, "line two");
  await harness.press("\r");
  await harness.flush();
  assert.equal(submitted.at(-1), "line one\nline two");

  await submitEditorText(harness, "first");
  await harness.flush();
  harness.app.setEditorText("follow-up text");
  await harness.press("\u001b\r");
  await harness.flush();
  assert.match(stripAnsi(harness.render()), /Queued follow-up #1/);

  await harness.press("\u001bp");
  await harness.flush();
  assert.match(stripAnsi(harness.render()), /Restored queued input to the editor/);
  assert.match(stripAnsi(harness.render()), /follow-up text/);

  harness.app.setEditorText("steer then escape");
  await harness.press("\r");
  await harness.flush();
  assert.match(stripAnsi(harness.render()), /Queued steering message #1/);
  await harness.press("\u001b");
  await harness.flush();
  assert.match(
    stripAnsi(harness.render()),
    /Stopped current Spark turn \(escape\)\. Restored 1 queued input\(s\) to the editor/,
  );
  assert.match(stripAnsi(harness.render()), /steer then escape/);
  releaseFirst?.("done");
  await harness.flush();
});

void test("Spark native busy queue delivers steering separately from follow-up turns", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  const submitted: string[] = [];
  const harness = createSparkNativeTuiHarness({
    responder: (input) => {
      submitted.push(input);
      if (input === "first") {
        return new Promise<string>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return `ack:${input}`;
    },
  });

  await submitEditorText(harness, "first");
  harness.app.setEditorText("steer one");
  await harness.press("\r");
  await harness.flush();
  harness.app.setEditorText("follow next");
  await harness.press("\u001b\r");
  await harness.flush();

  releaseFirst?.("done");
  await waitForNativeTimers();
  await waitForNativeTimers();
  await harness.flush();

  assert.equal(submitted[0], "first");
  assert.match(submitted[1] ?? "", /^Steering update for the previous Spark turn\./);
  assert.match(submitted[1] ?? "", /Steering 1:\nsteer one/);
  assert.equal(submitted[2], "follow next");
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
  assert.match(stripAnsi(narrowLines.join("\n")), /spark> streaming response/);
  assert.match(stripAnsi(narrowLines.join("\n")), /✓ tool:read \[success\] — first l\.\.\./);
  assert.match(stripAnsi(narrowLines.join("\n")), /thinking • hidden/);

  harness.app.toggleTools();
  harness.app.toggleThinking();
  const wideLines = harness.renderLines(88);
  const wideText = stripAnsi(wideLines.join("\n"));
  assert.equal(
    wideLines.every((line) => visibleWidth(line) <= 88),
    true,
    "wide render should respect the requested width",
  );
  assert.match(wideText, /┌─ ✓ tool:read \[success\] · tc-1/);
  assert.match(wideText, /│ first line/);
  assert.match(wideText, /│ second line with wider details/);
  assert.match(wideText, /thinking> hidden chain of implementation notes/);
});

void test("Spark cockpit renders shared workflow, run, task, artifact, review, and Graft view models", async () => {
  const harness = createSparkNativeTuiHarness({
    cols: 120,
    slashCommands: createSparkNativeLocalControlSlashCommands(),
  });

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
  assert.match(
    stripAnsi(harness.render()),
    /Workflow picker\/progress: 1 option\(s\), 1 workflow run\(s\)/,
  );
  assert.match(stripAnsi(harness.render()), /Role-run board: 1 role run\(s\), 0 interaction\(s\)/);

  assert.equal(await harness.submit("/runs"), "command");
  assert.equal(harness.app.cockpitSnapshot().activePanel, "runs");
  assert.match(
    stripAnsi(harness.render()),
    /role role:reviewer \[running\] 40% artifacts=1 Reviewer pass/,
  );
  assert.match(
    stripAnsi(harness.render()),
    /workflow run:release-readiness \[running\] 50% Release readiness workflow/,
  );
  assert.match(stripAnsi(harness.render()), /Actions: \/workflow-inspect run:release-readiness/);
  assert.match(stripAnsi(harness.render()), /\/workflow-pause run:release-readiness/);
  assert.match(stripAnsi(harness.render()), /\/workflow-stop run:release-readiness/);
  assert.match(stripAnsi(harness.render()), /\/workflow-save run:release-readiness/);

  assert.equal(await harness.submit("/tasks"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /task:spark-cockpit-superpowers \[running\] todos=1\/2 evidence=1 Spark cockpit superpowers/,
  );

  assert.equal(await harness.submit("/artifacts"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /artifact:review-ok \[record\/json\] producer=review status=approved Reviewer verdict/,
  );
  assert.match(
    stripAnsi(harness.render()),
    /artifact:graft-patch \[record\/json\] producer=task status=admitted Graft patch provenance/,
  );

  assert.equal(await harness.submit("/reviews"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /artifact:review-ok \[approved\] Reviewer verdict for cockpit task/,
  );
  assert.match(stripAnsi(harness.render()), /role:role:reviewer \[approved\] Reviewer pass/);

  assert.equal(await harness.submit("/graft"), "command");
  assert.match(
    stripAnsi(harness.render()),
    /artifact:graft-patch patch=patch:abc candidate=candidate:abc status=admitted/,
  );
  assert.match(
    stripAnsi(harness.render()),
    /task:task:graft-apply patch=patch:abc status=admitted/,
  );
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
  const harness = createSparkNativeTuiHarness({
    cols: 140,
    slashCommands: { ...createSparkNativeLocalControlSlashCommands(), ...slashCommands },
  });
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
  assert.match(stripAnsi(harness.render()), /▸─ workflow run:first \[running\] 25% First workflow/);
  assert.match(stripAnsi(harness.render()), /Keys: ↑\/↓ or j\/k select workflow run/);

  await harness.press("j");
  assert.match(stripAnsi(harness.render()), /Selected: run:second \[paused\]/);
  assert.match(
    stripAnsi(harness.render()),
    /▸─ workflow run:second \[paused\] 75% Second workflow/,
  );
  assert.match(stripAnsi(harness.render()), /\/workflow-resume run:second/);

  await harness.press("i");
  assert.deepEqual(invoked.at(-1), { name: "workflow-inspect", args: "run:second" });
  await harness.press("u");
  assert.deepEqual(invoked.at(-1), { name: "workflow-resume", args: "run:second" });
  await harness.press("x");
  assert.deepEqual(invoked.at(-1), { name: "workflow-stop", args: "run:second" });

  await harness.press("k");
  assert.match(stripAnsi(harness.render()), /Selected: run:first \[running\]/);
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
  const harness = createSparkNativeTuiHarness({
    cols: 110,
    slashCommands: createSparkNativeLocalControlSlashCommands(),
  });

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
    stripAnsi(harness.render()),
    /\/cockpit \[overview\|workflows\|runs\|tasks\|artifacts\|reviews\|graft\|off\]/,
  );
  assert.match(
    stripAnsi(harness.render()),
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
  await waitForNativeTimers();
  await harness.flush();
}

async function waitForNativeTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
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
