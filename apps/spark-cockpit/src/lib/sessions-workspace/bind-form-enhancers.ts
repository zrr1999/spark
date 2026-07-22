import type { ComposerController } from "./composer.svelte";
import { createSessionFormEnhancers, type FormEnhancerDeps } from "./form-enhancers";
import type { SessionsWorkbenchCopy, SubmissionState } from "./types";

export type ShellFormFeedbackState = {
  getCancelState: () => SubmissionState;
  getCancelFeedback: () => string | null;
  getCancelledTurnId: () => string | null;
  setCancelState: (value: SubmissionState) => void;
  setCancelFeedback: (value: string | null) => void;
  setCancelledTurnId: (value: string | null) => void;
  getDequeueState: () => SubmissionState;
  getDequeueFeedback: () => string | null;
  getDequeuingTurnId: () => string | null;
  setDequeueState: (value: SubmissionState) => void;
  setDequeueFeedback: (value: string | null) => void;
  setDequeuingTurnId: (value: string | null) => void;
  setModelState: (value: SubmissionState) => void;
  setModelFeedback: (value: string | null) => void;
  clearModelFeedbackTimer: () => void;
  armModelFeedbackClear: () => void;
  setThinkingState: (value: SubmissionState) => void;
  setThinkingFeedback: (value: string | null) => void;
  clearThinkingFeedbackTimer: () => void;
  armThinkingFeedbackClear: () => void;
  setRetryState: (value: SubmissionState) => void;
  setRetryFeedback: (value: string | null) => void;
  setRetrySubmissionId: (value: string) => void;
};

export function bindSessionFormEnhancers(input: {
  composer: ComposerController;
  getCopy: () => SessionsWorkbenchCopy;
  getActiveWorkspaceId: () => string;
  getSelectedSessionId: () => string | null;
  getEffectiveModelValue: () => string;
  getEffectiveThinkingLevel: () => string;
  shell: ShellFormFeedbackState;
  adoptQueuedTurn: (result: unknown) => void;
  adoptCancelledTurn: (result: unknown) => void;
  invalidateAll: () => Promise<void>;
}) {
  const { composer, shell } = input;
  const deps: FormEnhancerDeps = {
    get copy() {
      return input.getCopy();
    },
    getActiveWorkspaceId: input.getActiveWorkspaceId,
    getStartModel: () => composer.startModel,
    getStartThinkingLevel: () => composer.startThinkingLevel,
    getStartSubmissionId: () => composer.startSubmissionId,
    setStartSubmissionId: (value) => {
      composer.startSubmissionId = value;
    },
    getLastStartSubmittedContextKey: () => composer.lastStartSubmittedContextKey,
    setLastStartSubmittedContextKey: (value) => {
      composer.lastStartSubmittedContextKey = value;
    },
    setStartState: (value) => {
      composer.startState = value;
    },
    setStartFeedback: (value) => {
      composer.startFeedback = value;
    },
    setStartMessage: (value) => {
      composer.startMessage = value;
    },
    getSelectedSessionId: input.getSelectedSessionId,
    getSendSubmissionId: () => composer.sendSubmissionId,
    setSendSubmissionId: (value) => {
      composer.sendSubmissionId = value;
    },
    getLastSubmittedMessage: () => composer.lastSubmittedMessage,
    setLastSubmittedMessage: (value) => {
      composer.lastSubmittedMessage = value;
    },
    setSendState: (value) => {
      composer.sendState = value;
    },
    setSendFeedback: (value) => {
      composer.sendFeedback = value;
    },
    setMessage: (value) => {
      composer.message = value;
    },
    getCancelState: shell.getCancelState,
    getCancelFeedback: shell.getCancelFeedback,
    getCancelledTurnId: shell.getCancelledTurnId,
    setCancelState: shell.setCancelState,
    setCancelFeedback: shell.setCancelFeedback,
    setCancelledTurnId: shell.setCancelledTurnId,
    getDequeueState: shell.getDequeueState,
    getDequeueFeedback: shell.getDequeueFeedback,
    getDequeuingTurnId: shell.getDequeuingTurnId,
    setDequeueState: shell.setDequeueState,
    setDequeueFeedback: shell.setDequeueFeedback,
    setDequeuingTurnId: shell.setDequeuingTurnId,
    getSessionModel: () => composer.sessionModel,
    setSessionModel: (value) => {
      composer.sessionModel = value;
    },
    getEffectiveModelValue: input.getEffectiveModelValue,
    setModelState: shell.setModelState,
    setModelFeedback: shell.setModelFeedback,
    clearModelFeedbackTimer: shell.clearModelFeedbackTimer,
    armModelFeedbackClear: shell.armModelFeedbackClear,
    getSessionThinkingLevel: () => composer.sessionThinkingLevel,
    setSessionThinkingLevel: (value) => {
      composer.sessionThinkingLevel = value;
    },
    getEffectiveThinkingLevel: input.getEffectiveThinkingLevel,
    setThinkingState: shell.setThinkingState,
    setThinkingFeedback: shell.setThinkingFeedback,
    clearThinkingFeedbackTimer: shell.clearThinkingFeedbackTimer,
    armThinkingFeedbackClear: shell.armThinkingFeedbackClear,
    setRetryState: shell.setRetryState,
    setRetryFeedback: shell.setRetryFeedback,
    setRetrySubmissionId: shell.setRetrySubmissionId,
    startConversationContext: composer.startConversationContext,
    adoptQueuedTurn: input.adoptQueuedTurn,
    adoptCancelledTurn: input.adoptCancelledTurn,
    invalidateAll: input.invalidateAll,
  };
  return createSessionFormEnhancers(deps);
}
