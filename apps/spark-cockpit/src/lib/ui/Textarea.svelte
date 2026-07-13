<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { getContext } from "svelte";
  import { fieldContextKey, type FieldContext } from "./field-context";

  type Props = Omit<HTMLTextareaAttributes, "class" | "value"> & {
    class?: string;
    value?: string;
  };

  let { class: className = "", value = $bindable(""), ...restProps }: Props = $props();

  const field = getContext<FieldContext | undefined>(fieldContextKey);
  let describedBy = $derived(restProps["aria-describedby"] ?? field?.describedBy());
  let invalid = $derived(restProps["aria-invalid"] ?? (field?.invalid() ? true : undefined));
</script>

<textarea
  class="ui-textarea {className}"
  bind:value
  {...restProps}
  aria-describedby={describedBy}
  aria-invalid={invalid}
></textarea>

<style>
  .ui-textarea {
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    font: inherit;
    line-height: var(--leading-body);
    min-height: 104px;
    min-width: 0;
    padding: 10px 12px;
    resize: vertical;
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
    width: 100%;
  }

  .ui-textarea::placeholder {
    color: var(--color-ink-disabled);
  }

  .ui-textarea:focus-visible {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .ui-textarea:disabled {
    background: var(--color-surface-soft);
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }
</style>
