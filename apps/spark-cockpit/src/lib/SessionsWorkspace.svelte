<script lang="ts">
  import { enhance } from "$app/forms";
  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import {
    Composer,
    ConversationViewport,
    Message as ConversationMessage,
    SessionQueue,
    SessionStatusBar,
    SlashActionBar,
    SlashCommandMenu,
    sessionStatusIdentity,
    sessionStatusUsage,
    visibleConversationPartText,
  } from "$lib/components/conversation";
  import type {
    SessionQueueItem,
    SessionQueueLabels,
    SessionStatusBarLabels,
    SlashActionAvailability,
  } from "$lib/components/conversation";
  import type { ConversationPartLabels, LoadEarlierOutcome } from "$lib/components/conversation/types";
  import {
    ModelRuntimeControl,
    type ModelPickerGroup,
    type ModelRuntimeControlLabels,
  } from "$lib/components/model-selector";
  import ChannelSessionIcon from "$lib/ChannelSessionIcon.svelte";
  import {
    channelSessionPresentation,
    sessionHasChannelBinding,
  } from "$lib/channel-session-title";
  import { visibleSessionStatus } from "$lib/conversation-status";
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel, type AppMessages } from "$lib/i18n";
  import SessionAskPanel from "$lib/SessionAskPanel.svelte";
  import type { PendingWorkbenchAsk } from "$lib/pending-ask";
  import {
    cancelledTurnIdFromActionResult,
    queuedTurnIdFromActionResult,
  } from "$lib/session-action-result";
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
  import {
    initialSessionEventConnectionState,
    type SessionEventConnectionState,
  } from "$lib/session-event-connection";
  import {
    cockpitComposerFeedbackAfterInput,
    cockpitOpenSearchEvent,
    cockpitSessionSelectionShortcutForInput,
    cockpitSlashSubmissionError,
    cockpitSlashSuggestionsForInput,
    localizeCockpitSlashActionBar,
    scheduleCockpitActionAfterCurrentEvent,
  } from "$lib/slash-actions";
  import {
    beginSessionActivityRefresh,
    canStartSessionActivityRefresh,
    createSessionActivityRefreshState,
    createSessionLiveEventState,
    finishSessionActivityRefresh,
    reconcileSessionLiveEventState,
    convergeSessionLiveEventStateFromRegistryStatus,
    requestSessionActivityRefresh,
    shouldAdoptSessionHistory,
    sessionViewRevisionKey,
    type SessionLiveEventState,
  } from "$lib/session-live-events";
  import {
    resolveSessionActivityState,
    sessionActivityNeedsStatusProbe,
  } from "$lib/session-activity-state";
  import {
    activeSessionTimelineProcessItemId,
    buildSessionTimeline,
    latestSessionRetryCandidate,
    SESSION_TIMELINE_PAGE_SIZE,
    sessionTimelineWindow,
    type SessionTimelineItem,
  } from "$lib/session-timeline";
  import {
    SESSION_CONVERSATION_ANCHOR_BATCH,
    sessionConversationAnchorCount,
    type SessionSnapshotHistory,
    type SessionSnapshotWindow,
  } from "$lib/session-snapshot-window";
  import { buildSessionWorkbenchView, type SessionInspectorLabels } from "$lib/session-workbench";
  import { Button } from "$lib/ui";
  import {
    workbenchSessionScope,
    workspaceIdForWorkbenchSession,
  } from "$lib/workbench-session-scope";
  import { workspacePath, workspaceSessionsPath } from "$lib/workspace-routes";
  import {
    createId,
    sparkSlashActionBarForInput,
    sparkThinkingLevelOptions,
    type SparkActionView,
    type SparkModelCatalogProvider,
    type SparkModelControlSnapshot,
    type SparkModelRef,
    type SparkMessageView,
    type SparkSessionView,
    type SparkThinkingLevel,
  } from "@zendev-lab/spark-protocol";
  import type { CockpitMessages } from "@zendev-lab/spark-i18n";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { onMount, tick, untrack } from "svelte";
  import SessionDetailsPanel from "$lib/sessions-workspace/SessionDetailsPanel.svelte";
  import SessionStartPane from "$lib/sessions-workspace/SessionStartPane.svelte";
  import SessionConversationPane from "$lib/sessions-workspace/SessionConversationPane.svelte";
  import type { SessionConversationHost } from "$lib/sessions-workspace/conversation-host";
  import type { SessionActivity } from "$lib/sessions-workspace/types";
  import {
    applyCancelSubmitResult,
    applyDequeueSubmitResult,
    beginCancelSubmit,
    beginDequeueSubmit,
    resetCancelUiForActiveTurn,
    resetDequeueUiOnSessionChange,
  } from "$lib/sessions-workspace/cancel-dequeue";
  import { resultMessage, resultModel } from "$lib/sessions-workspace/form-results";
  import { buildModelGroups as buildModelGroupsFromProviders } from "$lib/sessions-workspace/model-groups";
  import {
    attachSessionLiveEventSource,
    attachSessionStatusProbe,
  } from "$lib/sessions-workspace/live-connection";
  import {
    connectionLabel as resolveConnectionLabel,
    compactWorkingDirectory,
    isNavigationTurn,
    modelValue,
    navigationSummary,
    queueRemoveFormId,
    sessionMessageInvocationId,
  } from "$lib/sessions-workspace/presentation";
  import { slashActionAvailability as resolveSlashAvailability } from "$lib/sessions-workspace/slash-availability";
  import {
    adoptCancelledTurnIntoLiveState,
    adoptQueuedTurnIntoLiveState,
  } from "$lib/sessions-workspace/turn-adoption";
  import {
    bumpTimelineRenderLimit,
    loadEarlierSessionTimeline,
  } from "$lib/sessions-workspace/timeline-window";
  import { buildInspectorLabels } from "$lib/sessions-workspace/ask-inspector.svelte";

  type SessionRecord = {
    sessionId: string;
    workspaceId?: string;
    scope?:
      | { kind: "workspace"; workspaceId: string }
      | { kind: "daemon"; daemonId?: string; daemonLabel?: string };
    title?: string;
    status: string;
    role?: string;
    bindings?: Array<{
      kind: string;
      adapter?: string;
      externalKey?: string;
      boundAt?: string;
    }>;
    createdAt: string;
    updatedAt: string;
  };

  type WorkspaceOption = {
    id: string;
    slug: string;
    name: string;
  };


  type FormValues = {
    workspaceId?: string;
    sessionId?: string;
    message?: string;
    model?: string;
    thinkingLevel?: string;
    submissionId?: string;
  };

  type ModelControlState = {
    available: boolean;
    snapshot: SparkModelControlSnapshot;
    error?: string;
  };

  type SubmissionState = "idle" | "submitting" | "success" | "error";

  type ComposerSurface = "start" | "session";

  type Messages = CockpitMessages["sessions"];

  type Props = {
    sessions: SessionRecord[];
    workspaces: WorkspaceOption[];
    selectedSessionId: string | null;
    startSubmissionIdSeed?: string;
    sendSubmissionIdSeed?: string;
    activeWorkspaceId?: string | null;
    messages: Messages;
    common: Parameters<typeof getStatusLabel>[1];
    locale: string;
    activity?: SessionActivity | null;
    sessionView?: SparkSessionView | null;
    sessionHistory?: SessionSnapshotHistory | null;
    initialEventCursor?: string | null;
    formMessage?: string | null;
    formIntent?: string | null;
    formValues?: FormValues | null;
    canAssign?: boolean;
    modelControl?: ModelControlState;
    /** Fallback seed when start/send-specific seeds are absent. */
    initialSubmissionId?: string;
  };

  let {
    sessions,
    workspaces,
    selectedSessionId,
    startSubmissionIdSeed = "",
    sendSubmissionIdSeed = "",
    activeWorkspaceId = null,
    messages,
    common,
    locale,
    activity = null,
    sessionView = null,
    sessionHistory = null,
    initialEventCursor = null,
    formMessage = null,
    formIntent = null,
    formValues = null,
    canAssign = true,
    modelControl = { available: false, snapshot: { providers: [], diagnostics: [] } },
    initialSubmissionId = "",
  }: Props = $props();

  let selected = $derived(
    sessions.find((session) => session.sessionId === selectedSessionId) ?? null,
  );
  let sessionPendingAsk = $derived.by(() => {
    const ask = (page.data as { pendingAsk?: PendingWorkbenchAsk | null }).pendingAsk;
    if (!ask?.sessionId || !selected?.sessionId) return null;
    return ask.sessionId === selected.sessionId ? ask : null;
  });
  let askDetailMessages = $derived(
    (page.data as { messages?: { inboxDetail?: AppMessages["inboxDetail"] } }).messages
      ?.inboxDetail ?? null,
  );
  let liveSessionView = $state<SparkSessionView | null>(untrack(() => sessionView));
  let liveSessionHistory = $state<SessionSnapshotHistory | null>(
    untrack(() => sessionHistory),
  );
  let historyLoadState = $state<"idle" | "loading">("idle");
  let liveEventState = $state<SessionLiveEventState | null>(null);
  let liveSessionId = $state("");
  let lastServerViewKey = $state("");
  let liveConnection = $state<SessionEventConnectionState>(
    untrack(() => initialSessionEventConnectionState(selectedSessionId)),
  );
  let selectedWorkspaceId = $derived(
    selected ? workspaceIdForWorkbenchSession(selected) : null,
  );
  let selectedWorkspaceHref = $derived(workspaceHref(selectedWorkspaceId));
  let selectedIsChannelSession = $derived(selected ? sessionHasChannelBinding(selected) : false);
  let selectedChannelBindings = $derived(
    (selected?.bindings ?? []).filter((binding) => binding.kind === "channel"),
  );
  let selectedChannelsSettingsHref = $derived(channelsSettingsHref(selectedWorkspaceId));
  let activityCommands = $derived(activity?.commands ?? []);
  let activityReports = $derived(activity?.reports ?? []);
  let sessionMessages = $derived(liveSessionView?.messages ?? []);
  let sessionActivityState = $derived(
    resolveSessionActivityState({
      registryStatus: selected?.status,
      session: liveSessionView,
      projectedTurns: activity?.queuedTurns ?? [],
      liveActiveTurnId: liveEventState?.activeTurnId,
    }),
  );
  let queuedTurns = $derived(sessionActivityState.pendingTurns);
  let modelProviders = $derived(
    modelControl.snapshot.providers.filter((provider) => provider.models.length > 0),
  );
  let modelGroups = $derived(buildModelGroupsFromProviders(modelProviders, messages.workbench));
  let activeWorkspace = $derived(
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
  );
  let sessionsHref = $derived(activeWorkspace ? workspaceSessionsPath(activeWorkspace) : "/sessions");
  let availableModels = $derived(
    modelControl.snapshot.providers.flatMap((provider) =>
      provider.models.filter((entry) => entry.available),
    ),
  );
  let statusIdentity = $derived(
    sessionStatusIdentity(liveSessionView, {
      sessionModel: modelControl.snapshot.session?.model,
      defaultModel: modelControl.snapshot.defaultModel,
      sessionThinkingLevel: modelControl.snapshot.session?.thinkingLevel,
    }),
  );
  let effectiveModel = $derived(statusIdentity.model ?? null);
  let effectiveModelValue = $derived(effectiveModel ? modelValue(effectiveModel) : "");
  let effectiveThinkingLevel = $derived(statusIdentity.thinkingLevel ?? "medium");
  let thinkingLevels = sparkThinkingLevelOptions;
  let effectiveModelAvailable = $derived(
    Boolean(
      effectiveModelValue &&
        availableModels.some((entry) => modelValue(entry.model) === effectiveModelValue),
    ),
  );
  let effectiveModelCatalogEntry = $derived(
    effectiveModel
      ? modelProviders
          .flatMap((provider) => provider.models)
          .find((entry) => modelValue(entry.model) === effectiveModelValue)
      : undefined,
  );
  // A transient catalog/control read must not block an existing conversation.
  // The session snapshot already carries its effective model; the daemon owns
  // final provider/auth admission when `turn.submit` reaches the runtime.
  let modelReady = $derived(Boolean(effectiveModelValue));
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
        : startSubmissionIdSeed || initialSubmissionId || createId("idem"),
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
        : sendSubmissionIdSeed || initialSubmissionId || createId("idem"),
    ),
  );
  let lastSubmittedMessage = $state("");
  let initialFormValuesApplied = $state(false);
  let startState = $state<SubmissionState>("idle");
  let sendState = $state<SubmissionState>("idle");
  let retryState = $state<SubmissionState>("idle");
  let modelState = $state<SubmissionState>("idle");
  let thinkingState = $state<SubmissionState>("idle");
  let startFeedback = $state<string | null>(null);
  let sendFeedback = $state<string | null>(null);
  let retryFeedback = $state<string | null>(null);
  let modelFeedback = $state<string | null>(null);
  let thinkingFeedback = $state<string | null>(null);
  let modelFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let thinkingFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let activityRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const activityRefreshState = createSessionActivityRefreshState();
  let sessionModelForm = $state<HTMLFormElement | null>(null);
  let sessionThinkingForm = $state<HTMLFormElement | null>(null);
  let retryMessageForm = $state<HTMLFormElement | null>(null);
  let retryPrompt = $state("");
  let retrySubmissionId = $state("");
  let startModelReady = $derived(
    modelControl.available &&
      availableModels.some((entry) => modelValue(entry.model) === startModel),
  );
  // Activity state folds live turn + pending queue; registry "running" alone is not enough.
  let conversationBusy = $derived(sessionActivityState.phase === "running");
  let activeTurnId = $derived(sessionActivityState.runningTurnId);
  let cancelState = $state<SubmissionState>("idle");
  let cancelFeedback = $state<string | null>(null);
  let cancelledTurnId = $state<string | null>(null);
  let dequeueState = $state<SubmissionState>("idle");
  let dequeueFeedback = $state<string | null>(null);
  let dequeuingTurnId = $state<string | null>(null);
  let timelineRenderLimit = $state(SESSION_TIMELINE_PAGE_SIZE);
  let timelineRenderSessionId = $state("");
  let automaticHistorySessionId = $state("");
  let effectiveTimelineRenderLimit = $derived(
    selectedSessionId === timelineRenderSessionId
      ? timelineRenderLimit
      : SESSION_TIMELINE_PAGE_SIZE,
  );

  let copy = $derived(messages.workbench);
  const startSlashListboxId = "start-conversation-slash-commands";
  const sessionSlashListboxId = "conversation-slash-commands";
  let startSlashActionBar = $derived.by(() => {
    const view = sparkSlashActionBarForInput(startMessage);
    return view ? localizeCockpitSlashActionBar(view, copy.slashActions) : undefined;
  });
  let sessionSlashActionBar = $derived.by(() => {
    const view = sparkSlashActionBarForInput(message);
    return view ? localizeCockpitSlashActionBar(view, copy.slashActions) : undefined;
  });
  let startSlashSuggestions = $derived.by(() =>
    startSlashDismissedInput === startMessage
      ? []
      : cockpitSlashSuggestionsForInput(startMessage, copy.slashActions),
  );
  let sessionSlashSuggestions = $derived.by(() =>
    sessionSlashDismissedInput === message
      ? []
      : cockpitSlashSuggestionsForInput(message, copy.slashActions),
  );
  let startSlashActiveOptionId = $derived(
    startSlashSuggestions.length > 0
      ? `${startSlashListboxId}-option-${Math.min(
          startSlashActiveIndex,
          startSlashSuggestions.length - 1,
        )}`
      : undefined,
  );
  let sessionSlashActiveOptionId = $derived(
    sessionSlashSuggestions.length > 0
      ? `${sessionSlashListboxId}-option-${Math.min(
          sessionSlashActiveIndex,
          sessionSlashSuggestions.length - 1,
        )}`
      : undefined,
  );

  let queueItems = $derived<SessionQueueItem[]>(
    queuedTurns
      .filter((turn) => turn.status === "queued")
      .map((turn) => ({
        id: turn.invocationId,
        text: turn.prompt,
        description: relative(turn.createdAt),
      })),
  );
  let queueLabels = $derived<SessionQueueLabels>({
    region: copy.queueRegion,
    queued: copy.queueLabel,
    next: copy.queueNext,
  });
  let queuedInvocationIds = $derived(
    new Set(
      queuedTurns
        .filter((turn) => turn.status === "queued")
        .map((turn) => turn.invocationId),
    ),
  );
  let queuedPromptReportIds = $derived(
    new Set(
      queuedTurns
        .filter((turn) => turn.status === "queued")
        .map((turn) => `turn-submit:${turn.commandId}:prompt`),
    ),
  );
  let timelineSessionMessages = $derived(
    sessionMessages.filter((entry) => {
      const invocationId = sessionMessageInvocationId(entry);
      return !invocationId || !queuedInvocationIds.has(invocationId);
    }),
  );
  let timelineActivityReports = $derived(
    activityReports.filter((report) => !queuedPromptReportIds.has(report.id)),
  );

  let modelRuntimeLabels = $derived<ModelRuntimeControlLabels>({
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
  });
  let statusBarLabels = $derived<SessionStatusBarLabels>({
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
  });
  let runtimeStatusUsage = $derived(
    sessionStatusUsage(liveSessionView, effectiveModelCatalogEntry?.contextWindow),
  );

  let timelineItems = $derived(
    buildSessionTimeline({
      messages: timelineSessionMessages,
      commands: activityCommands,
      reports: timelineActivityReports,
      fallbackTimestamp:
        sessionView?.updatedAt ?? selected?.updatedAt ?? new Date(0).toISOString(),
    }),
  );
  let renderedTimeline = $derived(
    sessionTimelineWindow(timelineItems, effectiveTimelineRenderLimit),
  );
  let timelineNavigationItems = $derived(
    renderedTimeline.items
      .filter(isNavigationTurn)
      .map((item) => ({
        id: item.id,
        actor: item.actor,
        label:
          item.actor === "session"
            ? `${copy.agent} · ${item.senderLabel ?? "?"}`
            : (item.senderLabel ?? copy.you),
        summary: navigationSummary(item),
        meta: relative(item.timestamp),
      })),
  );
  let latestRetryCandidate = $derived(
    conversationBusy || queuedTurns.length > 0
      ? null
      : latestSessionRetryCandidate(sessionMessages),
  );
  let latestRetryPrompt = $derived(latestRetryCandidate?.prompt ?? null);
  let retryableTimelineItemId = $derived(
    latestRetryCandidate ? `message:${latestRetryCandidate.failureMessageId}` : null,
  );
  let hasEarlierTimeline = $derived(
    renderedTimeline.hiddenCount > 0 || (liveSessionHistory?.hasEarlierMessages ?? false),
  );
  let activeProcessItemId = $derived(
    activeSessionTimelineProcessItemId(
      timelineItems,
      conversationBusy && Boolean(activeTurnId),
    ),
  );
  let conversationPartLabels = $derived<ConversationPartLabels>({
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
  });
  let inspectorLabels = $derived(buildInspectorLabels(copy));
  let workbenchView = $derived.by(() => {
    if (!liveSessionView) return null;
    const effectiveStatus: "running" | "idle" = conversationBusy ? "running" : "idle";
    const session =
      liveSessionView.status === effectiveStatus
        ? liveSessionView
        : { ...liveSessionView, status: effectiveStatus };
    return buildSessionWorkbenchView({ session, activity });
  });
  let timelineFollowKey = $derived.by(() => {
    const latest = timelineItems.at(-1);
    return latest ? `${latest.id}:${latest.status ?? "done"}:${latest.body.length}` : "empty";
  });
  let latestAnnouncement = $derived.by(() => {
    const latest = timelineItems.findLast((item) => item.actor === "spark");
    if (!latest || latest.status === "running" || latest.status === "streaming") return "";
    const compact = visibleConversationPartText(latest.parts).trim().replace(/\s+/g, " ");
    return compact.length <= 200 ? compact : `${compact.slice(0, 199)}…`;
  });

  $effect(() => {
    const sessionId = selected?.sessionId ?? "";
    if (!sessionId) {
      liveSessionId = "";
      liveEventState = null;
      liveSessionView = null;
      lastServerViewKey = "";
      return;
    }

    const nextServerViewKey = sessionViewRevisionKey(sessionView);
    if (sessionId !== liveSessionId) {
      const reset = resetDequeueUiOnSessionChange();
      dequeueState = reset.dequeueState;
      dequeueFeedback = reset.dequeueFeedback;
      dequeuingTurnId = reset.dequeuingTurnId;
      liveSessionId = sessionId;
      lastServerViewKey = nextServerViewKey;
      liveEventState = createSessionLiveEventState({
        sessionId,
        workspaceId: selectedWorkspaceId,
        view: sessionView,
        commandIds: activityCommands.map((command) => command.id),
        invocationIds: activityCommands.flatMap((command) =>
          command.invocationId ? [command.invocationId] : [],
        ),
        cursor: initialEventCursor,
      });
      liveSessionView = liveEventState.view;
      liveSessionHistory = sessionHistory;
      historyLoadState = "idle";
      return;
    }

    const currentHistory = untrack(() => liveSessionHistory);
    const preserveCurrentHistory = Boolean(
      currentHistory &&
        sessionHistory &&
        currentHistory.loadedMessages > sessionHistory.loadedMessages,
    );
    if (nextServerViewKey !== lastServerViewKey) {
      lastServerViewKey = nextServerViewKey;
      const state = untrack(() => liveEventState);
      if (
        state &&
        reconcileSessionLiveEventState(state, {
          workspaceId: selectedWorkspaceId,
          view: sessionView,
          commandIds: activityCommands.map((command) => command.id),
          invocationIds: activityCommands.flatMap((command) =>
            command.invocationId ? [command.invocationId] : [],
          ),
          preserveCurrentHistory,
        })
      ) {
        liveSessionView = state.view;
      }
    }
    if (shouldAdoptSessionHistory(currentHistory, sessionHistory)) {
      liveSessionHistory = sessionHistory;
    }

    for (const command of activityCommands) {
      liveEventState?.commandIds.add(command.id);
      if (command.invocationId) liveEventState?.invocationIds.add(command.invocationId);
    }
  });

  $effect(() => {
    const next = resetCancelUiForActiveTurn(
      { cancelState, cancelFeedback, cancelledTurnId },
      activeTurnId,
    );
    cancelState = next.cancelState;
    cancelFeedback = next.cancelFeedback;
  });

  $effect(() => {
    if (!initialFormValuesApplied) {
      startMessage =
        formIntent === "startConversation" ? (formValues?.message ?? "") : startMessage;
      if (formIntent === "startConversation" && formValues?.submissionId) {
        startSubmissionId = formValues.submissionId;
      }
      startModel = formValues?.model ?? startModel;
      startThinkingLevel = formValues?.thinkingLevel ?? startThinkingLevel;
      message = formIntent === "sendMessage" ? (formValues?.message ?? "") : message;
      initialFormValuesApplied = true;
    }

    const defaultModelValue = effectiveModelValue;
    if (!startModel || !availableModels.some((entry) => modelValue(entry.model) === startModel)) {
      startModel = effectiveModelAvailable
        ? defaultModelValue
        : modelValue(availableModels[0]?.model);
    }
    if (!(thinkingLevels as readonly string[]).includes(startThinkingLevel)) {
      startThinkingLevel = effectiveThinkingLevel;
    }
  });

  $effect(() => {
    if (!initialFormValuesApplied) return;
    const workspaceId = activeWorkspace?.id ?? "";
    if (!workspaceId || workspaceId === startPendingWorkspaceId) return;
    startPendingWorkspaceId = workspaceId;

    if (
      formIntent === "startConversation" &&
      formValues?.submissionId &&
      formValues.message?.trim()
    ) {
      const context = startConversationContext({
        workspaceId,
        message: formValues.message,
        model: formValues.model ?? startModel,
        thinkingLevel: formValues.thinkingLevel ?? startThinkingLevel,
      });
      startSubmissionId = formValues.submissionId;
      lastStartSubmittedContextKey = startConversationSubmissionContextKey(context);
      writeStartConversationPendingSubmission(window.sessionStorage, workspaceId, {
        ...context,
        submissionId: startSubmissionId,
      });
      return;
    }

    const pending = readStartConversationPendingSubmission(
      window.sessionStorage,
      workspaceId,
    );
    if (pending) {
      startMessage = pending.message;
      startModel = pending.model;
      startThinkingLevel = pending.thinkingLevel;
      startSubmissionId = pending.submissionId;
      lastStartSubmittedContextKey = startConversationSubmissionContextKey(pending);
      return;
    }

    startSubmissionId = startSubmissionIdSeed || createId("idem");
    lastStartSubmittedContextKey = "";
  });

  $effect(() => {
    const workspaceId = activeWorkspace?.id ?? "";
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
    const nextSessionId = selectedSessionId ?? "";
    if (nextSessionId === draftSessionId) return;
    draftSessionId = nextSessionId;
    const actionMessage =
      formIntent === "sendMessage" && formValues?.sessionId === nextSessionId
        ? (formValues.message ?? "")
        : null;
    const nextDraft =
      actionMessage ??
      (nextSessionId ? readSessionDraft(window.sessionStorage, nextSessionId) : "");
    let pending = nextSessionId
      ? readSessionPendingSubmission(window.sessionStorage, nextSessionId)
      : null;
    if (nextSessionId && actionMessage?.trim() && formValues?.submissionId) {
      pending = { message: actionMessage, submissionId: formValues.submissionId };
      writeSessionDraft(window.sessionStorage, nextSessionId, actionMessage);
      writeSessionPendingSubmission(window.sessionStorage, nextSessionId, pending);
    }
    message = nextDraft;
    if (pending?.message === nextDraft) {
      sendSubmissionId = pending.submissionId;
      lastSubmittedMessage = pending.message;
    } else {
      sendSubmissionId = sendSubmissionIdSeed || createId("idem");
      lastSubmittedMessage = "";
      if (nextSessionId && pending) {
        writeSessionPendingSubmission(window.sessionStorage, nextSessionId, null);
      }
    }
  });

  $effect(() => {
    const sessionId = draftSessionId;
    const draft = message;
    if (!sessionId || selectedSessionId !== sessionId) return;
    writeSessionDraft(window.sessionStorage, sessionId, draft);
    if (lastSubmittedMessage && draft !== lastSubmittedMessage) {
      writeSessionPendingSubmission(window.sessionStorage, sessionId, null);
      sendSubmissionId = createId("idem");
      lastSubmittedMessage = "";
    }
  });

  // Follow daemon truth when the effective model changes. Keep this separate from
  // the form-initialization effect so choosing an option does not immediately reset
  // the bound value before the enhanced form can submit it.
  $effect(() => {
    sessionModel = effectiveModelValue;
  });

  $effect(() => {
    sessionThinkingLevel = effectiveThinkingLevel;
  });

  $effect(() => {
    const nextSessionId = selectedSessionId ?? "";
    if (nextSessionId === timelineRenderSessionId) return;
    timelineRenderSessionId = nextSessionId;
    timelineRenderLimit = SESSION_TIMELINE_PAGE_SIZE;
  });

  // Keep route navigation responsive: render the latest daemon page first,
  // then fill in enough older raw pages for several real conversation turns.
  // This avoids blocking a session switch on a long sequence of snapshot RPCs.
  $effect(() => {
    const sessionId = selectedSessionId;
    const snapshot = liveSessionView;
    const history = liveSessionHistory;
    if (
      !sessionId ||
      sessionId !== liveSessionId ||
      !snapshot ||
      !history ||
      automaticHistorySessionId === sessionId
    ) {
      return;
    }

    const window: SessionSnapshotWindow = { snapshot, history };
    automaticHistorySessionId = sessionId;
    if (
      history.hasEarlierMessages &&
      sessionConversationAnchorCount(window) < SESSION_CONVERSATION_ANCHOR_BATCH
    ) {
      void loadEarlierTimeline(SESSION_CONVERSATION_ANCHOR_BATCH);
    }
  });

  $effect(() => {
    if (formIntent === "startConversation" && formMessage && startState === "idle") {
      startFeedback = formMessage;
    }
    if (formIntent === "sendMessage" && formMessage && sendState === "idle") {
      sendFeedback = formMessage;
    }
    if (formIntent === "removeQueuedTurn" && formMessage && dequeueState === "idle") {
      dequeueFeedback = formMessage;
    }
  });

  $effect(() => {
    const streamSessionId = liveSessionId;
    const streamState = liveEventState;
    if (!streamSessionId || !streamState || streamState.sessionId !== streamSessionId) {
      liveConnection = "offline";
      return;
    }

    return attachSessionLiveEventSource(streamSessionId, {
      getLiveEventState: () => untrack(() => liveEventState),
      setLiveConnection: (next) => {
        liveConnection = next;
      },
      getLiveConnection: () => untrack(() => liveConnection),
      onViewChanged: (view) => {
        liveSessionView = view;
      },
      onRefreshActivity: () => scheduleActivityRefresh(),
    });
  });

  // SSE is the immediate path. While a turn is active, also probe the daemon's
  // lightweight registry status so a dropped terminal projection cannot leave
  // the transcript, stop button, or composer permanently stuck in "running".
  $effect(() => {
    const sessionId = liveSessionId;
    const watchTerminalState = sessionActivityNeedsStatusProbe(sessionActivityState);
    if (!sessionId || !watchTerminalState) return;

    return attachSessionStatusProbe(sessionId, {
      getLiveEventState: () => untrack(() => liveEventState),
      convergeFromRegistryStatus: convergeSessionLiveEventStateFromRegistryStatus,
      onConverged: (state) => {
        liveEventState = state;
        liveSessionView = state.view;
      },
      invalidateAll,
    });
  });

  onMount(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") armActivityRefresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (modelFeedbackTimer) clearTimeout(modelFeedbackTimer);
      if (thinkingFeedbackTimer) clearTimeout(thinkingFeedbackTimer);
      if (activityRefreshTimer) clearTimeout(activityRefreshTimer);
    };
  });

  function scheduleActivityRefresh() {
    requestSessionActivityRefresh(activityRefreshState);
    armActivityRefresh();
  }

  function armActivityRefresh() {
    const canRefresh = Boolean(selected && document.visibilityState !== "hidden");
    if (
      activityRefreshTimer ||
      !canStartSessionActivityRefresh(activityRefreshState, canRefresh)
    ) {
      return;
    }
    activityRefreshTimer = setTimeout(() => {
      activityRefreshTimer = null;
      void refreshActivity();
    }, 180);
  }

  async function refreshActivity() {
    const canRefresh = Boolean(selected && document.visibilityState !== "hidden");
    if (!beginSessionActivityRefresh(activityRefreshState, canRefresh)) return;
    try {
      await invalidateAll();
    } finally {
      finishSessionActivityRefresh(activityRefreshState);
      armActivityRefresh();
    }
  }

  async function showEarlierTimeline(): Promise<LoadEarlierOutcome> {
    if (historyLoadState === "loading") return "busy";
    const history = liveSessionHistory;
    const snapshot = liveSessionView;
    if (!history || !snapshot || !history.hasEarlierMessages) {
      timelineRenderLimit = bumpTimelineRenderLimit(timelineRenderLimit);
      historyLoadState = "idle";
      return "loaded";
    }

    const window: SessionSnapshotWindow = { snapshot, history };
    return await loadEarlierTimeline(
      sessionConversationAnchorCount(window) + SESSION_CONVERSATION_ANCHOR_BATCH,
    );
  }

  async function loadEarlierTimeline(minimumAnchors: number): Promise<LoadEarlierOutcome> {
    if (historyLoadState === "loading") return "busy";
    const sessionId = selectedSessionId;
    const history = liveSessionHistory;
    const initialSnapshot = liveSessionView;
    if (!sessionId || !history || !initialSnapshot || !history.hasEarlierMessages) {
      return "exhausted";
    }

    historyLoadState = "loading";
    const result = await loadEarlierSessionTimeline({
      sessionId,
      selectedSessionId,
      history,
      initialSnapshot,
      minimumAnchors,
      getCurrentWindow: () => {
        const currentSnapshot = untrack(() => liveSessionView);
        const currentHistory = untrack(() => liveSessionHistory);
        if (!currentSnapshot || !currentHistory) return null;
        return { snapshot: currentSnapshot, history: currentHistory };
      },
    });
    if (result.outcome === "loaded" && result.window) {
      liveSessionView = result.window.snapshot;
      if (liveEventState?.sessionId === sessionId) liveEventState.view = result.window.snapshot;
      liveSessionHistory = result.window.history;
      if (result.timelineRenderLimitDelta) {
        timelineRenderLimit += result.timelineRenderLimitDelta;
      }
    }
    historyLoadState = "idle";
    return result.outcome;
  }

  function workspaceLabel(workspaceId: string) {
    return (
      workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
      messages.unknownWorkspace
    );
  }

  function sessionScopeLabel(session: SessionRecord) {
    const scope = workbenchSessionScope(session);
    if (scope.kind === "workspace") return workspaceLabel(scope.workspaceId);
    return messages.unknownWorkspace;
  }

  function sessionPresentation(session: SessionRecord) {
    return channelSessionPresentation(session, {
      labels: messages.channelLabels,
      fallback: copy.newConversation,
    });
  }

  function workspaceHref(workspaceId: string | null) {
    if (!workspaceId) return null;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    return workspace ? workspacePath(workspace) : null;
  }

  function channelsSettingsHref(workspaceId: string | null) {
    if (!workspaceId) return null;
    const workspace = workspaces.find((item) => item.id === workspaceId);
    return workspace ? workspacePath(workspace, "/settings/channels") : null;
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function relative(value: string | null) {
    return formatRelativeTime(value, locale as "en" | "zh-CN", common);
  }




  function connectionLabel() {
    return resolveConnectionLabel(liveConnection, copy);
  }


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




  function adoptQueuedTurn(result: unknown) {
    const state = untrack(() => liveEventState);
    const adopted = adoptQueuedTurnIntoLiveState(result, state, liveSessionId);
    if (!adopted) return;
    liveEventState = adopted;
    liveSessionView = adopted.view;
  }

  function adoptCancelledTurn(result: unknown) {
    const state = untrack(() => liveEventState);
    const adopted = adoptCancelledTurnIntoLiveState(result, state, liveSessionId);
    if (!adopted) return;
    liveEventState = adopted;
    liveSessionView = adopted.view;
  }




  function slashActionAvailability(
    action: SparkActionView,
    surface: ComposerSurface,
  ): SlashActionAvailability {
    return resolveSlashAvailability(action, {
      surface,
      hasSelectedSession: Boolean(selected),
      canAssign,
      sessionsCount: sessions.length,
      hasActiveWorkspace: Boolean(activeWorkspace),
      modelProvidersCount: modelProviders.length,
      modelState,
      thinkingState,
      queueItemCount: queueItems.length,
      conversationBusy,
      hasActiveTurn: Boolean(activeTurnId),
      cancelState,
      hasRetryPrompt: Boolean(latestRetryPrompt),
      modelReady,
      retryState,
      reasons: copy.slashActions.reasons,
    });
  }

  function clearSlashInput(surface: ComposerSurface) {
    if (surface === "start") {
      startMessage = "";
      startFeedback = null;
    } else {
      message = "";
      sendFeedback = null;
    }
    renewSubmissionId(surface);
  }

  function thinkingLevelFromAction(action: SparkActionView): SparkThinkingLevel | null {
    const candidate = action.payload.thinkingLevel;
    return typeof candidate === "string" &&
      (sparkThinkingLevelOptions as readonly string[]).includes(candidate)
      ? (candidate as SparkThinkingLevel)
      : null;
  }

  function openModelPickerAfterSlashAction(surface: ComposerSurface) {
    scheduleCockpitActionAfterCurrentEvent(() => {
      if (surface === "start") startModelPickerOpen = true;
      else sessionModelPickerOpen = true;
    });
  }

  function firstVisibleElement(selector: string): HTMLElement | null {
    const elements = [...document.querySelectorAll<HTMLElement>(selector)];
    return elements.find((element) => element.getClientRects().length > 0) ?? elements[0] ?? null;
  }

  function focusSurface(selector: string): boolean {
    const target = firstVisibleElement(selector);
    if (!target) return false;
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    target.focus({ preventScroll: true });
    return true;
  }

  function showQueueSurface(): boolean {
    const queue = firstVisibleElement("[data-session-queue]");
    if (!queue) return false;
    const details = queue.querySelector("details");
    if (details) details.open = true;
    const target = queue.querySelector<HTMLElement>(".queue-scroll") ?? queue;
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    target.focus({ preventScroll: true });
    return true;
  }

  function showSessionInspector(): boolean {
    const mobileDetails = firstVisibleElement("details.mobile-details");
    if (mobileDetails instanceof HTMLDetailsElement) mobileDetails.open = true;
    return focusSurface("[data-session-inspector-surface]");
  }

  async function handleSlashAction(action: SparkActionView, surface: ComposerSurface) {
    if (!slashActionAvailability(action, surface).enabled) return;

    if (action.intent === "model.select") {
      clearSlashInput(surface);
      await tick();
      openModelPickerAfterSlashAction(surface);
      return;
    }

    if (action.intent === "thinking.select") {
      const thinkingLevel = thinkingLevelFromAction(action);
      clearSlashInput(surface);
      if (!thinkingLevel) {
        await tick();
        openModelPickerAfterSlashAction(surface);
        return;
      }
      if (surface === "start") {
        startThinkingLevel = thinkingLevel;
        return;
      }
      sessionThinkingLevel = thinkingLevel;
      await submitThinkingSelection();
      return;
    }

    if (action.intent === "settings.inspect" || action.intent === "settings.providers") {
      clearSlashInput(surface);
      await goto(action.intent === "settings.providers" ? "/settings/models" : "/settings");
      return;
    }

    if (action.intent === "session.create") {
      clearSlashInput(surface);
      await goto(`${sessionsHref}?new=workspace`);
      return;
    }

    if (action.intent === "session.select") {
      clearSlashInput(surface);
      await goto(sessionsHref);
      return;
    }

    if (action.intent === "help.commands") {
      clearSlashInput(surface);
      window.dispatchEvent(new CustomEvent(cockpitOpenSearchEvent));
      return;
    }

    if (action.intent === "status.inspect") {
      clearSlashInput(surface);
      await invalidateAll();
      await tick();
      if (!focusSurface("[data-session-status-bar]")) showSessionInspector();
      return;
    }

    if (action.intent === "session.inspect") {
      clearSlashInput(surface);
      await tick();
      showSessionInspector();
      return;
    }

    if (action.intent === "queue.inspect") {
      clearSlashInput(surface);
      await tick();
      showQueueSurface();
      return;
    }

    if (action.intent === "turn.stop") {
      clearSlashInput(surface);
      await tick();
      document.querySelector<HTMLFormElement>("#session-cancel-turn-form")?.requestSubmit();
      return;
    }

    if (action.intent === "turn.retry" && latestRetryPrompt) {
      clearSlashInput(surface);
      retryConversationTurn(latestRetryPrompt);
    }
  }

  function retryConversationTurn(prompt: string) {
    if (!selected || !canAssign || !modelReady || retryState === "submitting") return;
    retryPrompt = prompt;
    retrySubmissionId = createClientSubmissionId();
    retryFeedback = null;
    retryState = "idle";
    void tick().then(() => retryMessageForm?.requestSubmit());
  }

  const enhanceRetryMessage: SubmitFunction = () => {
    retryState = "submitting";
    retryFeedback = null;

    return async ({ result, update }) => {
      await update({ reset: false });

      if (result.type === "success") {
        adoptQueuedTurn(result);
        retryState = "success";
        retryFeedback = null;
        retrySubmissionId = createClientSubmissionId();
        await invalidateAll();
        return;
      }

      if (result.type === "redirect") return;
      retryState = "error";
      retryFeedback = resultMessage(result, copy.sendFailed);
    };
  };

  const enhanceStartConversation: SubmitFunction = ({ formData, cancel }) => {
    const slashError = cockpitSlashSubmissionError(
      String(formData.get("message") ?? ""),
      copy.slashActions,
    );
    if (slashError) {
      cancel();
      startState = "error";
      startFeedback = slashError;
      return;
    }
    const context = startConversationContext({
      workspaceId: String(formData.get("workspaceId") ?? activeWorkspace?.id ?? ""),
      message: String(formData.get("message") ?? ""),
      model: String(formData.get("model") ?? ""),
      thinkingLevel: String(formData.get("thinkingLevel") ?? ""),
    });
    const pending = readStartConversationPendingSubmission(
      window.sessionStorage,
      context.workspaceId,
    );
    if (startConversationPendingSubmissionMatches(pending, context)) {
      startSubmissionId = pending.submissionId;
    } else if (
      !startSubmissionId ||
      (lastStartSubmittedContextKey &&
        startConversationSubmissionContextKey(context) !== lastStartSubmittedContextKey)
    ) {
      startSubmissionId = createId("idem");
    }
    lastStartSubmittedContextKey = startConversationSubmissionContextKey(context);
    formData.set("submissionId", startSubmissionId);
    writeStartConversationPendingSubmission(window.sessionStorage, context.workspaceId, {
      ...context,
      submissionId: startSubmissionId,
    });
    startState = "submitting";
    startFeedback = copy.sending;

    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "redirect") {
        writeStartConversationPendingSubmission(
          window.sessionStorage,
          context.workspaceId,
          null,
        );
        return;
      }

      if (result.type === "success") {
        startState = "success";
        startFeedback = resultMessage(result, copy.sent);
        startMessage = "";
        startSubmissionId = createId("idem");
        lastStartSubmittedContextKey = "";
        writeStartConversationPendingSubmission(
          window.sessionStorage,
          context.workspaceId,
          null,
        );
        await invalidateAll();
        return;
      }

      startState = "error";
      startFeedback = resultMessage(result, copy.startFailed);
    };
  };

  const enhanceSendMessage: SubmitFunction = ({ formData, cancel }) => {
    const slashError = cockpitSlashSubmissionError(
      String(formData.get("message") ?? ""),
      copy.slashActions,
    );
    if (slashError) {
      cancel();
      sendState = "error";
      sendFeedback = slashError;
      return;
    }
    const submissionSessionId = selectedSessionId ?? "";
    const submittedMessage = String(formData.get("message") ?? "").trim();
    if (!sendSubmissionId || (lastSubmittedMessage && submittedMessage !== lastSubmittedMessage)) {
      sendSubmissionId = createId("idem");
    }
    lastSubmittedMessage = submittedMessage;
    formData.set("submissionId", sendSubmissionId);
    writeSessionPendingSubmission(window.sessionStorage, submissionSessionId, {
      message: submittedMessage,
      submissionId: sendSubmissionId,
    });
    sendState = "submitting";
    sendFeedback = copy.sending;

    return async ({ result, update }) => {
      await update({ reset: false });

      if (result.type === "success") {
        adoptQueuedTurn(result);
        sendState = "success";
        sendFeedback = null;
        message = "";
        writeSessionDraft(window.sessionStorage, submissionSessionId, "");
        writeSessionPendingSubmission(window.sessionStorage, submissionSessionId, null);
        sendSubmissionId = createId("idem");
        lastSubmittedMessage = "";
        await invalidateAll();
        return;
      }

      if (result.type === "redirect") return;
      sendState = "error";
      sendFeedback = resultMessage(result, copy.sendFailed);
    };
  };

  const enhanceCancelTurn: SubmitFunction = () => {
    const started = beginCancelSubmit({ cancelState, cancelFeedback, cancelledTurnId });
    cancelState = started.cancelState;
    cancelFeedback = started.cancelFeedback;

    return async ({ result, update }) => {
      const confirmedCancelledTurnId = cancelledTurnIdFromActionResult(result);
      await update({ reset: false });
      const next = applyCancelSubmitResult(
        { cancelState, cancelFeedback, cancelledTurnId },
        {
          resultType: result.type,
          confirmedCancelledTurnId,
          errorMessage: resultMessage(result, copy.stopFailed),
        },
      );
      cancelState = next.cancelState;
      cancelFeedback = next.cancelFeedback;
      cancelledTurnId = next.cancelledTurnId;
      if (result.type === "success") {
        adoptCancelledTurn(result);
        await invalidateAll();
      }
    };
  };

  const enhanceRemoveQueuedTurn: SubmitFunction = ({ formData }) => {
    const requestedTurnId = String(formData.get("turnId") ?? "").trim();
    const started = beginDequeueSubmit(
      { dequeueState, dequeueFeedback, dequeuingTurnId },
      requestedTurnId,
    );
    dequeueState = started.dequeueState;
    dequeueFeedback = started.dequeueFeedback;
    dequeuingTurnId = started.dequeuingTurnId;

    return async ({ result, update }) => {
      await update({ reset: false });
      const next = applyDequeueSubmitResult(
        { dequeueState, dequeueFeedback, dequeuingTurnId },
        {
          resultType: result.type,
          successMessage: resultMessage(result, copy.removeQueued),
          errorMessage: resultMessage(result, copy.removeQueuedFailed),
        },
      );
      dequeueState = next.dequeueState;
      dequeueFeedback = next.dequeueFeedback;
      dequeuingTurnId = next.dequeuingTurnId;
      if (result.type === "success") adoptCancelledTurn(result);
      if (result.type !== "redirect") await invalidateAll();
    };
  };

  const enhanceSelectModel: SubmitFunction = () => {
    if (modelFeedbackTimer) clearTimeout(modelFeedbackTimer);
    modelState = "submitting";
    modelFeedback = copy.sending;
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "success") {
        modelState = "success";
        sessionModel = resultModel(result) ?? sessionModel;
        modelFeedback = copy.modelUpdated;
        modelFeedbackTimer = setTimeout(() => {
          modelFeedback = null;
          modelFeedbackTimer = null;
        }, 3_500);
        await invalidateAll();
        return;
      }
      modelState = "error";
      sessionModel = effectiveModelValue;
      modelFeedback = resultMessage(result, copy.modelFailed);
    };
  };


  async function submitModelSelection(nextValue: string) {
    sessionModel = nextValue;
    await tick();
    sessionModelForm?.requestSubmit();
  }

  const enhanceSelectThinking: SubmitFunction = () => {
    if (thinkingFeedbackTimer) clearTimeout(thinkingFeedbackTimer);
    thinkingState = "submitting";
    thinkingFeedback = copy.sending;
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === "success") {
        thinkingState = "success";
        const next =
          result.data && typeof result.data === "object" && "thinkingLevel" in result.data
            ? String((result.data as { thinkingLevel?: unknown }).thinkingLevel ?? "")
            : "";
        sessionThinkingLevel = next || sessionThinkingLevel;
        thinkingFeedback = copy.thinkingUpdated;
        thinkingFeedbackTimer = setTimeout(() => {
          thinkingFeedback = null;
          thinkingFeedbackTimer = null;
        }, 3_500);
        await invalidateAll();
        return;
      }
      thinkingState = "error";
      sessionThinkingLevel = effectiveThinkingLevel;
      thinkingFeedback = resultMessage(result, copy.thinkingFailed);
    };
  };

  async function submitThinkingSelection() {
    await tick();
    sessionThinkingForm?.requestSubmit();
  }

  function renewSubmissionId(surface?: "start" | "session") {
    if (startState === "submitting" || sendState === "submitting" || retryState === "submitting") {
      return;
    }
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

  function selectSlashSuggestion(
    suggestion: Readonly<{ command: string }>,
    surface: ComposerSurface,
  ) {
    const nextValue = `/${suggestion.command}`;
    if (surface === "start") {
      startMessage = nextValue;
      startSlashDismissedInput = null;
      handleStartMessageChange(nextValue);
      return;
    }

    message = nextValue;
    sessionSlashDismissedInput = null;
    handleSessionMessageChange(nextValue);
  }

  function handleSlashCompletionKeydown(event: KeyboardEvent, surface: ComposerSurface) {
    if (event.isComposing) return;
    const input = surface === "start" ? startMessage : message;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      cockpitSessionSelectionShortcutForInput(input)
    ) {
      event.preventDefault();
      clearSlashInput(surface);
      void goto(sessionsHref);
      return;
    }
    const suggestions = surface === "start" ? startSlashSuggestions : sessionSlashSuggestions;
    if (suggestions.length === 0) return;

    const activeIndex = surface === "start" ? startSlashActiveIndex : sessionSlashActiveIndex;
    const setActiveIndex = (index: number) => {
      if (surface === "start") startSlashActiveIndex = index;
      else sessionSlashActiveIndex = index;
    };

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((activeIndex + direction + suggestions.length) % suggestions.length);
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const suggestion = suggestions[Math.min(activeIndex, suggestions.length - 1)];
      if (suggestion) selectSlashSuggestion(suggestion, surface);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setActiveIndex(0);
      if (surface === "start") startSlashDismissedInput = startMessage;
      else sessionSlashDismissedInput = message;
    }
  }

  function createClientSubmissionId(): string {
    return createId("idem");
  }

  let conversationHost = $derived.by((): SessionConversationHost => ({
    selected: selected!,
    messages,
    copy,
    canAssign,
    conversationBusy,
    activeTurnId,
    liveConnection,
    connectionLabel,
    statusLabel,
    sessionScopeLabel,
    sessionPresentation,
    timelineFollowKey,
    latestAnnouncement,
    hasEarlierTimeline,
    showEarlierTimeline,
    timelineNavigationItems,
    timelineItems,
    renderedTimelineItems: renderedTimeline.items,
    activeProcessItemId,
    conversationPartLabels,
    relative,
    retryableTimelineItemId,
    latestRetryPrompt,
    retryState,
    modelReady,
    retryConversationTurn,
    get sessionModelForm() { return sessionModelForm; },
    set sessionModelForm(v) { sessionModelForm = v; },
    get sessionThinkingForm() { return sessionThinkingForm; },
    set sessionThinkingForm(v) { sessionThinkingForm = v; },
    get retryMessageForm() { return retryMessageForm; },
    set retryMessageForm(v) { retryMessageForm = v; },
    get sessionModel() { return sessionModel; },
    set sessionModel(v) { sessionModel = v; },
    get sessionThinkingLevel() { return sessionThinkingLevel; },
    set sessionThinkingLevel(v) { sessionThinkingLevel = v; },
    retryPrompt,
    retrySubmissionId,
    get message() { return message; },
    set message(v) { message = v; },
    sendSubmissionId,
    sendState,
    sendFeedback,
    retryFeedback,
    modelFeedback,
    thinkingFeedback,
    cancelFeedback,
    dequeueFeedback,
    modelState,
    thinkingState,
    cancelState,
    dequeueState,
    dequeuingTurnId,
    queueItems,
    queueLabels,
    queueRemoveFormId,
    sessionPendingAsk,
    askDetailMessages,
    liveSessionView,
    statusBarLabels,
    compactWorkingDirectory,
    runtimeStatusUsage,
    modelProvidersLength: modelProviders.length,
    modelGroups,
    modelRuntimeLabels,
    availableModelsLength: availableModels.length,
    modelControl,
    effectiveModelAvailable,
    get sessionModelPickerOpen() { return sessionModelPickerOpen; },
    set sessionModelPickerOpen(v) { sessionModelPickerOpen = v; },
    sessionSlashSuggestions,
    sessionSlashActionBar,
    sessionSlashActiveIndex,
    setSessionSlashActiveIndex: (index) => { sessionSlashActiveIndex = index; },
    sessionSlashListboxId,
    sessionSlashActiveOptionId,
    enhanceCancelTurn,
    enhanceSelectModel,
    enhanceSelectThinking,
    enhanceRemoveQueuedTurn,
    enhanceRetryMessage,
    enhanceSendMessage,
    slashActionAvailability: (action, _surface) => slashActionAvailability(action, "session"),
    handleSessionMessageChange,
    handleSlashCompletionKeydown: (event, _surface) => handleSlashCompletionKeydown(event, "session"),
    selectSlashSuggestion: (suggestion, _surface) => selectSlashSuggestion(suggestion, "session"),
    handleSlashAction: (action, _surface) => handleSlashAction(action, "session"),
    submitModelSelection,
    submitThinkingSelection,
  }));

