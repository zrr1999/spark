<script lang="ts">
  import { enhance } from "$app/forms";
  import {
    Composer,
    SessionQueue,
    SessionStatusBar,
    SlashActionBar,
    SlashCommandMenu,
  } from "$lib/components/conversation";
  import { ModelRuntimeControl } from "$lib/components/model-selector";
  import Icon from "$lib/Icon.svelte";
  import SessionAskPanel from "$lib/SessionAskPanel.svelte";
  import type { SessionConversationHost } from "./conversation-host";

  let { host }: { host: SessionConversationHost } = $props();
</script>
<form
      method="POST"
      action="?/sendMessage"
      class="conversation-composer"
      aria-busy={host.sendState === "submitting"}
      use:enhance={host.enhanceSendMessage}
    >
      <input type="hidden" name="sessionId" value={host.selected.sessionId} />
      <input type="hidden" name="submissionId" value={host.sendSubmissionId} />
      <Composer
        id="conversation-host.message"
        rows={2}
        placeholder={host.conversationBusy ? host.copy.queuePlaceholder : host.copy.messagePlaceholder}
        bind:value={() => host.message, (v) => (host.message = v)}
        disabled={!host.canAssign || host.sendState === "submitting"}
        submitDisabled={!host.canAssign ||
          !host.modelReady ||
          host.modelState === "submitting" ||
          host.thinkingState === "submitting" ||
          host.sendState === "submitting" ||
          !host.message.trim() ||
          Boolean(host.sessionSlashActionBar) ||
          host.sessionSlashSuggestions.length > 0}
        submitting={host.sendState === "submitting"}
        submitLabel={host.conversationBusy ? host.copy.queueSubmit : host.copy.sendSubmit}
        submittingLabel={host.copy.sending}
        ariaLabel={host.copy.messageLabel}
        multilineHint={host.copy.multilineHint}
        onValueChange={host.handleSessionMessageChange}
        onKeydown={(event) => host.handleSlashCompletionKeydown(event, "session")}
        completion={{
          expanded: host.sessionSlashSuggestions.length > 0,
          listboxId: host.sessionSlashListboxId,
          activeOptionId: host.sessionSlashActiveOptionId,
        }}        >
        {#snippet actions()}
          {#if host.sessionSlashSuggestions.length > 0}
            <SlashCommandMenu
              id={host.sessionSlashListboxId}
              suggestions={host.sessionSlashSuggestions}
              activeIndex={host.sessionSlashActiveIndex}
              ariaLabel={host.copy.slashActions.completionLabel}
              hint={host.copy.slashActions.completionHint}
              onActiveIndexChange={(index) => host.setSessionSlashActiveIndex(index)}
              onSelect={(suggestion) => host.selectSlashSuggestion(suggestion, "session")}
            />
          {/if}
          {#if host.sessionSlashActionBar}
            <SlashActionBar
              view={host.sessionSlashActionBar}
              resolveAction={(action) => host.slashActionAvailability(action, "session")}
              onAction={(action) => host.handleSlashAction(action, "session")}
            />
          {/if}
        {/snippet}
        {#snippet header()}
          <div class="composer-runtime-header">
            {#if host.sessionPendingAsk && host.askDetailMessages}
              <SessionAskPanel ask={host.sessionPendingAsk} messages={host.askDetailMessages} />
            {/if}
            {#if host.liveSessionView?.cwd}
              <SessionStatusBar
                labels={host.statusBarLabels}
                cwd={host.compactWorkingDirectory(host.liveSessionView.cwd)}
                gitBranch={host.liveSessionView.gitBranch}
                inputTokens={host.runtimeStatusUsage.inputTokens}
                outputTokens={host.runtimeStatusUsage.outputTokens}
                cacheReadTokens={host.runtimeStatusUsage.cacheReadTokens}
                cacheWriteTokens={host.runtimeStatusUsage.cacheWriteTokens}
                costUsd={host.runtimeStatusUsage.costUsd}
                latestCacheHitPercent={host.runtimeStatusUsage.latestCacheHitPercent}
                contextTokens={host.runtimeStatusUsage.contextTokens}
                contextWindow={host.runtimeStatusUsage.contextWindow}
              />
            {/if}
            <SessionQueue
              items={host.queueItems}
              labels={host.queueLabels}
              hasRunningTurn={host.conversationBusy}
            >
              {#snippet actions(item)}
                <button
                  class="queue-remove-button"
                  type="submit"
                  form={host.queueRemoveFormId(item.id)}
                  disabled={host.dequeueState === "submitting"}
                  aria-label={`${host.copy.removeQueued}: ${item.text}`}
                  title={host.copy.removeQueued}
                >
                  <Icon name="close" size={13} stroke={2.2} />
                  <span>
                    {host.dequeuingTurnId === item.id && host.dequeueState === "submitting"
                      ? host.copy.removingQueued
                      : host.copy.removeQueued}
                  </span>
                </button>
              {/snippet}
            </SessionQueue>
          </div>
        {/snippet}
        {#snippet context()}
          {#if host.modelProvidersLength > 0}
            <ModelRuntimeControl
              id="conversation"
              bind:open={() => host.sessionModelPickerOpen, (v) => (host.sessionModelPickerOpen = v)}
              modelForm="session-model-form"
              thinkingForm="session-thinking-form"
              bind:modelValue={() => host.sessionModel, (v) => (host.sessionModel = v)}
              bind:thinkingValue={() => host.sessionThinkingLevel, (v) => (host.sessionThinkingLevel = v)}
              groups={host.modelGroups}
              labels={host.modelRuntimeLabels}
              modelDisabled={!host.canAssign || host.modelState === "submitting" || host.availableModelsLength === 0}
              thinkingDisabled={!host.canAssign || host.thinkingState === "submitting"}
              selectedLabel={!host.effectiveModelAvailable ? host.copy.currentModelUnavailable : undefined}
              settingsHref="/settings/models"
              onModelChange={host.submitModelSelection}
              onThinkingCommit={() => void host.submitThinkingSelection()}
            />
          {:else}
            <a class="model-settings-link compact" href="/settings/models">
              <Icon name="warning" size={13} />
              {host.modelControl.available ? host.copy.modelUnavailable : host.copy.modelControlUnavailable}
            </a>
          {/if}
        {/snippet}
        {#snippet feedback()}
          {#if host.sendFeedback}
            <p
              class="form-feedback {host.sendState}"
              role={host.sendState === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {host.sendFeedback}
            </p>
          {/if}
          {#if host.retryFeedback}
            <p class="form-feedback error" role="alert" aria-live="polite">
              {host.retryFeedback}
            </p>
          {/if}
          {#if host.modelFeedback}
            <p
              class="form-feedback {host.modelState}"
              class:sr-only={host.modelState !== "error"}
              role={host.modelState === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {host.modelFeedback}
            </p>
          {/if}
          {#if host.thinkingFeedback}
            <p
              class="form-feedback {host.thinkingState}"
              class:sr-only={host.thinkingState !== "error"}
              role={host.thinkingState === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {host.thinkingFeedback}
            </p>
          {/if}
          {#if host.cancelFeedback}
            <p
              class="form-feedback {host.cancelState}"
              role={host.cancelState === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {host.cancelFeedback}
            </p>
          {/if}
          {#if host.dequeueFeedback}
            <p
              class="form-feedback {host.dequeueState}"
              role={host.dequeueState === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {host.dequeueFeedback}
            </p>
          {/if}
        {/snippet}
      </Composer>
    </form>


<style>

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


</style>
