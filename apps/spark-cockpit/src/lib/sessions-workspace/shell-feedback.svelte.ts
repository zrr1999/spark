import type { SubmissionState } from "./types";
import type { ShellFormFeedbackState } from "./bind-form-enhancers";

export function createShellFeedbackController() {
  let retryState = $state<SubmissionState>("idle");
  let modelState = $state<SubmissionState>("idle");
  let thinkingState = $state<SubmissionState>("idle");
  let retryFeedback = $state<string | null>(null);
  let modelFeedback = $state<string | null>(null);
  let thinkingFeedback = $state<string | null>(null);
  let modelFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let thinkingFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let retryPrompt = $state("");
  let retrySubmissionId = $state("");
  let cancelState = $state<SubmissionState>("idle");
  let cancelFeedback = $state<string | null>(null);
  let cancelledTurnId = $state<string | null>(null);
  let dequeueState = $state<SubmissionState>("idle");
  let dequeueFeedback = $state<string | null>(null);
  let dequeuingTurnId = $state<string | null>(null);

  const formFeedback: ShellFormFeedbackState = {
    getCancelState: () => cancelState,
    getCancelFeedback: () => cancelFeedback,
    getCancelledTurnId: () => cancelledTurnId,
    setCancelState: (value) => {
      cancelState = value;
    },
    setCancelFeedback: (value) => {
      cancelFeedback = value;
    },
    setCancelledTurnId: (value) => {
      cancelledTurnId = value;
    },
    getDequeueState: () => dequeueState,
    getDequeueFeedback: () => dequeueFeedback,
    getDequeuingTurnId: () => dequeuingTurnId,
    setDequeueState: (value) => {
      dequeueState = value;
    },
    setDequeueFeedback: (value) => {
      dequeueFeedback = value;
    },
    setDequeuingTurnId: (value) => {
      dequeuingTurnId = value;
    },
    setModelState: (value) => {
      modelState = value;
    },
    setModelFeedback: (value) => {
      modelFeedback = value;
    },
    clearModelFeedbackTimer: () => {
      if (modelFeedbackTimer) clearTimeout(modelFeedbackTimer);
      modelFeedbackTimer = null;
    },
    armModelFeedbackClear: () => {
      modelFeedbackTimer = setTimeout(() => {
        modelFeedback = null;
        modelFeedbackTimer = null;
      }, 3_500);
    },
    setThinkingState: (value) => {
      thinkingState = value;
    },
    setThinkingFeedback: (value) => {
      thinkingFeedback = value;
    },
    clearThinkingFeedbackTimer: () => {
      if (thinkingFeedbackTimer) clearTimeout(thinkingFeedbackTimer);
      thinkingFeedbackTimer = null;
    },
    armThinkingFeedbackClear: () => {
      thinkingFeedbackTimer = setTimeout(() => {
        thinkingFeedback = null;
        thinkingFeedbackTimer = null;
      }, 3_500);
    },
    setRetryState: (value) => {
      retryState = value;
    },
    setRetryFeedback: (value) => {
      retryFeedback = value;
    },
    setRetrySubmissionId: (value) => {
      retrySubmissionId = value;
    },
  };

  function dispose() {
    if (modelFeedbackTimer) clearTimeout(modelFeedbackTimer);
    if (thinkingFeedbackTimer) clearTimeout(thinkingFeedbackTimer);
    modelFeedbackTimer = null;
    thinkingFeedbackTimer = null;
  }

  return {
    formFeedback,
    dispose,
    get retryState() {
      return retryState;
    },
    set retryState(value: SubmissionState) {
      retryState = value;
    },
    get modelState() {
      return modelState;
    },
    get thinkingState() {
      return thinkingState;
    },
    get retryFeedback() {
      return retryFeedback;
    },
    set retryFeedback(value: string | null) {
      retryFeedback = value;
    },
    get modelFeedback() {
      return modelFeedback;
    },
    get thinkingFeedback() {
      return thinkingFeedback;
    },
    get retryPrompt() {
      return retryPrompt;
    },
    set retryPrompt(value: string) {
      retryPrompt = value;
    },
    get retrySubmissionId() {
      return retrySubmissionId;
    },
    set retrySubmissionId(value: string) {
      retrySubmissionId = value;
    },
    get cancelState() {
      return cancelState;
    },
    set cancelState(value: SubmissionState) {
      cancelState = value;
    },
    get cancelFeedback() {
      return cancelFeedback;
    },
    set cancelFeedback(value: string | null) {
      cancelFeedback = value;
    },
    get cancelledTurnId() {
      return cancelledTurnId;
    },
    get dequeueState() {
      return dequeueState;
    },
    get dequeueFeedback() {
      return dequeueFeedback;
    },
    set dequeueFeedback(value: string | null) {
      dequeueFeedback = value;
    },
    get dequeuingTurnId() {
      return dequeuingTurnId;
    },
    applyDequeueReset(next: {
      dequeueState: SubmissionState;
      dequeueFeedback: string | null;
      dequeuingTurnId: string | null;
    }) {
      dequeueState = next.dequeueState;
      dequeueFeedback = next.dequeueFeedback;
      dequeuingTurnId = next.dequeuingTurnId;
    },
    applyCancelReset(next: { cancelState: SubmissionState; cancelFeedback: string | null }) {
      cancelState = next.cancelState;
      cancelFeedback = next.cancelFeedback;
    },
  };
}

export type ShellFeedbackController = ReturnType<typeof createShellFeedbackController>;
