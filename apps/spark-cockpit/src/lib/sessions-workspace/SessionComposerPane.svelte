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
  import {
    SPARK_TURN_ATTACHMENT_MAX_BYTES,
    SPARK_TURN_ATTACHMENT_MAX_COUNT,
    SPARK_TURN_ATTACHMENT_MAX_TOTAL_BYTES,
  } from "@zendev-lab/spark-protocol";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { onDestroy } from "svelte";
  import type { SessionConversationHost } from "./conversation-host";

  let { host }: { host: SessionConversationHost } = $props();

  type SelectedAttachment = {
    key: string;
    file: File;
    previewUrl?: string;
  };

  let fileInput = $state<HTMLInputElement | null>(null);
  let selectedAttachments = $state<SelectedAttachment[]>([]);
  let attachmentError = $state<string | null>(null);
  let draggingAttachments = $state(false);

  const enhanceSendMessage: SubmitFunction = async (submission) => {
    const callback = await host.enhanceSendMessage(submission);
    if (!callback) return;
    return async (result) => {
      await callback(result);
      if (result.result.type === "success") clearAttachments();
    };
  };

  function attachmentKey(file: File): string {
    return `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
  }

  function addAttachments(files: readonly File[]) {
    if (files.length === 0) return;
    const existing = new Map(selectedAttachments.map((attachment) => [attachment.key, attachment]));
    for (const file of files) {
      const key = attachmentKey(file);
      if (!existing.has(key)) {
        existing.set(key, {
          key,
          file,
          ...(file.type.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {}),
        });
      }
    }
    const next = [...existing.values()];
    const tooLarge = next.find(
      (attachment) => attachment.file.size > SPARK_TURN_ATTACHMENT_MAX_BYTES,
    );
    const totalBytes = next.reduce((total, attachment) => total + attachment.file.size, 0);
    if (next.length > SPARK_TURN_ATTACHMENT_MAX_COUNT) {
      revokeNewPreviews(next, selectedAttachments);
      attachmentError = host.copy.attachmentCountError;
      return;
    }
    if (tooLarge) {
      revokeNewPreviews(next, selectedAttachments);
      attachmentError = host.copy.attachmentSizeError.replace("{name}", tooLarge.file.name);
      return;
    }
    if (totalBytes > SPARK_TURN_ATTACHMENT_MAX_TOTAL_BYTES) {
      revokeNewPreviews(next, selectedAttachments);
      attachmentError = host.copy.attachmentTotalSizeError;
      return;
    }
    selectedAttachments = next;
    attachmentError = null;
    syncFileInput();
    host.handleSessionAttachmentsChange();
  }

  function removeAttachment(key: string) {
    const removed = selectedAttachments.find((attachment) => attachment.key === key);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    selectedAttachments = selectedAttachments.filter((attachment) => attachment.key !== key);
    attachmentError = null;
    syncFileInput();
    host.handleSessionAttachmentsChange();
  }

  function clearAttachments() {
    for (const attachment of selectedAttachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    selectedAttachments = [];
    attachmentError = null;
    if (fileInput) fileInput.value = "";
  }

  function syncFileInput() {
    if (!fileInput) return;
    const transfer = new DataTransfer();
    for (const attachment of selectedAttachments) transfer.items.add(attachment.file);
    fileInput.files = transfer.files;
  }

  function revokeNewPreviews(
    next: readonly SelectedAttachment[],
    previous: readonly SelectedAttachment[],
  ) {
    const previousKeys = new Set(previous.map((attachment) => attachment.key));
    for (const attachment of next) {
      if (!previousKeys.has(attachment.key) && attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
  }

  function handlePaste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    addAttachments(files);
  }

  function handleDrop(event: DragEvent) {
    draggingAttachments = false;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    addAttachments(files);
  }

  function formatFileSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.ceil(size / 102.4) / 10} KB`;
    return `${Math.ceil(size / (1024 * 102.4)) / 10} MB`;
  }

  onDestroy(clearAttachments);
</script>
<form
  method="POST"
  action="?/sendMessage"
  enctype="multipart/form-data"
  class="conversation-composer"
  class:dragging={draggingAttachments}
  aria-busy={host.sendState === "submitting"}
  use:enhance={enhanceSendMessage}
  onpaste={handlePaste}
  ondragenter={(event) => {
    if (event.dataTransfer?.types.includes("Files")) draggingAttachments = true;
  }}
  ondragover={(event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  }}
  ondragleave={(event) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) draggingAttachments = false;
  }}
  ondrop={handleDrop}
