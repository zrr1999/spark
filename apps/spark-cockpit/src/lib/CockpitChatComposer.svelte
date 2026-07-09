<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import type { CockpitChatContextCard, CockpitChatPromptSuggestion } from "$lib/cockpit-chat-types";
  import type { IconName } from "$lib/icons";

  type QueuedMessage = {
    id: string;
    text: string;
  };

  type MainSessionMessages = {
    contextLabel: string;
    messageLabel: string;
    placeholder: string;
    send: string;
    stop: string;
    stopUnavailable: string;
    queue: string;
    queuedLabel: string;
    suggestionsLabel: string;
    contextActionsLabel: string;
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

  let {
    t,
    contextName,
    contextChipLabel,
    contextIcon = "folder",
    submitAction = "?/startTask",
    cancelAction = "?/cancelRun",
    composerId = "cockpit-chat-prompt",
    cancelFormId = "cockpit-chat-cancel-run-form",
    form,
    canStartTask,
    hasActiveRun,
    startButtonLabel,
    latestActiveInvocationId,
    suggestions,
    contextCards,
    onOptimisticSubmit,
  }: {
    t: MainSessionMessages;
    contextName: string;
    contextChipLabel: string;
    contextIcon?: IconName;
    submitAction?: string;
    cancelAction?: string;
    composerId?: string;
    cancelFormId?: string;
    form?: { message?: string; queuedCommandId?: string; values?: { prompt?: string; title?: string } } | null;
    canStartTask: boolean;
    hasActiveRun: boolean;
    startButtonLabel: string;
    latestActiveInvocationId?: string | null;
    suggestions: CockpitChatPromptSuggestion[];
    contextCards: CockpitChatContextCard[];
    onOptimisticSubmit?: (prompt: string) => void;
  } = $props();

  let draft = $state("");
  let queuedMessages = $state<QueuedMessage[]>([]);
  let editingQueuedId = $state<string | null>(null);
  let steeringId = $state<string | null>(null);

  let primaryActionLabel = $derived(hasActiveRun ? t.queue : canStartTask ? t.send : startButtonLabel);

  function enqueueMessage(text: string) {
    const value = text.trim();
    if (!value) return;
    queuedMessages = [...queuedMessages, { id: `queued-${Date.now()}-${queuedMessages.length}`, text: value }];
  }

  function saveQueuedEdit() {
    if (!editingQueuedId) return false;
    const value = draft.trim();
    if (!value) return true;
    queuedMessages = queuedMessages.map((message) =>
      message.id === editingQueuedId ? { ...message, text: value } : message,
    );
    editingQueuedId = null;
    draft = "";
    return true;
  }

  function handleComposerSubmit(event: SubmitEvent) {
    if (!canStartTask) {
      event.preventDefault();
      return;
    }
    if (hasActiveRun || editingQueuedId) {
      event.preventDefault();
      if (saveQueuedEdit()) return;
      enqueueMessage(draft);
      draft = "";
      return;
    }
    onOptimisticSubmit?.(draft);
  }

  function handleSuggestedSubmit(event: SubmitEvent, suggestion: CockpitChatPromptSuggestion) {
    if (!canStartTask) {
      event.preventDefault();
      prefillPrompt(suggestion.prompt);
      return;
    }
    if (hasActiveRun) {
      event.preventDefault();
      enqueueMessage(suggestion.prompt);
    }
  }

  function prefillPrompt(prompt: string) {
    draft = prompt;
    editingQueuedId = null;
  }

  function handlePromptKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const form = (event.currentTarget as HTMLTextAreaElement | null)?.form;
      form?.requestSubmit();
      return;
    }
    if (event.key === "Escape" && editingQueuedId) {
      editingQueuedId = null;
      draft = "";
    }
  }

  function editQueuedMessage(id: string) {
    const queued = queuedMessages.find((message) => message.id === id);
    if (!queued) return;
    draft = queued.text;
    editingQueuedId = id;
  }

  function deleteQueuedMessage(id: string) {
    queuedMessages = queuedMessages.filter((message) => message.id !== id);
    if (steeringId === id) steeringId = null;
    if (editingQueuedId === id) {
      editingQueuedId = null;
      draft = "";
    }
  }

  function steerQueuedMessage(id: string) {
    steeringId = steeringId === id ? null : id;
  }