</script>

{#snippet sessionDetails(compact = false)}
  {#if selected}
    <SessionDetailsPanel
      {selected}
      {compact}
      {messages}
      statusLabel={statusLabel}
      sessionScopeLabel={sessionScopeLabel(selected)}
      {selectedWorkspaceHref}
      {selectedIsChannelSession}
      {selectedChannelBindings}
      {selectedChannelsSettingsHref}
      {workbenchView}
      {inspectorLabels}
      instanceId={compact ? "session-inspector-mobile" : "session-inspector-desktop"}
    />
  {/if}
{/snippet}

<section class="sessions-stage" class:has-selection={Boolean(selected)} aria-label={messages.aria}>
  <main class="stage-pane">
    {#if !selected}
      <SessionStartPane
        {messages}
        {copy}
        {activeWorkspace}
        {canAssign}
        {startState}
        {startFeedback}
        bind:startMessage
        {startSubmissionId}
        bind:startModel
        bind:startThinkingLevel
        {startModelReady}
        bind:startModelPickerOpen
        {startSlashSuggestions}
        {startSlashActionBar}
        {startSlashActiveIndex}
        {startSlashListboxId}
        {startSlashActiveOptionId}
        modelProvidersLength={modelProviders.length}
        {modelGroups}
        {modelRuntimeLabels}
        availableModelsLength={availableModels.length}
        {modelControl}
        {enhanceStartConversation}
        slashActionAvailability={(action, _surface) => slashActionAvailability(action, "start")}
        onStartMessageChange={handleStartMessageChange}
        onSlashKeydown={(event) => handleSlashCompletionKeydown(event, "start")}
        onSlashActiveIndexChange={(index) => (startSlashActiveIndex = index)}
        onSlashSelect={(suggestion) => selectSlashSuggestion(suggestion, "start")}
        onSlashAction={(action) => handleSlashAction(action, "start")}
      />
    {:else}
      <SessionConversationPane host={conversationHost} {sessionDetails} />
    {/if}
  </main>

  {#if selected}
    <aside class="details-pane" aria-label={messages.detailsTitle}>
      <div class="details-heading">
        <p class="kicker">{copy.conversationContext}</p>
        <h2>{copy.conversationWorkbench}</h2>
      </div>
      {@render sessionDetails()}
    </aside>
  {/if}
</section>

<style>

  .sessions-stage {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    min-height: 520px;
    overflow: hidden;
  }

  .sessions-stage.has-selection {
    grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
  }

  .stage-pane {
    background: var(--color-canvas);
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    overflow: hidden;
    padding: 20px clamp(16px, 3vw, 32px);
  }

  .details-pane {
    align-content: start;
    background: var(--color-surface);
    border-left: 1px solid var(--color-border);
    display: grid;
    gap: 18px;
    min-height: 0;
    overflow-y: auto;
    padding: 22px 20px;
  }

  .details-heading h2 {
    color: var(--color-ink);
    font-size: 15px;
    font-weight: 650;
  }







</style>
