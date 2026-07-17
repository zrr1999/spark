import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSparkBehavior } from "@zendev-lab/spark-turn/behavior-eval";
import { buildSparkPromptManifest } from "@zendev-lab/spark-turn/prompt-manifest";

function manifest() {
  return buildSparkPromptManifest({
    promptVersion: "test-v1",
    sessionId: "session-with-private-identity",
    model: { provider: "test", id: "model", api: "responses" },
    reasoning: "medium",
    stablePrompt: "stable secret prompt",
    dynamicPrompt: "dynamic user data",
    promptCacheKey: "cache-key-containing-session-data",
    tools: [
      { name: "read", effect: "read", executionMode: "parallel" },
      { name: "write", effect: "local_write", executionMode: "sequential" },
      { name: "hidden", active: false, effect: "destructive" },
    ],
    selectedSkills: ["coding", "coding", "testing"],
    roundtripIndex: 1,
    maxParallelToolCalls: 4,
  });
}

void test("prompt manifest exposes diagnostics without retaining sensitive prompt/session data", () => {
  const result = manifest();
  const serialized = JSON.stringify(result);

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.prompt.stableChars, "stable secret prompt".length);
  assert.equal(result.prompt.dynamicChars, "dynamic user data".length);
  assert.equal(result.sessionFingerprint.length, 16);
  assert.equal(result.cache.keyFingerprint?.length, 16);
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["read", "write"],
  );
  assert.deepEqual(result.selectedSkills, ["coding", "testing"]);
  assert.deepEqual(result.roundtrip, { index: 1 });
  assert.doesNotMatch(serialized, /private-identity|secret prompt|user data|cache-key-containing/u);
});

void test("behavior eval reports tool precision, coverage, effects, outcome, and roundtrips", () => {
  const passing = evaluateSparkBehavior(
    {
      id: "implement-and-test",
      allowedTools: ["read", "write", "test"],
      requiredTools: ["write", "test"],
      forbiddenTools: ["publish"],
      allowedEffects: ["read", "local_write"],
      expectedOutcomes: ["completed"],
      maxToolCalls: 4,
      requireEvidence: true,
    },
    {
      manifest: manifest(),
      toolCalls: [
        { name: "read", effect: "read" },
        { name: "write", effect: "local_write" },
        { name: "test", effect: "read" },
      ],
      outcome: "completed",
      roundtrips: 3,
      evidenceRefs: ["test:focused"],
    },
  );

  assert.equal(passing.passed, true);
  assert.equal(passing.metrics.toolSelectionPrecision, 1);
  assert.equal(passing.metrics.requiredToolCoverage, 1);
  assert.equal(passing.metrics.roundtrips, 3);

  const failing = evaluateSparkBehavior(
    {
      id: "plan-no-write",
      allowedTools: ["read"],
      forbiddenTools: ["write", "publish"],
      allowedEffects: ["read"],
      expectedOutcomes: ["completed"],
      maxToolCalls: 1,
    },
    {
      manifest: manifest(),
      toolCalls: [
        { name: "read", effect: "read" },
        { name: "write", effect: "local_write" },
      ],
      outcome: "failed",
      roundtrips: 3,
    },
  );

  assert.equal(failing.passed, false);
  assert.equal(failing.metrics.toolSelectionPrecision, 0.5);
  assert.deepEqual(
    failing.checks.filter((entry) => !entry.passed).map((entry) => entry.id),
    ["allowed_tools", "forbidden_tools", "allowed_effects", "outcome", "tool_budget"],
  );
});
