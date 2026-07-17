import { describe, expect, it } from "vitest";

import {
  isVisibleThinkingChain,
  thinkingChainHasTerminalIssue,
  thinkingChainNeedsFailureSummary,
  visibleThinkingChainSteps,
} from "./thinking-chain-view";

describe("thinking chain presentation", () => {
  it("drops empty completed reasoning instead of rendering an empty shell", () => {
    const steps = [{ type: "reasoning" as const, summary: "  ", state: "complete" as const }];

    expect(visibleThinkingChainSteps(steps)).toEqual([]);
    expect(isVisibleThinkingChain("complete", steps)).toBe(false);
    expect(isVisibleThinkingChain("streaming", steps)).toBe(true);
  });

  it("keeps redacted reasoning and tool status as meaningful execution detail", () => {
    const steps = [
      { type: "reasoning" as const, summary: "", state: "complete" as const, redacted: true },
      {
        type: "tool" as const,
        callId: "call-1",
        name: "edit",
        state: "completed" as const,
      },
    ];

    expect(visibleThinkingChainSteps(steps)).toEqual(steps);
    expect(isVisibleThinkingChain("complete", steps)).toBe(true);
  });

  it("flags terminal failures that do not include an error summary", () => {
    const missing = [
      { type: "tool" as const, callId: "call-1", name: "edit", state: "failed" as const },
    ];
    const explained = [{ ...missing[0], summary: "Patch did not apply" }];

    expect(thinkingChainHasTerminalIssue(missing)).toBe(true);
    expect(thinkingChainNeedsFailureSummary(missing)).toBe(true);
    expect(thinkingChainNeedsFailureSummary(explained)).toBe(false);
  });
});
