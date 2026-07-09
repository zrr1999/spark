<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import type { IconName } from "$lib/icons";

  let {
    label,
    value,
    hint,
    featured = false,
    tone = "default",
    icon,
  }: {
    label: string;
    value: string | number;
    hint?: string;
    featured?: boolean;
    tone?: "default" | "primary" | "info" | "success" | "warning" | "purple" | "accent";
    icon?: IconName;
  } = $props();
</script>

<article class="ui-stat-card" class:featured data-tone={tone}>
  {#if icon}
    <div class="ui-stat-icon" aria-hidden="true">
      <Icon name={icon} size={24} />
    </div>
  {/if}
  <div>
    <span class="ui-stat-label">{label}</span>
    <strong class="ui-stat-value">{value}</strong>
    {#if hint}
      <small class="ui-stat-hint">{hint}</small>
    {/if}
  </div>
</article>

<style>
  .ui-stat-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-xl);
    box-shadow: var(--shadow-card);
    display: flex;
    gap: var(--spacing-md);
    min-width: 0;
    padding: var(--spacing-xl);
  }

  .ui-stat-card.featured {
    border-color: var(--color-warning-soft);
  }

  .ui-stat-card[data-tone="primary"] .ui-stat-icon,
  .ui-stat-card[data-tone="info"] .ui-stat-icon,
  .ui-stat-card[data-tone="accent"] .ui-stat-icon {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .ui-stat-card[data-tone="success"] .ui-stat-icon {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  .ui-stat-card[data-tone="warning"] .ui-stat-icon,
  .ui-stat-card.featured .ui-stat-icon {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .ui-stat-card[data-tone="purple"] .ui-stat-icon {
    background: var(--color-purple-soft);
    color: var(--color-purple);
  }

  .ui-stat-icon {
    align-items: center;
    background: var(--color-surface-soft);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    display: flex;
    flex: 0 0 auto;
    height: 48px;
    justify-content: center;
    width: 48px;
  }

  .ui-stat-label {
    color: var(--color-ink-subtle);
    display: block;
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    margin-bottom: var(--spacing-xs);
  }

  .ui-stat-value {
    color: var(--color-ink);
    display: block;
    font-size: var(--text-page-title);
    font-weight: var(--weight-page-title);
    letter-spacing: var(--tracking-page-title);
    line-height: var(--leading-page-title);
  }

  .ui-stat-hint {
    color: var(--color-ink-subtle);
    display: block;
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
    margin-top: var(--spacing-xxs);
  }
</style>
