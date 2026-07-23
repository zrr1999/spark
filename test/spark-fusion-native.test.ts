import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createProviderRegistryLeafRunner,
  SparkProviderRegistry,
  type ProviderConfig,
} from "@zendev-lab/spark-ai";
import { createSparkFusionTool } from "@zendev-lab/spark-fusion/extension";
import { SparkHostRuntime } from "../apps/spark-tui/src/host/index.ts";

function panelOpinion(): string {
  return JSON.stringify({
    version: 1,
    conclusion: "Run the bounded probe.",
    keyPoints: ["It separates the candidate boundaries."],
    evidenceRefs: ["evidence:trace-1"],
    assumptions: [],
    uncertainties: [],
  });
}

function judgeAnalysis(): string {
  return JSON.stringify({
    version: 1,
    consensus: ["Run the bounded probe."],
    contradictions: [],
    partialCoverage: [],
    uniqueInsights: [],
    blindSpots: [],
    answerOutline: ["State the next falsifiable experiment."],
    confidence: "medium",
  });
}

test("native host composes Fusion through the provider-registry leaf runner", async () => {
  const systemPrompts: string[] = [];
  const provider: ProviderConfig = {
    name: "fake",
    baseUrl: "https://fake.test",
    apiKey: "FAKE_API_KEY",
    api: "anthropic-messages",
    models: [
      {
        id: "model-a",
        name: "Model A",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_384,
        maxTokens: 8_192,
      },
    ],
    streamSimple(_model, context) {
      const systemPrompt = context.systemPrompt ?? "";
      systemPrompts.push(systemPrompt);
      const text = systemPrompt.includes("comparison judge") ? judgeAnalysis() : panelOpinion();
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text }],
        stopReason: "endTurn" as const,
        timestamp: 0,
        api: "anthropic-messages" as const,
        provider: "fake",
        model: "model-a",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      async function* iterate() {
        yield { type: "done" as const, message };
      }
      const stream = iterate() as ReturnType<typeof iterate> & {
        result(): Promise<typeof message>;
      };
      stream.result = async () => message;
      return stream;
    },
  };
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake", provider);
  registry.setActive({ providerName: "fake", modelId: "model-a" });

  const host = new SparkHostRuntime({ cwd: "/tmp/spark-fusion-native" });
  host.setLeafRunner(createProviderRegistryLeafRunner({ registry }));
  const result = await createSparkFusionTool().execute(
    "fusion-native-1",
    {
      action: "deliberate",
      question: "Which experiment should run next?",
      panels: [
        { id: "first", perspective: "Propose the smallest discriminator." },
        { id: "second", perspective: "Challenge the likely false positive." },
      ],
    },
    new AbortController().signal,
    () => undefined,
    host.makeContext({ model: { provider: "fake", id: "model-a" } }),
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.details?.status, "complete");
  assert.equal(systemPrompts.length, 3);
  assert.equal(systemPrompts.filter((prompt) => prompt.includes("independent panelist")).length, 2);
  assert.equal(systemPrompts.filter((prompt) => prompt.includes("comparison judge")).length, 1);
});
