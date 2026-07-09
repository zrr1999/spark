<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    variant = "primary",
    type = "button",
    href,
    disabled = false,
    title,
    onclick,
    children,
  }: {
    variant?: "primary" | "secondary" | "danger" | "ghost";
    type?: "button" | "submit";
    href?: string;
    disabled?: boolean;
    title?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  } = $props();
</script>

{#if href}
  <a class="ui-button" data-variant={variant} {href} {title}>
    {@render children()}
  </a>
{:else}
  <button class="ui-button" data-variant={variant} {type} {disabled} {title} {onclick}>
    {@render children()}
  </button>
{/if}

<style>
  .ui-button {
    align-items: center;
    border-radius: var(--rounded-md);
    display: inline-flex;
    font-family: var(--font-sans);
    font-size: var(--text-button);
    font-weight: var(--weight-button);
    gap: var(--spacing-xs);
    justify-content: center;
    line-height: var(--leading-button);
    min-height: 38px;
    padding: 8px 14px;
    text-decoration: none;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
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
    border: 1px solid var(--color-border);
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

  .ui-button[data-variant="ghost"] {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
  }

  .ui-button:disabled {
    background: var(--color-border);
    border-color: var(--color-border);
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }
</style>
