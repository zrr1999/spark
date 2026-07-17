import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { stableId } from "../packages/spark-extension-api/src/index.ts";
import { callLeafOrDegrade } from "../packages/spark-extension-api/src/index.ts";
import { DEFAULT_SPARK_PROVIDER_SPECS } from "../packages/spark-ai/src/control/provider-catalog.ts";
import { parseSparkCliArgs, parseSparkCliCommand } from "../apps/spark-tui/src/cli.ts";
import { saveSessionPhase } from "../packages/pi-extension/src/extension/current-project-state.ts";
import {
  assistantMessageToText,
  createProviderRegistryWorkflowModelRunner,
  createSparkCliHostServices,
  SparkAgentLoop,
  SparkHostRuntime,
  type SparkAgentStreamFunction,
  type SparkConfig,
} from "../apps/spark-tui/src/host/index.ts";

function assistant(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string",
      ),
    )
    .map((block) => block.text)
    .join(" ");
}

function fakeProviderModule(
  captured: {
    systemPrompt?: string;
    systemPromptStable?: string;
    systemPromptDynamic?: string;
    promptSnapshots?: Array<{
      systemPrompt?: string;
      systemPromptStable?: string;
      systemPromptDynamic?: string;
    }>;
    toolSnapshots?: string[][];
    assistantMessages?: Array<Record<string, unknown>>;
    modelId?: string;
    userPrompt?: string;
    streamCalls?: number;
  } = {},
) {
  return {
    default(api: { registerProvider(name: string, config: unknown): void }) {
      api.registerProvider("fake-provider", {
        name: "Fake Provider",
        baseUrl: "https://fake.test",
        api: "openai-completions",
        streamSimple: (
          _model: unknown,
          context: {
            messages?: Array<{ content?: unknown }>;
            systemPrompt?: string;
            systemPromptStable?: string;
            systemPromptDynamic?: string;
            tools?: Array<{ name?: string }>;
          },
        ) => {
          captured.streamCalls = (captured.streamCalls ?? 0) + 1;
          captured.systemPrompt = context.systemPrompt;
          captured.systemPromptStable = context.systemPromptStable;
          captured.systemPromptDynamic = context.systemPromptDynamic;
          captured.promptSnapshots?.push({
            systemPrompt: context.systemPrompt,
            systemPromptStable: context.systemPromptStable,
            systemPromptDynamic: context.systemPromptDynamic,
          });
          captured.toolSnapshots?.push(
            (context.tools ?? []).flatMap((tool) =>
              typeof tool.name === "string" ? [tool.name] : [],
            ),
          );
          captured.modelId = (_model as { id?: string }).id;
          captured.userPrompt = messageContentText(context.messages?.at(-1)?.content);
          const message =
            captured.assistantMessages?.[captured.streamCalls - 1] ??
            assistant(`boot ok:${context.messages?.length ?? 0}`);
          const reason = typeof message.stopReason === "string" ? message.stopReason : "stop";
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "done", reason, message };
            },
            result: async () => message,
          };
        },
        models: [
          {
            id: "fake-model",
            name: "Fake Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 4096,
          },
        ],
      });
    },
  };
}

void test("parseSparkCliArgs keeps help separate from initial message", () => {
  assert.deepEqual(parseSparkCliArgs(["--help"]), { help: true });
  assert.deepEqual(parseSparkCliArgs(["build", "this"]), {
    help: false,
    initialMessage: "build this",
  });
});

void test("parseSparkCliCommand preserves explicit tui session options", () => {
  assert.deepEqual(
    parseSparkCliCommand(["--session-id", "abc123", "--session-dir", "/tmp/spark-home"]),
    {
      kind: "tui",
      options: { sessionId: "abc123", sessionDir: "/tmp/spark-home" },
    },
  );
});

