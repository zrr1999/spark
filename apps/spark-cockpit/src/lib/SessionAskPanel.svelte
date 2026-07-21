<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import AskQuestionField from "$lib/AskQuestionField.svelte";
  import Icon from "$lib/Icon.svelte";
  import type { AppMessages } from "$lib/i18n";
  import type { PendingWorkbenchAsk } from "$lib/pending-ask";
  import { Button, Textarea } from "$lib/ui";
  import type { SubmitFunction } from "@sveltejs/kit";

  let {
    ask,
    messages,
  }: {
    ask: PendingWorkbenchAsk;
    messages: AppMessages["inboxDetail"];
  } = $props();

  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);
  let pendingCount = $derived(Math.max(1, ask.pendingCount ?? 1));

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

      await invalidateAll();
    };
  };
</script>

<section class="session-ask-panel" aria-labelledby="session-ask-title">
  <header class="ask-heading">
    <span class="ask-icon"><Icon name="inbox" size={16} /></span>
    <div class="ask-copy">
      <p class="kicker">{messages.response.kicker}</p>
      <h2 id="session-ask-title">{ask.title}</h2>
      <p class="prompt">{ask.prompt}</p>
    </div>
    {#if pendingCount > 1}
      <span class="pending-count" aria-label={`${pendingCount} ${messages.response.pendingRequests}`}>
        {pendingCount}
      </span>
    {/if}
  </header>

  <form method="POST" action={`${ask.detailHref}?/respond`} use:enhance={enhanceAnswer}>
    <div class="questions">
      {#if ask.questions.length === 0}
        <label class="freeform-question" for="session-ask-message">
          <span>{messages.response.answer}{messages.response.requiredMark}</span>
          <Textarea
            id="session-ask-message"
            name="answer:message"
            rows={4}
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
            idPrefix="session-ask-question"
          />
        {/each}
      {/if}
    </div>

    {#if errorMessage}
      <p class="form-error" role="alert">{errorMessage}</p>
    {/if}

    <footer class="ask-actions">
      <Button variant="secondary" href={ask.detailHref}>{messages.response.openInbox}</Button>
      <Button type="submit" name="status" value="answered" disabled={submitting}>
        {submitting ? messages.response.sending : messages.response.send}
      </Button>
    </footer>
  </form>
</section>

<style>
  .session-ask-panel {
    background: var(--color-warning-soft, var(--color-surface-soft));
    border: 1px solid var(--color-warning, var(--color-border));
    border-radius: var(--rounded-lg);
    display: grid;
    gap: var(--spacing-md);
    margin: 0 0 var(--spacing-md);
    padding: var(--spacing-md);
  }

  .ask-heading {
    align-items: start;
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .ask-icon {
    color: var(--color-warning-strong, var(--color-warning));
    display: inline-flex;
    margin-top: 2px;
  }

  .ask-copy {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .kicker {
    color: var(--color-primary);
    font-size: var(--text-caption, 11px);
    font-weight: 750;
    letter-spacing: 0.04em;
    margin: 0;
    text-transform: uppercase;
  }

  h2 {
    color: var(--color-ink);
    font-size: 15px;
    font-weight: 700;
    line-height: 1.35;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .prompt {
    color: var(--color-ink-muted);
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .pending-count {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-ink-muted);
    font-size: 11px;
    font-weight: 700;
    min-width: 1.75rem;
    padding: 2px 8px;
    text-align: center;
  }

  form {
    display: grid;
    gap: var(--spacing-md);
  }

  .questions {
    display: grid;
    gap: var(--spacing-md);
  }

  .freeform-question {
    display: grid;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
  }

  .form-error {
    color: var(--color-danger, #b42318);
    font-size: 13px;
    margin: 0;
  }

  .ask-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
