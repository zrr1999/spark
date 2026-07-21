import type { SubmitFunction } from "@sveltejs/kit";
import { createId } from "@zendev-lab/spark-protocol";
import {
  readStartConversationPendingSubmission,
  startConversationPendingSubmissionMatches,
  startConversationSubmissionContextKey,
  writeSessionDraft,
  writeSessionPendingSubmission,
  writeStartConversationPendingSubmission,
  type StartConversationSubmissionContext,
} from "$lib/session-draft";
import { cockpitSlashSubmissionError } from "$lib/slash-actions";
import { cancelledTurnIdFromActionResult } from "$lib/session-action-result";
import {
  applyCancelSubmitResult,
  applyDequeueSubmitResult,
  beginCancelSubmit,
  beginDequeueSubmit,
} from "./cancel-dequeue";
import { resultMessage, resultModel } from "./form-results";
import type { SessionsWorkbenchCopy, SubmissionState } from "./types";

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export type FormEnhancerDeps = {
  copy: SessionsWorkbenchCopy;
  getActiveWorkspaceId: () => string;
  getStartModel: () => string;
  getStartThinkingLevel: () => string;
  getStartSubmissionId: () => string;
  setStartSubmissionId: (value: string) => void;
  getLastStartSubmittedContextKey: () => string;
  setLastStartSubmittedContextKey: (value: string) => void;
  setStartState: (value: SubmissionState) => void;
  setStartFeedback: (value: string | null) => void;
  setStartMessage: (value: string) => void;
  getSelectedSessionId: () => string | null;
  getSendSubmissionId: () => string;
  setSendSubmissionId: (value: string) => void;
  getLastSubmittedMessage: () => string;
  setLastSubmittedMessage: (value: string) => void;
  setSendState: (value: SubmissionState) => void;
  setSendFeedback: (value: string | null) => void;
  setMessage: (value: string) => void;
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
  getSessionModel: () => string;
  setSessionModel: (value: string) => void;
  getEffectiveModelValue: () => string;
  setModelState: (value: SubmissionState) => void;
  setModelFeedback: (value: string | null) => void;
  clearModelFeedbackTimer: () => void;
  armModelFeedbackClear: () => void;
  getSessionThinkingLevel: () => string;
  setSessionThinkingLevel: (value: string) => void;
  getEffectiveThinkingLevel: () => string;
  setThinkingState: (value: SubmissionState) => void;
  setThinkingFeedback: (value: string | null) => void;
  clearThinkingFeedbackTimer: () => void;
  armThinkingFeedbackClear: () => void;
  setRetryState: (value: SubmissionState) => void;
  setRetryFeedback: (value: string | null) => void;
  setRetrySubmissionId: (value: string) => void;
  startConversationContext: (
    context: StartConversationSubmissionContext,
  ) => StartConversationSubmissionContext;
  adoptQueuedTurn: (result: unknown) => void;
  adoptCancelledTurn: (result: unknown) => void;
  invalidateAll: () => Promise<void>;
};

