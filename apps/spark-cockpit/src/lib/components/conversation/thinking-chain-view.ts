import type { ConversationChainStep } from "./types";

const TERMINAL_ISSUE_STATES = new Set(["failed", "denied", "cancelled"]);

export function visibleThinkingChainSteps(
  steps: readonly ConversationChainStep[],
): ConversationChainStep[] {
  return steps.filter((step) => {
    if (step.type === "tool") return true;
    if (step.type === "reasoning" && step.redacted) return true;
    return step.summary.trim().length > 0;
  });
}

export function thinkingChainHasTerminalIssue(steps: readonly ConversationChainStep[]) {
  return steps.some((step) => step.type === "tool" && TERMINAL_ISSUE_STATES.has(step.state));
}

export function thinkingChainNeedsFailureSummary(steps: readonly ConversationChainStep[]) {
  const failedSteps = steps.filter(
    (step) => step.type === "tool" && TERMINAL_ISSUE_STATES.has(step.state),
  );
  return (
    failedSteps.length > 0 &&
    failedSteps.every((step) => step.type === "tool" && !step.summary?.trim())
  );
}

export function isVisibleThinkingChain(
  state: "streaming" | "complete",
  steps: readonly ConversationChainStep[],
) {
  return state === "streaming" || visibleThinkingChainSteps(steps).length > 0;
}
