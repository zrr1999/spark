import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentRegistry,
  ProjectAgentSpecStore,
  createAgentSpec,
  createBuiltinAgents,
} from "spark-agents";

void test("builtin Spark agents are instructed to implement concrete repo behavior feedback", () => {
  const agents = createBuiltinAgents();
  const planner = agents.find((agent) => agent.id === "planner");
  const worker = agents.find((agent) => agent.id === "worker");
  assert.match(planner?.systemPrompt ?? "", /implementation work rather than memory-only updates/);
  assert.match(
    worker?.systemPrompt ?? "",
    /fix the implementation instead of only recording a preference/,
  );
});

void test("project agent spec store persists and hydrates registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agents-"));
  try {
    const store = new ProjectAgentSpecStore(dir);
    const spec = createAgentSpec({
      id: "svg-assembler",
      description: "Creates SVG assembly animation plans.",
      systemPrompt: "You are a specialist in SVG animation planning.",
      rationale: "We need a narrow reusable planner for SVG animation tasks.",
      expectedUses: ["svg assembly planning", "animation decomposition"],
    });
    await store.save(spec);

    const registry = new AgentRegistry();
    await store.hydrate(registry);
    const loaded = registry.select("svg-assembler");

    assert.equal(loaded.source, "project");
    assert.equal(loaded.id, "svg-assembler");
    assert.match(loaded.ref, /^agent:project-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
