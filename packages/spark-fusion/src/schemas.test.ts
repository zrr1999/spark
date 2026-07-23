import { describe, expect, it } from "vitest";
import { parseFusionAnalysis, parseFusionOpinion } from "./schemas.ts";

describe("Fusion output schemas", () => {
  it("accepts an exact opinion object and one JSON fence", () => {
    const opinion = {
      version: 1,
      conclusion: "Use the smaller probe first.",
      keyPoints: ["It isolates one boundary."],
      evidenceRefs: ["trace:17"],
      assumptions: ["The trace is reproducible."],
      uncertainties: [],
    };

    expect(parseFusionOpinion(JSON.stringify(opinion))).toEqual(opinion);
    expect(parseFusionOpinion(`\`\`\`json\n${JSON.stringify(opinion)}\n\`\`\``)).toEqual(opinion);
  });

  it("rejects prose, missing fields, extra fields, and empty array entries", () => {
    const opinion = {
      version: 1,
      conclusion: "A conclusion",
      keyPoints: [],
      evidenceRefs: [],
      assumptions: [],
      uncertainties: [],
    };

    expect(parseFusionOpinion(`Result: ${JSON.stringify(opinion)}`)).toBeUndefined();
    expect(parseFusionOpinion(JSON.stringify({ ...opinion, extra: true }))).toBeUndefined();
    expect(
      parseFusionOpinion(JSON.stringify({ ...opinion, assumptions: undefined })),
    ).toBeUndefined();
    expect(parseFusionOpinion(JSON.stringify({ ...opinion, keyPoints: [" "] }))).toBeUndefined();
    expect(
      parseFusionOpinion(JSON.stringify({ ...opinion, conclusion: "x".repeat(64_001) })),
    ).toBeUndefined();
  });

  it("validates nested judge contradictions and rejects malformed comparisons", () => {
    const analysis = {
      version: 1,
      consensus: ["Both panels prefer a bounded probe."],
      contradictions: [
        {
          topic: "Probe location",
          positions: [
            { panelId: "left", claim: "Probe before attention." },
            { panelId: "right", claim: "Probe after attention." },
          ],
        },
      ],
      partialCoverage: [],
      uniqueInsights: [{ panelId: "left", insight: "Reuse the saved activation." }],
      blindSpots: [],
      answerOutline: ["State the disagreement."],
      confidence: "medium",
    };

    expect(parseFusionAnalysis(JSON.stringify(analysis))).toEqual(analysis);
    expect(
      parseFusionAnalysis(
        JSON.stringify({
          ...analysis,
          contradictions: [
            {
              topic: "Only one position",
              positions: analysis.contradictions[0]?.positions.slice(0, 1),
            },
          ],
        }),
      ),
    ).toBeUndefined();
    expect(
      parseFusionAnalysis(JSON.stringify({ ...analysis, confidence: "certain" })),
    ).toBeUndefined();
  });
});
