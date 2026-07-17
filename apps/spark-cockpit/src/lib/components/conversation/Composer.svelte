<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import type { Snippet } from "svelte";

  type Props = {
    id: string;
    name?: string;
    value?: string;
    rows?: number;
    placeholder: string;
    disabled?: boolean;
    submitDisabled?: boolean;
    submitting?: boolean;
    submitLabel: string;
    submittingLabel: string;
    ariaLabel: string;
    multilineHint: string;
    header?: Snippet;
    context?: Snippet;
    feedback?: Snippet;
    onValueChange?: (value: string) => void;
  };

  let {
    id,
    name = "message",
    value = $bindable(""),
    rows = 3,
    placeholder,
    disabled = false,
    submitDisabled = false,
    submitting = false,
    submitLabel,
    submittingLabel,
    ariaLabel,
    multilineHint,
    header,
    context,
    feedback,
    onValueChange,
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

  function handleInput(event: Event) {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    resizeTextarea(textarea);
    onValueChange?.(textarea.value);
  }
</script>

<div class="conversation-composer-shell">
  {#if header}<div class="composer-header">{@render header()}</div>{/if}
  <label class="sr-only" for={id}>{ariaLabel}</label>
  <textarea
    {id}
    {name}
    {rows}
    required
    {placeholder}
    bind:value
    bind:this={textareaElement}
    {disabled}
    oninput={handleInput}
    onkeydown={submitOnEnter}
  ></textarea>
  {#if feedback}<div class="composer-feedback">{@render feedback()}</div>{/if}
  <div class="composer-toolbar">
    <div class="composer-context">
      {#if context}{@render context()}{/if}
      <span class="keyboard-hint">{multilineHint}</span>
    </div>
    <button
      class="composer-submit"
      type="submit"
      data-conversation-submit
      disabled={disabled || submitDisabled}
    >
      <Icon name="play" size={15} />
      {submitting ? submittingLabel : submitLabel}
    </button>
  </div>
</div>

<style>
  .conversation-composer-shell {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    box-shadow:
      0 1px 2px rgb(15 23 42 / 5%),
      0 12px 30px rgb(15 23 42 / 7%);
    container-name: conversation-composer;
    container-type: inline-size;
    display: grid;
    gap: 10px;
    min-width: 0;
    padding: 12px;
  }

  .composer-header {
    min-width: 0;
  }

  .composer-feedback {
    display: contents;
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
    padding: 3px;
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
    border-top: 1px solid var(--color-border-soft);
    display: flex;
    flex-wrap: wrap;
    gap: 10px 12px;
    justify-content: space-between;
    min-height: 40px;
    min-width: 0;
    padding-top: 10px;
  }

  .composer-context {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    flex: 1 1 12rem;
    flex-wrap: wrap;
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

  .composer-submit {
    align-items: center;
    background: var(--color-primary);
    border: 0;
    border-radius: var(--rounded-md);
    color: var(--color-on-primary, #fff);
    cursor: pointer;
    display: inline-flex;
    flex: 0 0 auto;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    gap: 6px;
    justify-content: center;
    margin-left: auto;
    min-height: 40px;
    padding: 0 13px;
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
    .composer-toolbar {
      align-items: stretch;
    }

    .composer-context {
      flex: 1 1 100%;
    }

    .composer-submit {
      margin-left: 0;
      width: 100%;
    }
  }

  @media (max-width: 640px) {
    .conversation-composer-shell {
      border-radius: 12px;
      padding: 10px;
    }

    textarea {
      min-height: 60px;
    }

    .keyboard-hint {
      display: none;
    }
  }
</style>
