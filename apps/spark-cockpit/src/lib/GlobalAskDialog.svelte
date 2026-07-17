<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import AskQuestionField from "$lib/AskQuestionField.svelte";
  import Icon from "$lib/Icon.svelte";
  import type { AppMessages } from "$lib/i18n";
  import type { PendingWorkbenchAsk } from "$lib/pending-ask";
  import { Button, Dialog as DialogShell, Textarea } from "$lib/ui";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { Dialog } from "bits-ui";
  import { tick } from "svelte";

  let {
    ask,
    messages,
  }: {
    ask: PendingWorkbenchAsk;
    messages: AppMessages["inboxDetail"];
  } = $props();

  let open = $state(true);
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);
  let pendingCount = $derived(Math.max(1, ask.pendingCount ?? 1));
  let formElement = $state<HTMLFormElement>();
  let formDraft: Array<[string, string]> = [];

  function captureFormDraft() {
    if (!formElement) return;
    formDraft = [...new FormData(formElement).entries()].flatMap(([name, value]) =>
      typeof value === "string" ? [[name, value] as [string, string]] : [],
    );
  }

  function restoreFormDraft() {
    if (!formElement || formDraft.length === 0) return;
    const valuesByName = new Map<string, string[]>();
    for (const [name, value] of formDraft) {
      const values = valuesByName.get(name) ?? [];
      values.push(value);
      valuesByName.set(name, values);
    }

    for (const control of formElement.elements) {
      if (
        !(control instanceof HTMLInputElement) &&
        !(control instanceof HTMLTextAreaElement) &&
        !(control instanceof HTMLSelectElement)
      ) {
        continue;
      }
      if (!control.name) continue;
      const values = valuesByName.get(control.name) ?? [];
      if (control instanceof HTMLInputElement && (control.type === "radio" || control.type === "checkbox")) {
        control.checked = values.includes(control.value);
        continue;
      }
      if (control instanceof HTMLSelectElement && control.multiple) {
        for (const option of control.options) option.selected = values.includes(option.value);
        continue;
      }
      control.value = values[0] ?? "";
    }
  }

  function minimizeRequest() {
    captureFormDraft();
    open = false;
  }

  async function resumeRequest() {
    open = true;
    await tick();
    restoreFormDraft();
  }

  const enhanceAnswer: SubmitFunction = ({ cancel }) => {
    if (submitting) {
      cancel();
      return;
    }

    submitting = true;
    errorMessage = null;
    return async ({ result }) => {
      submitting = false;
      if (result.type === "failure") {
        const data = result.data as { message?: string } | undefined;
        errorMessage = data?.message ?? messages.formMessages.recordFailed;
        return;
      }
      if (result.type === "error") {
        errorMessage = messages.formMessages.recordFailed;
        return;
      }

      open = false;
      await invalidateAll();
    };
  };
</script>

<DialogShell
  bind:open
  backdrop="blur"
  width="min(640px, calc(100vw - 32px))"
  maxHeight="min(760px, calc(100dvh - 32px))"
  elevation={110}
  describedBy="global-ask-description"
