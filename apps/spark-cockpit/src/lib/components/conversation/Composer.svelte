<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import type { Snippet } from "svelte";

  type Props = {
    id: string;
    name?: string;
    value?: string;
    rows?: number;
    required?: boolean;
    placeholder: string;
    disabled?: boolean;
    submitDisabled?: boolean;
    submitting?: boolean;
    submitLabel: string;
    submittingLabel: string;
    ariaLabel: string;
    multilineHint: string;
    header?: Snippet;
    attachments?: Snippet;
    actions?: Snippet;
    tools?: Snippet;
    context?: Snippet;
    feedback?: Snippet;
    onValueChange?: (value: string) => void;
    onKeydown?: (event: KeyboardEvent) => void;
    completion?: Readonly<{
      expanded: boolean;
      listboxId: string;
      activeOptionId?: string;
    }>;
  };

  let {
    id,
    name = "message",
    value = $bindable(""),
    rows = 3,
    required = true,
    placeholder,
    disabled = false,
    submitDisabled = false,
    submitting = false,
    submitLabel,
    submittingLabel,
    ariaLabel,
    multilineHint,
    header,
    attachments,
    actions,
    tools,
    context,
    feedback,
    onValueChange,
    onKeydown,
    completion,
  }: Props = $props();

  let textareaElement = $state<HTMLTextAreaElement | null>(null);

  function resizeTextarea(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, 192);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 192 ? "auto" : "hidden";
  }

  $effect(() => {
    void value;
    if (!textareaElement) return;
    const frame = requestAnimationFrame(() => resizeTextarea(textareaElement));
    return () => cancelAnimationFrame(frame);
  });

  function submitOnEnter(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    const textarea = event.currentTarget as HTMLTextAreaElement;
    const form = textarea.form;
    const submit = form?.querySelector<HTMLButtonElement>("[data-conversation-submit]");
    if (!form || !submit || submit.disabled) return;
    form.requestSubmit(submit);
  }

  function handleKeydown(event: KeyboardEvent) {
    onKeydown?.(event);
    if (event.defaultPrevented) return;
    submitOnEnter(event);
  }

  function handleInput(event: Event) {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    resizeTextarea(textarea);
    onValueChange?.(textarea.value);
  }
</script>

<div class="conversation-composer-shell">
  {#if header}<div class="composer-header">{@render header()}</div>{/if}
  {#if attachments}<div class="composer-attachments">{@render attachments()}</div>{/if}
  <div class="composer-body">
    <label class="sr-only" for={id}>{ariaLabel}</label>
    <textarea
      {id}
      {name}
      {rows}
      {required}
      {placeholder}
      bind:value
      bind:this={textareaElement}
      {disabled}
      role={completion ? "combobox" : undefined}
      aria-autocomplete={completion ? "list" : undefined}
      aria-expanded={completion?.expanded}
      aria-controls={completion?.expanded ? completion.listboxId : undefined}
      aria-activedescendant={completion?.expanded ? completion.activeOptionId : undefined}
      oninput={handleInput}
      onkeydown={handleKeydown}
    ></textarea>
  </div>
  {#if actions}<div class="composer-actions">{@render actions()}</div>{/if}
  {#if feedback}<div class="composer-feedback">{@render feedback()}</div>{/if}
  <footer class="composer-toolbar">
    <div class="composer-context">
      {#if tools}{@render tools()}{/if}
      {#if context}{@render context()}{/if}
      <span class="keyboard-hint">{multilineHint}</span>
    </div>
    <div class="composer-submit-actions">
      <button
        class="composer-submit"
        type="submit"
        data-conversation-submit
        disabled={disabled || submitDisabled}
        aria-label={submitting ? submittingLabel : submitLabel}
        title={submitting ? submittingLabel : submitLabel}
      >
        <Icon name="arrow-up" size={17} stroke={2.2} />
        <span class="submit-label">{submitting ? submittingLabel : submitLabel}</span>
      </button>
    </div>
  </footer>
</div>

<style>
  .conversation-composer-shell {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    box-shadow:
      0 1px 2px rgb(15 23 42 / 5%),
      0 14px 32px rgb(15 23 42 / 7%);
    container-name: conversation-composer;
    container-type: inline-size;
    display: grid;
    gap: 0;
    min-width: 0;
    overflow: visible;
    padding: 0;
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .conversation-composer-shell:focus-within {
    border-color: var(--color-border-strong);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--color-primary) 14%, transparent),
      0 16px 38px rgb(15 23 42 / 9%);
  }

  .composer-header {
    min-width: 0;
    padding: 8px 12px 0;
  }

  .composer-attachments {
    min-width: 0;
    padding: 10px 12px 0;
  }

  .composer-header + .composer-attachments {
    padding-top: 8px;
  }

  .composer-body {
    min-width: 0;
    padding: 10px 12px 8px;
  }

  .composer-header + .composer-body {
    padding-top: 6px;
  }

  .composer-actions {
    min-width: 0;
    padding: 0 10px 10px;
  }

  .composer-actions:empty {
    display: none;
  }

  .composer-feedback {
    display: grid;
    gap: 6px;
    padding: 0 12px 8px;
  }

  textarea {
    background: transparent;
    border: 0;
    color: var(--color-ink);
    field-sizing: content;
    font: inherit;
    line-height: 1.5;
    max-height: 192px;
    min-height: 48px;
    outline: none;
    padding: 2px;
    resize: none;
    width: 100%;
  }

  textarea::placeholder {
    color: var(--color-ink-subtle);
  }

  textarea:focus-visible {
    border-radius: 7px;
    box-shadow: var(--shadow-focus);
  }

  .composer-toolbar {
    align-items: center;
    background: transparent;
    display: grid;
    gap: 8px;
    grid-template-columns: minmax(0, 1fr) auto;
    min-height: 46px;
    min-width: 0;
    padding: 6px 8px 8px;
  }

  .composer-context {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    flex-wrap: nowrap;
    font-size: 11px;
    gap: 8px;
    min-width: 0;
  }

  .keyboard-hint {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-submit-actions {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    gap: 6px;
    min-width: 0;
  }

  .composer-submit {
    align-items: center;
    background: var(--color-primary);
    border: 0;
    aspect-ratio: 1;
    border-radius: 999px;
    color: var(--color-on-primary, #fff);
    cursor: pointer;
    display: inline-flex;
    flex: 0 0 auto;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    gap: 0;
    justify-content: center;
    height: 38px;
    padding: 0;
    width: 38px;
  }

  .composer-submit:hover:not(:disabled) {
    background: var(--color-primary-hover, #1d4ed8);
  }

  .composer-submit:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .composer-submit:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .submit-label {
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

  @container conversation-composer (max-width: 640px) {
    .keyboard-hint {
      display: none;
    }
  }

  @container conversation-composer (max-width: 480px) {
    .composer-context {
      overflow: hidden;
    }

    .composer-submit {
      padding: 0;
    }
  }

  @container conversation-composer (max-width: 360px) {
    .composer-submit {
      width: 38px;
    }
  }

  @media (max-width: 640px) {
    .conversation-composer-shell {
      border-radius: 12px;
    }

    textarea {
      min-height: 60px;
    }

    .keyboard-hint {
      display: none;
    }
  }
</style>
