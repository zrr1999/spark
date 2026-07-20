<script lang="ts">
  import { enhance } from "$app/forms";
  import { goto, invalidateAll } from "$app/navigation";
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
  import type { ConversationPartLabels } from "$lib/components/conversation/types";
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
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import SessionInspector from "$lib/SessionInspector.svelte";
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
    openingSessionEventConnectionState,
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
    applySessionLiveEvent,
    beginSessionActivityRefresh,
    canStartSessionActivityRefresh,
    createSessionActivityRefreshState,
    createSessionLiveEventState,
    finishSessionActivityRefresh,
    parseSessionSerializedEvent,
    reconcileSessionLiveEventState,
    registerQueuedSessionTurn,
    requestSessionActivityRefresh,
    sessionEventCursorStorageKey,
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
    hydrateSessionConversationWindow,
    mergeEarlierSessionSnapshotWindow,
    parseSessionSnapshotWindow,
    SESSION_CONVERSATION_ANCHOR_BATCH,
    SESSION_SNAPSHOT_PAGE_SIZE,
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

  type SessionActivityCommand = {
    id: string;
    title: string | null;
    goal: string | null;
    status: string;
    deliveryStatus: string | null;
    runtimeName: string | null;
    runtimeStatus: string | null;
    invocationId: string | null;
    invocationStatus: string | null;
    latestLog: string | null;
    latestLogAt: string | null;
    createdAt: string;
    updatedAt: string;
  };

  type SessionActivityReport = {
    id: string;
    kind: string;
    title: string;
    text: string;
    role: string | null;
    status: string | null;
    createdAt: string;
    runKind?: string;
    message?: SparkMessageView;
  };

  type SessionActivityQueuedTurn = {
    commandId: string;
    invocationId: string;
    prompt: string;
    status: "queued" | "running";
    createdAt: string;
    startedAt: string | null;
  };

  type SessionActivity = {
    commands: SessionActivityCommand[];
    queuedTurns?: SessionActivityQueuedTurn[];
    reports: SessionActivityReport[];
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
  let liveSessionView = $state<SparkSessionView | null>(untrack(() => sessionView));
  let liveSessionHistory = $state<SessionSnapshotHistory | null>(
    untrack(() => sessionHistory),
  );
  let historyLoadState = $state<"idle" | "loading" | "error">("idle");
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
  let modelGroups = $derived(buildModelGroups(modelProviders));
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
  let inspectorLabels = $derived<SessionInspectorLabels>({
    ariaLabel: copy.inspectorAria,
    tabs: {
      summary: copy.summaryTab,
      changes: copy.changesTab,
      tasks: copy.tasksTab,
      mailbox: copy.mailboxTab,
    },
    summaryHeading: copy.summaryHeading,
    tasksHeading: copy.tasksHeading,
    changesHeading: copy.changesHeading,
    mailboxHeading: copy.mailboxHeading,
    noTasksTitle: copy.noTasksTitle,
    noTasksBody: copy.noTasksBody,
    noChangesTitle: copy.noChangesTitle,
    noChangesBody: copy.noChangesBody,
    noMailboxTitle: copy.noMailboxTitle,
    noMailboxBody: copy.noMailboxBody,
    noSessionTodoTitle: copy.noSessionTodoTitle,
    noSessionTodoBody: copy.noSessionTodoBody,
    noActiveSessionTodo: copy.noActiveSessionTodo,
    unassignedProject: copy.unassignedProject,
    progress: copy.progress,
    todoList: copy.todoList,
    sessionTodoHeading: copy.sessionTodoHeading,
    openSessionTodo: copy.openSessionTodo,
    sessionTodoPending: copy.sessionTodoPending,
    sessionTodoInProgress: copy.sessionTodoInProgress,
    mailFrom: copy.mailFrom,
    mailRequest: copy.mailRequest,
    mailQuestion: copy.mailQuestion,
    mailNotification: copy.mailNotification,
    mailUnread: copy.mailUnread,
    mailRead: copy.mailRead,
    mailAcknowledged: copy.mailAcknowledged,
    mailDeliveryPending: copy.mailDeliveryPending,
    mailDeliveryDelivered: copy.mailDeliveryDelivered,
    mailDeliveryFailed: copy.mailDeliveryFailed,
    mailDeliveryUncertain: copy.mailDeliveryUncertain,
    sessionId: copy.sessionId,
    sessionStatus: copy.sessionStatus,
    workingDirectory: copy.workingDirectory,
    model: copy.contextModel,
    createdAt: copy.createdAt,
    updatedAt: copy.updatedAt,
    unavailable: copy.unavailable,
  });
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
      dequeueState = "idle";
      dequeueFeedback = null;
      dequeuingTurnId = null;
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
    if (activeTurnId && activeTurnId !== cancelledTurnId && cancelState !== "submitting") {
      cancelState = "idle";
      cancelFeedback = null;
    }
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

    let closed = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    const storageKey = sessionEventCursorStorageKey(streamSessionId);

    if (storageKey && !untrack(() => streamState.cursor)) {
      streamState.cursor = window.sessionStorage.getItem(storageKey);
    }

    const connect = () => {
      if (closed) return;
      if (!navigator.onLine) {
        liveConnection = "offline";
        return;
      }
      const state = untrack(() => liveEventState);
      if (!state || state.sessionId !== streamSessionId) return;
      liveConnection = openingSessionEventConnectionState(untrack(() => liveConnection));
      const url = new URL("/api/v1/events", window.location.origin);
      if (state.cursor) url.searchParams.set("cursor", state.cursor);
      eventSource = new EventSource(url);
      eventSource.onopen = () => {
        reconnectAttempt = 0;
        liveConnection = "live";
      };
      eventSource.addEventListener("spark-cockpit.event", (message) => {
        const event = parseSessionSerializedEvent(message.data);
        const state = untrack(() => liveEventState);
        if (!event || !state || state.sessionId !== streamSessionId) return;
        const result = applySessionLiveEvent(state, event);
        if (storageKey && state.cursor) {
          window.sessionStorage.setItem(storageKey, state.cursor);
        }
        if (result.changed) {
          liveSessionView = state.view;
        }
        if (result.refreshActivity) scheduleActivityRefresh();
      });
      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        liveConnection = navigator.onLine ? "reconnecting" : "offline";
        if (!closed && navigator.onLine && !reconnectTimer) {
          const delay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, delay);
        }
      };
    };

    const handleOnline = () => {
      if (closed || eventSource) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connect();
    };
    const handleOffline = () => {
      liveConnection = "offline";
      eventSource?.close();
      eventSource = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    connect();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      closed = true;
      eventSource?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  });

  // SSE is the immediate path. While a turn is active, also probe the daemon's
  // lightweight registry status so a dropped terminal projection cannot leave
  // the transcript, stop button, or composer permanently stuck in "running".
  $effect(() => {
    const sessionId = liveSessionId;
    const watchTerminalState = sessionActivityNeedsStatusProbe(sessionActivityState);
    if (!sessionId || !watchTerminalState) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshing = false;

    const schedule = (delay = 3_000) => {
      if (stopped || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void probeStatus();
      }, delay);
    };

    const probeStatus = async () => {
      if (stopped || refreshing) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      refreshing = true;
      try {
        const response = await fetch(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/status`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const result = (await response.json()) as { sessionId?: unknown; status?: unknown };
        if (
          result.sessionId === sessionId &&
          typeof result.status === "string" &&
          result.status !== "running"
        ) {
          await invalidateAll();
        }
      } finally {
        refreshing = false;
        schedule();
      }
    };

    schedule(1_500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
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

  async function showEarlierTimeline(): Promise<boolean> {
    if (historyLoadState === "loading") return false;
    const history = liveSessionHistory;
    const snapshot = liveSessionView;
    if (!history || !snapshot || !history.hasEarlierMessages) {
      timelineRenderLimit += SESSION_TIMELINE_PAGE_SIZE;
      historyLoadState = "idle";
      return true;
    }

    const window: SessionSnapshotWindow = { snapshot, history };
    return await loadEarlierTimeline(
      sessionConversationAnchorCount(window) + SESSION_CONVERSATION_ANCHOR_BATCH,
    );
  }

  async function loadEarlierTimeline(minimumAnchors: number): Promise<boolean> {
    if (historyLoadState === "loading") return false;
    const sessionId = selectedSessionId;
    const history = liveSessionHistory;
    const initialSnapshot = liveSessionView;
    if (!sessionId || !history || !initialSnapshot || !history.hasEarlierMessages) return false;
    const beforeMessageId = history.nextBeforeMessageId;
    if (!beforeMessageId) {
      historyLoadState = "error";
      return false;
    }

    historyLoadState = "loading";
    try {
      const initialWindow: SessionSnapshotWindow = {
        snapshot: initialSnapshot,
        history,
      };
      const loadedPages: SessionSnapshotWindow[] = [];
      await hydrateSessionConversationWindow(initialWindow, {
        minimumAnchors,
        loadEarlier: async (cursor) => {
          const query = new URLSearchParams({
            limit: String(SESSION_SNAPSHOT_PAGE_SIZE),
            before: cursor,
          });
          const response = await fetch(
            `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot?${query}`,
            { cache: "no-store" },
          );
          if (!response.ok) {
            throw new Error(`session history request failed: ${response.status}`);
          }
          const earlierPage = parseSessionSnapshotWindow(await response.json());
          if (earlierPage.snapshot.sessionId !== sessionId || selectedSessionId !== sessionId) {
            throw new Error("session changed while loading history");
          }
          loadedPages.push(earlierPage);
          return earlierPage;
        },
      });
      // A live event may append or settle a message while this request is in
      // flight. Merge into the latest browser window, never the pre-fetch copy.
      const currentSnapshot = untrack(() => liveSessionView);
      const currentHistory = untrack(() => liveSessionHistory);
      if (
        !currentSnapshot ||
        !currentHistory ||
        currentHistory.nextBeforeMessageId !== beforeMessageId ||
        selectedSessionId !== sessionId
      ) {
        historyLoadState = "idle";
        return false;
      }
      let window: SessionSnapshotWindow = { snapshot: currentSnapshot, history: currentHistory };
      for (const earlierPage of loadedPages) {
        window = mergeEarlierSessionSnapshotWindow(window, earlierPage);
      }

      liveSessionView = window.snapshot;
      if (liveEventState?.sessionId === sessionId) liveEventState.view = window.snapshot;
      liveSessionHistory = window.history;
      timelineRenderLimit += SESSION_TIMELINE_PAGE_SIZE;
      historyLoadState = "idle";
      return true;
    } catch {
      historyLoadState = selectedSessionId === sessionId ? "error" : "idle";
      return false;
    }
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

  function sessionMessageInvocationId(entry: SparkMessageView) {
    const metadata = entry.metadata;
    if (!metadata || metadata.source !== "daemon.invocation") return null;
    const invocationId = metadata.invocationId;
    return typeof invocationId === "string" && invocationId.trim()
      ? invocationId.trim()
      : null;
  }

  function navigationSummary(item: SessionTimelineItem) {
    const summary = (visibleConversationPartText(item.parts) || item.title || item.body)
      .trim()
      .replace(/\s+/gu, " ");
    return summary.length <= 160 ? summary : `${summary.slice(0, 159)}…`;
  }

  function isNavigationTurn(
    item: SessionTimelineItem,
  ): item is SessionTimelineItem & { actor: "user" | "session" } {
    return item.actor !== "spark";
  }

  function connectionLabel() {
    if (liveConnection === "live") return copy.live;
    if (liveConnection === "connecting") return copy.connecting;
    if (liveConnection === "reconnecting") return copy.reconnecting;
    return copy.offline;
  }

  function compactWorkingDirectory(value: string | undefined) {
    const path = value?.trim() ?? "";
    if (!path) return "";
    const home = /^\/(?:Users|home)\/[^/]+(?=\/|$)|^\/root(?=\/|$)/u.exec(path)?.[0];
    return home ? `~${path.slice(home.length)}` : path;
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

  function queueRemoveFormId(turnId: string) {
    return `queue-remove-${turnId.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  }

  function resultMessage(result: unknown, fallback: string) {
    if (!result || typeof result !== "object") return fallback;

    if ("data" in result && result.data && typeof result.data === "object") {
      const candidate = (result.data as { message?: unknown }).message;
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    if ("error" in result && result.error instanceof Error && result.error.message) {
      return result.error.message;
    }
    return fallback;
  }

  function resultModel(result: unknown) {
    if (!result || typeof result !== "object" || !("data" in result)) return null;
    const data = result.data;
    if (!data || typeof data !== "object" || !("model" in data)) return null;
    return typeof data.model === "string" && data.model.trim() ? data.model : null;
  }

  function adoptQueuedTurn(result: unknown) {
    const turnId = queuedTurnIdFromActionResult(result);
    const state = untrack(() => liveEventState);
    if (!turnId || !state || state.sessionId !== liveSessionId) return;
    if (!registerQueuedSessionTurn(state, turnId)) return;
    liveEventState = state;
    liveSessionView = state.view;
  }

  function buildModelGroups(providers: SparkModelCatalogProvider[]): ModelPickerGroup[] {
    return providers.map((provider) => {
      const available = provider.models.filter((entry) => entry.available);
      return {
        id: provider.providerName,
        label: provider.label,
        description: provider.auth.configured ? undefined : copy.providerLoginRequired,
        options:
          available.length > 0
            ? available.map((entry) => ({
                value: modelValue(entry.model),
                label: entry.model.modelLabel ?? entry.model.modelId,
                description:
                  entry.model.modelLabel && entry.model.modelLabel !== entry.model.modelId
                    ? entry.model.modelId
                    : undefined,
                keywords: [entry.model.modelId, provider.providerName],
                reasoning: entry.reasoning,
              }))
            : [
                {
                  value: `unavailable:${provider.providerName}`,
                  label: `${copy.providerLoginRequired} · ${provider.models.length}`,
                  disabled: true,
                },
              ],
      };
    });
  }

  function unavailable(reason: string): SlashActionAvailability {
    return { enabled: false, reason };
  }

  function slashActionAvailability(
    action: SparkActionView,
    surface: ComposerSurface,
  ): SlashActionAvailability {
    const hasSelectedSession = surface === "session" && Boolean(selected);

    switch (action.intent) {
      case "model.select":
        if (!canAssign) return unavailable(copy.slashActions.reasons.ownerOffline);
        if (modelProviders.length === 0) return unavailable(copy.slashActions.reasons.noModel);
        if (surface === "session" && modelState === "submitting") {
          return unavailable(copy.slashActions.reasons.modelUpdating);
        }
        return { enabled: true };
      case "thinking.select":
        if (!canAssign) return unavailable(copy.slashActions.reasons.ownerOffline);
        if (modelProviders.length === 0) return unavailable(copy.slashActions.reasons.noModel);
        if (surface === "session" && thinkingState === "submitting") {
          return unavailable(copy.slashActions.reasons.thinkingUpdating);
        }
        return { enabled: true };
      case "settings.inspect":
      case "settings.providers":
        return { enabled: true };
      case "status.inspect":
      case "session.inspect":
        return hasSelectedSession
          ? { enabled: true }
          : unavailable(copy.slashActions.reasons.sessionRequired);
      case "session.select":
        return sessions.length > 0
          ? { enabled: true }
          : unavailable(copy.slashActions.reasons.noSessions);
      case "session.create":
        if (!activeWorkspace) return unavailable(copy.slashActions.reasons.workspaceRequired);
        return canAssign
          ? { enabled: true }
          : unavailable(copy.slashActions.reasons.ownerOffline);
      case "queue.inspect":
        if (!hasSelectedSession) return unavailable(copy.slashActions.reasons.sessionRequired);
        return queueItems.length > 0
          ? { enabled: true }
          : unavailable(copy.slashActions.reasons.queueEmpty);
      case "turn.stop":
        if (!hasSelectedSession) return unavailable(copy.slashActions.reasons.sessionRequired);
        return conversationBusy && Boolean(activeTurnId) && cancelState !== "submitting"
          ? { enabled: true }
          : unavailable(copy.slashActions.reasons.noActiveTurn);
      case "turn.retry":
        if (!hasSelectedSession) return unavailable(copy.slashActions.reasons.sessionRequired);
        if (!canAssign) return unavailable(copy.slashActions.reasons.ownerOffline);
        if (!latestRetryPrompt) return unavailable(copy.slashActions.reasons.retryUnavailable);
        if (!modelReady) return unavailable(copy.slashActions.reasons.noModel);
        return retryState === "submitting"
          ? unavailable(copy.slashActions.reasons.retryInProgress)
          : { enabled: true };
      case "help.commands":
        return { enabled: true };
      case "help.hotkeys":
        return unavailable(copy.slashActions.reasons.hotkeysUnavailable);
      default:
        return unavailable(copy.slashActions.reasons.daemonExecutorUnavailable);
    }
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
    cancelState = "submitting";
    cancelFeedback = null;

    return async ({ result, update }) => {
      const confirmedCancelledTurnId = cancelledTurnIdFromActionResult(result);
      await update({ reset: false });

      if (result.type === "success") {
        cancelState = "success";
        cancelledTurnId = confirmedCancelledTurnId;
        cancelFeedback = null;
        await invalidateAll();
        return;
      }

      if (result.type === "redirect") return;
      cancelState = "error";
      cancelFeedback = resultMessage(result, copy.stopFailed);
    };
  };

  const enhanceRemoveQueuedTurn: SubmitFunction = ({ formData }) => {
    const requestedTurnId = String(formData.get("turnId") ?? "").trim();
    dequeuingTurnId = requestedTurnId || null;
    dequeueState = "submitting";
    dequeueFeedback = null;

    return async ({ result, update }) => {
      await update({ reset: false });

      if (result.type === "success") {
        dequeueState = "success";
        dequeueFeedback = resultMessage(result, copy.removeQueued);
        await invalidateAll();
        return;
      }

      if (result.type === "redirect") return;
      dequeueState = "error";
      dequeueFeedback = resultMessage(result, copy.removeQueuedFailed);
      await invalidateAll();
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

  function modelValue(model: SparkModelRef | undefined) {
    return model ? `${model.providerName}/${model.modelId}` : "";
  }

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
</script>

{#snippet sessionDetails(compact = false)}
  {#if selected}
    {@const displayedSessionStatus = visibleSessionStatus(selected.status)}
    <div
      class:compact-details={compact}
      class="details-content"
      data-session-inspector-surface
      tabindex="-1"
    >
      <dl class="details-grid">
        {#if displayedSessionStatus}
          <div>
            <dt>{messages.statusLabel}</dt>
            <dd><span class="status-pill {displayedSessionStatus}">{statusLabel(displayedSessionStatus)}</span></dd>
          </div>
        {/if}
        <div>
          <dt>{messages.workspaceLabel}</dt>
          <dd>
            {#if selectedWorkspaceHref}
              <a href={selectedWorkspaceHref}>{sessionScopeLabel(selected)}</a>
            {:else}
              {sessionScopeLabel(selected)}
            {/if}
          </dd>
        </div>
        {#if selected.role}
          <div>
            <dt>{messages.roleLabel}</dt>
            <dd>{selected.role}</dd>
          </div>
        {/if}
        {#if selectedIsChannelSession}
          <div>
            <dt>{messages.channelSessionBadge}</dt>
            <dd>
              <span class="channel-badge">{messages.channelSessionKicker}</span>
            </dd>
          </div>
          {#if selectedChannelBindings.length > 0}
            <div>
              <dt>{messages.channelBindingLabel}</dt>
              <dd class="channel-bindings">
                {#each selectedChannelBindings as binding (binding.externalKey ?? binding.adapter)}
                  <code>{binding.externalKey ?? binding.adapter}</code>
                {/each}
              </dd>
            </div>
          {/if}
          {#if selectedChannelsSettingsHref}
            <div class="channel-settings-row">
              <a class="channel-settings-link" href={selectedChannelsSettingsHref}>
                <Icon name="settings" size={14} />
                {messages.openChannelSettings}
              </a>
              <p class="muted">{messages.channelRoutingBody}</p>
            </div>
          {/if}
        {/if}
      </dl>

      {#if workbenchView}
        <SessionInspector
          view={workbenchView}
          labels={inspectorLabels}
          instanceId={compact ? "session-inspector-mobile" : "session-inspector-desktop"}
          {statusLabel}
        />
      {/if}

    </div>
  {/if}
{/snippet}

<section class="sessions-stage" class:has-selection={Boolean(selected)} aria-label={messages.aria}>
  <main class="stage-pane">
    {#if !selected}
      <div class="conversation-start">
        {#if !activeWorkspace}
          <div class="stage-empty">
            <Icon name="agents" size={28} />
            <div>
              <h1>{messages.createNoWorkspaceTitle}</h1>
              <p>{messages.createNoWorkspaceBody}</p>
              <a class="primary-action" href="/workspaces/new">{messages.createWorkspaceAction}</a>
            </div>
          </div>
        {:else}
          <div class="start-heading">
            <span class="spark-mark"><Icon name="spark" size={22} /></span>
            <div>
              <p class="kicker">Spark</p>
              <h1>{copy.newConversation}</h1>
              <p>{copy.workspaceStartHint}</p>
            </div>
          </div>

          <form
            method="POST"
            action="?/startConversation"
            class="start-composer"
            aria-busy={startState === "submitting"}
            use:enhance={enhanceStartConversation}
          >
            {#if activeWorkspace}
              <input type="hidden" name="workspaceId" value={activeWorkspace.id} />
            {/if}
            <input type="hidden" name="submissionId" value={startSubmissionId} />
            <Composer
              id="start-conversation-message"
              rows={2}
              placeholder={copy.startPlaceholder}
              bind:value={startMessage}
              disabled={!canAssign || startState === "submitting"}
              submitDisabled={!canAssign ||
                startState === "submitting" ||
                !startModelReady ||
                !startMessage.trim() ||
                Boolean(startSlashActionBar) ||
                startSlashSuggestions.length > 0}
              submitting={startState === "submitting"}
              submitLabel={copy.startSubmit}
              submittingLabel={copy.sending}
              ariaLabel={copy.messageLabel}
              multilineHint={copy.multilineHint}
              onValueChange={handleStartMessageChange}
              onKeydown={(event) => handleSlashCompletionKeydown(event, "start")}
              completion={{
                expanded: startSlashSuggestions.length > 0,
                listboxId: startSlashListboxId,
                activeOptionId: startSlashActiveOptionId,
              }}            >
              {#snippet actions()}
                {#if startSlashSuggestions.length > 0}
                  <SlashCommandMenu
                    id={startSlashListboxId}
                    suggestions={startSlashSuggestions}
                    activeIndex={startSlashActiveIndex}
                    ariaLabel={copy.slashActions.completionLabel}
                    hint={copy.slashActions.completionHint}
                    onActiveIndexChange={(index) => (startSlashActiveIndex = index)}
                    onSelect={(suggestion) => selectSlashSuggestion(suggestion, "start")}
                  />
                {/if}
                {#if startSlashActionBar}
                  <SlashActionBar
                    view={startSlashActionBar}
                    resolveAction={(action) => slashActionAvailability(action, "start")}
                    onAction={(action) => handleSlashAction(action, "start")}
                  />
                {/if}
              {/snippet}
              {#snippet context()}
                {#if modelProviders.length > 0}
                  <ModelRuntimeControl
                    id="start-conversation"
                    required
                    bind:open={startModelPickerOpen}
                    bind:modelValue={startModel}
                    bind:thinkingValue={startThinkingLevel}
                    groups={modelGroups}
                    labels={modelRuntimeLabels}
                    modelDisabled={!canAssign || availableModels.length === 0}
                    thinkingDisabled={!canAssign}
                    settingsHref="/settings/models"
                  />
                {:else}
                  <a class="model-settings-link" href="/settings/models">
                    <Icon name={modelControl.available ? "settings" : "warning"} size={14} />
                    {modelControl.available ? copy.configureModels : copy.modelControlUnavailable}
                  </a>
                {/if}
              {/snippet}
              {#snippet feedback()}
                {#if startFeedback}
                <p
                  class="form-feedback {startState}"
                  role={startState === "error" ? "alert" : "status"}
                  aria-live="polite"
                >
                  {startFeedback}
                </p>
                {/if}
              {/snippet}
            </Composer>
          </form>
        {/if}
      </div>
    {:else}
      {@const displayedSessionStatus = visibleSessionStatus(selected.status)}
      {@const selectedPresentation = sessionPresentation(selected)}
      <header class="stage-header">
        <div class="stage-title">
          <p class="kicker">{copy.timelineTitle}</p>
          <h1>
            {#if selectedPresentation.channel}
              <ChannelSessionIcon
                adapter={selectedPresentation.channel.adapter}
                scope={selectedPresentation.channel.scope}
                label={selectedPresentation.channel.label}
              />
            {/if}
            <span class="session-heading-title">{selectedPresentation.title}</span>
          </h1>
          <p>{sessionScopeLabel(selected)}</p>
        </div>
        <div class="stage-actions">
          {#if selected.role}<span class="context-chip">{selected.role}</span>{/if}
          {#if conversationBusy}
            <span
              class="session-working-indicator"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span class="session-working-spinner" aria-hidden="true"></span>
              {copy.working}
            </span>
          {/if}
          <span class="connection-state {liveConnection}" title={connectionLabel()}>
            <span aria-hidden="true"></span>
            {connectionLabel()}
          </span>
          {#if conversationBusy && activeTurnId}
            <form
              id="session-cancel-turn-form"
              method="POST"
              action="?/cancelTurn"
              use:enhance={enhanceCancelTurn}
            >
              <input type="hidden" name="sessionId" value={selected.sessionId} />
              <input type="hidden" name="turnId" value={activeTurnId} />
              <Button
                variant="danger"
                size="compact"
                type="submit"
                disabled={cancelState === "submitting" || cancelState === "success"}
              >
                <Icon name="close" size={14} stroke={2.2} />
                <span>{cancelState === "submitting" ? copy.stopping : copy.stop}</span>
              </Button>
            </form>
          {/if}
          {#if displayedSessionStatus && displayedSessionStatus !== "running"}
            <span class="status-pill {displayedSessionStatus}">{statusLabel(displayedSessionStatus)}</span>
          {/if}
        </div>
      </header>

      <details class="mobile-details">
        <summary>
          <span><Icon name="activity" size={15} />{copy.collapseDetails}</span>
          <Icon name="chevron-down" size={15} />
        </summary>
        {@render sessionDetails(true)}
      </details>

      {#key selected.sessionId}
        <ConversationViewport
          label={copy.timelineTitle}
          followKey={timelineFollowKey}
          announcement={latestAnnouncement}
          jumpToLatestLabel={copy.jumpToLatest}
          hasEarlier={hasEarlierTimeline}
          earlierLabel={copy.showEarlier}
          earlierErrorLabel={copy.unavailable}
          onLoadEarlier={showEarlierTimeline}
          navigationItems={timelineNavigationItems}
        >
        {#if timelineItems.length === 0}
          <div class="conversation-empty">
            <span class="spark-mark"><Icon name="spark" size={20} /></span>
            <p>{copy.timelineEmpty}</p>
          </div>
        {:else}
          {#each renderedTimeline.items as item (item.id)}
            <ConversationMessage
              {item}
              active={item.id === activeProcessItemId}
              userLabel={copy.you}
              assistantLabel={copy.spark}
              sessionLabel={copy.agent}
              copyLabel={copy.copyMessage}
              copiedLabel={copy.copiedMessage}
              partLabels={conversationPartLabels}
              relativeTime={relative}
              {statusLabel}
              retryAction={item.id === retryableTimelineItemId && latestRetryPrompt
                ? {
                    label: copy.retryTurn,
                    submittingLabel: copy.retryingTurn,
                    unavailableLabel: copy.retryUnavailable,
                    submitting: retryState === "submitting",
                    disabled: !canAssign || !modelReady,
                    onRetry: () => {
                      if (latestRetryPrompt) retryConversationTurn(latestRetryPrompt);
                    },
                  }
                : undefined}
            />
          {/each}
        {/if}
        </ConversationViewport>
      {/key}

      <form
        id="session-model-form"
        bind:this={sessionModelForm}
        method="POST"
        action="?/selectModel"
        use:enhance={enhanceSelectModel}
      ></form>
      <input form="session-model-form" type="hidden" name="sessionId" value={selected.sessionId} />
      <form
        id="session-thinking-form"
        bind:this={sessionThinkingForm}
        method="POST"
        action="?/selectThinking"
        use:enhance={enhanceSelectThinking}
      ></form>
      <input
        form="session-thinking-form"
        type="hidden"
        name="sessionId"
        value={selected.sessionId}
      />

      {#each queueItems as item (item.id)}
        <form
          id={queueRemoveFormId(item.id)}
          method="POST"
          action="?/cancelTurn"
          hidden
          use:enhance={enhanceRemoveQueuedTurn}
        >
          <input type="hidden" name="sessionId" value={selected.sessionId} />
          <input type="hidden" name="turnId" value={item.id} />
          <input type="hidden" name="cancelIntent" value="dequeue" />
        </form>
      {/each}

      <form
        bind:this={retryMessageForm}
        method="POST"
        action="?/sendMessage"
        hidden
        use:enhance={enhanceRetryMessage}
      >
        <input type="hidden" name="sessionId" value={selected.sessionId} />
        <input type="hidden" name="submissionId" value={retrySubmissionId} />
        <input type="hidden" name="message" value={retryPrompt} />
      </form>

      <form
        method="POST"
        action="?/sendMessage"
        class="conversation-composer"
        aria-busy={sendState === "submitting"}
        use:enhance={enhanceSendMessage}
      >
        <input type="hidden" name="sessionId" value={selected.sessionId} />
        <input type="hidden" name="submissionId" value={sendSubmissionId} />
        <Composer
          id="conversation-message"
          rows={2}
          placeholder={conversationBusy ? copy.queuePlaceholder : copy.messagePlaceholder}
          bind:value={message}
          disabled={!canAssign || sendState === "submitting"}
          submitDisabled={!canAssign ||
            !modelReady ||
            modelState === "submitting" ||
            thinkingState === "submitting" ||
            sendState === "submitting" ||
            !message.trim() ||
            Boolean(sessionSlashActionBar) ||
            sessionSlashSuggestions.length > 0}
          submitting={sendState === "submitting"}
          submitLabel={conversationBusy ? copy.queueSubmit : copy.sendSubmit}
          submittingLabel={copy.sending}
          ariaLabel={copy.messageLabel}
          multilineHint={copy.multilineHint}
          onValueChange={handleSessionMessageChange}
          onKeydown={(event) => handleSlashCompletionKeydown(event, "session")}
          completion={{
            expanded: sessionSlashSuggestions.length > 0,
            listboxId: sessionSlashListboxId,
            activeOptionId: sessionSlashActiveOptionId,
          }}        >
          {#snippet actions()}
            {#if sessionSlashSuggestions.length > 0}
              <SlashCommandMenu
                id={sessionSlashListboxId}
                suggestions={sessionSlashSuggestions}
                activeIndex={sessionSlashActiveIndex}
                ariaLabel={copy.slashActions.completionLabel}
                hint={copy.slashActions.completionHint}
                onActiveIndexChange={(index) => (sessionSlashActiveIndex = index)}
                onSelect={(suggestion) => selectSlashSuggestion(suggestion, "session")}
              />
            {/if}
            {#if sessionSlashActionBar}
              <SlashActionBar
                view={sessionSlashActionBar}
                resolveAction={(action) => slashActionAvailability(action, "session")}
                onAction={(action) => handleSlashAction(action, "session")}
              />
            {/if}
          {/snippet}
          {#snippet header()}
            <div class="composer-runtime-header">
              {#if liveSessionView?.cwd}
                <SessionStatusBar
                  labels={statusBarLabels}
                  cwd={compactWorkingDirectory(liveSessionView.cwd)}
                  gitBranch={liveSessionView.gitBranch}
                  inputTokens={runtimeStatusUsage.inputTokens}
                  outputTokens={runtimeStatusUsage.outputTokens}
                  cacheReadTokens={runtimeStatusUsage.cacheReadTokens}
                  cacheWriteTokens={runtimeStatusUsage.cacheWriteTokens}
                  costUsd={runtimeStatusUsage.costUsd}
                  latestCacheHitPercent={runtimeStatusUsage.latestCacheHitPercent}
                  contextTokens={runtimeStatusUsage.contextTokens}
                  contextWindow={runtimeStatusUsage.contextWindow}
                />
              {/if}
              <SessionQueue
                items={queueItems}
                labels={queueLabels}
                hasRunningTurn={conversationBusy}
              >
                {#snippet actions(item)}
                  <button
                    class="queue-remove-button"
                    type="submit"
                    form={queueRemoveFormId(item.id)}
                    disabled={dequeueState === "submitting"}
                    aria-label={`${copy.removeQueued}: ${item.text}`}
                    title={copy.removeQueued}
                  >
                    <Icon name="close" size={13} stroke={2.2} />
                    <span>
                      {dequeuingTurnId === item.id && dequeueState === "submitting"
                        ? copy.removingQueued
                        : copy.removeQueued}
                    </span>
                  </button>
                {/snippet}
              </SessionQueue>
            </div>
          {/snippet}
          {#snippet context()}
            {#if modelProviders.length > 0}
              <ModelRuntimeControl
                id="conversation"
                bind:open={sessionModelPickerOpen}
                modelForm="session-model-form"
                thinkingForm="session-thinking-form"
                bind:modelValue={sessionModel}
                bind:thinkingValue={sessionThinkingLevel}
                groups={modelGroups}
                labels={modelRuntimeLabels}
                modelDisabled={!canAssign || modelState === "submitting" || availableModels.length === 0}
                thinkingDisabled={!canAssign || thinkingState === "submitting"}
                selectedLabel={!effectiveModelAvailable ? copy.currentModelUnavailable : undefined}
                settingsHref="/settings/models"
                onModelChange={submitModelSelection}
                onThinkingCommit={() => void submitThinkingSelection()}
              />
            {:else}
              <a class="model-settings-link compact" href="/settings/models">
                <Icon name="warning" size={13} />
                {modelControl.available ? copy.modelUnavailable : copy.modelControlUnavailable}
              </a>
            {/if}
          {/snippet}
          {#snippet feedback()}
            {#if sendFeedback}
              <p
                class="form-feedback {sendState}"
                role={sendState === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {sendFeedback}
              </p>
            {/if}
            {#if retryFeedback}
              <p class="form-feedback error" role="alert" aria-live="polite">
                {retryFeedback}
              </p>
            {/if}
            {#if modelFeedback}
              <p
                class="form-feedback {modelState}"
                class:sr-only={modelState !== "error"}
                role={modelState === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {modelFeedback}
              </p>
            {/if}
            {#if thinkingFeedback}
              <p
                class="form-feedback {thinkingState}"
                class:sr-only={thinkingState !== "error"}
                role={thinkingState === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {thinkingFeedback}
              </p>
            {/if}
            {#if cancelFeedback}
              <p
                class="form-feedback {cancelState}"
                role={cancelState === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {cancelFeedback}
              </p>
            {/if}
            {#if dequeueFeedback}
              <p
                class="form-feedback {dequeueState}"
                role={dequeueState === "error" ? "alert" : "status"}
                aria-live="polite"
              >
                {dequeueFeedback}
              </p>
            {/if}
          {/snippet}
        </Composer>
      </form>
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

  .stage-header {
    align-items: start;
    display: flex;
    flex: 0 0 auto;
    gap: 16px;
    justify-content: space-between;
  }

  .stage-title {
    min-width: 0;
  }

  .stage-actions {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  .connection-state {
    align-items: center;
    color: var(--color-ink-subtle);
    display: inline-flex;
    font-size: 10px;
    font-weight: 650;
    gap: 6px;
    min-height: 32px;
    white-space: nowrap;
  }

  .connection-state > span {
    background: var(--color-ink-disabled);
    border-radius: 999px;
    height: 7px;
    width: 7px;
  }

  .connection-state.live > span {
    background: var(--color-success);
  }

  .connection-state.connecting > span,
  .connection-state.reconnecting > span {
    background: var(--color-warning);
  }

  .connection-state.offline > span {
    background: var(--color-danger);
  }

  .session-working-indicator {
    align-items: center;
    background: var(--color-primary-weak);
    border: 1px solid color-mix(in srgb, var(--color-primary) 22%, transparent);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    display: inline-flex;
    font-size: 11px;
    font-weight: 650;
    gap: 7px;
    min-height: 30px;
    padding: 0 10px;
    white-space: nowrap;
  }

  .session-working-spinner {
    animation: session-working-spin 760ms linear infinite;
    border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 50%;
    border-top-color: currentColor;
    box-sizing: border-box;
    height: 13px;
    width: 13px;
  }

  @keyframes session-working-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .stage-header h1,
  .start-heading h1,
  .stage-empty h1 {
    color: var(--color-ink);
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -0.015em;
    line-height: 1.3;
    margin: 0;
  }

  .stage-header h1 {
    align-items: center;
    display: inline-flex;
    gap: 8px;
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
  }

  .session-heading-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .channel-badge {
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    border-radius: 999px;
    color: var(--color-primary);
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1;
    padding: 5px 8px;
    text-transform: none;
    white-space: nowrap;
  }

  .channel-settings-link {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: var(--rounded-md, 8px);
    color: var(--color-ink);
    display: inline-flex;
    font-size: 12px;
    font-weight: 650;
    gap: 5px;
    padding: 6px 10px;
    text-decoration: none;
    white-space: nowrap;
  }

  .channel-settings-link:hover {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .channel-bindings {
    display: grid;
    gap: 4px;
  }

  .channel-bindings code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    word-break: break-all;
  }

  .channel-settings-row {
    display: grid;
    gap: 6px;
    grid-column: 1 / -1;
  }

  .stage-title > p:last-child,
  .start-heading > div > p:last-child,
  .stage-empty p {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.5;
    margin: 4px 0 0;
  }

  .kicker {
    color: var(--color-primary);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    margin: 0 0 5px;
    text-transform: uppercase;
  }

  h2,
  p {
    margin: 0;
  }

  .conversation-start {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    min-height: 0;
    overflow-y: auto;
    padding: 24px 0;
  }

  .start-heading,
  .start-composer {
    max-width: 720px;
    width: 100%;
  }

  .start-heading {
    align-items: start;
    display: grid;
    gap: 14px;
    grid-template-columns: auto minmax(0, 1fr);
    margin-bottom: 14px;
  }

  .spark-mark {
    align-items: center;
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: 10px;
    color: var(--color-primary);
    display: inline-flex;
    flex: 0 0 auto;
    height: 40px;
    justify-content: center;
    width: 40px;
  }

  .stage-empty {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    flex-direction: column;
    gap: 14px;
    justify-content: center;
    max-width: 460px;
    text-align: center;
  }

  .stage-empty > div {
    display: grid;
    gap: 12px;
    justify-items: center;
  }

  .conversation-empty {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    justify-content: center;
    min-height: 180px;
    text-align: center;
  }

  .conversation-empty p {
    font-size: 13px;
    line-height: 1.5;
    max-width: 380px;
  }

  .conversation-composer {
    align-self: center;
    flex: 0 0 auto;
    max-width: 800px;
    min-width: 0;
    width: 100%;
  }

  .composer-runtime-header {
    display: grid;
    gap: 8px;
    min-width: 0;
  }

  .queue-remove-button {
    align-items: center;
    background: transparent;
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-sm);
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    gap: 4px;
    min-height: 26px;
    padding: 3px 7px;
    white-space: nowrap;
  }

  .queue-remove-button:hover:not(:disabled) {
    background: var(--color-surface);
    border-color: var(--color-danger-soft, var(--color-border));
    color: var(--color-danger);
  }

  .queue-remove-button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .queue-remove-button:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .context-chip {
    align-items: center;
    color: var(--color-ink-subtle);
    display: inline-flex;
    flex: 0 1 auto;
    font-size: 11px;
    gap: 5px;
    max-width: min(220px, 100%);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stage-actions .context-chip {
    max-width: min(260px, 36vw);
  }

  .sr-only {
    border: 0;
    clip: rect(0, 0, 0, 0);
    height: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  .model-settings-link {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 600;
    gap: 5px;
    min-height: 40px;
    padding: 0 10px;
    text-decoration: none;
  }

  .model-settings-link.compact {
    color: var(--color-danger);
  }

  .primary-action,
  .secondary-action {
    align-items: center;
    border-radius: var(--rounded-md);
    display: inline-flex;
    font-size: 13px;
    font-weight: 600;
    gap: 6px;
    justify-content: center;
    min-height: 40px;
    padding: 0 13px;
    text-decoration: none;
    width: fit-content;
  }

  .primary-action {
    background: var(--color-primary);
    border: 0;
    color: var(--color-on-primary, #fff);
    cursor: pointer;
  }

  .primary-action:hover {
    background: var(--color-primary-hover, #1d4ed8);
  }

  .secondary-action {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
  }

  .form-feedback {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.4;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .form-feedback.success {
    color: var(--color-success-strong, var(--color-success));
  }

  .form-feedback.error {
    color: var(--color-danger-strong, var(--color-danger));
  }

  .details-heading h2 {
    color: var(--color-ink);
    font-size: 15px;
    font-weight: 650;
  }

  .details-content {
    display: grid;
    gap: 20px;
  }

  .details-grid {
    display: grid;
    gap: 14px;
    margin: 0;
  }

  .details-grid div {
    display: grid;
    gap: 5px;
  }

  .details-grid dt {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .details-grid dd {
    color: var(--color-ink-muted);
    font-size: 13px;
    margin: 0;
    min-width: 0;
  }

  .details-grid a {
    color: var(--color-primary);
    text-decoration: none;
  }

  .mobile-details summary {
    align-items: center;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: flex;
    font-size: 12px;
    font-weight: 650;
    justify-content: space-between;
    list-style: none;
    min-height: 40px;
  }

  .mobile-details summary::-webkit-details-marker {
    display: none;
  }

  .mobile-details summary > span {
    align-items: center;
    display: inline-flex;
    gap: 7px;
  }

  .muted {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.5;
  }

  .status-pill {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 650;
    padding: 4px 7px;
    text-transform: capitalize;
    white-space: nowrap;
  }

  .status-pill.running,
  .status-pill.ready,
  .status-pill.queued,
  .status-pill.acked {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill.completed,
  .status-pill.success,
  .status-pill.delivered {
    background: var(--color-success-weak, #ecfdf5);
    color: var(--color-success-strong, #047857);
  }

  .status-pill.failed,
  .status-pill.error,
  .status-pill.rejected {
    background: var(--color-danger-weak, #fef2f2);
    color: var(--color-danger-strong, #b91c1c);
  }

  .status-pill.archived,
  .status-pill.cancelled {
    background: var(--color-warning-soft);
    color: var(--color-warning-strong, var(--color-warning));
  }

  .mobile-details {
    display: none;
  }

  .sr-only {
    border: 0;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  @media (max-width: 960px) {
    .sessions-stage,
    .sessions-stage.has-selection {
      grid-template-columns: minmax(0, 1fr);
      height: 100%;
      min-height: 0;
    }

    .details-pane {
      display: none;
    }

    .mobile-details {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 10px;
      display: block;
      flex: 0 0 auto;
      padding: 10px 12px;
    }

    .mobile-details[open] {
      max-height: min(48dvh, 420px);
      overflow-y: auto;
    }

    .mobile-details .details-content {
      border-top: 1px solid var(--color-border-soft);
      gap: 14px;
      margin-top: 10px;
      padding-top: 12px;
    }

    .mobile-details .details-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

  }

  @media (max-width: 640px) {
    .stage-pane {
      gap: 12px;
      padding: 14px 12px;
    }

    .conversation-start {
      align-items: stretch;
      justify-content: flex-start;
      padding: 10px 0;
    }

    .start-heading {
      margin-bottom: 14px;
    }

    .mobile-details .details-grid {
      grid-template-columns: 1fr 1fr;
    }

  }

  @media (prefers-reduced-motion: reduce) {
    .session-working-spinner {
      animation: none;
    }
  }
</style>
