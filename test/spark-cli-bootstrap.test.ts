import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { stableId } from "../packages/spark-extension-api/src/index.ts";
import { callLeafOrDegrade } from "../packages/spark-extension-api/src/index.ts";
import { DEFAULT_SPARK_PROVIDER_SPECS } from "../packages/spark-ai/src/control/provider-catalog.ts";
import { parseSparkCliArgs, parseSparkCliCommand } from "../apps/spark-tui/src/cli.ts";
import {
  assistantMessageToText,
  createProviderRegistryWorkflowModelRunner,
  createSparkCliHostServices,
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
          context: { messages?: Array<{ content?: unknown }>; systemPrompt?: string },
        ) => {
          captured.streamCalls = (captured.streamCalls ?? 0) + 1;
          captured.systemPrompt = context.systemPrompt;
          captured.modelId = (_model as { id?: string }).id;
          captured.userPrompt = messageContentText(context.messages?.at(-1)?.content);
          const message = assistant(`boot ok:${context.messages?.length ?? 0}`);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "done", reason: "stop", message };
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
    assert.match(captured.systemPrompt ?? "", /<base_system_prompts>/);
    assert.doesNotMatch(captured.systemPrompt ?? "", /# Spark/);
    assert.match(captured.systemPrompt ?? "", /# spark-cue/);
    assert.match(captured.systemPrompt ?? "", /# spark-graft/);
    assert.doesNotMatch(captured.systemPrompt ?? "", /at most one unfinished claimed task/);
    assert.match(captured.systemPrompt ?? "", /workspace-skill/);
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
    assert.equal(result.content.map((part) => part.text).join("\n"), "alpha\nbeta\n");
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
