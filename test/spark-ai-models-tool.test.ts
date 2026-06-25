import assert from "node:assert/strict";
import test from "node:test";
import { registerSparkModelsTool } from "../packages/spark-ai/src/models-extension.ts";
import type { ToolConfig } from "@zendev-lab/pi-extension-api";

interface FakeModel {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
}

function fakeRegistry() {
  const models: FakeModel[] = [
    {
      provider: "openai",
      id: "gpt-5",
      name: "GPT 5",
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ["text", "image"],
    },
    {
      provider: "openai",
      id: "gpt-4o-mini",
      name: "GPT 4o mini",
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoning: false,
      input: ["text", "image"],
    },
    {
      provider: "local",
      id: "demo-offline",
      name: "Demo Offline",
      contextWindow: 8_000,
      maxTokens: 1_000,
      reasoning: false,
      input: ["text"],
    },
  ];
  const available = new Set(["openai/gpt-5", "openai/gpt-4o-mini"]);
  return {
    getAvailable: () => models.filter((model) => available.has(`${model.provider}/${model.id}`)),
    getAll: () => models,
    hasConfiguredAuth: (model: FakeModel) => available.has(`${model.provider}/${model.id}`),
    getError: () => undefined,
  };
}

function registerTools(): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  registerSparkModelsTool({ registerTool: (config) => tools.set(config.name, config) });
  return tools;
}

async function executeModels(
  params: Record<string, unknown>,
  registry: ReturnType<typeof fakeRegistry> = fakeRegistry(),
) {
  const tool = registerTools().get("models");
  assert.ok(tool, "models tool should be registered");
  return tool.execute("tool-call", params, new AbortController().signal, () => undefined, {
    modelRegistry: registry,
  } as unknown as Parameters<ToolConfig["execute"]>[4]);
}

void test("models registers one standalone tool", () => {
  const tools = registerTools();
  assert.deepEqual([...tools.keys()], ["models"]);
});

void test("models lists available models by default", async () => {
  const result = await executeModels({});
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Available models \(2\)/);
  assert.match(text, /openai\s+gpt-5/);
  assert.match(text, /openai\s+gpt-4o-mini/);
  assert.doesNotMatch(text, /demo-offline/);
  assert.equal(result.details?.count, 2);
});

void test("models can include unavailable registered models with auth column", async () => {
  const result = await executeModels({ includeUnavailable: true });
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Registered models \(3\)/);
  assert.match(text, /auth/);
  assert.match(text, /local\s+demo-offline/);
  assert.match(text, /demo-offline\s+8K\s+1K\s+no\s+no\s+no/);
  assert.equal(result.details?.count, 3);
});

void test("models supports provider, query, and limit filters", async () => {
  const result = await executeModels({ provider: "openai", query: "mini", limit: 1 });
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Available models \(1; provider=openai, query="mini"\)/);
  assert.match(text, /gpt-4o-mini/);
  assert.doesNotMatch(text, /gpt-5/);
  assert.equal(result.details?.count, 1);
  assert.equal(result.details?.totalMatched, 1);
});

void test("models reports a clear host capability error when modelRegistry is missing", async () => {
  const tool = registerTools().get("models");
  assert.ok(tool, "models tool should be registered");
  await assert.rejects(
    () =>
      tool.execute(
        "tool-call",
        {},
        new AbortController().signal,
        () => undefined,
        {} as Parameters<ToolConfig["execute"]>[4],
      ),
    /models requires ctx\.modelRegistry from the host context/,
  );
});
