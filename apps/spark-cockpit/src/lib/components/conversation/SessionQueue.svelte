<script lang="ts">
  import type { SessionQueueProps } from "./index";

  let {
    items,
    labels,
    hasRunningTurn,
    defaultOpen = true,
    actions,
  }: SessionQueueProps = $props();
</script>

{#if items.length > 0}
  <section class="session-queue" aria-label={labels.region} data-session-queue>
    {#if items.length === 1}
      {#each items as item (item.id)}
        <div class="single-queue-item">
          <span class="single-queue-label">
            {hasRunningTurn ? labels.next : labels.queued}
          </span>
          <div class="single-queue-copy">
            <span class="queue-item-content" title={item.text}>{item.text}</span>
            {#if item.description?.trim()}
              <span class="queue-item-description">{item.description.trim()}</span>
            {/if}
          </div>
          {#if actions}
            <span class="queue-item-actions">{@render actions(item)}</span>
          {/if}
        </div>
      {/each}
    {:else}
      <details open={defaultOpen}>
        <summary>
          <span class="disclosure" aria-hidden="true"></span>
          <span class="queue-heading">
            <span class="queue-count">{items.length}</span>
            {labels.queued}
          </span>
        </summary>

        <!-- svelte-ignore a11y_no_noninteractive_tabindex (the bounded scroll region needs keyboard focus) -->
        <div
          class="queue-scroll"
          role="region"
          aria-label={`${items.length} ${labels.queued}`}
          tabindex="0"
        >
          <ul>
            {#each items as item (item.id)}
              <li class="queue-item">
                <div class="queue-item-row">
                  <span class="queue-item-indicator" aria-hidden="true"></span>
                  <span class="queue-item-content" title={item.text}>{item.text}</span>
                  {#if actions}
                    <span class="queue-item-actions">{@render actions(item)}</span>
                  {/if}
                </div>
                {#if item.description?.trim()}
                  <span class="queue-item-description">{item.description.trim()}</span>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      </details>
    {/if}
  </section>
{/if}

<style>
  .session-queue {
    background: color-mix(in srgb, var(--color-surface-soft) 78%, transparent);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    min-width: 0;
    overflow: hidden;
  }

  details,
  summary,
  ul {
    margin: 0;
    padding: 0;
  }

  summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-size: 12px;
    font-weight: 650;
    gap: 8px;
    list-style: none;
    min-height: 34px;
    padding: 0 10px;
    user-select: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:hover {
    background: color-mix(in srgb, var(--color-surface-hover) 65%, transparent);
  }

  summary:focus-visible,
  .queue-scroll:focus-visible {
    box-shadow: inset var(--shadow-focus);
    outline: none;
  }

  .disclosure {
    border-bottom: 1.5px solid currentColor;
    border-right: 1.5px solid currentColor;
    display: inline-block;
    height: 7px;
    transform: rotate(45deg) translateY(-1px);
    transform-origin: center;
    transition: transform 140ms ease;
    width: 7px;
  }

  details:not([open]) .disclosure {
    transform: rotate(-45deg) translate(1px, 1px);
  }

  .queue-heading {
    align-items: baseline;
    display: inline-flex;
    gap: 4px;
  }

  .queue-count {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }

  .single-queue-item {
    align-items: flex-start;
    display: flex;
    gap: 8px;
    min-width: 0;
    padding: 8px 10px;
  }

  .single-queue-label {
    color: var(--color-ink);
    flex: 0 0 auto;
    font-size: 12px;
    font-weight: 650;
    line-height: 1.45;
    white-space: nowrap;
  }

  .single-queue-copy {
    display: grid;
    flex: 1 1 auto;
    min-width: 0;
  }

  .single-queue-item .queue-item-description {
    margin-left: 0;
  }

  .single-queue-item .queue-item-actions {
    opacity: 1;
  }

  .queue-scroll {
    border-top: 1px solid var(--color-border-soft);
    max-height: 10rem;
    overscroll-behavior: contain;
    overflow-y: auto;
    padding: 5px;
    scrollbar-gutter: stable;
  }

  ul {
    display: grid;
    gap: 2px;
    list-style: none;
  }

  .queue-item {
    border-radius: var(--rounded-sm);
    min-width: 0;
    padding: 6px 7px;
  }

  .queue-item:hover,
  .queue-item:focus-within {
    background: color-mix(in srgb, var(--color-surface-hover) 72%, transparent);
  }

  .queue-item-row {
    align-items: flex-start;
    display: flex;
    gap: 8px;
    min-width: 0;
  }

  .queue-item-indicator {
    border: 1px solid var(--color-ink-subtle);
    border-radius: 999px;
    flex: 0 0 auto;
    height: 8px;
    margin-top: 5px;
    width: 8px;
  }

  .queue-item-content {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    display: -webkit-box;
    flex: 1 1 auto;
    font-size: 12px;
    line-height: 1.45;
    min-width: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    line-clamp: 2;
    white-space: pre-wrap;
  }

  .queue-item-description {
    color: var(--color-ink-subtle);
    display: block;
    font-size: 11px;
    line-height: 1.4;
    margin: 3px 0 0 16px;
    overflow-wrap: anywhere;
  }

  .queue-item-actions {
    align-items: center;
    display: inline-flex;
    flex: 0 0 auto;
    gap: 4px;
    opacity: 0;
    transition: opacity 140ms ease;
  }

  .queue-item:hover .queue-item-actions,
  .queue-item:focus-within .queue-item-actions {
    opacity: 1;
  }

  @media (hover: none) {
    .queue-item-actions {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .disclosure,
    .queue-item-actions {
      transition: none;
    }
  }
</style>
