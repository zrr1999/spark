import { isInternalExecutionTransportFailure } from "./internal-execution-detail";
import type { ConversationChainStep } from "./types";

const TERMINAL_ISSUE_STATES = new Set(["failed", "denied", "cancelled"]);

export function visibleThinkingChainSteps(
  steps: readonly ConversationChainStep[],
): ConversationChainStep[] {
  return steps.flatMap<ConversationChainStep>((step) => {
    if (step.type === "tool") {
      if (isInternalExecutionTransportFailure(step.summary, step.name)) {
        return [
          {
            type: "tool",
            callId: step.callId,
            name: step.name,
            state: step.state,
          },
        ];
      }
      return [step];
    }
    if (step.type === "reasoning" && step.redacted) return [step];
    return step.summary.trim().length > 0 ? [step] : [];
  });
}

export function thinkingChainHasTerminalIssue(steps: readonly ConversationChainStep[]) {
  return visibleThinkingChainSteps(steps).some(
    (step) => step.type === "tool" && TERMINAL_ISSUE_STATES.has(step.state),
  );
}

export function thinkingChainNeedsFailureSummary(steps: readonly ConversationChainStep[]) {
  const failedSteps = visibleThinkingChainSteps(steps).filter(
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