</script>

<div class="suggested-prompts" aria-label={t.suggestionsLabel}>
  {#each suggestions as suggestion}
    <form method="POST" action={submitAction} onsubmit={(event) => handleSuggestedSubmit(event, suggestion)}>
      <input type="hidden" name="prompt" value={suggestion.prompt} />
      <button
        type="submit"
        class:queueing={hasActiveRun}
        disabled={!canStartTask && hasActiveRun}
        title={hasActiveRun ? `${t.queue}: ${suggestion.meta || suggestion.label}` : suggestion.meta}
        aria-label={hasActiveRun ? `${t.queue}: ${suggestion.label}` : suggestion.label}
      >
        <span>{suggestion.label}</span>
      </button>
    </form>
  {/each}
</div>

{#if contextCards.length > 0}
  <section class="context-action-cards" aria-label={t.contextActionsLabel}>
    {#each contextCards as card}
      <article class="context-card {card.type}">
        <div>
          <span class="context-kicker">{card.kicker}</span>
          <h3>{card.title}</h3>
          <p>{card.description}</p>
        </div>
        <div class="context-card-actions">
          <button type="button" onclick={() => prefillPrompt(card.prompt)}>{card.primaryLabel}</button>
          {#if card.href && card.secondaryLabel}
            <a href={card.href}>{card.secondaryLabel}</a>
          {/if}
        </div>
      </article>
    {/each}
  </section>
{/if}

{#if queuedMessages.length > 0}
  <div class="queued-messages" aria-label={t.queuedLabel}>
    <div class="queued-heading">
      <span><Icon name="chevron" size={14} />{t.queuedLabel}</span>
      <small>{queuedMessages.length}</small>
    </div>
    {#each queuedMessages as message}
      <article class="queued-row" class:editing={editingQueuedId === message.id} class:steering={steeringId === message.id}>
        <p>{message.text}</p>
        <div class="queued-actions">
          <button type="button" onclick={() => steerQueuedMessage(message.id)}>
            {steeringId === message.id ? t.steering : t.steerQueued}
          </button>
          <button type="button" onclick={() => editQueuedMessage(message.id)}>{t.editQueued}</button>
          <button type="button" onclick={() => deleteQueuedMessage(message.id)}>{t.deleteQueued}</button>
        </div>
      </article>
    {/each}
  </div>
{/if}

<form method="POST" action={submitAction} class="chat-composer" onsubmit={handleComposerSubmit}>
  <label for={composerId}>{editingQueuedId ? t.editQueued : t.messageLabel}</label>
  <textarea
    id={composerId}
    name="prompt"
    bind:value={draft}
    rows="3"
    placeholder={t.placeholder}
    required
    onkeydown={handlePromptKeydown}
  ></textarea>
  <div class="composer-footer">
    <div class="composer-controls" aria-label={t.contextLabel}>
      <span class="context-chip active"><Icon name={contextIcon} size={14} />{contextChipLabel}: {contextName}</span>
    </div>
    <div class="submit-controls">
      {#if hasActiveRun}
        <button
          type="submit"
          form={cancelFormId}
          class="stop-button"
          disabled={!latestActiveInvocationId}
          title={!latestActiveInvocationId ? t.stopUnavailable : undefined}
        >
          <Icon name="warning" size={16} stroke={2.3} />
          <span>{t.stop}</span>
        </button>
      {/if}
      <button type="submit" disabled={!canStartTask}>
        <Icon name="play" size={16} stroke={2.3} />
        <span>{primaryActionLabel}</span>
      </button>
    </div>
  </div>
  <p class="keyboard-hint">{t.keyboardHint}</p>
  {#if form?.message}
    <p class:form-error={!form?.queuedCommandId} class="form-message">{form.message}</p>
  {/if}
  {#if !canStartTask}
    <p class="unavailable-note">{t.unavailableBody}</p>
  {/if}
</form>

<form id={cancelFormId} method="POST" action={cancelAction} class="stop-form">
  <input type="hidden" name="runtimeInvocationId" value={latestActiveInvocationId ?? ""} />
</form>

<style>
  .suggested-prompts,
  .composer-footer,
  .composer-controls,
  .submit-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .context-action-cards {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .suggested-prompts form,
  .stop-form {
    margin: 0;
  }

  .suggested-prompts button,
  .chat-composer button,
  .queued-actions button,
  .context-card button,
  .context-card a {
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

  .suggested-prompts button.queueing {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .suggested-prompts button.queueing::after {
    content: "+";
    font-size: 12px;
    font-weight: 900;
    line-height: 1;
  }

  .suggested-prompts button:not(:disabled):hover {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .context-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    display: grid;
    gap: 12px;
    padding: 12px;
  }

  .context-card.inbox {
    border-color: var(--color-warning-soft);
  }

  .context-card.artifact {
    border-color: var(--color-primary-soft);
  }

  .context-kicker {
    color: var(--color-primary);
    display: block;
    font-size: 11px;
    font-weight: 850;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
    text-transform: uppercase;
  }

  .context-card h3 {
    color: var(--color-ink);
    font-size: 14px;
    margin: 0;
  }

  .context-card p {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.45;
    margin: 4px 0 0;
  }

  .context-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .context-card button,
  .context-card a {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
    padding: 7px 10px;
    text-decoration: none;
  }

  .context-card button:hover,
  .context-card a:hover {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .queued-messages {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    display: grid;
    gap: 8px;
    padding: 10px;
  }

  .queued-heading,
  .queued-row,
  .queued-actions {
    align-items: center;
    display: flex;
    gap: 8px;
  }

  .queued-heading {
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 800;
    justify-content: space-between;
    text-transform: uppercase;
  }

  .queued-heading span {
    align-items: center;
    display: inline-flex;
    gap: 6px;
  }

  .queued-heading small {
    color: var(--color-ink-subtle);
    font-size: 12px;
  }

  .queued-row {
    align-items: flex-start;
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    flex-wrap: wrap;
    justify-content: space-between;
    padding: 10px;
  }

  .queued-row.editing,
  .queued-row.steering {
    border-color: var(--color-primary-soft);
  }

  .queued-row p {
    color: var(--color-ink);
    flex: 1 1 220px;
    font-size: 13px;
    line-height: 1.45;
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .queued-actions {
    flex: 0 1 auto;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .queued-actions button {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
    padding: 6px 9px;
  }

  .queued-actions button:hover {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .chat-composer {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    display: grid;
    gap: 10px;
    padding: 12px;
  }

  .chat-composer label {
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .chat-composer textarea {
    background: transparent;
    border: 0;
    color: var(--color-ink);
    font: inherit;
    line-height: 1.5;
    min-height: 76px;
    padding: 2px 0;
    resize: vertical;
  }

  .chat-composer textarea:focus {
    outline: none;
  }

  .composer-footer {
    align-items: center;
    border-top: 1px solid var(--color-border);
    justify-content: space-between;
    padding-top: 10px;
  }

  .composer-controls {
    min-width: 0;
  }

  .submit-controls {
    margin-left: auto;
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

  .context-chip.active {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .chat-composer button[type="submit"],
  .stop-button {
    background: var(--color-primary);
    border: 0;
    color: var(--color-surface);
    justify-content: center;
    min-height: 38px;
    padding: 8px 14px;
  }

  .chat-composer button[type="submit"]:not(:disabled):hover {
    background: var(--color-primary-hover);
  }

  .stop-button {
    background: var(--color-danger);
  }

  .chat-composer button[type="submit"]:disabled,
  .suggested-prompts button:disabled,
  .stop-button:disabled {
    background: var(--color-border);
    border-color: var(--color-border);
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }

  .keyboard-hint,
  .form-message {
    font-size: 12px;
    line-height: 1.45;
  }

  .keyboard-hint,
  .unavailable-note {
    color: var(--color-ink-subtle);
  }

  .form-message {
    color: var(--color-primary);
  }

  .form-message.form-error {
    color: var(--color-danger);
  }

  .unavailable-note {
    color: var(--color-warning);
    font-size: 12px;
  }
</style>
