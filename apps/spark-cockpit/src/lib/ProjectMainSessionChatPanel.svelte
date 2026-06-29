<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import ProjectChatComposer from "$lib/ProjectChatComposer.svelte";
  import ProjectChatTranscript from "$lib/ProjectChatTranscript.svelte";
  import { buildProjectChatContextActions } from "$lib/project-chat-context-actions";

  type Command = {
    id: string;
    kind: string;
    title: string | null;
    payloadJson: string;
    status: string;
    deliveryStatus: string | null;
    attemptCount: number | null;
    lastAttemptAt: string | null;
    ackedAt: string | null;
    rejectedAt: string | null;
    rejectCode: string | null;
    rejectMessage: string | null;
    runtimeWorkspaceName: string | null;
    runtimeName: string | null;
    runtimeStatus: string | null;
    createdAt: string;
    updatedAt: string;
  };

  type MainSessionMessages = {
    aria: string;
    kicker: string;
    title: string;
    body: string;
    contextLabel: string;
    workspaceContext: string;
    projectContext: string;
    runtimeContext: string;
    noOwnerContext: string;
    readyState: string;
    busyState: string;
    offlineState: string;
    emptyAssistantTitle: string;
    emptyAssistantBody: string;
    suggestionsLabel: string;
    contextActionsLabel: string;
    suggestNoTasks: string;
    suggestBlockedTask: string;
    suggestRecentArtifact: string;
    suggestPendingInbox: string;
    taskContextKicker: string;
    artifactContextKicker: string;
    inboxContextKicker: string;
    askAboutThis: string;
    attachToChat: string;
    openArtifact: string;
    openInbox: string;
    userLabel: string;
    assistantLabel: string;
    systemLabel: string;
    runDetails: string;
    toolActivity: string;
    rawLogOutput: string;
    noRunDetails: string;
    workingLabel: string;
    elapsedLabel: string;
    currentActivityLabel: string;
    waitingAnswer: string;
    runningAnswer: string;
    completedAnswer: string;
    errorAnswer: string;
    cancelledAnswer: string;
    latestOutputPrefix: string;
    commandMetaLabel: string;
    invocationMetaLabel: string;
    logMetaLabel: string;
    detailsSummary: string;
    diagnosticsTitle: string;
    diagnosticsBody: string;
    suggestions: string[];
    messageLabel: string;
    placeholder: string;
    send: string;
    stop: string;
    stopUnavailable: string;
    queue: string;
    queuedLabel: string;
    editQueued: string;
    deleteQueued: string;
    steerQueued: string;
    steering: string;
    permissionLabel: string;
    permissionChatOnly: string;
    modelLabel: string;
    modelUnavailable: string;
    modeLabel: string;
    modeDefault: string;
    placeholderControlsHint: string;
    keyboardHint: string;
    unavailableBody: string;
  };

  type ProjectChatPanelData = {
    messages: {
      common: Record<string, unknown>;
      project: {
        command: {
          recentAria: string;
          recentLabel: string;
          shownSuffix: string;
          empty: string;
        };
        mainSession: MainSessionMessages;
      };
    };
    project: {
      id: string;
      name: string;
      workspaceName: string;
      workspaceSlug: string;
      status: string;
    };
    ownerBinding: {
      displayName: string;
      bindingStatus: string;
      runtimeName: string;
      runtimeStatus: string;
    } | null;
    taskSummary: {
      byGroup: Record<string, number | undefined>;
    };
    tasks: Array<{
      runtimeTaskId: string;
      title: string;
      description: string | null;
      status: string;
      statusGroup: string;
    }>;
    inboxItems: Array<{
      id: string;
      kind: string;
      title: string;
      status: string;
      urgency: string;
    }>;
    artifacts: Array<{
      id: string;
      kind: string;
      title: string;
      format: string;
      source: string;
    }>;
    invocations: Array<{
      id: string;
      runtimeInvocationId: string;
      taskRuntimeId: string | null;
      agentName: string | null;
      status: string;
      updatedAt: string;
    }>;
    commands: Command[];
    logChunks: Array<{
      id: string;
      runtimeInvocationId: string;
      agentName: string | null;
      stream: string;
      sequence: number;
      content: string;
      createdAt: string;
    }>;
  };

  let {
    data,
    form,
    canStartTask,
    startButtonLabel,
    ownerCommandNote,
    workspaceUrl,
    statusLabel,
    formatRelative,
    deliveryHeadline,
    deliveryDetail,
  }: {
    data: ProjectChatPanelData;
    form?: { message?: string; queuedCommandId?: string; values?: { prompt?: string; title?: string } } | null;
    canStartTask: boolean;
    startButtonLabel: string;
    ownerCommandNote: string;
    workspaceUrl: string;
    statusLabel: (status: string) => string;
    formatRelative: (value: string | null) => string;
    deliveryHeadline: (command: Command) => string;
    deliveryDetail: (command: Command) => string;
  } = $props();

  let t = $derived(data.messages.project.mainSession);
  let runtimeStatus = $derived(data.ownerBinding?.runtimeStatus ?? "blocked");
  let runtimeContext = $derived(
    data.ownerBinding
      ? `${data.ownerBinding.displayName} · ${data.ownerBinding.runtimeName}`
      : t.noOwnerContext,
  );
  let hasInFlightCommand = $derived(
    data.commands.some(
      (command) =>
        command.status === "queued" ||
        command.status === "delivered" ||
        command.deliveryStatus === "pending" ||
        command.deliveryStatus === "sent",
    ),
  );
  let hasActiveRun = $derived((data.taskSummary.byGroup.running ?? 0) > 0 || hasInFlightCommand);
  let latestActiveInvocationId = $derived(
    data.invocations.find((invocation) =>
      ["queued", "running"].includes(invocation.status.toLowerCase()),
    )?.runtimeInvocationId ?? null,
  );
  let assistantState = $derived(hasActiveRun ? t.busyState : canStartTask ? t.readyState : t.offlineState);
  let contextActions = $derived(
    buildProjectChatContextActions({
      projectName: data.project.name,
      tasks: data.tasks,
      artifacts: data.artifacts,
      inboxItems: data.inboxItems,
      baseSuggestions: t.suggestions,
      workspaceUrl,
      messages: t,
    }),
  );
