import { untrack } from "svelte";
import { createId } from "@zendev-lab/spark-protocol";
import {
  readSessionDraft,
  readSessionPendingSubmission,
  readStartConversationPendingSubmission,
  resolveStartConversationDraftSubmission,
  startConversationPendingSubmissionMatches,
  startConversationSubmissionContextKey,
  writeSessionDraft,
  writeSessionPendingSubmission,
  writeStartConversationPendingSubmission,
  type StartConversationSubmissionContext,
} from "$lib/session-draft";
import { cockpitComposerFeedbackAfterInput } from "$lib/slash-actions";
import type { FormValues, SubmissionState } from "./types";

export type ComposerSources = {
  getFormIntent: () => string | null | undefined;
  getFormValues: () => FormValues | null | undefined;
  getFormMessage: () => string | null | undefined;
  getActiveWorkspaceId: () => string | undefined;
  getStartSubmissionIdSeed: () => string;
  getSendSubmissionIdSeed: () => string;
  getInitialSubmissionId: () => string;
  getSelectedSessionId: () => string | null;
  getEffectiveModelValue: () => string;
  getEffectiveModelAvailable: () => boolean;
  getAvailableModelValues: () => string[];
  getEffectiveThinkingLevel: () => string;
  getThinkingLevels: () => readonly string[];
};

function startConversationContext(
  context: StartConversationSubmissionContext,
): StartConversationSubmissionContext {
  return {
    workspaceId: context.workspaceId.trim(),
    message: context.message.trim(),
    model: context.model.trim(),
    thinkingLevel: context.thinkingLevel.trim(),
  };
}

