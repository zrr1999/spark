import { describe, expect, it } from "vitest";

import { createSparkSessionRepro } from "./index.ts";
import { renderReproTickInstruction } from "./instructions.ts";

describe("renderReproTickInstruction", () => {
  it("preserves the setup research and user-decision policy", () => {
    const instruction = renderReproTickInstruction(createSparkSessionRepro("session:test"));

    expect(instruction).toContain("competitor-baseline-availability-researched");
    expect(instruction).toContain("Do not invent a substitute baseline");
    expect(instruction).toContain("Ask exactly one material user decision at a time");
    expect(instruction).toContain("recordAsEvidence=true");
    expect(instruction).toContain("Real tool calls trigger evidence collection");
    expect(instruction).toContain("reuse returned evidence refs");
    expect(instruction).toContain("do not proactively write a separate evidence record");
    expect(instruction).toContain('use artifact kind="preview" with Markdown');
    expect(instruction).toContain("normally one, at most three");
    expect(instruction).toContain("owned by artifact, never memory or internal evidence");
    expect(instruction).not.toContain("canonical learning-document store");
    expect(instruction).not.toContain('memory({ action: "search", kind: "learning"');
  });

  it.each(["reproduce", "scale"] as const)(
    "requires runtime evidence and a bounded diagnostic loop during %s",
    (stageName) => {
      const repro = createSparkSessionRepro("session:test");
      const stageIndex = repro.stages.findIndex((stage) => stage.name === stageName);
      expect(stageIndex).toBeGreaterThanOrEqual(0);
      repro.currentStageIndex = stageIndex;
      repro.currentPhase = "implement";

      const instruction = renderReproTickInstruction(repro);

      expect(instruction).toContain("one bounded diagnostic loop per tick, not merely one command");
      expect(instruction).toContain("first_bad_step → first_bad_layer → suspected_boundary");
      expect(instruction).toContain("claim, supporting_refs, expected_if_true, and falsifier");
      expect(instruction).toContain("Change one variable at a time");
      expect(instruction).toContain("runtime_verdict=confirmed | rejected | inconclusive");
      expect(instruction).toContain("cannot stand in for runtime validation");
      expect(instruction).toContain("offline .npy/.safetensors slice");
      expect(instruction).toContain("sole writer and executor");
    },
  );
});
