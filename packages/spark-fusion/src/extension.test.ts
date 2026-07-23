import {
  resolveToolPolicy,
  type LeafCapabilityRequest,
  type ToolConfig,
} from "@zendev-lab/spark-core";
import { describe, expect, it, vi } from "vitest";
import sparkFusionExtension, { createSparkFusionTool } from "./extension.ts";

function opinion(role: string): string {
  return JSON.stringify({
    version: 1,
    conclusion: role,
    keyPoints: [role],
    evidenceRefs: [],
    assumptions: [],
    uncertainties: [],
  });
}

function analysis(): string {
  return JSON.stringify({
    version: 1,
    consensus: [],
    contradictions: [],
    partialCoverage: [],
    uniqueInsights: [],
    blindSpots: [],
    answerOutline: ["Write the verified final answer."],
    confidence: "high",
  });
}

describe("Spark Fusion extension", () => {
  it("registers one canonical, sequential, approval-required read tool", () => {
    let registered: ToolConfig | undefined;
    sparkFusionExtension({
      registerTool(config) {
        registered = config;
      },
    });

    expect(registered?.name).toBe("fusion");
    expect(registered?.parameters).toMatchObject({ additionalProperties: false });
    expect(resolveToolPolicy(registered as ToolConfig)).toEqual({
      effect: "read",
      executionMode: "sequential",
      domains: ["models", "deliberation"],
      phases: ["plan", "implement"],
      approval: "required",
    });
    expect(registered?.renderCall?.({ action: "deliberate" }, {}, undefined).render(80)).toEqual([
      "fusion action=deliberate panels=3",
    ]);
  });

  it("uses the host leaf runner, carries the session model, and returns Judge data to the writer", async () => {
    const calls: LeafCapabilityRequest[] = [];
    const tool = createSparkFusionTool();
    const result = await tool.execute(
      "call-1",
      {
        action: "deliberate",
        question: "Which hypothesis should be tested first?",
        panels: [
          { id: "a", perspective: "Test A" },
          { id: "b", perspective: "Test B" },
        ],
      },
      new AbortController().signal,
      vi.fn(),
      {
        model: { provider: "provider", id: "active" },
        runLeaf: async (request) => {
          calls.push(request);
          const model = request.sessionModel;
          return request.role === "fusion-judge"
            ? { degraded: false, text: analysis(), ...(model ? { model } : {}) }
            : { degraded: false, text: opinion(request.role), ...(model ? { model } : {}) };
        },
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ status: "complete", version: 1 });
    expect(calls).toHaveLength(3);
    expect(calls.every((request) => request.sessionModel === "provider/active")).toBe(true);
    const content = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(content).toMatchObject({
      status: "complete",
      judge: { analysis: { confidence: "high" } },
    });
  });

  it("fails mechanically when the host has no leaf capability", async () => {
    const result = await createSparkFusionTool().execute(
      "call-2",
      { action: "deliberate", question: "Question" },
      new AbortController().signal,
      vi.fn(),
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      status: "failed",
      failureCode: "insufficient-panels",
      panels: [
        { status: "degraded", reasonCode: "host-unsupported" },
        { status: "degraded", reasonCode: "host-unsupported" },
        { status: "degraded", reasonCode: "host-unsupported" },
      ],
    });
  });
});