>
      <input type="hidden" name="sessionId" value={host.selected.sessionId} />
      <input type="hidden" name="submissionId" value={host.sendSubmissionId} />
      <input
        class="attachment-input"
        bind:this={fileInput}
        type="file"
        name="attachments"
        multiple
        tabindex="-1"
        onchange={(event) => addAttachments([...(event.currentTarget.files ?? [])])}
      />
      <Composer
        id="conversation-host.message"
        rows={2}
        required={false}
        placeholder={host.conversationBusy ? host.copy.queuePlaceholder : host.copy.messagePlaceholder}
        bind:value={() => host.message, (v) => (host.message = v)}
        disabled={!host.canAssign || host.sendState === "submitting"}
        submitDisabled={!host.canAssign ||
          !host.modelReady ||
          host.modelState === "submitting" ||
          host.thinkingState === "submitting" ||
          host.sendState === "submitting" ||
          (!host.message.trim() && selectedAttachments.length === 0) ||
          Boolean(host.sessionSlashActionBar) ||
          host.sessionSlashSuggestions.length > 0}
        submitting={host.sendState === "submitting"}
        submitLabel={host.conversationBusy ? host.copy.queueSubmit : host.copy.sendSubmit}
        submittingLabel={host.copy.sending}
        ariaLabel={host.copy.messageLabel}
        multilineHint={host.copy.multilineHint}
        onValueChange={host.handleSessionMessageChange}
        onKeydown={(event: KeyboardEvent) => host.handleSlashCompletionKeydown(event, "session")}
        completion={{
          expanded: host.sessionSlashSuggestions.length > 0,
          listboxId: host.sessionSlashListboxId,
          activeOptionId: host.sessionSlashActiveOptionId,
        }}        >
        {#snippet attachments()}
          {#if selectedAttachments.length > 0}
            <div class="attachment-tray" aria-label={host.copy.addAttachment}>
              {#each selectedAttachments as attachment (attachment.key)}
                <article class="attachment-card" class:image={Boolean(attachment.previewUrl)}>
                  {#if attachment.previewUrl}
                    <img src={attachment.previewUrl} alt={attachment.file.name} />
                  {:else}
                    <span class="attachment-file-mark" aria-hidden="true">
                      {attachment.file.name.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE"}
                    </span>
                  {/if}
                  <div class="attachment-copy">
                    <strong title={attachment.file.name}>{attachment.file.name}</strong>
                    <span>{formatFileSize(attachment.file.size)}</span>
                  </div>
                  <button
                    type="button"
                    class="attachment-remove"
                    aria-label={`${host.copy.removeAttachment}: ${attachment.file.name}`}
                    title={host.copy.removeAttachment}
                    onclick={() => removeAttachment(attachment.key)}
                  >
                    <Icon name="close" size={13} stroke={2.3} />
                  </button>
                </article>
              {/each}
            </div>
          {/if}
        {/snippet}
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
        {#snippet tools()}
          <button
            type="button"
            class="attachment-add"
            aria-label={host.copy.addAttachment}
            title={host.copy.addAttachment}
            disabled={!host.canAssign || host.sendState === "submitting"}
            onclick={() => fileInput?.click()}
          >
            <Icon name="plus" size={17} stroke={2} />
          </button>
        {/snippet}
        {#snippet feedback()}
          {#if draggingAttachments}
            <p class="attachment-drop-hint" role="status">{host.copy.dropAttachments}</p>
          {/if}
          {#if attachmentError}
            <p class="form-feedback error" role="alert">{attachmentError}</p>
          {/if}
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

  .conversation-composer.dragging :global(.conversation-composer-shell) {
    border-color: var(--color-primary);
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--color-primary) 16%, transparent),
      0 16px 38px rgb(15 23 42 / 9%);
  }

  .attachment-input {
    display: none;
  }

  .attachment-tray {
    display: flex;
    gap: 8px;
    min-width: 0;
    overflow-x: auto;
    padding-bottom: 2px;
  }

  .attachment-card {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: 10px;
    display: grid;
    flex: 0 0 184px;
    gap: 8px;
    grid-template-columns: 40px minmax(0, 1fr) 22px;
    min-height: 52px;
    overflow: hidden;
    padding: 5px;
  }

  .attachment-card.image {
    flex-basis: 154px;
  }

  .attachment-card img,
  .attachment-file-mark {
    border-radius: 7px;
    height: 40px;
    object-fit: cover;
    width: 40px;
  }

  .attachment-file-mark {
    align-items: center;
    background: var(--color-primary-weak);
    color: var(--color-primary);
    display: flex;
    font-size: 9px;
    font-weight: 750;
    justify-content: center;
    letter-spacing: 0.02em;
  }

  .attachment-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .attachment-copy strong {
    color: var(--color-ink);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-copy span {
    color: var(--color-ink-subtle);
    font-size: 10px;
  }

  .attachment-remove,
  .attachment-add {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
  }

  .attachment-remove {
    align-self: start;
    border-radius: 999px;
    height: 22px;
    width: 22px;
  }

  .attachment-add {
    border-radius: 9px;
    flex: 0 0 auto;
    height: 34px;
    width: 34px;
  }

  .attachment-remove:hover,
  .attachment-add:hover:not(:disabled) {
    background: var(--color-surface-raised, var(--color-surface-soft));
    color: var(--color-ink);
  }

  .attachment-remove:focus-visible,
  .attachment-add:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .attachment-add:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .attachment-drop-hint {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 650;
    margin: 0;
    text-align: center;
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
