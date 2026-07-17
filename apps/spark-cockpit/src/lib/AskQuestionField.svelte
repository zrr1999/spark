<script lang="ts">
  import type { AppMessages } from "$lib/i18n";
  import {
    cockpitCustomAnswerValue,
    type PendingWorkbenchAsk,
  } from "$lib/pending-ask";
  import { Textarea } from "$lib/ui";

  let {
    question,
    questionIndex,
    messages,
    disabled = false,
    idPrefix = "ask-question",
  }: {
    question: PendingWorkbenchAsk["questions"][number];
    questionIndex: number;
    messages: AppMessages["inboxDetail"]["response"];
    disabled?: boolean;
    idPrefix?: string;
  } = $props();

  let answerName = $derived(`answer:${question.id}`);
  let customAnswerName = $derived(`custom-answer:${question.id}`);
  let customChoiceId = $derived(`${idPrefix}-${questionIndex}-custom-choice`);
  let customAnswerId = $derived(`${idPrefix}-${questionIndex}-custom-answer`);

  function selectCustomChoice(event: Event) {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    const choice = textarea
      .closest(".custom-option-row")
      ?.querySelector<HTMLInputElement>("[data-custom-answer-choice]");
    if (choice && !choice.checked && !choice.disabled) choice.click();
  }
</script>

<fieldset class="question-block">
  <legend>
    {question.prompt}{question.required ? messages.requiredMark : ""}
  </legend>

  {#if (question.type === "single" || question.type === "preview") && question.options?.length}
    <div class="option-list">
      {#each question.options as option (option.value)}
        <label class="option-row">
          <input
            name={answerName}
            type="radio"
            value={option.value}
            required={question.required}
            {disabled}
          />
          <span>
            <strong>{option.label}</strong>
            {#if option.description}<small>{option.description}</small>{/if}
            {#if option.preview}<code class="option-preview">{option.preview}</code>{/if}
          </span>
        </label>
      {/each}
      <div class="option-row custom-option-row">
        <input
          id={customChoiceId}
          name={answerName}
          type="radio"
          value={cockpitCustomAnswerValue}
          required={question.required}
          data-custom-answer-choice
          {disabled}
        />
        <div class="custom-answer-copy">
          <label for={customChoiceId}>{messages.customAnswer}</label>
          <Textarea
            id={customAnswerId}
            name={customAnswerName}
            rows={3}
            placeholder={messages.customAnswerPlaceholder}
            aria-label={`${question.prompt}: ${messages.customAnswer}`}
            onfocus={selectCustomChoice}
            oninput={selectCustomChoice}
            {disabled}
          />
        </div>
      </div>
    </div>
  {:else if question.type === "multi" && question.options?.length}
    <div class="option-list">
      {#each question.options as option (option.value)}
        <label class="option-row">
          <input name={answerName} type="checkbox" value={option.value} {disabled} />
          <span>
            <strong>{option.label}</strong>
            {#if option.description}<small>{option.description}</small>{/if}
            {#if option.preview}<code class="option-preview">{option.preview}</code>{/if}
          </span>
        </label>
      {/each}
      <div class="option-row custom-option-row">
        <input
          id={customChoiceId}
          name={answerName}
          type="checkbox"
          value={cockpitCustomAnswerValue}
          data-custom-answer-choice
          {disabled}
        />
        <div class="custom-answer-copy">
          <label for={customChoiceId}>{messages.customAnswer}</label>
          <Textarea
            id={customAnswerId}
            name={customAnswerName}
            rows={3}
            placeholder={messages.customAnswerPlaceholder}
            aria-label={`${question.prompt}: ${messages.customAnswer}`}
            onfocus={selectCustomChoice}
            oninput={selectCustomChoice}
            {disabled}
          />
        </div>
      </div>
    </div>
  {:else}
    <Textarea
      id={`${idPrefix}-${questionIndex}`}
      name={answerName}
      rows={4}
      required={question.required}
      placeholder={messages.customAnswerPlaceholder}
      aria-label={question.prompt}
      {disabled}
    />
  {/if}
</fieldset>

<style>
  .question-block {
    border: 0;
    display: grid;
    gap: var(--spacing-sm);
    margin: 0;
    min-width: 0;
    padding: 0;
  }

  .question-block legend {
    color: var(--color-ink);
    font-size: var(--text-body);
    font-weight: 700;
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

  .option-row > input {
    margin: 3px 0 0;
  }

  .option-row span,
  .custom-answer-copy {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  .option-row strong,
  .custom-answer-copy > label {
    color: var(--color-ink);
    font-size: var(--text-body);
    font-weight: 700;
  }

  .option-row small {
    color: var(--color-ink-muted);
    display: block;
    line-height: 1.45;
  }

  .option-preview {
    background: var(--color-canvas);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-sm);
    color: var(--color-ink-muted);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    line-height: 1.45;
    margin: 3px 0 0;
    max-height: 180px;
    overflow: auto;
    padding: 8px 9px;
    white-space: pre-wrap;
  }

  .custom-option-row {
    cursor: default;
  }

  .custom-answer-copy :global(textarea) {
    min-height: 76px;
  }
</style>
