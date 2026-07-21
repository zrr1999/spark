import { describe, expect, it } from "vitest";
import {
  describeSessionStatus,
  formatCompactTokenCount,
  formatContextUsage,
  formatSessionCost,
  formatSessionStatusPercent,
  sessionStatusIdentity,
  sessionStatusUsage,
  type SessionStatusBarLabels,
} from "./session-status";

const labels: SessionStatusBarLabels = {
  bar: "Session runtime status",
  workingDirectory: "Working directory",
  branch: "Git branch",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  cacheReadTokens: "Cache read tokens",
  cacheWriteTokens: "Cache write tokens",
  cacheHit: "Latest cache hit",
  cost: "Cost",
  context: "Context",
};

describe("session status formatting", () => {
  it("formats dense token, cache, cost, and context values", () => {
    expect(formatCompactTokenCount(19_000_000)).toBe("19M");
    expect(formatCompactTokenCount(820_000)).toBe("820k");
    expect(formatCompactTokenCount(230_000_000)).toBe("230M");
    expect(formatSessionStatusPercent(99.34)).toBe("99.3%");
    expect(formatSessionCost(23.509)).toBe("$23.509");
    expect(formatContextUsage(262_632, 372_000)).toBe("70.6%/372k");
  });

  it("omits invalid usage and keeps a known context window visible", () => {
    expect(formatCompactTokenCount(Number.NaN)).toBeUndefined();
    expect(formatCompactTokenCount(-1)).toBeUndefined();
    expect(formatSessionStatusPercent(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(formatSessionCost(-0.1)).toBeUndefined();
    expect(formatContextUsage(undefined, 372_000)).toBe("—/372k");
    expect(formatContextUsage(10, 0)).toBeUndefined();
  });

  it("builds a localized accessible description from the same values", () => {
    const description = describeSessionStatus(labels, {
      cwd: "~/workspace/zrr1999/spark",
      gitBranch: "main",
      inputTokens: 19_000_000,
      outputTokens: 820_000,
      cacheReadTokens: 230_000_000,
      latestCacheHitPercent: 99.3,
      costUsd: 23.509,
      contextTokens: 262_632,
      contextWindow: 372_000,
    });

    expect(description).toContain("Working directory: ~/workspace/zrr1999/spark");
    expect(description).toContain("Input tokens: 19000000");
    expect(description).toContain("Context: 70.6%/372k");
    expect(description).not.toContain("gpt-5.6-sol");
  });

  it("adds live run totals to the full-transcript snapshot baseline", () => {
    const usage = sessionStatusUsage(
      {
        version: 1,
        sessionId: "session-usage",
        status: "running",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          costUsd: 0.1,
          latestCacheHitPercent: 40,
          contextTokens: 210,
        },
        messages: [],
        tools: [],
        runs: [
          {
            version: 1,
            id: "run-live",
            kind: "session",
            status: "running",
            artifactRefs: [],
            metadata: {
              usageTotals: {
                inputTokens: 40,
                outputTokens: 8,
                cacheReadTokens: 160,
                cacheWriteTokens: 0,
                costUsd: 0.2,
                latestCacheHitPercent: 80,
                contextTokens: 208,
              },
            },
          },
        ],
        tasks: [],
        artifacts: [],
        evidence: [],
        metadata: {},
      },
      372_000,
    );

    expect(usage).toMatchObject({
      inputTokens: 140,
      outputTokens: 28,
      cacheReadTokens: 240,
      cacheWriteTokens: 10,
      costUsd: expect.closeTo(0.3, 10),
      latestCacheHitPercent: 80,
      contextTokens: 208,
      contextWindow: 372_000,
    });
  });

  it("keeps canonical session identity when control has no session state", () => {
    expect(
      sessionStatusIdentity(
        {
          version: 1,
          sessionId: "session-identity",
          status: "idle",
          model: { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" },
          thinkingLevel: "xhigh",
          messages: [],
          tools: [],
          runs: [],
          tasks: [],
          artifacts: [],
          evidence: [],
          metadata: {},
        },
        { defaultModel: { providerName: "fallback", modelId: "default" } },
      ),
    ).toEqual({
      model: { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" },
      thinkingLevel: "xhigh",
    });
  });
});
