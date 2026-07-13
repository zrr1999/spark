<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    eyebrow,
    id,
    title,
    description,
    lede,
    statusLabel,
    statusClass,
    badge,
    actions,
  }: {
    eyebrow?: string;
    id?: string;
    title: string;
    description?: string;
    lede?: string;
    statusLabel?: string;
    statusClass?: string;
    badge?: Snippet;
    actions?: Snippet;
  } = $props();

  let body = $derived(description ?? lede);
</script>

<header class="ui-page-header">
  <div>
    {#if eyebrow}
      <p class="ui-kicker">{eyebrow}</p>
    {/if}
    <h1 {id}>{title}</h1>
    {#if body}
      <p class="ui-lede">{body}</p>
    {/if}
  </div>
  {#if statusLabel}
    <span class="status-pill {statusClass ?? ''}">{statusLabel}</span>
  {:else if badge}
    <div class="ui-page-badge">
      {@render badge()}
    </div>
  {/if}
  {#if actions}
    <div class="ui-page-actions">
      {@render actions()}
    </div>
  {/if}
</header>

<style>
  @import "./status-pill.css";

  .ui-page-header {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-md);
    justify-content: space-between;
  }

  .ui-kicker {
    color: var(--color-primary);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    letter-spacing: 0.08em;
    margin: 0 0 var(--spacing-xs);
    text-transform: uppercase;
  }

  h1 {
    font-size: var(--text-page-title);
    font-weight: var(--weight-page-title);
    letter-spacing: var(--tracking-page-title);
    line-height: var(--leading-page-title);
    margin: 0;
  }

  .ui-lede {
    color: var(--color-ink-subtle);
    font-size: var(--text-body);
    line-height: var(--leading-body);
    margin: var(--spacing-xs) 0 0;
    max-width: 72ch;
  }

  .ui-page-badge,
  .ui-page-actions {
    margin-left: auto;
  }
</style>
