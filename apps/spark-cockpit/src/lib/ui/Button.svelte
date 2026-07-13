<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    variant = "primary",
    size = "default",
    type = "button",
    href,
    disabled = false,
    title,
    name,
    value,
    form,
    target,
    rel,
    ariaLabel,
    class: className = "",
    onclick,
    children,
  }: {
    variant?: "primary" | "secondary" | "danger" | "ghost";
    size?: "compact" | "default";
    type?: "button" | "submit";
    href?: string;
    disabled?: boolean;
    title?: string;
    name?: string;
    value?: string;
    form?: string;
    target?: "_blank" | "_self" | "_parent" | "_top";
    rel?: string;
    ariaLabel?: string;
    class?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  } = $props();
</script>

{#if href}
  <a
    class="ui-button {className}"
    data-variant={variant}
    data-size={size}
    {href}
    {title}
    {target}
    {rel}
    aria-label={ariaLabel}
  >
    {@render children()}
  </a>
{:else}
  <button
    class="ui-button {className}"
    data-variant={variant}
    data-size={size}
    {type}
    {disabled}
    {title}
    {name}
    {value}
    {form}
    aria-label={ariaLabel}
    {onclick}
  >
    {@render children()}
  </button>
{/if}

<style>
  .ui-button {
    align-items: center;
    border-radius: var(--rounded-md);
    cursor: pointer;
    display: inline-flex;
    font-family: var(--font-sans);
    font-size: var(--text-button);
    font-weight: var(--weight-button);
    gap: var(--spacing-xs);
    justify-content: center;
    line-height: var(--leading-button);
    min-height: 40px;
    padding: 8px 14px;
    text-decoration: none;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }

  .ui-button[data-size="compact"] {
    font-size: var(--text-caption);
    min-height: 32px;
    padding: 5px 10px;
  }

  .ui-button[data-variant="primary"] {
    background: var(--color-primary);
    border: 0;
    color: var(--color-on-primary);
  }

  .ui-button[data-variant="primary"]:not(:disabled):hover {
    background: var(--color-primary-hover);
  }

  .ui-button[data-variant="secondary"] {
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    color: var(--color-ink-muted);
  }

  .ui-button[data-variant="secondary"]:not(:disabled):hover {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .ui-button[data-variant="danger"] {
    background: var(--color-danger);
    border: 0;
    color: var(--color-on-primary);
  }

  .ui-button[data-variant="danger"]:not(:disabled):hover {
    filter: brightness(0.94);
  }

  .ui-button[data-variant="ghost"] {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
  }

  .ui-button[data-variant="ghost"]:not(:disabled):hover {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  .ui-button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .ui-button:disabled {
    background: var(--color-border);
    border-color: var(--color-border);
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }
</style>