void test("createSparkCliHostServices constructs runtime, extensions, provider registry, sessions, skills, and agent loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-bootstrap-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(join(cwd, ".spark", "skills", "workspace-skill"), { recursive: true });
    await writeFile(
      join(cwd, ".spark", "skills", "workspace-skill", "SKILL.md"),
      "---\nname: workspace-skill\ndescription: Use when bootstrapping Spark CLI tests\n---\n\n# Workspace Skill\n",
      "utf8",
    );
    await mkdir(join(cwd, ".spark", "prompts"), { recursive: true });
    await writeFile(
      join(cwd, ".spark", "prompts", "bootstrap.md"),
      '---\ndescription: Bootstrap prompt\nargument-hint: "<topic>"\n---\nBootstrap $1\n',
      "utf8",
    );
    await mkdir(join(sparkHome, "agent"), { recursive: true });
    await writeFile(
      join(sparkHome, "agent", "keybindings.json"),
      JSON.stringify({ bindings: { "app.modelCycle.next": "ctrl+n" } }),
      "utf8",
    );

    const config: SparkConfig = {
      extensions: ["@zendev-lab/spark-ask/extension"],
      providers: ["fake-provider"],
    };
    const captured: { systemPrompt?: string } = {};
    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      config,
      extensions: config.extensions,
      providers: config.providers,
      providerImporter: async () => fakeProviderModule(captured),
    });

    assert.equal(services.runtime.cwd, cwd);
    assert.equal(services.providerRegistry.getActive()?.providerName, "fake-provider");
    assert.equal(services.providerRegistry.getActive()?.modelId, "fake-model");
    assert.equal(services.providerRegistry.hasProvider("spark-fusion"), false);
    assert.equal(
      services.runtime.getAllTools().some((tool) => tool.name === "ask"),
      true,
    );
    assert.equal(services.sessionStore.cwd, cwd);
    const baseContext = services.runtime.makeContext();
    assert.equal(typeof baseContext.runRole, "function");
    const sessionManager = baseContext.sessionManager;
    const sessionFile = sessionManager?.getSessionFile?.();
    assert.ok(sessionFile);
    assert.ok(sessionFile.endsWith(`${stableId(cwd)}.jsonl`));
    assert.equal(sessionManager?.getLeafId?.(), basename(sessionFile, ".jsonl"));
    assert.notEqual(sessionManager?.getLeafId?.(), "spark-cli-leaf");
    assert.equal(services.keybindings.keyFor("app.modelCycle.next"), "ctrl+n");
    assert.equal(
      (await services.skillResolver.resolve()).skills.some(
        (skill) => skill.name === "workspace-skill",
      ),
      true,
    );
    assert.equal(
      services.promptTemplates?.templates.some(
        (template) => template.name === "bootstrap" && template.argumentHint === "<topic>",
      ),
      true,
    );

    const response = await services.agentLoop.submit("hello");
    assert.equal(response ? assistantMessageToText(response) : "", "boot ok:1");
    assert.match(captured.systemPrompt ?? "", /You are Spark,/);
    assert.doesNotMatch(captured.systemPrompt ?? "", /running in the native spark-tui host/);
    assert.match(captured.systemPrompt ?? "", /Spark phase: plan\./);
    assert.match(captured.systemPrompt ?? "", /Tools: task_read, task_write, assign/);
    assert.match(captured.systemPrompt ?? "", /<available_skills>/);
    assert.doesNotMatch(captured.systemPrompt ?? "", /# Spark/);
    assert.match(captured.systemPrompt ?? "", /<name>spark-cue<\/name>/);
    assert.doesNotMatch(captured.systemPrompt ?? "", /# spark-cue/);
    assert.doesNotMatch(captured.systemPrompt ?? "", /<base_system_prompts>/);
    assert.doesNotMatch(captured.systemPrompt ?? "", /# spark-graft/);
    assert.doesNotMatch(captured.systemPrompt ?? "", /at most one unfinished claimed task/);
    assert.match(captured.systemPrompt ?? "", /workspace-skill/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native host selects at most three request skills dynamically and clears them next submit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-dynamic-skills-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(join(cwd, ".spark", "skills", "workspace-skill"), { recursive: true });
    await writeFile(
      join(cwd, ".spark", "skills", "workspace-skill", "SKILL.md"),
      "---\nname: workspace-skill\ndescription: Use for the unique frobnicate architecture workflow\n---\n\n# Workspace Skill Body\n\nApply frobnicate rules.\n",
      "utf8",
    );

    const captured: Parameters<typeof fakeProviderModule>[0] = { promptSnapshots: [] };
    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      config: { extensions: [], providers: ["fake-provider"] },
      providerImporter: async () => fakeProviderModule(captured),
    });

    await services.agentLoop.submit("please frobnicate this architecture");
    const selectedManifest = services.agentLoop.getLastPromptManifest();
    assert.ok(selectedManifest?.selectedSkills.includes("workspace-skill"));
    assert.ok((selectedManifest?.selectedSkills.length ?? 0) <= 3);
    const selectedSnapshot = captured.promptSnapshots?.[0];
    assert.match(selectedSnapshot?.systemPromptDynamic ?? "", /# Workspace Skill Body/);
    assert.doesNotMatch(selectedSnapshot?.systemPromptStable ?? "", /# Workspace Skill Body/);

    await services.agentLoop.submit("zzzz-unmatched-unique-token");
    const clearedManifest = services.agentLoop.getLastPromptManifest();
    assert.deepEqual(clearedManifest?.selectedSkills, []);
    const clearedSnapshot = captured.promptSnapshots?.[1];
    assert.doesNotMatch(clearedSnapshot?.systemPromptDynamic ?? "", /# Workspace Skill Body/);
    assert.equal(
      selectedSnapshot?.systemPromptStable,
      clearedSnapshot?.systemPromptStable,
      "selected skill bodies must not perturb the stable prompt hash input",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native host keeps prompt phase and executable tool profile on one loaded state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-phase-profile-"));
  try {
    const captured: Parameters<typeof fakeProviderModule>[0] = {};
    const services = await createSparkCliHostServices({
      cwd: dir,
      sparkHome: join(dir, ".spark-home"),
      config: { extensions: [], providers: ["fake-provider"] },
      providerImporter: async () => fakeProviderModule(captured),
    });

    assert.equal(services.agentLoop.getCurrentPhase(), "plan");

    await saveSessionPhase(dir, services.runtime.makeContext(), "implement");
    await services.agentLoop.submit("refresh the phase profile");
    assert.equal(services.agentLoop.getCurrentPhase(), "implement");
    assert.match(captured.systemPrompt ?? "", /Spark phase: implement\./);

    await saveSessionPhase(dir, services.runtime.makeContext(), "plan");
    await services.runtime.emit("before_agent_start", {});
    assert.equal(services.agentLoop.getCurrentPhase(), "plan");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("background turns use a driver profile and the next user submit restores persisted plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-background-driver-profile-"));
  try {
    const backgroundToolUse = assistant("run background write");
    backgroundToolUse.content = [
      {
        type: "toolCall",
        id: "tc-background-write",
        name: "implement_write",
        arguments: {},
      },
    ];
    backgroundToolUse.stopReason = "toolUse";
    const captured: Parameters<typeof fakeProviderModule>[0] = {
      promptSnapshots: [],
      toolSnapshots: [],
      assistantMessages: [
        backgroundToolUse,
        assistant("background complete"),
        assistant("user complete"),
      ],
    };
    const services = await createSparkCliHostServices({
      cwd: dir,
      sparkHome: join(dir, ".spark-home"),
      config: { extensions: [], providers: ["fake-provider"] },
      providerImporter: async () => fakeProviderModule(captured),
    });
    let writeExecutions = 0;
    services.runtime.registerTool({
      name: "implement_write",
      description: "implement-only write used by background drivers",
      parameters: { type: "object" },
      policy: {
        effect: "local_write",
        executionMode: "sequential",
        phases: ["implement"],
        approval: "none",
      },
      async execute() {
        writeExecutions += 1;
        return { content: [{ type: "text", text: "written" }] };
      },
    });
    await saveSessionPhase(dir, services.runtime.makeContext(), "plan");
    assert.equal(services.agentLoop.getCurrentPhase(), "plan");

    const backgroundDone = new Promise<void>((resolve) => {
      const unsubscribe = services.agentLoop.onEvent((event) => {
        if (event.type !== "run_outcome") return;
        unsubscribe();
        resolve();
      });
    });
    services.runtime.sendMessage(
      {
        customType: "background-driver-test",
        content: "continue the background driver",
        display: false,
        authority: "runtime_control",
        trust: "trusted",
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    await backgroundDone;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(writeExecutions, 1);
    assert.equal(services.agentLoop.getCurrentPhase(), undefined);
    for (const snapshot of captured.promptSnapshots?.slice(0, 2) ?? []) {
      assert.match(snapshot.systemPrompt ?? "", /You are Spark,/u);
      assert.match(snapshot.systemPrompt ?? "", /<available_skills>/u);
      assert.doesNotMatch(snapshot.systemPrompt ?? "", /Spark phase: (?:plan|implement)\./u);
    }
    assert.deepEqual(captured.toolSnapshots?.slice(0, 2), [
      ["implement_write"],
      ["implement_write"],
    ]);

    await services.agentLoop.submit("resume the real user plan");

    assert.equal(services.agentLoop.getCurrentPhase(), "plan");
    assert.match(captured.promptSnapshots?.[2]?.systemPrompt ?? "", /Spark phase: plan\./u);
    assert.deepEqual(captured.toolSnapshots?.[2], []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native submit preparation rejects concurrent submits before request context can race", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-submit-preparation-race" });
  let releasePrepare: () => void = () => undefined;
  const prepareGate = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  let markPrepareStarted: () => void = () => undefined;
  const prepareStarted = new Promise<void>((resolve) => {
    markPrepareStarted = resolve;
  });
  const prepared: string[] = [];
  const promptSnapshots: string[] = [];
  let selected = "";
  let loop: SparkAgentLoop;
  const streamFunction: SparkAgentStreamFunction = (_model, context) => {
    promptSnapshots.push(context.systemPrompt ?? "");
    const message = assistant("prepared");
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message } as never;
      },
      result: async () => message as never,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  loop = new SparkAgentLoop({
    host,
    streamFunction,
    getModel: () => ({ id: "model", provider: "provider", api: "openai-completions" }) as never,
    prepareUserSubmit: async (content) => {
      prepared.push(content);
      markPrepareStarted();
      await prepareGate;
      selected = content;
      loop.setSystemPrompt(`Dynamic context checkpoint: ${content}`);
    },
    promptManifest: { getSelectedSkills: () => (selected ? [selected] : []) },
  });

  const first = loop.submitWithOutcome("request-a");
  await prepareStarted;
  await assert.rejects(loop.submitWithOutcome("request-b"), /state=preparing/u);
  releasePrepare();
  await first;

  assert.deepEqual(prepared, ["request-a"]);
  assert.deepEqual(promptSnapshots, ["Dynamic context checkpoint: request-a"]);
  assert.deepEqual(loop.getLastPromptManifest()?.selectedSkills, ["request-a"]);
});

void test("native submit preparation does not start while a trigger turn is in pre-stream lifecycle", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-trigger-before-prepare-race" });
  let releaseBackground: () => void = () => undefined;
  const backgroundGate = new Promise<void>((resolve) => {
    releaseBackground = resolve;
  });
  let markBackgroundStarted: () => void = () => undefined;
  const backgroundStarted = new Promise<void>((resolve) => {
    markBackgroundStarted = resolve;
  });
  host.on("before_agent_start", async (event) => {
    if ((event as { source?: unknown }).source !== "triggerTurn") return;
    markBackgroundStarted();
    await backgroundGate;
  });
  let prepareCalls = 0;
  const message = assistant("background complete");
  const loop = new SparkAgentLoop({
    host,
    streamFunction: () =>
      ({
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message } as never;
        },
        result: async () => message as never,
      }) as ReturnType<SparkAgentStreamFunction>,
    getModel: () => ({ id: "model", provider: "provider", api: "openai-completions" }) as never,
    prepareUserSubmit: () => {
      prepareCalls += 1;
    },
  });
  const backgroundDone = new Promise<void>((resolve) => {
    const unsubscribe = loop.onEvent((event) => {
      if (event.type !== "run_outcome") return;
      unsubscribe();
      resolve();
    });
  });

  host.sendMessage(
    { customType: "background-race", content: "background", display: false },
    { deliverAs: "followUp", triggerTurn: true },
  );
  await backgroundStarted;

  await assert.rejects(loop.submitWithOutcome("must not prepare"), /state=triggerTurn/u);
  assert.equal(prepareCalls, 0);

  releaseBackground();
  await backgroundDone;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loop.getState(), "idle");
});

void test("trigger turns queued during user preparation are deferred without entering the user prompt", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-trigger-during-prepare-race" });
  let releasePrepare: () => void = () => undefined;
  const prepareGate = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  let markPrepareStarted: () => void = () => undefined;
  const prepareStarted = new Promise<void>((resolve) => {
    markPrepareStarted = resolve;
  });
  const contexts: unknown[] = [];
  const message = assistant("complete");
  const loop = new SparkAgentLoop({
    host,
    streamFunction: (_model, context) => {
      contexts.push(context.messages);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message } as never;
        },
        result: async () => message as never,
      } as ReturnType<SparkAgentStreamFunction>;
    },
    getModel: () => ({ id: "model", provider: "provider", api: "openai-completions" }) as never,
    prepareUserSubmit: async () => {
      markPrepareStarted();
      await prepareGate;
    },
  });
  let outcomes = 0;
  const backgroundDone = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      if (event.type !== "run_outcome") return;
      outcomes += 1;
      if (outcomes === 2) resolve();
    });
  });

  const userRun = loop.submitWithOutcome("real user request");
  await prepareStarted;
  host.sendMessage(
    { customType: "deferred-background", content: "background payload", display: false },
    { deliverAs: "followUp", triggerTurn: true },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(contexts.length, 0, "background must not start while preparation owns prompt state");

  releasePrepare();
  await userRun;
  await backgroundDone;

  assert.equal(contexts.length, 2);
  assert.match(JSON.stringify(contexts[0]), /real user request/u);
  assert.doesNotMatch(JSON.stringify(contexts[0]), /deferred-background|background payload/u);
  assert.match(JSON.stringify(contexts[1]), /deferred-background/u);
  assert.match(JSON.stringify(contexts[1]), /background payload/u);
  assert.equal(loop.getState(), "idle");
});

