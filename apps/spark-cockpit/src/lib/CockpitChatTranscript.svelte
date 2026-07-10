<script lang="ts">
  import AgentMdxStream from "$lib/AgentMdxStream.svelte";
  import Icon from "$lib/Icon.svelte";
  import {
    activityKind,
    buildCockpitChatTranscriptTurns,
    latestActivity,
    type CockpitChatCommand,
    type CockpitChatInvocation,
    type CockpitChatLogChunk,
    type CockpitChatTranscriptTurn,
  } from "$lib/cockpit-chat-transcript-view";

  type Command = CockpitChatCommand & {
    attemptCount: number | null;
    lastAttemptAt: string | null;
    ackedAt: string | null;
    rejectedAt: string | null;
    rejectCode: string | null;
    rejectMessage: string | null;
    runtimeWorkspaceName: string | null;
    runtimeName: string | null;
    runtimeStatus: string | null;
    updatedAt: string;
  };

  type Invocation = CockpitChatInvocation;
  type LogChunk = CockpitChatLogChunk;

  type TranscriptMessages = {
    emptyAssistantTitle: string;
    emptyAssistantBody: string;
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
  };

  type RunDetailView = Pick<
    CockpitChatTranscriptTurn,
    "id" | "invocations" | "logs" | "status" | "currentActivity"
  >;

  let {
    t,
    commands,
    invocations,
    logChunks,
    runtimeStatus,
    hasActiveRun,
    assistantState,
    ownerCommandNote,
    statusLabel,
    formatRelative,
  }: {
    t: TranscriptMessages;
    commands: Command[];
    invocations: Invocation[];
    logChunks: LogChunk[];
    runtimeStatus: string;
    hasActiveRun: boolean;
    assistantState: string;
    ownerCommandNote: string;
    statusLabel: (status: string) => string;
    formatRelative: (value: string | null) => string;
  } = $props();

  let transcriptElement = $state<HTMLDivElement | undefined>(undefined);
  let stickToBottom = $state(true);
  let transcriptTurns = $derived(
    buildCockpitChatTranscriptTurns(commands, invocations, logChunks, {
      waitingAnswer: t.waitingAnswer,
      runningAnswer: t.runningAnswer,
      completedAnswer: t.completedAnswer,
      errorAnswer: t.errorAnswer,
      cancelledAnswer: t.cancelledAnswer,
      latestOutputPrefix: t.latestOutputPrefix,
    }),
  );
  let detachedInvocations = $derived(
    transcriptTurns.length === 0 && invocations.length > 0 ? invocations : [],
  );
  let detachedLogs = $derived(
    detachedInvocations.length > 0
      ? logChunks.filter((log) =>
          detachedInvocations.some(
            (invocation) => invocation.runtimeInvocationId === log.runtimeInvocationId,
          ),
        )
      : [],
  );
  let transcriptScrollSignal = $derived(`${transcriptTurns.length}:${logChunks.length}`);

  $effect(() => {
    if (!transcriptElement || !stickToBottom || transcriptScrollSignal.length === 0) return;
    queueMicrotask(() => {
      transcriptElement?.scrollTo({ top: transcriptElement.scrollHeight, behavior: "smooth" });
    });
  });

  function handleTranscriptScroll() {
    if (!transcriptElement) return;
    const distanceFromBottom =
      transcriptElement.scrollHeight - transcriptElement.scrollTop - transcriptElement.clientHeight;
    stickToBottom = distanceFromBottom < 120;
  }
</script>

<div
  class="transcript"
  aria-live="polite"
  bind:this={transcriptElement}
  onscroll={handleTranscriptScroll}
