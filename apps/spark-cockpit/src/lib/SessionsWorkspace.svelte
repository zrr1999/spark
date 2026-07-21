<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import {
    sessionStatusIdentity,
    sessionStatusUsage,
    visibleConversationPartText,
  } from "$lib/components/conversation";
  import type {
    SessionQueueItem,
    SessionQueueLabels,
    SlashActionAvailability,
  } from "$lib/components/conversation";
  import { sessionHasChannelBinding } from "$lib/channel-session-title";
  import { formatRelativeTime, statusLabel as getStatusLabel, type AppMessages } from "$lib/i18n";
  import type { PendingWorkbenchAsk } from "$lib/pending-ask";
  import {
    cockpitSlashSuggestionsForInput,
    localizeCockpitSlashActionBar,
  } from "$lib/slash-actions";
  import { resolveSessionActivityState } from "$lib/session-activity-state";
  import {
    activeSessionTimelineProcessItemId,
    buildSessionTimeline,
    latestSessionRetryCandidate,
    sessionTimelineWindow,
  } from "$lib/session-timeline";
  import type { SessionSnapshotHistory } from "$lib/session-snapshot-window";
  import { buildSessionWorkbenchView } from "$lib/session-workbench";
  import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
  import { workspaceSessionsPath } from "$lib/workspace-routes";
  import {
    createId,
    sparkSlashActionBarForInput,
    sparkThinkingLevelOptions,
    type SparkActionView,
    type SparkSessionView,
  } from "@zendev-lab/spark-protocol";
  import type { CockpitMessages } from "@zendev-lab/spark-cockpit-i18n";
  import { onMount, tick, untrack } from "svelte";
  import SessionDetailsPanel from "$lib/sessions-workspace/SessionDetailsPanel.svelte";
  import SessionStartPane from "$lib/sessions-workspace/SessionStartPane.svelte";
  import SessionConversationPane from "$lib/sessions-workspace/SessionConversationPane.svelte";
  import type { SessionConversationHost } from "$lib/sessions-workspace/conversation-host";
  // SessionAskPanel mounts from SessionComposerPane via conversationHost.sessionPendingAsk.
  import {
    adoptCancelledTurnIntoLiveState,
    adoptQueuedTurnIntoLiveState,
    bindSessionFormEnhancers,
    buildConversationPartLabels,
    buildInspectorLabels,
    buildModelGroups as buildModelGroupsFromProviders,
    buildModelRuntimeLabels,
    buildStatusBarLabels,
    compactWorkingDirectory,
    connectionLabel as resolveConnectionLabel,
    createActivityRefreshController,
    createComposerController,
    createLiveSessionController,
    createSlashHandlers,
    createTimelineWindowController,
    isNavigationTurn,
    modelValue,
    navigationSummary,
    queueRemoveFormId,
    resetCancelUiForActiveTurn,
    sessionMessageInvocationId,
    slashActionAvailability as resolveSlashAvailability,
  } from "$lib/sessions-workspace";
  import { createShellFeedbackController } from "$lib/sessions-workspace/shell-feedback.svelte";
  import {
    channelsSettingsHref as resolveChannelsSettingsHref,
    sessionPresentation as resolveSessionPresentation,
    sessionScopeLabel as resolveSessionScopeLabel,
    workspaceHref as resolveWorkspaceHref,
  } from "$lib/sessions-workspace/workspace-presentation";
  import type {
    ComposerSurface,
    FormValues,
    ModelControlState,
    SessionActivity,
    SessionRecord,
    WorkspaceOption,
  } from "$lib/sessions-workspace/types";

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
  let selectedWorkspaceId = $derived(
    selected ? workspaceIdForWorkbenchSession(selected) : null,
  );
  let selectedWorkspaceHref = $derived(resolveWorkspaceHref(workspaces, selectedWorkspaceId));
  let selectedIsChannelSession = $derived(selected ? sessionHasChannelBinding(selected) : false);
  let selectedChannelBindings = $derived(
    (selected?.bindings ?? []).filter((binding) => binding.kind === "channel"),
  );
  let selectedChannelsSettingsHref = $derived(
    resolveChannelsSettingsHref(workspaces, selectedWorkspaceId),
  );
  let activityCommands = $derived(activity?.commands ?? []);
  let activityReports = $derived(activity?.reports ?? []);
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
  let thinkingLevels = sparkThinkingLevelOptions;

  const feedback = createShellFeedbackController();
  let sessionModelForm = $state<HTMLFormElement | null>(null);
  let sessionThinkingForm = $state<HTMLFormElement | null>(null);
  let retryMessageForm = $state<HTMLFormElement | null>(null);

  const activityRefresh = createActivityRefreshController({
    canRefresh: () => Boolean(selected && document.visibilityState !== "hidden"),
    invalidateAll,
  });

  const live = createLiveSessionController({
    getSelectedSessionId: () => selectedSessionId,
    getSelectedWorkspaceId: () => selectedWorkspaceId,
    getSessionView: () => sessionView,
    getSessionHistory: () => sessionHistory,
    getInitialEventCursor: () => initialEventCursor,
    getActivityCommandIds: () => activityCommands.map((command) => command.id),
    getActivityInvocationIds: () =>
      activityCommands.flatMap((command) => (command.invocationId ? [command.invocationId] : [])),
    getSessionActivityState: () => sessionActivityState,
    invalidateAll,
    onRefreshActivity: () => activityRefresh.scheduleActivityRefresh(),
    onDequeueReset: (next) => feedback.applyDequeueReset(next),
  });

  let sessionMessages = $derived(live.liveSessionView?.messages ?? []);
  let sessionActivityState = $derived(
    resolveSessionActivityState({
      registryStatus: selected?.status,
      session: live.liveSessionView,
      projectedTurns: activity?.queuedTurns ?? [],
      liveActiveTurnId: live.liveEventState?.activeTurnId,
    }),
  );
  let queuedTurns = $derived(sessionActivityState.pendingTurns);
  let statusIdentity = $derived(
    sessionStatusIdentity(live.liveSessionView, {
      sessionModel: modelControl.snapshot.session?.model,
      defaultModel: modelControl.snapshot.defaultModel,
      sessionThinkingLevel: modelControl.snapshot.session?.thinkingLevel,
    }),
  );
  let effectiveModel = $derived(statusIdentity.model ?? null);
  let effectiveModelValue = $derived(effectiveModel ? modelValue(effectiveModel) : "");
  let effectiveThinkingLevel = $derived(statusIdentity.thinkingLevel ?? "medium");
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
  let conversationBusy = $derived(sessionActivityState.phase === "running");
  let activeTurnId = $derived(sessionActivityState.runningTurnId);

  const composer = createComposerController({
    getFormIntent: () => formIntent,
    getFormValues: () => formValues,
    getFormMessage: () => formMessage,
    getActiveWorkspaceId: () => activeWorkspace?.id,
    getStartSubmissionIdSeed: () => startSubmissionIdSeed,
    getSendSubmissionIdSeed: () => sendSubmissionIdSeed,
    getInitialSubmissionId: () => initialSubmissionId,
    getSelectedSessionId: () => selectedSessionId,
    getEffectiveModelValue: () => effectiveModelValue,
    getEffectiveModelAvailable: () => effectiveModelAvailable,
    getAvailableModelValues: () => availableModels.map((entry) => modelValue(entry.model)),
    getEffectiveThinkingLevel: () => effectiveThinkingLevel,
    getThinkingLevels: () => thinkingLevels,
  });

  const timeline = createTimelineWindowController({
    getSelectedSessionId: () => selectedSessionId,
    getLiveSessionId: () => live.liveSessionId,
    getLiveSessionView: () => live.liveSessionView,
    getLiveSessionHistory: () => live.liveSessionHistory,
    setLiveSessionView: (view) => {
      live.liveSessionView = view;
    },
    setLiveSessionHistory: (history) => {
      live.liveSessionHistory = history;
    },
    getLiveEventState: () => live.liveEventState,
  });

  let startModelReady = $derived(
    modelControl.available &&
      availableModels.some((entry) => modelValue(entry.model) === composer.startModel),
  );

  let copy = $derived(messages.workbench);
  const startSlashListboxId = "start-conversation-slash-commands";
  const sessionSlashListboxId = "conversation-slash-commands";
  let startSlashActionBar = $derived.by(() => {
    const view = sparkSlashActionBarForInput(composer.startMessage);
    return view ? localizeCockpitSlashActionBar(view, copy.slashActions) : undefined;
  });
  let sessionSlashActionBar = $derived.by(() => {
    const view = sparkSlashActionBarForInput(composer.message);
    return view ? localizeCockpitSlashActionBar(view, copy.slashActions) : undefined;
  });
  let startSlashSuggestions = $derived.by(() =>
    composer.startSlashDismissedInput === composer.startMessage
      ? []
      : cockpitSlashSuggestionsForInput(composer.startMessage, copy.slashActions),
  );
  let sessionSlashSuggestions = $derived.by(() =>
    composer.sessionSlashDismissedInput === composer.message
      ? []
      : cockpitSlashSuggestionsForInput(composer.message, copy.slashActions),
  );
  let startSlashActiveOptionId = $derived(
    startSlashSuggestions.length > 0
      ? `${startSlashListboxId}-option-${Math.min(
          composer.startSlashActiveIndex,
          startSlashSuggestions.length - 1,
        )}`
      : undefined,
  );
  let sessionSlashActiveOptionId = $derived(
    sessionSlashSuggestions.length > 0
      ? `${sessionSlashListboxId}-option-${Math.min(
          composer.sessionSlashActiveIndex,
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

  let modelRuntimeLabels = $derived(buildModelRuntimeLabels(copy));
  let statusBarLabels = $derived(buildStatusBarLabels(copy));
  let conversationPartLabels = $derived(buildConversationPartLabels(copy));
  let runtimeStatusUsage = $derived(
    sessionStatusUsage(live.liveSessionView, effectiveModelCatalogEntry?.contextWindow),
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
    sessionTimelineWindow(timelineItems, timeline.effectiveTimelineRenderLimit),
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
    renderedTimeline.hiddenCount > 0 || (live.liveSessionHistory?.hasEarlierMessages ?? false),
  );
  let activeProcessItemId = $derived(
    activeSessionTimelineProcessItemId(
      timelineItems,
      conversationBusy && Boolean(activeTurnId),
    ),
  );
  let inspectorLabels = $derived(buildInspectorLabels(copy));
  let workbenchView = $derived.by(() => {
    if (!live.liveSessionView) return null;
    const effectiveStatus: "running" | "idle" = conversationBusy ? "running" : "idle";
    const session =
      live.liveSessionView.status === effectiveStatus
        ? live.liveSessionView
        : { ...live.liveSessionView, status: effectiveStatus };
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
    feedback.applyCancelReset(
      resetCancelUiForActiveTurn(
        {
          cancelState: feedback.cancelState,
          cancelFeedback: feedback.cancelFeedback,
          cancelledTurnId: feedback.cancelledTurnId,
        },
        activeTurnId,
      ),
    );
  });

  $effect(() => {
    if (formIntent === "removeQueuedTurn" && formMessage && feedback.dequeueState === "idle") {
      feedback.dequeueFeedback = formMessage;
    }
  });

  function adoptQueuedTurn(result: unknown) {
    const state = untrack(() => live.liveEventState);
    const adopted = adoptQueuedTurnIntoLiveState(result, state, live.liveSessionId);
    if (!adopted) return;
    live.liveEventState = adopted;
    live.liveSessionView = adopted.view;
  }

  function adoptCancelledTurn(result: unknown) {
    const state = untrack(() => live.liveEventState);
    const adopted = adoptCancelledTurnIntoLiveState(result, state, live.liveSessionId);
    if (!adopted) return;
    live.liveEventState = adopted;
    live.liveSessionView = adopted.view;
  }

  const {
    enhanceStartConversation,
    enhanceSendMessage,
    enhanceCancelTurn,
    enhanceRemoveQueuedTurn,
    enhanceSelectModel,
    enhanceSelectThinking,
    enhanceRetryMessage,
  } = bindSessionFormEnhancers({
    composer,
    getCopy: () => copy,
    getActiveWorkspaceId: () => activeWorkspace?.id ?? "",
    getSelectedSessionId: () => selectedSessionId,
    getEffectiveModelValue: () => effectiveModelValue,
    getEffectiveThinkingLevel: () => effectiveThinkingLevel,
    shell: feedback.formFeedback,
    adoptQueuedTurn,
    adoptCancelledTurn,
    invalidateAll,
  });

  onMount(() => {
    document.addEventListener("visibilitychange", activityRefresh.onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", activityRefresh.onVisibilityChange);
      activityRefresh.dispose();
      feedback.dispose();
    };
  });

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function relative(value: string | null) {
    return formatRelativeTime(value, locale as "en" | "zh-CN", common);
  }

  function connectionLabel() {
    return resolveConnectionLabel(live.liveConnection, copy);
  }

  function sessionScopeLabel(session: SessionRecord) {
    return resolveSessionScopeLabel(workspaces, session, messages.unknownWorkspace);
  }

  function sessionPresentation(session: SessionRecord) {
    return resolveSessionPresentation(session, messages, copy);
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
      modelState: feedback.modelState,
      thinkingState: feedback.thinkingState,
      queueItemCount: queueItems.length,
      conversationBusy,
      hasActiveTurn: Boolean(activeTurnId),
      cancelState: feedback.cancelState,
      hasRetryPrompt: Boolean(latestRetryPrompt),
      modelReady,
      retryState: feedback.retryState,
      reasons: copy.slashActions.reasons,
    });
  }

  function retryConversationTurn(prompt: string) {
    if (!selected || !canAssign || !modelReady || feedback.retryState === "submitting") return;
    feedback.retryPrompt = prompt;
    feedback.retrySubmissionId = createId("idem");
    feedback.retryFeedback = null;
    feedback.retryState = "idle";
    void tick().then(() => retryMessageForm?.requestSubmit());
  }

  async function submitModelSelection(nextValue: string) {
    composer.sessionModel = nextValue;
    await tick();
    sessionModelForm?.requestSubmit();
  }

  async function submitThinkingSelection() {
    await tick();
    sessionThinkingForm?.requestSubmit();
  }

  const {
    selectSlashSuggestion,
    handleSlashCompletionKeydown,
    handleSlashAction,
  } = createSlashHandlers({
    composer,
    getSessionsHref: () => sessionsHref,
    getStartSlashSuggestions: () => startSlashSuggestions,
    getSessionSlashSuggestions: () => sessionSlashSuggestions,
    isSlashActionEnabled: (action, surface) => slashActionAvailability(action, surface).enabled,
    getLatestRetryPrompt: () => latestRetryPrompt,
    retryConversationTurn,
    submitThinkingSelection,
  });

  let conversationHost = $derived.by((): SessionConversationHost => ({
    selected: selected!,
    messages,
    copy,
    canAssign,
    conversationBusy,
    activeTurnId,
    liveConnection: live.liveConnection,
    connectionLabel,
    statusLabel,
    sessionScopeLabel,
    sessionPresentation,
    timelineFollowKey,
    latestAnnouncement,
    hasEarlierTimeline,
    showEarlierTimeline: timeline.showEarlierTimeline,
    timelineNavigationItems,
    timelineItems,
    renderedTimelineItems: renderedTimeline.items,
    activeProcessItemId,
    conversationPartLabels,
    relative,
    retryableTimelineItemId,
    latestRetryPrompt,
    retryState: feedback.retryState,
    modelReady,
    retryConversationTurn,
    get sessionModelForm() { return sessionModelForm; },
    set sessionModelForm(v) { sessionModelForm = v; },
    get sessionThinkingForm() { return sessionThinkingForm; },
    set sessionThinkingForm(v) { sessionThinkingForm = v; },
    get retryMessageForm() { return retryMessageForm; },
    set retryMessageForm(v) { retryMessageForm = v; },
    get sessionModel() { return composer.sessionModel; },
    set sessionModel(v) { composer.sessionModel = v; },
    get sessionThinkingLevel() { return composer.sessionThinkingLevel; },
    set sessionThinkingLevel(v) { composer.sessionThinkingLevel = v; },
    retryPrompt: feedback.retryPrompt,
    retrySubmissionId: feedback.retrySubmissionId,
    get message() { return composer.message; },
    set message(v) { composer.message = v; },
    sendSubmissionId: composer.sendSubmissionId,
    sendState: composer.sendState,
    sendFeedback: composer.sendFeedback,
    retryFeedback: feedback.retryFeedback,
    modelFeedback: feedback.modelFeedback,
    thinkingFeedback: feedback.thinkingFeedback,
    cancelFeedback: feedback.cancelFeedback,
    dequeueFeedback: feedback.dequeueFeedback,
    modelState: feedback.modelState,
    thinkingState: feedback.thinkingState,
    cancelState: feedback.cancelState,
    dequeueState: feedback.dequeueState,
    dequeuingTurnId: feedback.dequeuingTurnId,
    queueItems,
    queueLabels,
    queueRemoveFormId,
    sessionPendingAsk,
    askDetailMessages,
    liveSessionView: live.liveSessionView,
    statusBarLabels,
    compactWorkingDirectory,
    runtimeStatusUsage,
    modelProvidersLength: modelProviders.length,
    modelGroups,
    modelRuntimeLabels,
    availableModelsLength: availableModels.length,
    modelControl,
    effectiveModelAvailable,
    get sessionModelPickerOpen() { return composer.sessionModelPickerOpen; },
    set sessionModelPickerOpen(v) { composer.sessionModelPickerOpen = v; },
    sessionSlashSuggestions,
    sessionSlashActionBar,
    sessionSlashActiveIndex: composer.sessionSlashActiveIndex,
    setSessionSlashActiveIndex: (index) => {
      composer.sessionSlashActiveIndex = index;
    },
    sessionSlashListboxId,
    sessionSlashActiveOptionId,
    enhanceCancelTurn,
    enhanceSelectModel,
    enhanceSelectThinking,
    enhanceRemoveQueuedTurn,
    enhanceRetryMessage,
    enhanceSendMessage,
    slashActionAvailability: (action, _surface) => slashActionAvailability(action, "session"),
    handleSessionMessageChange: composer.handleSessionMessageChange,
    handleSlashCompletionKeydown: (event, _surface) =>
      handleSlashCompletionKeydown(event, "session"),
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
        startState={composer.startState}
        startFeedback={composer.startFeedback}
        bind:startMessage={composer.startMessage}
        startSubmissionId={composer.startSubmissionId}
        bind:startModel={composer.startModel}
        bind:startThinkingLevel={composer.startThinkingLevel}
        {startModelReady}
        bind:startModelPickerOpen={composer.startModelPickerOpen}
        {startSlashSuggestions}
        {startSlashActionBar}
        startSlashActiveIndex={composer.startSlashActiveIndex}
        {startSlashListboxId}
        {startSlashActiveOptionId}
        modelProvidersLength={modelProviders.length}
        {modelGroups}
        {modelRuntimeLabels}
        availableModelsLength={availableModels.length}
        {modelControl}
        {enhanceStartConversation}
        slashActionAvailability={(action, _surface) => slashActionAvailability(action, "start")}
        onStartMessageChange={composer.handleStartMessageChange}
        onSlashKeydown={(event) => handleSlashCompletionKeydown(event, "start")}
        onSlashActiveIndexChange={(index) => (composer.startSlashActiveIndex = index)}
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
  }

  @media (max-width: 640px) {
    .stage-pane {
      gap: 12px;
      padding: 14px 12px;
    }
  }
</style>
