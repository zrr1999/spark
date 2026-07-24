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
  import SessionSideThreadDialog from "./SessionSideThreadDialog.svelte";

  let {
    host,
    sessionDetails,
  }: {
    host: SessionConversationHost;
    sessionDetails: Snippet<[boolean?]>;
  } = $props();

  let sideThreadOpen = $state(false);
</script>

<SessionStageHeader {host} {sessionDetails} onOpenSideThread={() => (sideThreadOpen = true)} />

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
            sessionId={host.selected.sessionId}
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

{#if sideThreadOpen}
  <SessionSideThreadDialog
    sessionId={host.selected.sessionId}
    messages={host.messages}
    statusLabel={host.statusLabel}
    onClose={() => (sideThreadOpen = false)}
  />
{/if}

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
</style>
