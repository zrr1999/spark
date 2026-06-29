<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import {
    activityKind,
    buildProjectChatTranscriptTurns,
    latestActivity,
    type ProjectChatCommand,
    type ProjectChatInvocation,
    type ProjectChatLogChunk,
    type ProjectChatTranscriptTurn,
  } from "$lib/project-chat-transcript-view";

  type Command = ProjectChatCommand & {
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

  type Invocation = ProjectChatInvocation;
  type LogChunk = ProjectChatLogChunk;

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

  type RunDetailView = Pick<ProjectChatTranscriptTurn, "id" | "invocations" | "logs" | "status" | "currentActivity">;

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

  let transcriptTurns = $derived(
    buildProjectChatTranscriptTurns(commands, invocations, logChunks, {
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
</script>

<div class="transcript" aria-live="polite">
  {#if transcriptTurns.length === 0 && detachedInvocations.length === 0}
    <article class="message assistant-message">
      <div class="avatar"><Icon name="spark" size={18} stroke={2.2} /></div>
      <div class="bubble assistant-bubble">
        <div class="message-heading">
          <strong>{t.emptyAssistantTitle}</strong>
          <span class="status-pill {hasActiveRun ? 'running' : runtimeStatus}">{statusLabel(hasActiveRun ? "running" : runtimeStatus)}</span>
        </div>
        <p class="message-text">{t.emptyAssistantBody}</p>
        <div class="context-line">
          <span>{assistantState}</span>
          {#if ownerCommandNote}
            <span>{ownerCommandNote}</span>
          {/if}
        </div>
      </div>
    </article>
  {:else}
    {#each transcriptTurns as turn}
      <article class="message user-message">
        <div class="bubble user-bubble">
          <div class="message-heading">
            <strong>{t.userLabel}</strong>
            <small>{formatRelative(turn.command.createdAt)}</small>
          </div>
          <p class="message-text">{turn.prompt}</p>
          <small class="meta-line">{t.commandMetaLabel}: {statusLabel(turn.command.deliveryStatus ?? turn.command.status)}</small>
        </div>
      </article>

      <article class="message assistant-message {turn.status}">
        <div class="avatar"><Icon name={turn.status === "error" ? "warning" : "spark"} size={18} stroke={2.2} /></div>
        <div class="bubble assistant-bubble">
          <div class="message-heading">
            <strong>{turn.status === "error" ? t.systemLabel : t.assistantLabel}</strong>
            <span class="status-pill {turn.status}">{statusLabel(turn.status)}</span>
          </div>
          {#if turn.status === "running"}
            <div class="working-indicator">
              <span class="pulse" aria-hidden="true"></span>
              <span>{t.workingLabel}</span>
              <small>{t.elapsedLabel}: {formatRelative(turn.command.createdAt)}</small>
            </div>
          {/if}
          <p class="message-text">{turn.answer}</p>
          {#if turn.currentActivity}
            <small class="meta-line">{t.currentActivityLabel}: {turn.currentActivity}</small>
          {/if}
          {@render RunDetails(turn)}
        </div>
      </article>
    {/each}

    {#if detachedInvocations.length > 0}
      <article class="message assistant-message running">
        <div class="avatar"><Icon name="activity" size={18} stroke={2.2} /></div>
        <div class="bubble assistant-bubble">
          <div class="message-heading">
            <strong>{t.assistantLabel}</strong>
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
        </div>
      </article>
    {/if}
  {/if}
</div>

{#snippet RunDetails(detail: RunDetailView)}
  <details class="run-details">
    <summary>
      <span><Icon name="activity" size={15} />{t.runDetails}</span>
      <small>
        {detail.invocations.length} {t.invocationMetaLabel} · {detail.logs.length} {t.logMetaLabel}
      </small>
    </summary>
    {#if detail.invocations.length === 0 && detail.logs.length === 0}
      <p class="details-empty">{t.noRunDetails}</p>
    {:else}
      <div class="run-detail-grid">
        <section>
          <h4>{t.detailsSummary}</h4>
          {#if detail.invocations.length === 0}
            <p class="details-empty">{t.noRunDetails}</p>
          {:else}
            <div class="invocation-stack">
              {#each detail.invocations as invocation}
                <article class="invocation-card">
                  <div>
                    <strong>{invocation.agentName ?? t.assistantLabel}</strong>
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
          <h4>{t.toolActivity}</h4>
          {#if detail.logs.length === 0}
            <p class="details-empty">{t.noRunDetails}</p>
          {:else}
            <div class="activity-stack">
              {#each detail.logs as log}
                <article class="activity-row {activityKind(log)}">
                  <header>
                    <span>{log.stream}</span>
                    <small>{log.runtimeInvocationId} · #{log.sequence} · {formatRelative(log.createdAt)}</small>
                  </header>
                  <pre aria-label={t.rawLogOutput}>{log.content}</pre>
                </article>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {/if}
  </details>
{/snippet}

<style>
  .transcript {
    display: grid;
    gap: 14px;
  }

  .message {
    display: grid;
    gap: 12px;
  }

  .assistant-message {
    align-items: start;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .user-message {
    justify-items: end;
  }

  .avatar {
    align-items: center;
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: 999px;
    color: var(--color-primary);
    display: inline-flex;
    height: 36px;
    justify-content: center;
    width: 36px;
  }

  .assistant-message.error .avatar {
    background: var(--color-danger-soft);
    border-color: var(--color-danger);
    color: var(--color-danger-strong);
  }

  .bubble {
    border: 1px solid var(--color-border);
    border-radius: 16px;
    display: grid;
    gap: 10px;
    max-width: min(760px, 100%);
    padding: 16px;
  }

  .assistant-bubble {
    background: var(--color-surface);
  }

  .user-bubble {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
  }

  .message-heading,
  .context-line,
  .working-indicator,
  .run-details summary,
  .invocation-card,
  .activity-row header {
    align-items: center;
    display: flex;
    gap: 10px;
  }

  .message-heading {
    justify-content: space-between;
  }

  .message-text {
    color: var(--color-ink);
    line-height: 1.55;
    margin: 0;
    white-space: pre-wrap;
  }

  .assistant-bubble .message-text,
  .context-line,
  .meta-line,
  .working-indicator small,
  .details-empty {
    color: var(--color-ink-subtle);
  }

  .context-line {
    flex-wrap: wrap;
    font-size: 12px;
  }

  .meta-line,
  .message-heading small,
  time {
    color: var(--color-ink-subtle);
    font-size: 12px;
  }

  .working-indicator {
    background: var(--color-primary-weak);
    border: 1px solid var(--color-primary-soft);
    border-radius: 999px;
    color: var(--color-primary);
    flex-wrap: wrap;
    font-size: 12px;
    font-weight: 800;
    justify-content: flex-start;
    padding: 7px 10px;
    width: fit-content;
  }

  .pulse {
    animation: pulse 1.4s infinite ease-in-out;
    background: currentColor;
    border-radius: 999px;
    display: inline-block;
    height: 8px;
    width: 8px;
  }

  .run-details {
    border-top: 1px solid var(--color-border);
    display: grid;
    gap: 12px;
    margin-top: 4px;
    padding-top: 10px;
  }

  .run-details summary {
    color: var(--color-ink-muted);
    cursor: pointer;
    font-size: 13px;
    font-weight: 800;
    justify-content: space-between;
  }

  .run-details summary span {
    align-items: center;
    display: inline-flex;
    gap: 7px;
  }

  .run-details summary small {
    color: var(--color-ink-subtle);
    font-size: 12px;
  }

  .run-detail-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    padding-top: 12px;
  }

  .run-detail-grid h4 {
    color: var(--color-ink-muted);
    font-size: 12px;
    letter-spacing: 0.04em;
    margin: 0 0 8px;
    text-transform: uppercase;
  }

  .invocation-stack,
  .activity-stack {
    display: grid;
    gap: 8px;
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

  .invocation-card strong,
  .invocation-card small {
    display: block;
  }

  .invocation-card small {
    color: var(--color-ink-subtle);
    margin-top: 3px;
  }

  .activity-row {
    display: grid;
    gap: 8px;
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
    color: var(--color-ink-muted);
    font-size: 12px;
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
    line-height: 1.5;
    margin: 0;
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
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
  .status-pill.rejected {
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

  @media (max-width: 900px) {
    .assistant-message {
      grid-template-columns: 1fr;
    }

    .avatar {
      display: none;
    }

    .run-detail-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
