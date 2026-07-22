import type { SubmissionState } from "./types";

export type CancelTurnUiState = {
  cancelState: SubmissionState;
  cancelFeedback: string | null;
  cancelledTurnId: string | null;
};

export type DequeueTurnUiState = {
  dequeueState: SubmissionState;
  dequeueFeedback: string | null;
  dequeuingTurnId: string | null;
};

/** Reset cancel chrome when a different live turn becomes active. */
export function resetCancelUiForActiveTurn(
  state: CancelTurnUiState,
  activeTurnId: string | null | undefined,
): CancelTurnUiState {
  if (
    activeTurnId &&
    activeTurnId !== state.cancelledTurnId &&
    state.cancelState !== "submitting"
  ) {
    return { cancelState: "idle", cancelFeedback: null, cancelledTurnId: state.cancelledTurnId };
  }
  return state;
}

export function beginCancelSubmit(state: CancelTurnUiState): CancelTurnUiState {
  return { ...state, cancelState: "submitting", cancelFeedback: null };
}

export function applyCancelSubmitResult(
  state: CancelTurnUiState,
  input: {
    resultType: string;
    confirmedCancelledTurnId: string | null;
    errorMessage: string;
  },
): CancelTurnUiState {
  if (input.resultType === "success") {
    return {
      cancelState: "success",
      cancelledTurnId: input.confirmedCancelledTurnId,
      cancelFeedback: null,
    };
  }
  if (input.resultType === "redirect") return state;
  return {
    ...state,
    cancelState: "error",
    cancelFeedback: input.errorMessage,
  };
}

export function beginDequeueSubmit(
  state: DequeueTurnUiState,
  requestedTurnId: string,
): DequeueTurnUiState {
  return {
    dequeueState: "submitting",
    dequeueFeedback: null,
    dequeuingTurnId: requestedTurnId || null,
  };
}

export function applyDequeueSubmitResult(
  state: DequeueTurnUiState,
  input: {
    resultType: string;
    successMessage: string;
    errorMessage: string;
  },
): DequeueTurnUiState {
  if (input.resultType === "success") {
    return {
      dequeueState: "success",
      dequeueFeedback: input.successMessage,
      dequeuingTurnId: null,
    };
  }
  if (input.resultType === "redirect") return state;
  return {
    dequeueState: "error",
    dequeueFeedback: input.errorMessage,
    dequeuingTurnId: null,
  };
}

export function resetDequeueUiOnSessionChange(): DequeueTurnUiState {
  return { dequeueState: "idle", dequeueFeedback: null, dequeuingTurnId: null };
}
