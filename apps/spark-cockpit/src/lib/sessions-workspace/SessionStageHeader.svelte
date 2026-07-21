<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import ChannelSessionIcon from "$lib/ChannelSessionIcon.svelte";
  import { Button } from "$lib/ui";
  import { enhance } from "$app/forms";
  import { visibleSessionStatus } from "$lib/conversation-status";
  import type { Snippet } from "svelte";
  import type { SessionConversationHost } from "./conversation-host";

  let {
    host,
    sessionDetails,
  }: {
    host: SessionConversationHost;
    sessionDetails: Snippet<[boolean?]>;
  } = $props();

  let displayedSessionStatus = $derived(visibleSessionStatus(host.selected.status));
  let selectedPresentation = $derived(host.sessionPresentation(host.selected));
</script>


    <header class="stage-header">
      <div class="stage-title">
        <p class="kicker">{host.copy.timelineTitle}</p>
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
        <p>{host.sessionScopeLabel(host.selected)}</p>
      </div>
      <div class="stage-actions">
        {#if host.selected.role}<span class="context-chip">{host.selected.role}</span>{/if}
        {#if host.conversationBusy}
          <span
            class="session-working-indicator"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span class="session-working-spinner" aria-hidden="true"></span>
            {host.copy.working}
          </span>
        {/if}
        <span class="connection-state {host.liveConnection}" title={host.connectionLabel()}>
          <span aria-hidden="true"></span>
          {host.connectionLabel()}
        </span>
        {#if host.conversationBusy && host.activeTurnId}
          <form
            id="session-cancel-turn-form"
            method="POST"
            action="?/cancelTurn"
            use:enhance={host.enhanceCancelTurn}
          >
            <input type="hidden" name="sessionId" value={host.selected.sessionId} />
            <input type="hidden" name="turnId" value={host.activeTurnId} />
            <Button
              variant="danger"
              size="compact"
              type="submit"
              disabled={host.cancelState === "submitting" || host.cancelState === "success"}
            >
              <Icon name="close" size={14} stroke={2.2} />
              <span>{host.cancelState === "submitting" ? host.copy.stopping : host.copy.stop}</span>
            </Button>
          </form>
        {/if}
        {#if displayedSessionStatus && displayedSessionStatus !== "running"}
          <span class="status-pill {displayedSessionStatus}">{host.statusLabel(displayedSessionStatus)}</span>
        {/if}
      </div>
    </header>

    <details class="mobile-details">
      <summary>
        <span><Icon name="activity" size={15} />{host.copy.collapseDetails}</span>
        <Icon name="chevron-down" size={15} />
      </summary>
      {@render sessionDetails(true)}
    </details>

<style>

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

  .stage-header h1 {
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







  .stage-title > p:last-child {
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

</style>
