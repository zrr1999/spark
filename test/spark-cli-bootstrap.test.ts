import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { stableId } from "../packages/pi-extension-api/src/index.ts";
import { parseSparkCliArgs } from "../packages/spark-cli/src/cli.ts";
import {
  createSparkCliHostServices,
  submitToSparkAgent,
  type SparkConfig,
} from "../packages/spark-cli/src/host/index.ts";

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

function fakeProviderModule(captured: { systemPrompt?: string } = {}) {
  return {
    default(api: { registerProvider(name: string, config: unknown): void }) {
      api.registerProvider("fake-provider", {
        name: "Fake Provider",
        baseUrl: "https://fake.test",
        api: "openai-completions",
        streamSimple: (
          _model: unknown,
          context: { messages?: unknown[]; systemPrompt?: string },
        ) => {
          captured.systemPrompt = context.systemPrompt;
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
    await mkdir(join(sparkHome, "agent"), { recursive: true });
    await writeFile(
      join(sparkHome, "agent", "keybindings.json"),
      JSON.stringify({ bindings: { "app.modelCycle.next": "ctrl+n" } }),
      "utf8",
    );

    const config: SparkConfig = {
      extensions: ["@zendev-lab/pi-ask/extension"],
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
    assert.equal(services.providerRegistry.hasProvider("spark-fusion"), true);
    assert.equal(services.providerRegistry.listModelsFor("spark-fusion")[0]?.id, "spark-fusion");
    assert.equal(
      services.runtime.getAllTools().some((tool) => tool.name === "ask"),
      true,
    );
    assert.equal(services.sessionStore.cwd, cwd);
    const sessionManager = services.runtime.makeContext().sessionManager;
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

    const response = await submitToSparkAgent(services, "hello");
    assert.equal(response, "boot ok:1");
    assert.match(captured.systemPrompt ?? "", /Spark mode: research\./);
    assert.match(captured.systemPrompt ?? "", /workspace-skill/);
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

    assert.equal(services.config.providers[0], "fake-provider");
    assert.equal(services.providerRegistry.getActive()?.providerName, "fake-provider");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("spark-cli package keeps pi-coding-agent out of runtime dependencies", async () => {
  const pkg = JSON.parse(await readFile("packages/spark-cli/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
});