void test("completed user submit clears selected skills before an agent_end background turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-background-skill-clear-"));
  try {
    const cwd = join(dir, "repo");
    await mkdir(join(cwd, ".spark", "skills", "request-skill"), { recursive: true });
    await writeFile(
      join(cwd, ".spark", "skills", "request-skill", "SKILL.md"),
      "---\nname: request-skill\ndescription: Use for zyx-request-skill tasks\n---\n\n# Request-only body\n",
      "utf8",
    );
    const captured: Parameters<typeof fakeProviderModule>[0] = { promptSnapshots: [] };
    const services = await createSparkCliHostServices({
      cwd,
      sparkHome: join(dir, ".spark-home"),
      config: { extensions: [], providers: ["fake-provider"] },
      providerImporter: async () => fakeProviderModule(captured),
    });
    let queuedBackground = false;
    services.runtime.on("agent_end", () => {
      if (queuedBackground) return;
      queuedBackground = true;
      services.runtime.sendMessage(
        { customType: "background-test", content: "background continuation", display: false },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
    let completedTurns = 0;
    const backgroundComplete = new Promise<void>((resolve) => {
      services.agentLoop.onEvent((event) => {
        if (event.type !== "turn_complete") return;
        completedTurns += 1;
        if (completedTurns === 2) resolve();
      });
    });

    await services.agentLoop.submit("use request-skill for this task");
    await backgroundComplete;

    assert.match(captured.promptSnapshots?.[0]?.systemPromptDynamic ?? "", /# Request-only body/u);
    assert.doesNotMatch(
      captured.promptSnapshots?.[1]?.systemPromptDynamic ?? "",
      /# Request-only body/u,
    );
    assert.deepEqual(services.agentLoop.getLastPromptManifest()?.selectedSkills, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native host honors config extensions for explicit Graft opt-in and full disable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-config-extensions-"));
  try {
    const graftServices = await createSparkCliHostServices({
      cwd: dir,
      sparkHome: join(dir, "graft-home"),
      config: {
        extensions: ["@zendev-lab/spark-graft/extension"],
        providers: [],
      },
    });
    assert.equal(
      graftServices.runtime.getAllTools().some((tool) => tool.name === "graft_read"),
      true,
    );

    const disabledServices = await createSparkCliHostServices({
      cwd: dir,
      sparkHome: join(dir, "disabled-home"),
      config: { extensions: [], providers: [] },
    });
    assert.deepEqual(disabledServices.runtime.getAllTools(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native host installs explicit session manager before extension load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-session-manager-order-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(sparkHome, { recursive: true });
    let capturedLeaf: string | undefined;
    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      sparkStateRoot: sparkHome,
      config: { extensions: ["test-session-extension"], providers: [] },
      extensions: ["test-session-extension"],
      providers: [],
      sessionManager: { getLeafId: () => "session:explicit-test" },
      extensionImporter: async () => ({
        default: (api: unknown) => {
          const ctx = (
            api as {
              makeContext?: () => {
                sparkStateRoot?: string;
                sessionManager?: { getLeafId?: () => string };
              };
            }
          ).makeContext?.();
          capturedLeaf = ctx?.sessionManager?.getLeafId?.();
          assert.equal(ctx?.sparkStateRoot, sparkHome);
        },
      }),
    });

    assert.equal(capturedLeaf, "session:explicit-test");
    assert.equal(services.runtime.makeContext().sparkStateRoot, sparkHome);
    assert.equal(
      services.runtime.makeContext().sessionManager?.getLeafId?.(),
      "session:explicit-test",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native host registers spark-files working-tree tools via the builtin extension set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-spark-files-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(sparkHome, { recursive: true });
    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      config: { extensions: ["@zendev-lab/spark-files/extension"], providers: ["fake-provider"] },
      extensions: ["@zendev-lab/spark-files/extension"],
      providers: ["fake-provider"],
      providerImporter: async () => fakeProviderModule(),
    });

    const fileToolNames = services.runtime.getAllTools().map((tool) => tool.name);
    for (const name of ["read", "write", "edit", "ls", "grep", "find"]) {
      assert.equal(
        fileToolNames.includes(name),
        true,
        `expected file tool ${name} to be registered`,
      );
    }
    assert.equal(
      services.extensionLoadResult.outcomes.find(
        (outcome) => outcome.specifier === "@zendev-lab/spark-files/extension",
      )?.ok,
      true,
    );

    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n", "utf8");
    const readTool = services.runtime.getTool("read");
    assert.ok(readTool);
    const result = await readTool!.config.execute(
      "call-1",
      { path: "sample.txt" },
      new AbortController().signal,
      () => undefined,
      services.runtime.makeContext(),
    );
    assert.match(
      result.content.map((part) => part.text).join("\n"),
      /^\[File version: sha256:[0-9a-f]{64}\]\n\n1#[0-9a-f]{12}:alpha\n2#[0-9a-f]{12}:beta\n3#[0-9a-f]{12}:$/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("native host registers spark-ai models tool and exposes Spark model registry context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-spark-ai-models-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(sparkHome, { recursive: true });
    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      config: {
        extensions: ["@zendev-lab/spark-ai/models-extension"],
        providers: ["fake-provider"],
      },
      extensions: ["@zendev-lab/spark-ai/models-extension"],
      providers: ["fake-provider"],
      providerImporter: async () => fakeProviderModule(),
    });

    assert.equal(
      services.extensionLoadResult.outcomes.find(
        (outcome) => outcome.specifier === "@zendev-lab/spark-ai/models-extension",
      )?.ok,
      true,
    );
    const modelsTool = services.runtime.getTool("models");
    assert.ok(modelsTool);
    const result = await modelsTool!.config.execute(
      "call-models",
      {},
      new AbortController().signal,
      () => undefined,
      services.runtime.makeContext(),
    );
    const text = result.content.map((part) => part.text).join("\n");
    assert.match(text, /Available models \(1\)/);
    assert.match(text, /fake-provider\s+fake-model/);
    assert.deepEqual(result.details?.models, [
      {
        provider: "fake-provider",
        id: "fake-model",
        name: "Fake Model",
        contextWindow: 8192,
        maxTokens: 4096,
        thinking: false,
        images: false,
        available: true,
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("createSparkCliHostServices loads config from explicit sparkHome by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-home-config-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(sparkHome, { recursive: true });
    await writeFile(
      join(sparkHome, "config.json"),
      JSON.stringify({ extensions: [], providers: ["fake-provider"] }),
      "utf8",
    );

    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      extensions: [],
      providerImporter: async () => fakeProviderModule(),
    });

    assert.deepEqual(services.config.providers, [...DEFAULT_SPARK_PROVIDER_SPECS, "fake-provider"]);
    assert.equal(services.providerRegistry.getActive()?.providerName, "fake-provider");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("provider registry workflow model runner completes in-process without role runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-workflow-model-runner-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(sparkHome, { recursive: true });
    const captured: { systemPrompt?: string; modelId?: string; userPrompt?: string } = {};
    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      config: { extensions: [], providers: ["fake-provider"] },
      extensions: [],
      providers: ["fake-provider"],
      providerImporter: async () => fakeProviderModule(captured),
    });

    const runModel = createProviderRegistryWorkflowModelRunner(services.providerRegistry);
    const result = await runModel({
      prompt: "Compare model answers",
      label: "panel 1",
      model: "fake-provider/fake-model",
      metadata: { workflowAgent: true, agentType: "model" },
    });

    assert.equal(result.text, "boot ok:1");
    assert.equal(captured.modelId, "fake-model");
    assert.equal(captured.userPrompt, "Compare model answers");
    assert.match(captured.systemPrompt ?? "", /read-only Spark workflow model agent/);
    assert.equal(result.metadata?.providerName, "fake-provider");
    assert.equal(result.metadata?.modelId, "fake-model");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("provider registry workflow model runner rejects unknown provider and model targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-workflow-model-runner-unknown-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(sparkHome, { recursive: true });
    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      config: { extensions: [], providers: ["fake-provider"] },
      extensions: [],
      providers: ["fake-provider"],
      providerImporter: async () => fakeProviderModule(),
    });

    const runModel = createProviderRegistryWorkflowModelRunner(services.providerRegistry);
    await assert.rejects(
      () =>
        runModel({
          prompt: "use a missing provider",
          label: "panel",
          model: "missing-provider/missing-model",
        }),
      /Unknown provider: missing-provider/,
    );
    await assert.rejects(
      () =>
        runModel({
          prompt: "use a missing bare model",
          label: "panel",
          model: "missing-model",
        }),
      /Unknown workflow model: missing-model/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("host ctx.runLeaf delegates to a single-shot spark-ai leaf and reports the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-runleaf-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(sparkHome, { recursive: true });
    const captured: {
      systemPrompt?: string;
      modelId?: string;
      userPrompt?: string;
      streamCalls?: number;
    } = {};
    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      config: { extensions: [], providers: ["fake-provider"] },
      extensions: [],
      providers: ["fake-provider"],
      providerImporter: async () => fakeProviderModule(captured),
    });

    const ctx = services.runtime.makeContext();
    assert.equal(typeof ctx.runLeaf, "function");
    const result = await ctx.runLeaf!({
      role: "web-researcher",
      brief: "Synthesize the provided results.",
      input: "candidate one\ncandidate two",
    });

    assert.equal(result.degraded, false);
    assert.equal(result.text, "boot ok:1");
    assert.equal(result.model, "fake-provider/fake-model");
    assert.equal(captured.streamCalls, 1);
    assert.equal(captured.modelId, "fake-model");
    assert.equal(captured.userPrompt, "candidate one\ncandidate two");
    assert.match(captured.systemPrompt ?? "", /bounded Spark leaf capability/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("host ctx.runLeaf degrades without throwing for an unknown model override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cli-runleaf-degrade-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(sparkHome, { recursive: true });
    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      config: { extensions: [], providers: ["fake-provider"] },
      extensions: [],
      providers: ["fake-provider"],
      providerImporter: async () => fakeProviderModule(),
    });

    const ctx = services.runtime.makeContext();
    const result = await ctx.runLeaf!({
      role: "web-researcher",
      brief: "Synthesize.",
      input: "data",
      model: "missing-provider/missing-model",
    });

    assert.equal(result.degraded, true);
    assert.equal(result.reasonCode, "model-binding-unavailable");
    assert.equal(result.text, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("callLeafOrDegrade returns host-unsupported when a host omits runLeaf, without throwing", async () => {
  const result = await callLeafOrDegrade(
    {},
    { role: "web-researcher", brief: "synthesize", input: "data" },
  );
  assert.equal(result.degraded, true);
  assert.equal(result.reasonCode, "host-unsupported");
  assert.equal(result.text, "");
});

void test("callLeafOrDegrade delegates to a present host runLeaf", async () => {
  let calls = 0;
  const result = await callLeafOrDegrade(
    {
      runLeaf: async () => {
        calls += 1;
        return { degraded: false, text: "synthesized", model: "p/m" };
      },
    },
    { role: "web-researcher", brief: "synthesize", input: "data" },
  );
  assert.equal(calls, 1);
  assert.equal(result.degraded, false);
  assert.equal(result.text, "synthesized");
});

void test("spark-tui-app package keeps pi-coding-agent out of runtime dependencies", async () => {
  const pkg = JSON.parse(await readFile("apps/spark-tui/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
});
