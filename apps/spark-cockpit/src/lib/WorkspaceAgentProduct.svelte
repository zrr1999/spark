<script lang="ts">
  import { onMount } from "svelte";
  import {
    addOptimisticAgentsChatCommand,
    applyAgentsChatEvent,
    createAgentsChatLiveState,
    type AgentsChatSerializedEvent,
  } from "$lib/agents-chat-live-state";
  import AgentMdxStream from "$lib/AgentMdxStream.svelte";
  import Icon from "$lib/Icon.svelte";
  import {
    activityKind,
    buildCockpitChatTranscriptTurns,
    type CockpitChatTranscriptTurn,
  } from "$lib/cockpit-chat-transcript-view";
  import {
    formatRelativeTime,
    statusLabel as getStatusLabel,
    type AppMessages,
    type Locale,
  } from "$lib/i18n";
  import { workspaceControlControlLabel } from "$lib/workspace-control-display";
  import type { AgentsProductProjection } from "@zendev-lab/spark-cockpit-coordination/agents-product";

  type WorkspaceAgentProductData = AgentsProductProjection & {
    locale: Locale;
    messages: AppMessages;
    workspace: {
      id: string;
      name: string;
    };
  };

  type WorkspaceAgentProductForm = {
    intent?: string;
    message?: string;
    queuedCommandId?: string;
    values?: {
      prompt?: string;
    };
  } | null;

  let { data, form = null }: { data: WorkspaceAgentProductData; form?: WorkspaceAgentProductForm } =
    $props();
  let t = $derived(data.messages.agents);
  let product = $derived(t.product);
  let common = $derived(data.messages.common);
  let taskForm = $derived(form?.intent === "chat" ? form : null);
  let selectedRunId = $state("current");
  let draftPrompt = $state("");
  let liveState = $state(
    createAgentsChatLiveState({
      workspaceId: "",
      commands: [],
      invocations: [],
      logChunks: [],
    }),
  );
  $effect(() => {
    liveState = createAgentsChatLiveState({
      workspaceId: data.workspace?.id ?? "",
      commands: data.commands ?? [],
      invocations: data.invocations ?? [],
      logChunks: data.logChunks ?? [],
    });
  });
  $effect(() => {
    if (taskForm?.values?.prompt) draftPrompt = taskForm.values.prompt;
  });

  let runtimeStatus = $derived(data.ownerBinding?.runtimeStatus ?? "blocked");
  let runtimeContext = $derived(
    data.ownerBinding
      ? `${data.ownerBinding.displayName} · ${data.ownerBinding.runtimeName}`
      : t.chat.noOwnerContext,
  );
  let canStartTask = $derived(
    data.ownerBinding?.bindingStatus === "available" &&
      data.workspaceControl.control.serverMutationAllowed,
  );
  let workspaceControlLabel = $derived(
    workspaceControlControlLabel(data.workspaceControl.control, data.messages.home.workspaceControl),
  );
  let hasInFlightCommand = $derived(
    liveState.commands.some(
      (command) =>
        command.status === "queued" ||
        command.status === "delivered" ||
        command.deliveryStatus === "pending" ||
        command.deliveryStatus === "sent",
    ),
  );
  let hasActiveInvocation = $derived(
    liveState.invocations.some((invocation) =>
      ["queued", "running"].includes(invocation.status.toLowerCase()),
    ),
  );
  let hasActiveRun = $derived(hasInFlightCommand || hasActiveInvocation);
  let latestActiveInvocationId = $derived(
    liveState.invocations.find((invocation) =>
      ["queued", "running"].includes(invocation.status.toLowerCase()),
    )?.runtimeInvocationId ?? null,
  );
  let taskActionLabel = $derived(
    !data.ownerBinding
      ? t.chat.noOwnerButton
      : !canStartTask
        ? t.chat.unavailableButton
        : hasActiveRun
          ? product.runningButton
          : product.startButton,
  );
  let assistantState = $derived(
    hasActiveRun ? t.chat.busyState : canStartTask ? t.chat.readyState : t.chat.offlineState,
  );
  let ownerCommandNote = $derived(
    data.ownerBinding
      ? `${t.chat.ownerPrefix} ${data.ownerBinding.displayName} · ${data.ownerBinding.runtimeName}${
          canStartTask ? "" : ` · ${workspaceControlLabel}`
        }`
      : "",
  );
  let taskSuggestions = $derived(
    t.chat.suggestions.map((prompt: string, index: number) => ({
      id: `agents-product-${index}`,
      label: prompt,
      prompt,
    })),
  );
  let transcriptTurns = $derived(
    buildCockpitChatTranscriptTurns(liveState.commands, liveState.invocations, liveState.logChunks, {
      waitingAnswer: t.chat.waitingAnswer,
      completedAnswer: t.chat.completedAnswer,
      errorAnswer: t.chat.errorAnswer,
      cancelledAnswer: t.chat.cancelledAnswer,
      latestOutputPrefix: t.chat.latestOutputPrefix,
    }),
  );
  let historyTurns = $derived(transcriptTurns.slice().reverse());
  let currentTurn = $derived(currentProductTurn(transcriptTurns));
  let selectedTurn = $derived(
    selectedRunId === "current"
      ? currentTurn
      : transcriptTurns.find((turn) => turn.id === selectedRunId) ?? currentTurn,
  );
  let displaySource = $derived(renderSourceForTurn(selectedTurn));
  let hasDisplaySource = $derived(Boolean(displaySource.trim()));
  let selectedLogs = $derived(selectedTurn?.logs.slice(-8) ?? []);

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function handleOptimisticSubmit(prompt: string) {
    const id = addOptimisticAgentsChatCommand(liveState, { prompt });
    if (!id) return;
    liveState.commands = [...liveState.commands];
    selectedRunId = "current";
  }

  function handleTaskSubmit(event: SubmitEvent) {
    if (!canStartTask || hasActiveRun) {
      event.preventDefault();
      return;
    }
    handleOptimisticSubmit(draftPrompt);
  }

  function handleSuggestedSubmit(event: SubmitEvent, prompt: string) {
    if (!canStartTask || hasActiveRun) {
      event.preventDefault();
      if (!hasActiveRun) draftPrompt = prompt;
      return;
    }
    handleOptimisticSubmit(prompt);
  }

  onMount(() => {
    if (!data.workspace) return;
    const cursorStorageKey = `spark-cockpit:agents-product:${data.workspace.id}:events-cursor`;
    liveState.cursor = window.sessionStorage.getItem(cursorStorageKey);
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const url = new URL("/api/v1/events", window.location.origin);
      if (liveState.cursor) url.searchParams.set("cursor", liveState.cursor);
      eventSource = new EventSource(url);
      eventSource.addEventListener("spark-cockpit.event", (message) => {
        const event = parseSseEvent(message);
        if (!event) return;
        const changed = applyAgentsChatEvent(liveState, event);
        if (liveState.cursor) window.sessionStorage.setItem(cursorStorageKey, liveState.cursor);
        if (changed) {
          liveState.commands = [...liveState.commands];
          liveState.invocations = [...liveState.invocations];
          liveState.logChunks = [...liveState.logChunks];
          if (hasActiveRun) selectedRunId = "current";
        }
      });
      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        if (!closed && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 1_000);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      eventSource?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  });

  function parseSseEvent(message: MessageEvent<string>): AgentsChatSerializedEvent | null {
    try {
      const event = JSON.parse(message.data) as AgentsChatSerializedEvent;
      return event && typeof event.id === "string" && typeof event.createdAt === "string"
        ? event
        : null;
    } catch {
      return null;
    }
  }

  function currentProductTurn(turns: CockpitChatTranscriptTurn[]) {
    return (
      turns
        .slice()
        .reverse()
        .find((turn) => turn.status === "running" || turn.status === "waiting") ??
      turns.at(-1) ??
      null
    );
  }

  function renderSourceForTurn(turn: CockpitChatTranscriptTurn | null) {
    if (!turn) return "";
    if (turn.renderSource?.trim()) return turn.renderSource;
    if (isGenericAnswer(turn.answer)) return "";
    return turn.answer.replace(`${t.chat.latestOutputPrefix}\n`, "").trim();
  }

  function isGenericAnswer(answer: string) {
    return [
      t.chat.waitingAnswer,
      t.chat.completedAnswer,
      t.chat.errorAnswer,
      t.chat.cancelledAnswer,
    ].includes(answer);
  }