>
  {#if transcriptTurns.length === 0 && detachedInvocations.length === 0}
    <article class="turn empty-turn">
      <div class="turn-meta">
        <span class="role">{t.emptyAssistantTitle}</span>
        <span class="status-pill {hasActiveRun ? 'running' : runtimeStatus}">
          {statusLabel(hasActiveRun ? "running" : runtimeStatus)}
        </span>
      </div>
      <p class="message-text muted">{t.emptyAssistantBody}</p>
      <div class="context-line">
        <span>{assistantState}</span>
        {#if ownerCommandNote}
          <span>{ownerCommandNote}</span>
        {/if}
      </div>
    </article>
  {:else}
    {#each transcriptTurns as turn}
      <article class="turn user-turn">
        <div class="user-prompt">{turn.prompt}</div>
        <div class="turn-meta quiet">
          <span class="role">{t.userLabel}</span>
          <small>{formatRelative(turn.command.createdAt)}</small>
        </div>
      </article>

      <article class="turn assistant-turn {turn.status}">
        <div class="turn-meta">
          <span class="role">{turn.status === "error" ? t.systemLabel : t.assistantLabel}</span>
          <span class="status-pill {turn.status}">{statusLabel(turn.status)}</span>
        </div>

        {#if turn.status === "running"}
          <div class="working-line">
            <span class="pulse" aria-hidden="true"></span>
            <span>{t.workingLabel}</span>
            <small>{t.elapsedLabel}: {formatRelative(turn.command.createdAt)}</small>
          </div>
        {/if}

        {#if turn.renderSource}
          <div class="answer-body">
            <AgentMdxStream source={turn.renderSource} streaming={turn.status === "running"} />
          </div>
        {:else}
          <p class="message-text" class:streaming-text={turn.status === "running"}>
            {turn.answer}{#if turn.status === "running"}<span class="streaming-caret" aria-hidden="true"></span>{/if}
          </p>
        {/if}

        {#if turn.currentActivity && turn.status === "running"}
          <p class="activity-line">{t.currentActivityLabel}: {turn.currentActivity}</p>
        {/if}

        {@render RunDetails(turn)}
      </article>
    {/each}

    {#if detachedInvocations.length > 0}
      <article class="turn assistant-turn running">
        <div class="turn-meta">
          <span class="role">{t.assistantLabel}</span>
          <span class="status-pill running">{statusLabel("running")}</span>
        </div>
        <p class="message-text">{hasActiveRun ? t.runningAnswer : t.completedAnswer}</p>
        {@render RunDetails({
          id: "detached-run-details",
          invocations: detachedInvocations,
          logs: detachedLogs,
          status: hasActiveRun ? "running" : "completed",
          currentActivity: latestActivity(detachedLogs),
        })}
      </article>
    {/if}
  {/if}
</div>

{#snippet RunDetails(detail: RunDetailView)}
  {#if detail.invocations.length > 0 || detail.logs.length > 0}
    <details class="run-details">
      <summary>
        <span><Icon name="activity" size={14} />{t.runDetails}</span>
        <small>
          {detail.invocations.length} {t.invocationMetaLabel} · {detail.logs.length} {t.logMetaLabel}
        </small>
      </summary>
      <div class="run-detail-stack">
        {#if detail.invocations.length > 0}
          <section>
            <h4>{t.detailsSummary}</h4>
            <div class="invocation-stack">
              {#each detail.invocations as invocation}
                <article class="invocation-row">
                  <div>
                    <strong>{invocation.agentName ?? t.assistantLabel}</strong>
                    <small>{invocation.runtimeInvocationId}</small>
                  </div>
                  <span class="status-pill {invocation.status}">{statusLabel(invocation.status)}</span>
                  <time>{formatRelative(invocation.updatedAt)}</time>
                </article>
              {/each}
            </div>
          </section>
        {/if}
        {#if detail.logs.length > 0}
          <section>
            <h4>{t.toolActivity}</h4>
            <div class="activity-stack">
              {#each detail.logs as log}
                <article class="activity-row {activityKind(log)}">
                  <header>
                    <span>{log.stream}</span>
                    <small>#{log.sequence} · {formatRelative(log.createdAt)}</small>
                  </header>
                  <pre aria-label={t.rawLogOutput}>{log.content}</pre>
                </article>
              {/each}
            </div>
          </section>
        {/if}
      </div>
    </details>
  {/if}
{/snippet}

<style>
  .transcript {
    display: grid;
    gap: 22px;
    min-height: 0;
  }

  .turn {
    display: grid;
    gap: 8px;
    max-width: min(720px, 100%);
    min-width: 0;
  }

  .user-turn {
    justify-items: end;
    margin-left: auto;
  }

  .assistant-turn,
  .empty-turn {
    justify-items: start;
  }

  .user-prompt {
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: 14px 14px 4px 14px;
    color: var(--color-ink);
    line-height: 1.5;
    max-width: min(560px, 100%);
    padding: 10px 14px;
    white-space: pre-wrap;
  }

  .turn-meta {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: space-between;
    width: 100%;
  }

  .turn-meta.quiet {
    justify-content: flex-end;
    opacity: 0.72;
  }

  .role {
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .answer-body,
  .message-text {
    color: var(--color-ink);
    line-height: 1.6;
    margin: 0;
    min-width: 0;
    width: 100%;
  }

  .message-text {
    white-space: pre-wrap;
  }

  .message-text.muted,
  .context-line,
  .activity-line,
  .working-line small {
    color: var(--color-ink-subtle);
  }

  .context-line {
    display: flex;
    flex-wrap: wrap;
    font-size: 12px;
    gap: 8px;
  }

  .working-line,
  .activity-line {
    align-items: center;
    color: var(--color-primary);
    display: flex;
    flex-wrap: wrap;
    font-size: 12px;
    font-weight: 700;
    gap: 8px;
    margin: 0;
  }

  .activity-line {
    background: transparent;
    border: 0;
    font-weight: 600;
    padding: 0;
  }

  .pulse {
    animation: pulse 1.4s infinite ease-in-out;
    background: currentColor;
    border-radius: 999px;
    display: inline-block;
    height: 7px;
    width: 7px;
  }

  .streaming-caret {
    animation: caret-blink 1s steps(2, start) infinite;
    background: var(--color-primary);
    border-radius: 999px;
    display: inline-block;
    height: 1em;
    margin-left: 4px;
    transform: translateY(2px);
    width: 7px;
  }

  .run-details {
    border-top: 1px solid var(--color-border-soft);
    margin-top: 4px;
    padding-top: 8px;
    width: 100%;
  }

  .run-details summary {
    align-items: center;
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: flex;
    font-size: 12px;
    font-weight: 700;
    gap: 10px;
    justify-content: space-between;
    list-style: none;
  }

  .run-details summary::-webkit-details-marker {
    display: none;
  }

  .run-details summary span {
    align-items: center;
    display: inline-flex;
    gap: 6px;
  }

  .run-detail-stack {
    display: grid;
    gap: 12px;
    padding-top: 10px;
  }

  .run-detail-stack h4 {
    color: var(--color-ink-subtle);
    font-size: 11px;
    letter-spacing: 0.04em;
    margin: 0 0 6px;
    text-transform: uppercase;
  }

  .invocation-stack,
  .activity-stack {
    display: grid;
    gap: 6px;
  }

  .invocation-row,
  .activity-row {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: 10px;
    padding: 8px 10px;
  }

  .invocation-row {
    align-items: center;
    display: grid;
    gap: 8px;
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .invocation-row strong,
  .invocation-row small {
    display: block;
  }

  .invocation-row small,
  .activity-row header small,
  time {
    color: var(--color-ink-subtle);
    font-size: 11px;
  }

  .activity-row {
    display: grid;
    gap: 6px;
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

  .activity-row header {
    align-items: center;
    color: var(--color-ink-muted);
    display: flex;
    font-size: 11px;
    justify-content: space-between;
  }

  .activity-row header span {
    font-weight: 800;
    text-transform: uppercase;
  }

  .activity-row pre {
    color: var(--color-ink);
    font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
  }

  .status-pill {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 800;
    padding: 4px 8px;
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

  .status-pill.waiting,
  .status-pill.blocked,
  .status-pill.pending,
  .status-pill.queued,
  .status-pill.ready,
  .status-pill.offline,
  .status-pill.disconnected {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .status-pill.error,
  .status-pill.failed,
  .status-pill.cancelled,
  .status-pill.canceled,
  .status-pill.rejected,
  .status-pill.lost,
  .status-pill.stale {
    background: var(--color-danger-soft);
    color: var(--color-danger-strong);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.85);
    }
    50% {
      opacity: 1;
      transform: scale(1);
    }
  }

  @keyframes caret-blink {
    0%,
    45% {
      opacity: 1;
    }
    46%,
    100% {
      opacity: 0.15;
    }
  }
</style>
