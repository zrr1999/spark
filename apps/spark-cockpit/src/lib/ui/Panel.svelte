<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    kicker,
    note,
    badge,
    compact = false,
    padded = true,
    class: className = "",
    id,
    ariaLabelledby,
    ariaLabel,
    headerActions,
    children,
  }: {
    title?: string;
    kicker?: string;
    note?: string;
    badge?: string;
    compact?: boolean;
    padded?: boolean;
    class?: string;
    id?: string;
    ariaLabelledby?: string;
    ariaLabel?: string;
    headerActions?: Snippet;
    children: Snippet;
  } = $props();

  let headingId = $derived(id ?? ariaLabelledby);
</script>

<section
  class="ui-panel {className}"
  class:compact
  class:unpadded={!padded}
  aria-labelledby={headingId}
  aria-label={ariaLabel}
>
  {#if title || kicker || badge || headerActions}
    <div class="ui-panel-header" class:compact>
      <div>
        {#if kicker}
          <p class="ui-kicker">{kicker}</p>
        {/if}
        {#if title}
          <h2 id={headingId}>{title}</h2>
        {/if}
        {#if note}
          <p class="ui-panel-note">{note}</p>
        {/if}
      </div>
      <div class="ui-panel-header-end">
        {#if headerActions}
          {@render headerActions()}
        {/if}
        {#if badge}
          <span class="ui-badge">{badge}</span>
        {/if}
      </div>
    </div>
  {/if}
  <div class="ui-panel-body">
    {@render children()}
  </div>
</section>

<style>
  .ui-panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-xl);
    box-shadow: var(--shadow-card);
    display: grid;
    min-width: 0;
  }

  .ui-panel-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
    padding: var(--spacing-xl) var(--spacing-xxl);
  }

  .ui-panel-header.compact {
    padding: var(--spacing-lg) var(--spacing-xl);
  }

  .ui-panel-header-end {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
  }

  .ui-panel-body {
    display: grid;
    gap: var(--spacing-md);
    min-width: 0;
    padding: var(--spacing-lg) var(--spacing-xl) var(--spacing-xl);
  }

  .ui-panel.compact .ui-panel-body {
    padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  }

  .ui-panel.unpadded .ui-panel-body {
    padding: 0;
  }

  .ui-kicker {
    color: var(--color-primary);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    letter-spacing: 0.08em;
    margin: 0 0 var(--spacing-xs);
    text-transform: uppercase;
  }

  h2 {
    font-size: var(--text-section-title);
    font-weight: var(--weight-section-title);
    letter-spacing: var(--tracking-section-title);
    line-height: var(--leading-section-title);
    margin: 0;
  }

  .ui-panel-note {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
    margin: var(--spacing-xs) 0 0;
  }

  .ui-badge {
    background: var(--color-primary-weak);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    padding: 6px 10px;
    white-space: nowrap;
  }
</style>