</script>

<section class="product-shell" aria-labelledby="agents-product-title" aria-label={product.aria}>
  <div class="product-toolbar">
    <div>
      <p class="panel-kicker">{product.kicker}</p>
      <h2 id="agents-product-title">{product.title}</h2>
      <p class="chat-copy">{product.body}</p>
    </div>
    <div class="toolbar-actions">
      <span class="sync-chip" class:live={hasActiveRun}>
        <Icon name="activity" size={14} />{hasActiveRun ? product.liveSync : product.idleSync}
      </span>
    </div>
  </div>

  <div class="product-meta" aria-label={product.contextLabel}>
    <span class="context-chip"><Icon name="workspace" size={14} />{product.workspaceLabel}: {data.workspace.name}</span>
    <span class="context-chip runtime {runtimeStatus}">
      <Icon name="activity" size={14} />{product.runtimeLabel}: {runtimeContext}
    </span>
    <span class="context-chip"><Icon name="spark" size={14} />{assistantState}</span>
    {#if ownerCommandNote}
      <span class="context-chip muted">{ownerCommandNote}</span>
    {/if}
  </div>

  <div class="product-workbench">
    <aside class="run-rail" aria-label={product.historyLabel}>
      <div class="run-rail-header">
        <span>{product.historyLabel}</span>
        <strong>{historyTurns.length + 1}</strong>
      </div>
      <button
        type="button"
        class="run-item"
        class:active={selectedRunId === "current"}
        onclick={() => (selectedRunId = "current")}
      >
        <span class="run-dot {currentTurn?.status ?? runtimeStatus}" aria-hidden="true"></span>
        <span class="run-copy">
          <strong>{product.currentOption}</strong>
          <small>{currentTurn?.prompt ?? product.emptyTitle}</small>
        </span>
        <em>{statusLabel(currentTurn?.status ?? runtimeStatus)}</em>
      </button>
      <div class="run-list">
        {#if historyTurns.length === 0}
          <p class="details-empty">{product.emptyBody}</p>
        {:else}
          {#each historyTurns as turn}
            <button
              type="button"
              class="run-item"
              class:active={selectedRunId === turn.id}
              onclick={() => (selectedRunId = turn.id)}
            >
              <span class="run-dot {turn.status}" aria-hidden="true"></span>
              <span class="run-copy">
                <strong>{turn.prompt}</strong>
                <small>{formatRelative(turn.command.createdAt)}</small>
              </span>
              <em>{statusLabel(turn.status)}</em>
            </button>
          {/each}
        {/if}
      </div>
    </aside>

    <article class="product-stage {selectedTurn?.status ?? 'empty'}" class:busy={hasActiveRun}>
      <header class="stage-header">
        <div>
          <span class="stage-kicker">{selectedRunId === "current" ? product.currentLabel : product.historyLabel}</span>
          <h3>{selectedTurn?.prompt ?? product.emptyTitle}</h3>
        </div>
        <span class="status-pill {selectedTurn?.status ?? runtimeStatus}">
          {statusLabel(selectedTurn?.status ?? runtimeStatus)}
        </span>
      </header>

      {#if hasDisplaySource}
        <div class="genui-canvas">
          <AgentMdxStream source={displaySource} streaming={selectedTurn?.status === "running"} />
        </div>
      {:else}
        <div class="empty-product">
          <div class="empty-icon"><Icon name="spark" size={28} /></div>
          <div>
            <h3>{product.emptyTitle}</h3>
            <p>{selectedTurn ? selectedTurn.answer : product.emptyBody}</p>
          </div>
        </div>
      {/if}

      {#if selectedTurn?.currentActivity}
        <p class="activity-line"><strong>{product.activityLabel}</strong> {selectedTurn.currentActivity}</p>
      {/if}

      {#if selectedTurn}
        <details class="run-details" open={selectedTurn.status === "running"}>
          <summary>
            <span><Icon name="activity" size={15} />{product.runDetails}</span>
            <small>{selectedTurn.invocations.length} {t.chat.invocationMetaLabel} · {selectedTurn.logs.length} {t.chat.logMetaLabel}</small>
          </summary>
          <div class="run-detail-grid">
            <section>
              <h4>{product.invocationsLabel}</h4>
              {#if selectedTurn.invocations.length === 0}
                <p class="details-empty">{t.chat.noRunDetails}</p>
              {:else}
                <div class="invocation-stack">
                  {#each selectedTurn.invocations as invocation}
                    <article class="invocation-card">
                      <div>
                        <strong>{invocation.agentName ?? t.chat.assistantLabel}</strong>
                        <small>{invocation.runtimeInvocationId}</small>
                      </div>
                      <span class="status-pill {invocation.status}">{statusLabel(invocation.status)}</span>
                      <time>{formatRelative(invocation.updatedAt)}</time>
                    </article>
                  {/each}
                </div>
              {/if}
            </section>
            <section>
              <h4>{product.recentActivityLabel}</h4>
              {#if selectedLogs.length === 0}
                <p class="details-empty">{t.chat.noRunDetails}</p>
              {:else}
                <div class="activity-stack">
                  {#each selectedLogs as log}
                    <article class="activity-row {activityKind(log)}">
                      <header>
                        <span>{log.stream}</span>
                        <small>{log.runtimeInvocationId} · #{log.sequence} · {formatRelative(log.createdAt)}</small>
                      </header>
                      <pre aria-label={t.chat.rawLogOutput}>{log.content}</pre>
                    </article>
                  {/each}
                </div>
              {/if}
            </section>
          </div>
        </details>
      {/if}
    </article>

    <section class="task-launcher" aria-labelledby="agents-task-launcher-title">
      <div>
        <p class="panel-kicker">{product.launcherKicker}</p>
        <h2 id="agents-task-launcher-title">{product.launcherTitle}</h2>
        <p>{product.launcherBody}</p>
      </div>

      <div class="suggested-prompts" aria-label={t.chat.suggestionsLabel}>
        {#each taskSuggestions as suggestion}
          <form method="POST" action="?/sendChat" onsubmit={(event) => handleSuggestedSubmit(event, suggestion.prompt)}>
            <input type="hidden" name="prompt" value={suggestion.prompt} />
            <button type="submit" disabled={!canStartTask || hasActiveRun} title={suggestion.prompt}>
              {suggestion.label}
            </button>
          </form>
        {/each}
      </div>

      <form method="POST" action="?/sendChat" class="task-form" onsubmit={handleTaskSubmit}>
        <label for="agents-task-prompt">{product.promptLabel}</label>
        <textarea
          id="agents-task-prompt"
          name="prompt"
          bind:value={draftPrompt}
          rows="4"
          placeholder={product.placeholder}
          disabled={!canStartTask || hasActiveRun}
          required
        ></textarea>
        <div class="task-form-footer">
          <div class="form-hints">
            <span>{product.uniqueWorkspaceNote}</span>
            <span>{product.watchNote}</span>
          </div>
          <div class="submit-controls">
            {#if hasActiveRun}
              <button
                type="submit"
                form="agents-product-cancel-run-form"
                class="stop-button"
                disabled={!latestActiveInvocationId}
                title={!latestActiveInvocationId ? t.chat.stopUnavailable : undefined}
              >
                <Icon name="warning" size={16} stroke={2.3} />
                <span>{t.chat.stop}</span>
              </button>
            {/if}
            <button type="submit" disabled={!canStartTask || hasActiveRun}>
              <Icon name="play" size={16} stroke={2.3} />
              <span>{taskActionLabel}</span>
            </button>
          </div>
        </div>
        {#if taskForm?.message}
          <p class:form-error={!taskForm?.queuedCommandId} class="form-message">{taskForm.message}</p>
        {/if}
        {#if !canStartTask}
          <p class="unavailable-note">{t.chat.unavailableBody}</p>
        {/if}
      </form>

      <form id="agents-product-cancel-run-form" method="POST" action="?/cancelRun" class="stop-form">
        <input type="hidden" name="runtimeInvocationId" value={latestActiveInvocationId ?? ""} />
      </form>
    </section>
  </div>
</section>

<style>
  .product-shell {
    display: grid;
    gap: 18px;
  }

  .product-toolbar,
  .stage-header,
  .task-form-footer {
    align-items: center;
    display: flex;
    gap: 18px;
    justify-content: space-between;
  }

  .panel-kicker,
  .stage-kicker {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0.08em;
    margin: 0 0 8px;
    text-transform: uppercase;
  }

  h2,
  h3,
  h4,
  p {
    margin: 0;
  }

  .chat-copy,
  .task-launcher p,
  .empty-product p,
  .form-hints,
  .details-empty {
    color: var(--color-ink-subtle);
    line-height: 1.55;
  }

  .chat-copy {
    margin-top: 8px;
    max-width: 760px;
  }

  .toolbar-actions,
  .product-meta,
  .suggested-prompts,
  .submit-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .toolbar-actions {
    align-items: start;
    justify-content: flex-end;
  }

  .context-chip,
  .sync-chip {
    align-items: center;
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 12px;
    font-weight: 750;
    gap: 6px;
    padding: 7px 10px;
  }

  .context-chip.runtime.online,
  .context-chip.runtime.available,
  .sync-chip.live {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .context-chip.muted {
    color: var(--color-ink-subtle);
  }

  .product-workbench {
    align-items: start;
    display: grid;
    gap: 18px;
    grid-template-columns: minmax(210px, 0.52fr) minmax(0, 1.4fr) minmax(320px, 0.78fr);
  }

  .run-rail,
  .product-stage,
  .task-launcher {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: var(--shadow-card);
  }

  .run-rail {
    display: grid;
    gap: 10px;
    max-height: calc(100dvh - 150px);
    min-height: 0;
    overflow: hidden;
    padding: 12px;
    position: sticky;
    top: 18px;
  }

  .run-rail-header {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    font-size: 11px;
    font-weight: 800;
    justify-content: space-between;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .run-rail-header strong {
    align-items: center;
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 11px;
    justify-content: center;
    min-width: 22px;
    padding: 4px 7px;
  }

  .run-list {
    display: grid;
    gap: 6px;
    min-height: 0;
    overflow: auto;
  }

  .run-item {
    align-items: start;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: grid;
    gap: 8px;
    grid-template-columns: 8px minmax(0, 1fr);
    padding: 9px 8px;
    text-align: left;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
    width: 100%;
  }

  .run-item:hover,
  .run-item.active {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .run-dot {
    background: var(--color-ink-disabled);
    border-radius: 999px;
    height: 8px;
    margin-top: 5px;
    width: 8px;
  }

  .run-dot.running,
  .run-dot.waiting,
  .run-dot.online,
  .run-dot.available {
    background: var(--color-primary);
  }

  .run-dot.completed,
  .run-dot.succeeded,
  .run-dot.success {
    background: var(--color-success);
  }

  .run-dot.error,
  .run-dot.failed,
  .run-dot.cancelled,
  .run-dot.canceled {
    background: var(--color-danger);
  }

  .run-copy {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .run-copy strong,
  .run-copy small,
  .run-item em {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-copy strong {
    color: var(--color-ink);
    font-size: 13px;
    font-weight: 650;
    line-height: 1.35;
  }

  .run-copy small {
    color: var(--color-ink-subtle);
    font-size: 11px;
    line-height: 1.35;
  }

  .run-item em {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-style: normal;
    font-weight: 800;
    grid-column: 2;
    line-height: 1;
    text-transform: capitalize;
  }

  .product-stage {
    display: grid;
    gap: 16px;
    min-height: 0;
    padding: 18px;
  }

  .product-stage.busy {
    border-color: var(--color-primary-soft);
  }

  .status-pill {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 12px;
    font-weight: 850;
    padding: 6px 10px;
    text-transform: capitalize;
  }

  .status-pill.running,
  .status-pill.waiting,
  .status-pill.online,
  .status-pill.available {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .status-pill.completed,
  .status-pill.succeeded,
  .status-pill.success {
    background: var(--color-success-soft);
    border-color: var(--color-success);
    color: var(--color-success-strong);
  }

  .status-pill.error,
  .status-pill.failed,
  .status-pill.cancelled,
  .status-pill.canceled {
    background: var(--color-danger-soft);
    border-color: var(--color-danger);
    color: var(--color-danger-strong);
  }

  .genui-canvas {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    min-height: clamp(220px, 30vw, 360px);
    padding: 18px;
  }

  .empty-product {
    align-items: flex-start;
    background: var(--color-canvas);
    border: 1px dashed var(--color-border);
    border-radius: 8px;
    display: flex;
    gap: 14px;
    min-height: 150px;
    padding: 22px;
  }

  .activity-line {
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: 12px;
    color: var(--color-primary);
    padding: 10px 12px;
  }

  .run-details {
    border-top: 1px solid var(--color-border);
    padding-top: 12px;
  }

  .run-details summary,
  .invocation-card,
  .activity-row header {
    align-items: center;
    display: flex;
    gap: 10px;
  }

  .run-details summary {
    color: var(--color-ink-muted);
    cursor: pointer;
    font-weight: 800;
    justify-content: space-between;
  }

  .run-detail-grid {
    display: grid;
    gap: 14px;
    grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
    margin-top: 14px;
  }

  .invocation-stack,
  .activity-stack {
    display: grid;
    gap: 10px;
    margin-top: 8px;
  }

  .invocation-card,
  .activity-row {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 10px;
  }

  .invocation-card {
    justify-content: space-between;
  }

  .invocation-card div,
  .activity-row {
    min-width: 0;
  }

  .invocation-card small,
  .activity-row small {
    color: var(--color-ink-subtle);
    display: block;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .activity-row header {
    justify-content: space-between;
  }

  .activity-row pre {
    color: var(--color-ink-muted);
    font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.45;
    margin: 8px 0 0;
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
  }

  .activity-row.error {
    border-color: var(--color-danger);
  }

  .activity-row.success {
    border-color: var(--color-success);
  }

  .activity-row.tool {
    border-color: var(--color-primary-soft);
  }

  .task-launcher {
    background: var(--color-canvas);
    display: grid;
    gap: 14px;
    padding: 18px;
    position: sticky;
    top: 18px;
  }

  .suggested-prompts form,
  .stop-form {
    margin: 0;
  }

  .suggested-prompts button,
  .task-form button {
    align-items: center;
    border-radius: 999px;
    display: inline-flex;
    font: inherit;
    font-size: 13px;
    font-weight: 750;
    gap: 8px;
  }

  .suggested-prompts button {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
    padding: 8px 11px;
  }

  .suggested-prompts button:not(:disabled):hover {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .task-form {
    display: grid;
    gap: 10px;
  }

  .task-form label {
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 850;
    text-transform: uppercase;
  }

  .task-form textarea {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    color: var(--color-ink);
    font: inherit;
    line-height: 1.5;
    min-height: 138px;
    padding: 12px 14px;
    resize: vertical;
  }

  .task-form textarea:focus {
    border-color: var(--color-primary-soft);
    outline: 2px solid var(--color-primary-weak);
  }

  .form-hints {
    display: grid;
    font-size: 12px;
    gap: 2px;
  }

  .task-form button {
    background: var(--color-primary);
    border: 0;
    color: var(--color-on-primary);
    padding: 10px 14px;
  }

  .task-form button.stop-button {
    background: var(--color-danger-soft);
    border: 1px solid var(--color-danger);
    color: var(--color-danger-strong);
  }

  .task-form button:disabled,
  .suggested-prompts button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .form-message,
  .unavailable-note {
    border-radius: 12px;
    font-size: 13px;
    margin: 0;
    padding: 9px 11px;
  }

  .form-message {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .form-message.form-error,
  .unavailable-note {
    background: var(--color-danger-soft);
    color: var(--color-danger-strong);
  }

  .empty-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: 14px;
    color: var(--color-primary);
    display: inline-flex;
    flex: 0 0 auto;
    height: 46px;
    justify-content: center;
    width: 46px;
  }

  @media (max-width: 1280px) {
    .product-workbench {
      grid-template-columns: minmax(200px, 0.55fr) minmax(0, 1fr);
    }

    .task-launcher {
      grid-column: 1 / -1;
      position: static;
    }
  }

  @media (max-width: 1100px) {
    .product-toolbar,
    .stage-header,
    .task-form-footer {
      align-items: stretch;
      flex-direction: column;
    }

    .toolbar-actions,
    .product-meta,
    .submit-controls {
      justify-content: flex-start;
    }

    .product-workbench {
      grid-template-columns: 1fr;
    }

    .run-rail,
    .task-launcher {
      max-height: none;
      position: static;
    }

    .run-detail-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
