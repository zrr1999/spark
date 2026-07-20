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

  it("keeps internal cue transport failures visible but removes their raw diagnostic", () => {
    const internalFailure = {
      type: "tool" as const,
      callId: "call-cue",
      name: "cue_exec",
      state: "failed" as const,
      summary:
        "cue-shell error [TRANSPORT_RESOLVE_FAILED]: failed to resolve cue-shell client transport",
    };

    const visibleInternalFailure = visibleThinkingChainSteps([internalFailure]);
    expect(visibleInternalFailure).toEqual([
      {
        type: "tool",
        callId: "call-cue",
        name: "cue_exec",
        state: "failed",
      },
    ]);
    expect(JSON.stringify(visibleInternalFailure)).not.toContain("TRANSPORT_RESOLVE_FAILED");
    expect(isVisibleThinkingChain("complete", [internalFailure])).toBe(true);
    expect(thinkingChainHasTerminalIssue([internalFailure])).toBe(true);
    expect(thinkingChainNeedsFailureSummary([internalFailure])).toBe(true);

    const userRelevantFailure = {
      type: "tool" as const,
      callId: "call-edit",
      name: "edit",
      state: "failed" as const,
      summary: "Patch did not apply",
    };
    expect(visibleThinkingChainSteps([internalFailure, userRelevantFailure])).toEqual([
      {
        type: "tool",
        callId: "call-cue",
        name: "cue_exec",
        state: "failed",
      },
      userRelevantFailure,
    ]);
    expect(thinkingChainHasTerminalIssue([internalFailure, userRelevantFailure])).toBe(true);
  });
});