export function createSessionFormEnhancers(deps: FormEnhancerDeps): {
  enhanceStartConversation: SubmitFunction;
  enhanceSendMessage: SubmitFunction;
  enhanceCancelTurn: SubmitFunction;
  enhanceRemoveQueuedTurn: SubmitFunction;
  enhanceSelectModel: SubmitFunction;
  enhanceSelectThinking: SubmitFunction;
  enhanceRetryMessage: SubmitFunction;
} {
  const enhanceStartConversation: SubmitFunction = ({ formData, cancel }) => {
    const slashError = cockpitSlashSubmissionError(
      formString(formData, "message"),
      deps.copy.slashActions,
    );
    if (slashError) {
      cancel();
      deps.setStartState("error");
      deps.setStartFeedback(slashError);
      return;
    }
    const context = deps.startConversationContext({
      workspaceId: formString(formData, "workspaceId") || deps.getActiveWorkspaceId(),
      message: formString(formData, "message"),
      model: formString(formData, "model"),
      thinkingLevel: formString(formData, "thinkingLevel"),
    });
    const pending = readStartConversationPendingSubmission(
      window.sessionStorage,
      context.workspaceId,
    );
    let startSubmissionId = deps.getStartSubmissionId();
    if (startConversationPendingSubmissionMatches(pending, context)) {
      startSubmissionId = pending.submissionId;
    } else if (
      !startSubmissionId ||
      (deps.getLastStartSubmittedContextKey() &&
        startConversationSubmissionContextKey(context) !== deps.getLastStartSubmittedContextKey())
    ) {
      startSubmissionId = createId("idem");
    }
    deps.setStartSubmissionId(startSubmissionId);
    deps.setLastStartSubmittedContextKey(startConversationSubmissionContextKey(context));
    formData.set("submissionId", startSubmissionId);
    writeStartConversationPendingSubmission(window.sessionStorage, context.workspaceId, {
      ...context,
      submissionId: startSubmissionId,
    });
    deps.setStartState("submitting");
    deps.setStartFeedback(deps.copy.sending);

    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "redirect") {
        writeStartConversationPendingSubmission(window.sessionStorage, context.workspaceId, null);
        return;
      }
      if (result.type === "success") {
        deps.setStartState("success");
        deps.setStartFeedback(resultMessage(result, deps.copy.sent));
        deps.setStartMessage("");
        deps.setStartSubmissionId(createId("idem"));
        deps.setLastStartSubmittedContextKey("");
        writeStartConversationPendingSubmission(window.sessionStorage, context.workspaceId, null);
        await deps.invalidateAll();
        return;
      }
      deps.setStartState("error");
      deps.setStartFeedback(resultMessage(result, deps.copy.startFailed));
    };
  };

  const enhanceSendMessage: SubmitFunction = ({ formData, cancel }) => {
    const slashError = cockpitSlashSubmissionError(
      formString(formData, "message"),
      deps.copy.slashActions,
    );
    if (slashError) {
      cancel();
      deps.setSendState("error");
      deps.setSendFeedback(slashError);
      return;
    }
    const submissionSessionId = deps.getSelectedSessionId() ?? "";
    const submittedMessage = formString(formData, "message").trim();
    let sendSubmissionId = deps.getSendSubmissionId();
    if (
      !sendSubmissionId ||
      (deps.getLastSubmittedMessage() && submittedMessage !== deps.getLastSubmittedMessage())
    ) {
      sendSubmissionId = createId("idem");
    }
    deps.setSendSubmissionId(sendSubmissionId);
    deps.setLastSubmittedMessage(submittedMessage);
    formData.set("submissionId", sendSubmissionId);
    writeSessionPendingSubmission(window.sessionStorage, submissionSessionId, {
      message: submittedMessage,
      submissionId: sendSubmissionId,
    });
    deps.setSendState("submitting");
    deps.setSendFeedback(deps.copy.sending);

    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "success") {
        deps.adoptQueuedTurn(result);
        deps.setSendState("success");
        deps.setSendFeedback(null);
        deps.setMessage("");
        writeSessionDraft(window.sessionStorage, submissionSessionId, "");
        writeSessionPendingSubmission(window.sessionStorage, submissionSessionId, null);
        deps.setSendSubmissionId(createId("idem"));
        deps.setLastSubmittedMessage("");
        await deps.invalidateAll();
        return;
      }
      if (result.type === "redirect") return;
      deps.setSendState("error");
      deps.setSendFeedback(resultMessage(result, deps.copy.sendFailed));
    };
  };

  const enhanceCancelTurn: SubmitFunction = () => {
    const started = beginCancelSubmit({
      cancelState: deps.getCancelState(),
      cancelFeedback: deps.getCancelFeedback(),
      cancelledTurnId: deps.getCancelledTurnId(),
    });
    deps.setCancelState(started.cancelState);
    deps.setCancelFeedback(started.cancelFeedback);

    return async ({ result, update }) => {
      const confirmedCancelledTurnId = cancelledTurnIdFromActionResult(result);
      await update({ reset: false });
      const next = applyCancelSubmitResult(
        {
          cancelState: deps.getCancelState(),
          cancelFeedback: deps.getCancelFeedback(),
          cancelledTurnId: deps.getCancelledTurnId(),
        },
        {
          resultType: result.type,
          confirmedCancelledTurnId,
          errorMessage: resultMessage(result, deps.copy.stopFailed),
        },
      );
      deps.setCancelState(next.cancelState);
      deps.setCancelFeedback(next.cancelFeedback);
      deps.setCancelledTurnId(next.cancelledTurnId);
      if (result.type === "success") {
        deps.adoptCancelledTurn(result);
        await deps.invalidateAll();
      }
    };
  };

  const enhanceRemoveQueuedTurn: SubmitFunction = ({ formData }) => {
    const requestedTurnId = formString(formData, "turnId").trim();
    const started = beginDequeueSubmit(
      {
        dequeueState: deps.getDequeueState(),
        dequeueFeedback: deps.getDequeueFeedback(),
        dequeuingTurnId: deps.getDequeuingTurnId(),
      },
      requestedTurnId,
    );
    deps.setDequeueState(started.dequeueState);
    deps.setDequeueFeedback(started.dequeueFeedback);
    deps.setDequeuingTurnId(started.dequeuingTurnId);

    return async ({ result, update }) => {
      await update({ reset: false });
      const next = applyDequeueSubmitResult(
        {
          dequeueState: deps.getDequeueState(),
          dequeueFeedback: deps.getDequeueFeedback(),
          dequeuingTurnId: deps.getDequeuingTurnId(),
        },
        {
          resultType: result.type,
          successMessage: resultMessage(result, deps.copy.removeQueued),
          errorMessage: resultMessage(result, deps.copy.removeQueuedFailed),
        },
      );
      deps.setDequeueState(next.dequeueState);
      deps.setDequeueFeedback(next.dequeueFeedback);
      deps.setDequeuingTurnId(next.dequeuingTurnId);
      if (result.type === "success") deps.adoptCancelledTurn(result);
      if (result.type !== "redirect") await deps.invalidateAll();
    };
  };

  const enhanceSelectModel: SubmitFunction = () => {
    deps.clearModelFeedbackTimer();
    deps.setModelState("submitting");
    deps.setModelFeedback(deps.copy.sending);
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "success") {
        deps.setModelState("success");
        deps.setSessionModel(resultModel(result) ?? deps.getSessionModel());
        deps.setModelFeedback(deps.copy.modelUpdated);
        deps.armModelFeedbackClear();
        await deps.invalidateAll();
        return;
      }
      deps.setModelState("error");
      deps.setSessionModel(deps.getEffectiveModelValue());
      deps.setModelFeedback(resultMessage(result, deps.copy.modelFailed));
    };
  };

  const enhanceSelectThinking: SubmitFunction = () => {
    deps.clearThinkingFeedbackTimer();
    deps.setThinkingState("submitting");
    deps.setThinkingFeedback(deps.copy.sending);
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "success") {
        deps.setThinkingState("success");
        const thinkingLevel =
          result.data && typeof result.data === "object" && "thinkingLevel" in result.data
            ? (result.data as { thinkingLevel?: unknown }).thinkingLevel
            : undefined;
        deps.setSessionThinkingLevel(
          typeof thinkingLevel === "string" && thinkingLevel
            ? thinkingLevel
            : deps.getSessionThinkingLevel(),
        );
        deps.setThinkingFeedback(deps.copy.thinkingUpdated);
        deps.armThinkingFeedbackClear();
        await deps.invalidateAll();
        return;
      }
      deps.setThinkingState("error");
      deps.setSessionThinkingLevel(deps.getEffectiveThinkingLevel());
      deps.setThinkingFeedback(resultMessage(result, deps.copy.thinkingFailed));
    };
  };

  const enhanceRetryMessage: SubmitFunction = () => {
    deps.setRetryState("submitting");
    deps.setRetryFeedback(null);
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "success") {
        deps.adoptQueuedTurn(result);
        deps.setRetryState("success");
        deps.setRetryFeedback(null);
        deps.setRetrySubmissionId(createId("idem"));
        await deps.invalidateAll();
        return;
      }
      if (result.type === "redirect") return;
      deps.setRetryState("error");
      deps.setRetryFeedback(resultMessage(result, deps.copy.sendFailed));
    };
  };

  return {
    enhanceStartConversation,
    enhanceSendMessage,
    enhanceCancelTurn,
    enhanceRemoveQueuedTurn,
    enhanceSelectModel,
    enhanceSelectThinking,
    enhanceRetryMessage,
  };
}