>
  <header class="dialog-heading">
    <div class="heading-copy">
      <p class="kicker">{messages.response.kicker}</p>
      <Dialog.Title class="global-ask-title">{ask.title}</Dialog.Title>
      <Dialog.Description id="global-ask-description" class="global-ask-description">
        {ask.prompt}
      </Dialog.Description>
    </div>
    <Dialog.Close
      class="global-ask-close"
      type="button"
      aria-label={messages.response.minimizeDialog}
      disabled={submitting}
      onclick={minimizeRequest}
    >
      <Icon name="close" size={18} />
    </Dialog.Close>
  </header>

  <form
    bind:this={formElement}
    method="POST"
    action={`${ask.detailHref}?/respond`}
    use:enhance={enhanceAnswer}
    oninput={captureFormDraft}
    onchange={captureFormDraft}
  >
    <div class="questions">
      {#if ask.questions.length === 0}
        <label class="freeform-question" for="global-ask-message">
          <span>{messages.response.answer}{messages.response.requiredMark}</span>
          <Textarea
            id="global-ask-message"
            name="answer:message"
            rows={5}
            placeholder={messages.response.answerPlaceholder}
            required
            disabled={submitting}
          />
        </label>
      {:else}
        {#each ask.questions as question, questionIndex (question.id)}
          <AskQuestionField
            {question}
            {questionIndex}
            messages={messages.response}
            disabled={submitting}
            idPrefix="global-ask-question"
          />
        {/each}
      {/if}
    </div>

    {#if errorMessage}
      <p class="form-error" role="alert">{errorMessage}</p>
    {/if}

    <footer class="dialog-actions">
      <div class="secondary-actions">
        <Dialog.Close
          class="global-ask-later"
          type="button"
          disabled={submitting}
          onclick={minimizeRequest}
        >
          {messages.response.answerLater}
        </Dialog.Close>
        <Button
          variant="secondary"
          href={ask.detailHref}
          onclick={() => (open = false)}
        >
          {messages.response.openInbox}
        </Button>
      </div>
      <Button type="submit" name="status" value="answered" disabled={submitting}>
        {submitting ? messages.response.sending : messages.response.send}
      </Button>
    </footer>
  </form>
</DialogShell>

{#if !open}
  <aside class="ask-recovery" aria-live="polite">
    <button
      type="button"
      onclick={resumeRequest}
      aria-label={`${messages.response.resumeRequest}: ${ask.title} · ${pendingCount} ${messages.response.pendingRequests}`}
    >
      <span class="recovery-icon"><Icon name="inbox" size={18} /></span>
      <span class="recovery-copy">
        <strong>{messages.response.resumeRequest}</strong>
        <small>{ask.title}</small>
      </span>
      <span class="pending-count" aria-hidden="true">{pendingCount}</span>
    </button>
  </aside>
{/if}

<style>
  .dialog-heading {
    align-items: start;
    border-bottom: 1px solid var(--color-border-soft);
    display: flex;
    gap: var(--spacing-lg);
    justify-content: space-between;
    padding: var(--spacing-xl);
  }

  .heading-copy {
    display: grid;
    gap: var(--spacing-xs);
    min-width: 0;
  }

  .kicker {
    color: var(--color-primary);
    font-size: var(--text-caption);
    font-weight: 750;
    letter-spacing: 0.04em;
    margin: 0;
    text-transform: uppercase;
  }

  :global(.global-ask-title) {
    color: var(--color-ink);
    font-size: 22px;
    font-weight: 750;
    letter-spacing: -0.02em;
    line-height: 1.25;
    margin: 0;
    overflow-wrap: anywhere;
  }

  :global(.global-ask-description) {
    color: var(--color-ink-muted);
    line-height: 1.55;
    margin: 0;
    overflow-wrap: anywhere;
  }

  :global(.global-ask-close),
  :global(.global-ask-later) {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    justify-content: center;
  }

  :global(.global-ask-close) {
    border-radius: var(--rounded-md);
    flex: 0 0 auto;
    height: 34px;
    width: 34px;
  }

  :global(.global-ask-close:hover),
  :global(.global-ask-later:hover) {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  :global(.global-ask-close:focus-visible),
  :global(.global-ask-later:focus-visible) {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  :global(.global-ask-close:disabled),
  :global(.global-ask-later:disabled) {
    cursor: not-allowed;
    opacity: 0.55;
  }

  form {
    display: grid;
  }

  .questions {
    display: grid;
    gap: var(--spacing-lg);
    padding: var(--spacing-xl);
  }

  .freeform-question {
    display: grid;
    gap: var(--spacing-sm);
  }

  .freeform-question > span {
    color: var(--color-ink);
    font-size: var(--text-body);
    font-weight: 700;
  }

  .form-error {
    background: var(--color-danger-weak);
    border: 1px solid var(--color-danger-soft);
    border-radius: var(--rounded-md);
    color: var(--color-danger);
    margin: 0 var(--spacing-xl) var(--spacing-lg);
    padding: 10px 12px;
  }

  .dialog-actions {
    align-items: center;
    border-top: 1px solid var(--color-border-soft);
    display: flex;
    gap: var(--spacing-sm);
    justify-content: space-between;
    padding: var(--spacing-md) var(--spacing-xl);
  }

  .secondary-actions {
    align-items: center;
    display: flex;
    gap: var(--spacing-xs);
  }

  :global(.global-ask-later) {
    border-radius: var(--rounded-md);
    min-height: 40px;
    padding: 8px 12px;
  }

  .ask-recovery {
    bottom: 20px;
    max-width: min(360px, calc(100vw - 32px));
    position: fixed;
    right: 20px;
    z-index: 90;
  }

  .ask-recovery button {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-primary-soft);
    border-radius: 14px;
    box-shadow: 0 16px 42px rgb(15 23 42 / 18%);
    color: var(--color-ink);
    cursor: pointer;
    display: grid;
    font: inherit;
    gap: 10px;
    grid-template-columns: auto minmax(0, 1fr) auto;
    min-height: 58px;
    padding: 9px 11px;
    text-align: left;
    width: 100%;
  }

  .ask-recovery button:hover {
    background: var(--color-surface-soft);
    border-color: var(--color-primary);
  }

  .ask-recovery button:focus-visible {
    box-shadow:
      var(--shadow-focus),
      0 16px 42px rgb(15 23 42 / 18%);
    outline: none;
  }

  .recovery-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: 10px;
    color: var(--color-primary);
    display: inline-flex;
    height: 36px;
    justify-content: center;
    width: 36px;
  }

  .recovery-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .recovery-copy strong {
    font-size: 12px;
  }

  .recovery-copy small {
    color: var(--color-ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pending-count {
    align-items: center;
    background: var(--color-primary);
    border-radius: 999px;
    color: white;
    display: inline-flex;
    font-size: 11px;
    font-weight: 750;
    height: 24px;
    justify-content: center;
    min-width: 24px;
    padding: 0 6px;
  }

  @media (max-width: 640px) {
    .dialog-heading,
    .questions {
      padding: var(--spacing-lg);
    }

    .dialog-actions {
      align-items: stretch;
      flex-direction: column-reverse;
      padding: var(--spacing-md) var(--spacing-lg);
    }

    .dialog-actions :global(.ui-button),
    .secondary-actions,
    .secondary-actions :global(.ui-button),
    :global(.global-ask-later) {
      width: 100%;
    }

    .ask-recovery {
      bottom: 12px;
      left: 12px;
      max-width: none;
      right: 12px;
    }
  }
</style>
