<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { getContext } from "svelte";
  import { fieldContextKey, type FieldContext } from "./field-context";

  type Props = Omit<HTMLInputAttributes, "class" | "size" | "value"> & {
    class?: string;
    value?: string | number;
    controlSize?: "compact" | "default";
  };

  let {
    class: className = "",
    value = $bindable(),
    controlSize = "default",
    ...restProps
  }: Props = $props();

  const field = getContext<FieldContext | undefined>(fieldContextKey);
  let describedBy = $derived(restProps["aria-describedby"] ?? field?.describedBy());
  let invalid = $derived(restProps["aria-invalid"] ?? (field?.invalid() ? true : undefined));
</script>

<input
  class="ui-input {className}"
  data-size={controlSize}
  bind:value
  {...restProps}
  aria-describedby={describedBy}
  aria-invalid={invalid}
/>

<style>
  .ui-input {
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    font: inherit;
    min-height: 40px;
    min-width: 0;
    padding: 8px 12px;
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
    width: 100%;
  }

  .ui-input[data-size="compact"] {
    min-height: 32px;
    padding-block: 4px;
  }

  .ui-input::placeholder {
    color: var(--color-ink-disabled);
  }

  .ui-input:focus-visible {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .ui-input:disabled {
    background: var(--color-surface-soft);
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }
</style>
