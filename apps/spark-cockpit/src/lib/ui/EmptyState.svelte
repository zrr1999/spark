<script lang="ts">
  import type { Snippet } from "svelte";

  import Icon from "$lib/Icon.svelte";
  import type { IconName } from "$lib/icons";

  let {
    title,
    body,
    icon,
    compact = false,
    actions,
  }: {
    title: string;
    body?: string;
    icon?: IconName;
    compact?: boolean;
    actions?: Snippet;
  } = $props();
</script>

<div class="ui-empty-state" class:compact>
  {#if icon}
    <div class="ui-empty-icon" aria-hidden="true">
      <Icon name={icon} size={compact ? 20 : 24} />
    </div>
  {/if}
  <h3>{title}</h3>
  {#if body}
    <p>{body}</p>
  {/if}
  {#if actions}
    <div class="ui-empty-actions">
      {@render actions()}
    </div>
  {/if}
</div>

<style>
  .ui-empty-state {
    align-items: center;
    display: grid;
    gap: var(--spacing-sm);
    justify-items: center;
    padding: var(--spacing-xxl);
    text-align: center;
  }

  .ui-empty-state.compact {
    padding: var(--spacing-xl) var(--spacing-lg);
  }

  .ui-empty-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    display: flex;
    height: 56px;
    justify-content: center;
    width: 56px;
  }

  .ui-empty-state.compact .ui-empty-icon {
    height: 44px;
    width: 44px;
  }

  h3 {
    color: var(--color-ink);
    font-size: var(--text-card-title);
    font-weight: var(--weight-card-title);
    margin: 0;
  }

  p {
    color: var(--color-ink-subtle);
    font-size: var(--text-body);
    line-height: var(--leading-body);
    margin: 0;
    max-width: 36ch;
  }

  .ui-empty-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
    justify-content: center;
    margin-top: var(--spacing-xs);
  }
</style>
