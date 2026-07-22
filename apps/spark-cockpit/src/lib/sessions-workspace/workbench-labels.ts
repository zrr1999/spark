import type { SessionStatusBarLabels } from "$lib/components/conversation";
import type { ConversationPartLabels } from "$lib/components/conversation/types";
import type { ModelRuntimeControlLabels } from "$lib/components/model-selector";
import type { SessionsWorkbenchCopy } from "./types";

export function buildModelRuntimeLabels(copy: SessionsWorkbenchCopy): ModelRuntimeControlLabels {
  return {
    aria: copy.modelRuntimeAria,
    model: copy.modelLabel,
    thinking: copy.thinkingLabel,
    chooseModel: copy.chooseModel,
    chooseModelHint: copy.chooseModelHint,
    searchModels: copy.searchModels,
    noModelsFound: copy.noModelsFound,
    closeModelPicker: copy.closeModelPicker,
    clearModelSearch: copy.clearModelSearch,
    modelUnavailable: copy.modelUnavailable,
    configureModels: copy.configureModels,
    thinkingLevels: {
      off: copy.thinkingOff,
      minimal: copy.thinkingMinimal,
      low: copy.thinkingLow,
      medium: copy.thinkingMedium,
      high: copy.thinkingHigh,
      xhigh: copy.thinkingXHigh,
    },
  };
}

export function buildStatusBarLabels(copy: SessionsWorkbenchCopy): SessionStatusBarLabels {
  return {
    bar: copy.runtimeStatusBar,
    workingDirectory: copy.workingDirectory,
    branch: copy.gitBranch,
    inputTokens: copy.inputTokens,
    outputTokens: copy.outputTokens,
    cacheReadTokens: copy.cacheReadTokens,
    cacheWriteTokens: copy.cacheWriteTokens,
    cacheHit: copy.cacheHit,
    cost: copy.cost,
    context: copy.contextUsage,
  };
}

export function buildConversationPartLabels(copy: SessionsWorkbenchCopy): ConversationPartLabels {
  return {
    reasoning: copy.reasoning,
    reasoningStreaming: copy.reasoningStreaming,
    chain: copy.chain,
    chainStreaming: copy.chainStreaming,
    chainEmpty: copy.chainEmpty,
    chainFailed: copy.chainFailed,
    tool: copy.tool,
    task: copy.task,
    approval: copy.approval,
    unknown: copy.unknownPart,
    collapse: copy.collapse,
    expand: copy.expand,
    budgetExhausted: copy.budgetExhausted,
    budgetExhaustedHint: copy.budgetExhaustedHint,
  };
}
