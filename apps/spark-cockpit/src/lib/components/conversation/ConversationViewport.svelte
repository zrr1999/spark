<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { tick, type Snippet } from "svelte";

  type Props = {
    label: string;
    followKey?: string | number | null;
    announcement?: string;
    jumpToLatestLabel: string;
    children?: Snippet;
    empty?: Snippet;
  };

  let {
    label,
    followKey = null,
    announcement = "",
    jumpToLatestLabel,
    children,
    empty,
  }: Props = $props();

  let viewport: HTMLDivElement | null = $state(null);
  let atBottom = $state(true);
  let initialScrollComplete = false;

  $effect(() => {
    if (followKey === null && initialScrollComplete) return;
    if (!viewport || (!atBottom && initialScrollComplete)) return;
    void tick().then(() => scrollToLatest(initialScrollComplete ? "smooth" : "instant"));
  });

  $effect(() => {
    if (!viewport) return;
    const element = viewport;
    const observer = new ResizeObserver(() => {
      if (atBottom) scrollToLatest("instant");
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  function updateBottomState() {
    if (!viewport) return;
    atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 56;
  }

  function scrollToLatest(behavior: ScrollBehavior = "smooth") {
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    atBottom = true;
    initialScrollComplete = true;
  }
</script>

<section class="conversation-viewport" aria-label={label} role="log" aria-live="off">
  <div
    class="conversation-scroll"
    bind:this={viewport}
    onscroll={updateBottomState}
  >
    {#if children}
      <div class="conversation-content">
        {@render children()}
      </div>
    {:else if empty}
      {@render empty()}
    {/if}
  </div>

  {#if !atBottom}
    <button
      class="jump-latest"
      type="button"
      aria-label={jumpToLatestLabel}
      title={jumpToLatestLabel}
      onclick={() => scrollToLatest()}
    >
      <Icon name="chevron-down" size={16} stroke={2.2} />
      <span>{jumpToLatestLabel}</span>
    </button>
  {/if}

  <p class="live-announcement" aria-live="polite" aria-atomic="true">{announcement}</p>
</section>

<style>
  .conversation-viewport {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }

  .conversation-scroll {
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px max(0px, calc((100% - 800px) / 2)) 20px;
    scrollbar-gutter: stable;
  }

  .conversation-content {
    display: grid;
    gap: 22px;
  }

  .jump-latest {
    align-items: center;
    backdrop-filter: blur(10px);
    background: color-mix(in srgb, var(--color-surface) 88%, transparent);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    bottom: 10px;
    box-shadow: var(--shadow-card, 0 4px 16px rgb(15 23 42 / 12%));
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    gap: 6px;
    left: 50%;
    min-height: 36px;
    padding: 0 12px;
    position: absolute;
    transform: translateX(-50%);
  }

  .jump-latest:hover {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .jump-latest:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .live-announcement {
    border: 0;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  @media (max-width: 960px) {
    .conversation-scroll {
      padding-inline: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .conversation-scroll {
      scroll-behavior: auto;
    }
  }
</style>