export function createComposerController(sources: ComposerSources) {
  const formIntent = untrack(() => sources.getFormIntent());
  const formValues = untrack(() => sources.getFormValues());

  let startModel = $state(
    untrack(() => (formIntent === "startConversation" ? (formValues?.model ?? "") : "")),
  );
  let startSlashActiveIndex = $state(0);
  let sessionSlashActiveIndex = $state(0);
  let startSlashDismissedInput = $state<string | null>(null);
  let sessionSlashDismissedInput = $state<string | null>(null);
  let startModelPickerOpen = $state(false);
  let sessionModelPickerOpen = $state(false);
  let sessionModel = $state("");
  let startThinkingLevel = $state(
    untrack(() =>
      formIntent === "startConversation" ? (formValues?.thinkingLevel ?? "medium") : "medium",
    ),
  );
  let sessionThinkingLevel = $state("medium");
  let startMessage = $state(
    untrack(() => (formIntent === "startConversation" ? (formValues?.message ?? "") : "")),
  );
  let startSubmissionId = $state(
    untrack(() =>
      formIntent === "startConversation" && formValues?.submissionId
        ? formValues.submissionId
        : sources.getStartSubmissionIdSeed() ||
          sources.getInitialSubmissionId() ||
          createId("idem"),
    ),
  );
  let lastStartSubmittedContextKey = $state("");
  let startPendingWorkspaceId = $state("");
  let message = $state(
    untrack(() => (formIntent === "sendMessage" ? (formValues?.message ?? "") : "")),
  );
  let draftSessionId = $state("");
  let sendSubmissionId = $state(
    untrack(() =>
      formIntent === "sendMessage" && formValues?.submissionId
        ? formValues.submissionId
        : sources.getSendSubmissionIdSeed() || sources.getInitialSubmissionId() || createId("idem"),
    ),
  );
  let lastSubmittedMessage = $state("");
  let initialFormValuesApplied = $state(false);
  let startState = $state<SubmissionState>("idle");
  let sendState = $state<SubmissionState>("idle");
  let startFeedback = $state<string | null>(null);
  let sendFeedback = $state<string | null>(null);

  $effect(() => {
    if (!initialFormValuesApplied) {
      const intent = sources.getFormIntent();
      const values = sources.getFormValues();
      startMessage = intent === "startConversation" ? (values?.message ?? "") : startMessage;
      if (intent === "startConversation" && values?.submissionId) {
        startSubmissionId = values.submissionId;
      }
      startModel = values?.model ?? startModel;
      startThinkingLevel = values?.thinkingLevel ?? startThinkingLevel;
      message = intent === "sendMessage" ? (values?.message ?? "") : message;
      initialFormValuesApplied = true;
    }

    const defaultModelValue = sources.getEffectiveModelValue();
    const available = sources.getAvailableModelValues();
    if (!startModel || !available.includes(startModel)) {
      startModel = sources.getEffectiveModelAvailable() ? defaultModelValue : (available[0] ?? "");
    }
    if (!sources.getThinkingLevels().includes(startThinkingLevel)) {
      startThinkingLevel = sources.getEffectiveThinkingLevel();
    }
  });

  $effect(() => {
    if (!initialFormValuesApplied) return;
    const workspaceId = sources.getActiveWorkspaceId() ?? "";
    if (!workspaceId || workspaceId === startPendingWorkspaceId) return;
    startPendingWorkspaceId = workspaceId;

    const intent = sources.getFormIntent();
    const values = sources.getFormValues();
    if (intent === "startConversation" && values?.submissionId && values.message?.trim()) {
      const context = startConversationContext({
        workspaceId,
        message: values.message,
        model: values.model ?? startModel,
        thinkingLevel: values.thinkingLevel ?? startThinkingLevel,
      });
      startSubmissionId = values.submissionId;
      lastStartSubmittedContextKey = startConversationSubmissionContextKey(context);
      writeStartConversationPendingSubmission(window.sessionStorage, workspaceId, {
        ...context,
        submissionId: startSubmissionId,
      });
      return;
    }

    const pending = readStartConversationPendingSubmission(window.sessionStorage, workspaceId);
    if (pending) {
      startMessage = pending.message;
      startModel = pending.model;
      startThinkingLevel = pending.thinkingLevel;
      startSubmissionId = pending.submissionId;
      lastStartSubmittedContextKey = startConversationSubmissionContextKey(pending);
      return;
    }

    startSubmissionId = sources.getStartSubmissionIdSeed() || createId("idem");
    lastStartSubmittedContextKey = "";
  });

  $effect(() => {
    const workspaceId = sources.getActiveWorkspaceId() ?? "";
    if (!workspaceId || workspaceId !== startPendingWorkspaceId) return;
    const currentContext = startConversationContext({
      workspaceId,
      message: startMessage,
      model: startModel,
      thinkingLevel: startThinkingLevel,
    });
    const currentContextKey = startConversationSubmissionContextKey(currentContext);
    if (currentContext.message && currentContextKey === lastStartSubmittedContextKey) {
      return;
    }

    const pending = readStartConversationPendingSubmission(window.sessionStorage, workspaceId);
    const next = resolveStartConversationDraftSubmission({
      context: currentContext,
      pending,
      previousContextKey: lastStartSubmittedContextKey,
      submissionId: startSubmissionId,
      createSubmissionId: () => createId("idem"),
    });
    startSubmissionId = next.submissionId;
    lastStartSubmittedContextKey = next.contextKey;
    writeStartConversationPendingSubmission(window.sessionStorage, workspaceId, next.pending);
  });

  $effect(() => {
    const nextSessionId = sources.getSelectedSessionId() ?? "";
    if (nextSessionId === draftSessionId) return;
    draftSessionId = nextSessionId;
    const intent = sources.getFormIntent();
    const values = sources.getFormValues();
    const actionMessage =
      intent === "sendMessage" && values?.sessionId === nextSessionId
        ? (values.message ?? "")
        : null;
    const nextDraft =
      actionMessage ??
      (nextSessionId ? readSessionDraft(window.sessionStorage, nextSessionId) : "");
    let pending = nextSessionId
      ? readSessionPendingSubmission(window.sessionStorage, nextSessionId)
      : null;
    if (nextSessionId && actionMessage?.trim() && values?.submissionId) {
      pending = { message: actionMessage, submissionId: values.submissionId };
      writeSessionDraft(window.sessionStorage, nextSessionId, actionMessage);
      writeSessionPendingSubmission(window.sessionStorage, nextSessionId, pending);
    }
    message = nextDraft;
    if (pending?.message === nextDraft) {
      sendSubmissionId = pending.submissionId;
      lastSubmittedMessage = pending.message;
    } else {
      sendSubmissionId = sources.getSendSubmissionIdSeed() || createId("idem");
      lastSubmittedMessage = "";
      if (nextSessionId && pending) {
        writeSessionPendingSubmission(window.sessionStorage, nextSessionId, null);
      }
    }
  });

  $effect(() => {
    const sessionId = draftSessionId;
    const draft = message;
    if (!sessionId || sources.getSelectedSessionId() !== sessionId) return;
    writeSessionDraft(window.sessionStorage, sessionId, draft);
    if (lastSubmittedMessage && draft !== lastSubmittedMessage) {
      writeSessionPendingSubmission(window.sessionStorage, sessionId, null);
      sendSubmissionId = createId("idem");
      lastSubmittedMessage = "";
    }
  });

  $effect(() => {
    sessionModel = sources.getEffectiveModelValue();
  });

  $effect(() => {
    sessionThinkingLevel = sources.getEffectiveThinkingLevel();
  });

  $effect(() => {
    const intent = sources.getFormIntent();
    const formMessage = sources.getFormMessage();
    if (intent === "startConversation" && formMessage && startState === "idle") {
      startFeedback = formMessage;
    }
    if (intent === "sendMessage" && formMessage && sendState === "idle") {
      sendFeedback = formMessage;
    }
  });

  function renewSubmissionId(surface?: "start" | "session") {
    if (startState === "submitting" || sendState === "submitting") return;
    if (surface !== "session") startSubmissionId = createId("idem");
    if (surface !== "start") sendSubmissionId = createId("idem");
  }

  function handleStartMessageChange(value: string) {
    startSlashActiveIndex = 0;
    if (startSlashDismissedInput !== value) startSlashDismissedInput = null;
    const transition = cockpitComposerFeedbackAfterInput(startState);
    startState = transition.state;
    if (transition.clearFeedback) startFeedback = null;
    renewSubmissionId("start");
  }

  function handleSessionMessageChange(value: string) {
    sessionSlashActiveIndex = 0;
    if (sessionSlashDismissedInput !== value) sessionSlashDismissedInput = null;
    const transition = cockpitComposerFeedbackAfterInput(sendState);
    sendState = transition.state;
    if (transition.clearFeedback) sendFeedback = null;
    renewSubmissionId("session");
  }

  function handleSessionAttachmentsChange() {
    const transition = cockpitComposerFeedbackAfterInput(sendState);
    sendState = transition.state;
    if (transition.clearFeedback) sendFeedback = null;
    renewSubmissionId("session");
  }

  return {
    get startModel() {
      return startModel;
    },
    set startModel(value: string) {
      startModel = value;
    },
    get startSlashActiveIndex() {
      return startSlashActiveIndex;
    },
    set startSlashActiveIndex(value: number) {
      startSlashActiveIndex = value;
    },
    get sessionSlashActiveIndex() {
      return sessionSlashActiveIndex;
    },
    set sessionSlashActiveIndex(value: number) {
      sessionSlashActiveIndex = value;
    },
    get startSlashDismissedInput() {
      return startSlashDismissedInput;
    },
    set startSlashDismissedInput(value: string | null) {
      startSlashDismissedInput = value;
    },
    get sessionSlashDismissedInput() {
      return sessionSlashDismissedInput;
    },
    set sessionSlashDismissedInput(value: string | null) {
      sessionSlashDismissedInput = value;
    },
    get startModelPickerOpen() {
      return startModelPickerOpen;
    },
    set startModelPickerOpen(value: boolean) {
      startModelPickerOpen = value;
    },
    get sessionModelPickerOpen() {
      return sessionModelPickerOpen;
    },
    set sessionModelPickerOpen(value: boolean) {
      sessionModelPickerOpen = value;
    },
    get sessionModel() {
      return sessionModel;
    },
    set sessionModel(value: string) {
      sessionModel = value;
    },
    get startThinkingLevel() {
      return startThinkingLevel;
    },
    set startThinkingLevel(value: string) {
      startThinkingLevel = value;
    },
    get sessionThinkingLevel() {
      return sessionThinkingLevel;
    },
    set sessionThinkingLevel(value: string) {
      sessionThinkingLevel = value;
    },
    get startMessage() {
      return startMessage;
    },
    set startMessage(value: string) {
      startMessage = value;
    },
    get startSubmissionId() {
      return startSubmissionId;
    },
    set startSubmissionId(value: string) {
      startSubmissionId = value;
    },
    get lastStartSubmittedContextKey() {
      return lastStartSubmittedContextKey;
    },
    set lastStartSubmittedContextKey(value: string) {
      lastStartSubmittedContextKey = value;
    },
    get message() {
      return message;
    },
    set message(value: string) {
      message = value;
    },
    get sendSubmissionId() {
      return sendSubmissionId;
    },
    set sendSubmissionId(value: string) {
      sendSubmissionId = value;
    },
    get lastSubmittedMessage() {
      return lastSubmittedMessage;
    },
    set lastSubmittedMessage(value: string) {
      lastSubmittedMessage = value;
    },
    get startState() {
      return startState;
    },
    set startState(value: SubmissionState) {
      startState = value;
    },
    get sendState() {
      return sendState;
    },
    set sendState(value: SubmissionState) {
      sendState = value;
    },
    get startFeedback() {
      return startFeedback;
    },
    set startFeedback(value: string | null) {
      startFeedback = value;
    },
    get sendFeedback() {
      return sendFeedback;
    },
    set sendFeedback(value: string | null) {
      sendFeedback = value;
    },
    startConversationContext,
    renewSubmissionId,
    handleStartMessageChange,
    handleSessionMessageChange,
    handleSessionAttachmentsChange,
    matchesStartPending: startConversationPendingSubmissionMatches,
  };
}

export type ComposerController = ReturnType<typeof createComposerController>;