</script>

<section class="panel main-session-panel" aria-labelledby="main-session-title" aria-label={t.aria}>
  <div class="main-session-header">
    <div>
      <p class="panel-kicker">{t.kicker}</p>
      <h2 id="main-session-title">{t.title}</h2>
      <p class="main-session-copy">{t.body}</p>
    </div>
    <div class="main-session-status" aria-label={t.contextLabel}>
      <span class="context-chip"><Icon name="workspace" size={14} />{t.workspaceContext}: {data.project.workspaceName}</span>
      <span class="context-chip"><Icon name="folder" size={14} />{t.projectContext}: {data.project.name}</span>
      <span class="context-chip runtime {runtimeStatus}">
        <Icon name="agents" size={14} />{t.runtimeContext}: {runtimeContext}
      </span>
    </div>
  </div>

  <div class="chat-shell" class:busy={hasActiveRun}>
    <ProjectChatTranscript
      {t}
      commands={data.commands}
      invocations={data.invocations}
      logChunks={data.logChunks}
      {runtimeStatus}
      {hasActiveRun}
      {assistantState}
      {ownerCommandNote}
      {statusLabel}
      {formatRelative}
    />

    <ProjectChatComposer
      {t}
      projectName={data.project.name}
      {form}
      {canStartTask}
      {hasActiveRun}
      {startButtonLabel}
      {latestActiveInvocationId}
      suggestions={contextActions.suggestions}
      contextCards={contextActions.cards}
    />
  </div>

  <details class="command-diagnostics">
    <summary>
      <span>
        <Icon name="activity" size={16} />
        {t.diagnosticsTitle}
      </span>
      <small>{data.commands.length} {data.messages.project.command.shownSuffix}</small>
    </summary>
    <p>{t.diagnosticsBody}</p>
    <div class="command-deliveries" aria-label={data.messages.project.command.recentAria}>
      <div class="command-deliveries-heading">
        <span class="meta-label">{data.messages.project.command.recentLabel}</span>
        <small>{data.commands.length} {data.messages.project.command.shownSuffix}</small>
      </div>
      {#if data.commands.length === 0}
        <p class="command-note">{data.messages.project.command.empty}</p>
      {:else}
        {#each data.commands as command}
          <article class="command-delivery-row">
            <header>
              <div>
                <strong>{command.title ?? command.kind}</strong>
                <small>{command.id} · {formatRelative(command.createdAt)}</small>
              </div>
              <span class="status-pill {command.deliveryStatus ?? command.status}">
                {statusLabel(command.deliveryStatus ?? command.status)}
              </span>
            </header>
            <p>{deliveryHeadline(command)}</p>
            {#if deliveryDetail(command)}
              <small>{deliveryDetail(command)}</small>
            {/if}
          </article>
        {/each}
      {/if}
    </div>
  </details>
</section>

<style>
  .main-session-panel {
    display: grid;
    gap: 20px;
    padding: 24px 28px;
  }

  .main-session-header {
    align-items: start;
    display: grid;
    gap: 18px;
    grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
  }

  .panel-kicker {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0.08em;
    margin: 0 0 8px;
    text-transform: uppercase;
  }

  h2,
  p {
    margin: 0;
  }

  .main-session-copy,
  .command-diagnostics p {
    color: var(--color-ink-subtle);
    line-height: 1.55;
  }

  .main-session-status {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .main-session-status {
    justify-content: flex-end;
  }

  .context-chip {
    align-items: center;
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 12px;
    font-weight: 750;
    gap: 6px;
    max-width: 100%;
    padding: 7px 10px;
  }

  .context-chip.runtime.online,
  .context-chip.runtime.available {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .chat-shell {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
    border: 1px solid var(--color-border);
    border-radius: 18px;
    display: grid;
    gap: 16px;
    padding: 18px;
  }

  .chat-shell.busy {
    border-color: var(--color-primary-soft);
  }

  .command-diagnostics {
    border-top: 1px solid var(--color-border);
    display: grid;
    gap: 12px;
    padding-top: 16px;
  }

  .command-diagnostics summary {
    align-items: center;
    color: var(--color-ink);
    cursor: pointer;
    display: flex;
    font-weight: 800;
    justify-content: space-between;
  }

  .command-diagnostics summary span {
    align-items: center;
    display: inline-flex;
    gap: 8px;
  }

  .command-diagnostics summary small,
  .command-deliveries-heading small,
  .command-delivery-row small {
    color: var(--color-ink-subtle);
    font-size: 12px;
  }

  .command-deliveries {
    display: grid;
    gap: 10px;
    padding-top: 4px;
  }

  .command-deliveries-heading,
  .command-delivery-row header {
    align-items: center;
    display: flex;
    gap: 10px;
    justify-content: space-between;
  }

  .meta-label {
    color: var(--color-ink-muted);
    display: block;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.04em;
    margin-bottom: 6px;
    text-transform: uppercase;
  }

  .command-note {
    color: var(--color-primary);
    font-size: 12px;
    line-height: 1.45;
  }

  .command-delivery-row {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    display: grid;
    gap: 8px;
    padding: 12px;
  }

  .command-delivery-row strong {
    color: var(--color-ink);
    display: block;
    font-size: 13px;
  }

  .command-delivery-row p {
    color: var(--color-ink-muted);
    font-size: 13px;
    font-weight: 700;
  }

  .status-pill {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
    text-transform: capitalize;
    white-space: nowrap;
  }

  .status-pill.online,
  .status-pill.running,
  .status-pill.delivered,
  .status-pill.sent {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill.done,
  .status-pill.completed,
  .status-pill.succeeded,
  .status-pill.resolved,
  .status-pill.acked {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  .status-pill.blocked,
  .status-pill.pending,
  .status-pill.queued,
  .status-pill.ready,
  .status-pill.offline,
  .status-pill.disconnected {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .status-pill.failed,
  .status-pill.cancelled,
  .status-pill.rejected {
    background: var(--color-danger-soft);
    color: var(--color-danger-strong);
  }

  @media (max-width: 1100px) {
    .main-session-header {
      grid-template-columns: 1fr;
    }

    .main-session-status {
      justify-content: flex-start;
    }
  }
</style>
