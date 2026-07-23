import type { ConversationChainStep, ConversationPartLabels } from "./types";

export const thinkingChainLabels: ConversationPartLabels = {
  reasoning: "REASONING",
  reasoningStreaming: "REASONING_STREAMING",
  chain: "CHAIN_COMPLETE",
  chainStreaming: "CHAIN_STREAMING",
  chainEmpty: "CHAIN_EMPTY",
  chainFailed: "CHAIN_FAILED",
  tool: "TOOL",
  task: "TASK",
  approval: "APPROVAL",
  unknown: "UNKNOWN",
  collapse: "COLLAPSE",
  expand: "EXPAND",
  budgetExhausted: "BUDGET_EXHAUSTED",
  budgetExhaustedHint: "BUDGET_EXHAUSTED_HINT",
};

export const activeThinkingChainSteps: ConversationChainStep[] = [
  {
    type: "reasoning",
    summary: "Investigating the first divergence",
    state: "streaming",
  },
  {
    type: "commentary",
    summary: "The focused probe is running",
    state: "complete",
  },
  {
    type: "tool",
    callId: "call-pending",
    name: "search",
    state: "pending",
  },
  {
    type: "tool",
    callId: "call-running",
    name: "exec",
    state: "running",
    summary: "Running focused probe",
  },
  {
    type: "tool",
    callId: "call-failed",
    name: "edit",
    state: "failed",
  },
];
