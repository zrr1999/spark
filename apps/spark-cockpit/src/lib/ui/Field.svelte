<script lang="ts">
  import type { Snippet } from "svelte";
  import { setContext } from "svelte";
  import { fieldContextKey, type FieldContext } from "./field-context";

  let {
    id,
    label,
    hint,
    error,
    required = false,
    compact = false,
    children,
  }: {
    id: string;
    label: string;
    hint?: string;
    error?: string;
    required?: boolean;
    compact?: boolean;
    children: Snippet;
  } = $props();

  setContext<FieldContext>(fieldContextKey, {
    describedBy: () => (error ? `${id}-error` : hint ? `${id}-hint` : undefined),
    invalid: () => Boolean(error),
  });
</script>

<div class="ui-field" class:compact class:error={Boolean(error)}>
  <label for={id}>{label}{#if required}<span aria-hidden="true"> *</span>{/if}</label>
  <div class="ui-field-control">
    {@render children()}
  </div>
  <div class="ui-field-meta">
    {#if error}
      <p id={`${id}-error`} role="alert">{error}</p>
    {:else if hint}
      <p id={`${id}-hint`}>{hint}</p>
    {/if}
  </div>
</div>

<style>
  .ui-field {
    display: grid;
    grid-template-rows: auto auto auto;
    gap: 7px;
    min-width: 0;
  }

  .ui-field.compact {
    gap: var(--spacing-xxs);
  }

  .ui-field-control,
  .ui-field-meta {
    min-width: 0;
  }

  /* Reserve one caption line so sibling fields in a grid stay aligned when only some have hints. */
  .ui-field-meta {
    min-height: calc(var(--leading-caption, 1.35) * 1em);
  }

  label {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
  }

  label span,
  .ui-field.error p {
    color: var(--color-danger-strong);
  }

  p {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
    margin: 0;
  }
</style>
