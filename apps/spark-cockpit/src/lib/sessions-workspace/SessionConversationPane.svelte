<script lang="ts">
  import { enhance } from "$app/forms";
  import {
    Composer,
    ConversationViewport,
    Message as ConversationMessage,
    SessionQueue,
    SessionStatusBar,
    SlashActionBar,
    SlashCommandMenu,
  } from "$lib/components/conversation";
  import { ModelRuntimeControl } from "$lib/components/model-selector";
  import Icon from "$lib/Icon.svelte";
  import SessionAskPanel from "$lib/SessionAskPanel.svelte";
  import type { Snippet } from "svelte";
  import type { SessionConversationHost } from "./conversation-host";
  import SessionStageHeader from "./SessionStageHeader.svelte";
  import SessionComposerPane from "./SessionComposerPane.svelte";

  let {
    host,
    sessionDetails,
  }: {
    host: SessionConversationHost;
    sessionDetails: Snippet<[boolean?]>;
  } = $props();
</script>

<SessionStageHeader {host} {sessionDetails} />

    {#key host.selected.sessionId}
      <ConversationViewport
        label={host.copy.timelineTitle}
        followKey={host.timelineFollowKey}
        announcement={host.latestAnnouncement}
        jumpToLatestLabel={host.copy.jumpToLatest}
        hasEarlier={host.hasEarlierTimeline}
        onLoadEarlier={host.showEarlierTimeline}
        navigationItems={host.timelineNavigationItems}
      >
      {#if host.timelineItems.length === 0}
        <div class="conversation-empty">
          <span class="spark-mark"><Icon name="spark" size={20} /></span>
          <p>{host.copy.timelineEmpty}</p>
        </div>
      {:else}
        {#each host.renderedTimelineItems as item (item.id)}
          <ConversationMessage
            {item}
            active={item.id === host.activeProcessItemId}
            userLabel={host.copy.you}
            assistantLabel={host.copy.spark}
            sessionLabel={host.copy.agent}
            copyLabel={host.copy.copyMessage}
            copiedLabel={host.copy.copiedMessage}
            partLabels={host.conversationPartLabels}
            relativeTime={host.relative}
            statusLabel={host.statusLabel}
            retryAction={item.id === host.retryableTimelineItemId && host.latestRetryPrompt
              ? {
                  label: host.copy.retryTurn,
                  submittingLabel: host.copy.retryingTurn,
                  unavailableLabel: host.copy.retryUnavailable,
                  submitting: host.retryState === "submitting",
                  disabled: !host.canAssign || !host.modelReady,
                  onRetry: () => {
                    if (host.latestRetryPrompt) host.retryConversationTurn(host.latestRetryPrompt);
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
      bind:this={() => host.sessionModelForm, (v) => (host.sessionModelForm = v)}
      method="POST"
      action="?/selectModel"
      use:enhance={host.enhanceSelectModel}
    ></form>
    <input form="session-model-form" type="hidden" name="sessionId" value={host.selected.sessionId} />
    <form
      id="session-thinking-form"
      bind:this={() => host.sessionThinkingForm, (v) => (host.sessionThinkingForm = v)}
      method="POST"
      action="?/selectThinking"
      use:enhance={host.enhanceSelectThinking}
    ></form>
    <input
      form="session-thinking-form"
      type="hidden"
      name="sessionId"
      value={host.selected.sessionId}
    />

    {#each host.queueItems as item (item.id)}
      <form
        id={host.queueRemoveFormId(item.id)}
        method="POST"
        action="?/cancelTurn"
        hidden
        use:enhance={host.enhanceRemoveQueuedTurn}
      >
        <input type="hidden" name="sessionId" value={host.selected.sessionId} />
        <input type="hidden" name="turnId" value={item.id} />
        <input type="hidden" name="cancelIntent" value="dequeue" />
      </form>
    {/each}

    <form
      bind:this={() => host.retryMessageForm, (v) => (host.retryMessageForm = v)}
      method="POST"
      action="?/sendMessage"
      hidden
      use:enhance={host.enhanceRetryMessage}
    >
      <input type="hidden" name="sessionId" value={host.selected.sessionId} />
      <input type="hidden" name="submissionId" value={host.retrySubmissionId} />
      <input type="hidden" name="message" value={host.retryPrompt} />
    </form>


<SessionComposerPane {host} />

<style>


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

  .muted {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.5;
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
