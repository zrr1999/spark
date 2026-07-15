<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import Icon from "$lib/Icon.svelte";
  import type { AppMessages } from "$lib/i18n";
  import type { PendingWorkbenchAsk } from "$lib/pending-ask";
  import { Button, Dialog as DialogShell, Textarea } from "$lib/ui";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { Dialog } from "bits-ui";

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
      aria-label={messages.response.closeDialog}
      disabled={submitting}
    >
      <Icon name="close" size={18} />
    </Dialog.Close>
  </header>

  <form method="POST" action={`${ask.detailHref}?/respond`} use:enhance={enhanceAnswer}>
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
          <fieldset class="question-block">
            <legend>
              {question.prompt}{question.required ? messages.response.requiredMark : ""}
            </legend>

            {#if question.type === "single" && question.options?.length}
              <div class="option-list">
                {#each question.options as option (option.id)}
                  <label class="option-row">
                    <input
                      name={`answer:${question.id}`}
                      type="radio"
                      value={option.id}
                      required={question.required}
                      disabled={submitting}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {#if option.description}<small>{option.description}</small>{/if}
                    </span>
                  </label>
                {/each}
              </div>
            {:else if question.type === "multi" && question.options?.length}
              <div class="option-list">
                {#each question.options as option (option.id)}
                  <label class="option-row">
                    <input
                      name={`answer:${question.id}`}
                      type="checkbox"
                      value={option.id}
                      disabled={submitting}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {#if option.description}<small>{option.description}</small>{/if}
                    </span>
                  </label>
                {/each}
              </div>
            {:else if question.type === "preview"}
              <p class="preview-copy">{messages.response.previewOnly}</p>
            {:else}
              <Textarea
                id={`global-ask-question-${questionIndex}`}
                name={`answer:${question.id}`}
                rows={4}
                required={question.required}
                aria-label={question.prompt}
                disabled={submitting}
              />
            {/if}
          </fieldset>
        {/each}
      {/if}
    </div>

    {#if errorMessage}
      <p class="form-error" role="alert">{errorMessage}</p>
    {/if}

    <footer class="dialog-actions">
      <div class="secondary-actions">
        <Dialog.Close class="global-ask-later" type="button" disabled={submitting}>
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

  .freeform-question,
  .question-block {
    display: grid;
    gap: var(--spacing-sm);
  }

  .freeform-question > span,
  .question-block legend {
    color: var(--color-ink);
    font-size: var(--text-body);
    font-weight: 700;
  }

  .question-block {
    border: 0;
    margin: 0;
    min-width: 0;
    padding: 0;
  }

  .question-block legend {
    margin-bottom: var(--spacing-sm);
    padding: 0;
  }

  .option-list {
    display: grid;
    gap: var(--spacing-xs);
  }

  .option-row {
    align-items: start;
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    cursor: pointer;
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: auto minmax(0, 1fr);
    padding: 11px 12px;
  }

  .option-row:has(input:checked) {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
  }

  .option-row input {
    margin: 3px 0 0;
  }

  .option-row span {
    display: grid;
    gap: 2px;
  }

  .option-row strong {
    color: var(--color-ink);
    font-size: var(--text-body);
  }

  .option-row small,
  .preview-copy {
    color: var(--color-ink-muted);
    line-height: 1.45;
  }

  .preview-copy {
    background: var(--color-surface-soft);
    border-radius: var(--rounded-md);
    margin: 0;
    padding: 11px 12px;
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
  }
</style>
