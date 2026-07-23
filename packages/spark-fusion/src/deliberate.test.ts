import type { LeafCapabilityRequest, LeafCapabilityRunner } from "@zendev-lab/spark-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FUSION_PANELS, deliberateSparkFusion } from "./deliberate.ts";

function opinion(conclusion: string): string {
  return JSON.stringify({
    version: 1,
    conclusion,
    keyPoints: [conclusion],
    evidenceRefs: [],
    assumptions: [],
    uncertainties: [],
  });
}

function analysis(): string {
  return JSON.stringify({
    version: 1,
    consensus: ["Use a bounded experiment."],
    contradictions: [],
    partialCoverage: [],
    uniqueInsights: [],
    blindSpots: ["No runtime trace was supplied."],
    answerOutline: ["Explain the bounded experiment."],
    confidence: "medium",
  });
}

function successfulRunner(calls: LeafCapabilityRequest[] = []): LeafCapabilityRunner {
  return async (request) => {
    calls.push(request);
    const model = request.model ?? request.sessionModel;
    if (request.role === "fusion-judge") {
      return { degraded: false, text: analysis(), ...(model ? { model } : {}) };
    }
    return {
      degraded: false,
      text: opinion(`Opinion from ${request.role}`),
      ...(model ? { model } : {}),
    };
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("deliberateSparkFusion", () => {
  it("runs the default independent panels before a strict judge and preserves panel order", async () => {
    const calls: LeafCapabilityRequest[] = [];
    const result = await deliberateSparkFusion(
      { question: "Which probe best localizes the first divergence?", sessionModel: "local/main" },
      { runLeaf: successfulRunner(calls) },
    );

    expect(result.status).toBe("complete");
    expect(result.panels.map((panel) => panel.id)).toEqual(
      DEFAULT_FUSION_PANELS.map((panel) => panel.id),
    );
    expect(result.panels.every((panel) => panel.status === "succeeded")).toBe(true);
    expect(result.judge?.analysis.confidence).toBe("medium");
    expect(calls.map((call) => call.role)).toEqual([
      ...DEFAULT_FUSION_PANELS.map((panel) => `fusion-panel:${panel.id}`),
      "fusion-judge",
    ]);
    expect(calls.slice(0, 3).every((call) => call.brief.includes("untrusted data"))).toBe(true);
    expect(calls[3]?.brief).toContain("do not write the final user-facing answer");
  });

  it("starts all independent panels concurrently", async () => {
    const firstPanelRelease = Promise.withResolvers<void>();
    const allPanelsStarted = Promise.withResolvers<void>();
    const started: string[] = [];
    const pending = deliberateSparkFusion(
      {
        question: "Compare the active hypotheses.",
        panels: [
          { id: "first", perspective: "Perspective A" },
          { id: "second", perspective: "Perspective B" },
          { id: "third", perspective: "Perspective C" },
        ],
      },
      {
        runLeaf: async (request) => {
          if (request.role === "fusion-judge") {
            return { degraded: false, text: analysis() };
          }
          started.push(request.role);
          if (started.length === 3) allPanelsStarted.resolve();
          if (request.role === "fusion-panel:first") await firstPanelRelease.promise;
          return { degraded: false, text: opinion(request.role) };
        },
      },
    );

    await allPanelsStarted.promise;
    expect(started).toEqual([
      "fusion-panel:first",
      "fusion-panel:second",
      "fusion-panel:third",
    ]);
    firstPanelRelease.resolve();
    await expect(pending).resolves.toMatchObject({ status: "complete" });
  });

  it("honors explicit heterogeneous panel and judge models while retaining the session fallback", async () => {
    const calls: LeafCapabilityRequest[] = [];
    const result = await deliberateSparkFusion(
      {
        question: "Compare two hypotheses.",
        context: "trace:17 is the only observed evidence",
        panels: [
          { id: "first", perspective: "Argue hypothesis A.", model: "provider/a" },
          { id: "second", perspective: "Argue hypothesis B." },
        ],
        judgeModel: "provider/judge",
        sessionModel: "provider/session",
      },
      { runLeaf: successfulRunner(calls) },
    );

    expect(result.status).toBe("complete");
    expect(calls[0]).toMatchObject({ model: "provider/a", sessionModel: "provider/session" });
    expect(calls[1]).toMatchObject({ sessionModel: "provider/session" });
    expect(calls[1]).not.toHaveProperty("model");
    expect(calls[2]).toMatchObject({
      role: "fusion-judge",
      model: "provider/judge",
      sessionModel: "provider/session",
    });
    expect(result.panels.map((panel) => panel.model)).toEqual(["provider/a", "provider/session"]);
    expect(result.judge?.model).toBe("provider/judge");
  });

  it("returns partial without invoking a judge when fewer than two panels are valid", async () => {
    const calls: LeafCapabilityRequest[] = [];
    const runLeaf: LeafCapabilityRunner = async (request) => {
      calls.push(request);
      return request.role.endsWith(":valid")
        ? { degraded: false, text: opinion("Only valid opinion") }
        : { degraded: false, text: "not json" };
    };
    const result = await deliberateSparkFusion(
      {
        question: "A bounded question",
        panels: [
          { id: "valid", perspective: "Valid perspective" },
          { id: "invalid", perspective: "Invalid perspective" },
        ],
      },
      { runLeaf },
    );

    expect(result).toMatchObject({ status: "partial", failureCode: "insufficient-panels" });
    expect(result.panels.map((panel) => panel.status)).toEqual(["succeeded", "invalid"]);
    expect(calls).toHaveLength(2);
  });

  it("returns a judged partial result when some panels fail but two remain valid", async () => {
    const calls: LeafCapabilityRequest[] = [];
    const result = await deliberateSparkFusion(
      {
        question: "A bounded question",
        panels: [
          { id: "first", perspective: "Perspective A" },
          { id: "invalid", perspective: "Perspective B" },
          { id: "third", perspective: "Perspective C" },
        ],
      },
      {
        runLeaf: async (request) => {
          calls.push(request);
          if (request.role === "fusion-judge") {
            return { degraded: false, text: analysis() };
          }
          return request.role === "fusion-panel:invalid"
            ? { degraded: false, text: "not json" }
            : { degraded: false, text: opinion(request.role) };
        },
      },
    );

    expect(result).toMatchObject({
      status: "partial",
      failureCode: "panel-degraded",
      judge: { analysis: { confidence: "medium" } },
    });
    expect(result.panels.map((panel) => panel.status)).toEqual([
      "succeeded",
      "invalid",
      "succeeded",
    ]);
    expect(calls.at(-1)?.role).toBe("fusion-judge");
  });

  it("preserves valid panel opinions when the judge degrades or emits invalid output", async () => {
    const panels = [
      { id: "a", perspective: "Perspective A" },
      { id: "b", perspective: "Perspective B" },
    ];
    const degraded = await deliberateSparkFusion(
      { question: "Question", panels },
      {
        runLeaf: async (request) =>
          request.role === "fusion-judge"
            ? { degraded: true, text: "", reasonCode: "route-unavailable" }
            : { degraded: false, text: opinion(request.role) },
      },
    );
    const invalid = await deliberateSparkFusion(
      { question: "Question", panels },
      {
        runLeaf: async (request) =>
          request.role === "fusion-judge"
            ? { degraded: false, text: "{}" }
            : { degraded: false, text: opinion(request.role) },
      },
    );

    expect(degraded).toMatchObject({ status: "partial", failureCode: "judge-degraded" });
    expect(invalid).toMatchObject({ status: "partial", failureCode: "judge-output-invalid" });
    expect(degraded).toMatchObject({
      judgeFailure: { reasonCode: "route-unavailable" },
    });
    expect(invalid).toMatchObject({ judgeFailure: { reasonCode: "invalid-output" } });
    expect(degraded.panels.every((panel) => panel.opinion !== undefined)).toBe(true);
    expect(invalid.panels.every((panel) => panel.opinion !== undefined)).toBe(true);
    expect(degraded).not.toHaveProperty("judge");
    expect(invalid).not.toHaveProperty("judge");
  });

  it("rejects hallucinated and duplicate panel references in judge output", async () => {
    const runWithJudge = async (judgeText: string) =>
      await deliberateSparkFusion(
        {
          question: "Question",
          panels: [
            { id: "a", perspective: "Perspective A" },
            { id: "b", perspective: "Perspective B" },
          ],
        },
        {
          runLeaf: async (request) =>
            request.role === "fusion-judge"
              ? { degraded: false, text: judgeText }
              : { degraded: false, text: opinion(request.role) },
        },
      );
    const base = {
      version: 1,
      consensus: [],
      partialCoverage: [],
      uniqueInsights: [],
      blindSpots: [],
      answerOutline: [],
      confidence: "low",
    };
    const hallucinated = await runWithJudge(
      JSON.stringify({
        ...base,
        contradictions: [],
        uniqueInsights: [{ panelId: "invented", insight: "Unsupported attribution" }],
      }),
    );
    const duplicate = await runWithJudge(
      JSON.stringify({
        ...base,
        contradictions: [
          {
            topic: "Duplicate attribution",
            positions: [
              { panelId: "a", claim: "First claim" },
              { panelId: "a", claim: "Second claim" },
            ],
          },
        ],
      }),
    );

    expect(hallucinated).toMatchObject({
      status: "partial",
      failureCode: "judge-output-invalid",
    });
    expect(duplicate).toMatchObject({
      status: "partial",
      failureCode: "judge-output-invalid",
    });
    expect(hallucinated).not.toHaveProperty("judge");
    expect(duplicate).not.toHaveProperty("judge");
  });

  it("fails closed with stable reason codes and never returns thrown provider text", async () => {
    const result = await deliberateSparkFusion(
      {
        question: "Question",
        panels: [
          { id: "throws", perspective: "Throw" },
          { id: "degrades", perspective: "Degrade" },
        ],
      },
      {
        runLeaf: async (request) => {
          if (request.role.endsWith(":throws")) throw new Error("secret provider token=abc123");
          return { degraded: true, text: "raw provider failure", reasonCode: "no-model" };
        },
      },
    );

    expect(result).toMatchObject({ status: "failed", failureCode: "insufficient-panels" });
    expect(result.panels.map((panel) => panel.reasonCode)).toEqual([
      "model-call-failed",
      "no-model",
    ]);
    expect(JSON.stringify(result)).not.toContain("abc123");
    expect(JSON.stringify(result)).not.toContain("raw provider failure");
  });

  it("aborts all in-flight leaves at the overall timeout and reports timeout mechanically", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const pending = deliberateSparkFusion(
      { question: "Question", timeoutMs: 1_000 },
      {
        runLeaf: async (request) => {
          if (request.signal) signals.push(request.signal);
          return await new Promise(() => undefined);
        },
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.panels.map((panel) => panel.reasonCode)).toEqual([
      "timeout",
      "timeout",
      "timeout",
    ]);
  });

  it("reports a Judge-phase timeout without discarding valid panel opinions", async () => {
    vi.useFakeTimers();
    const judgeStarted = Promise.withResolvers<void>();
    const pending = deliberateSparkFusion(
      {
        question: "Question",
        timeoutMs: 1_000,
        panels: [
          { id: "a", perspective: "Perspective A" },
          { id: "b", perspective: "Perspective B" },
        ],
      },
      {
        runLeaf: async (request) => {
          if (request.role !== "fusion-judge") {
            return { degraded: false, text: opinion(request.role) };
          }
          judgeStarted.resolve();
          return await new Promise(() => undefined);
        },
      },
    );

    await judgeStarted.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result).toMatchObject({
      status: "partial",
      failureCode: "judge-degraded",
      judgeFailure: { reasonCode: "timeout" },
    });
    expect(result.panels.every((panel) => panel.status === "succeeded")).toBe(true);
  });

  it("propagates parent cancellation separately from a timeout", async () => {
    const controller = new AbortController();
    const pending = deliberateSparkFusion(
      { question: "Question", signal: controller.signal },
      { runLeaf: async () => await new Promise(() => undefined) },
    );
    controller.abort();
    const result = await pending;

    expect(result.status).toBe("failed");
    expect(result.panels.map((panel) => panel.reasonCode)).toEqual([
      "aborted",
      "aborted",
      "aborted",
    ]);
  });

  it("rejects unbounded, duplicate, or empty panel requests before model execution", async () => {
    const runLeaf = vi.fn(successfulRunner());
    await expect(
      deliberateSparkFusion(
        {
          question: "Question",
          panels: [
            { id: "same", perspective: "A" },
            { id: "same", perspective: "B" },
          ],
        },
        { runLeaf },
      ),
    ).rejects.toThrow("ids must be unique");
    await expect(deliberateSparkFusion({ question: "  " }, { runLeaf })).rejects.toThrow(
      "must not be empty",
    );
    expect(runLeaf).not.toHaveBeenCalled();
  });
});
