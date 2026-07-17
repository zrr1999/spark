<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { tick, type Snippet } from "svelte";
  import {
    captureConversationPrependAnchor,
    restoreConversationPrependAnchor,
  } from "./conversation-scroll-anchor";

  const LOAD_EARLIER_THRESHOLD = 96;

  type Props = {
    label: string;
    followKey?: string | number | null;
    announcement?: string;
    jumpToLatestLabel: string;
    hasEarlier?: boolean;
    earlierLabel?: string;
    earlierErrorLabel?: string;
    onLoadEarlier?: () => Promise<boolean>;
    children?: Snippet;
    empty?: Snippet;
  };

  let {
    label,
    followKey = null,
    announcement = "",
    jumpToLatestLabel,
    hasEarlier = false,
    earlierLabel = "",
    earlierErrorLabel = "",
    onLoadEarlier,
    children,
    empty,
  }: Props = $props();

  let viewport: HTMLDivElement | null = $state(null);
  let atBottom = $state(true);
  let loadingEarlier = $state(false);
  let earlierFailed = $state(false);
  let suspendFollow = $state(false);
  let initialScrollComplete = $state(false);

  $effect(() => {
    if (!hasEarlier) earlierFailed = false;
  });

  $effect(() => {
    if (followKey === null && initialScrollComplete) return;
    if (suspendFollow) return;
    if (!viewport || (!atBottom && initialScrollComplete)) return;
    void tick().then(() => scrollToLatest(initialScrollComplete ? "smooth" : "instant"));
  });

  $effect(() => {
    if (!viewport) return;
    const element = viewport;
    const observer = new ResizeObserver(() => {
      if (atBottom && !suspendFollow) scrollToLatest("instant");
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    const element = viewport;
    if (!element || !initialScrollComplete || !hasEarlier) return;
    void tick().then(() => {
      if (viewport === element && element.scrollTop <= LOAD_EARLIER_THRESHOLD) {
        void loadEarlier();
      }
    });
  });

  function updateScrollState() {
    if (!viewport) return;
    atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 56;
    if (initialScrollComplete && viewport.scrollTop <= LOAD_EARLIER_THRESHOLD) {
      void loadEarlier();
    }
  }

  async function loadEarlier(force = false) {
    const element = viewport;
    if (!element || !hasEarlier || !onLoadEarlier || loadingEarlier) return;
    if (!force && element.scrollTop > LOAD_EARLIER_THRESHOLD) return;

    const anchor = captureConversationPrependAnchor(element);
    let continueFillingViewport = false;
    loadingEarlier = true;
    earlierFailed = false;
    suspendFollow = true;
    try {
      const loaded = await onLoadEarlier();
      await tick();
      if (viewport !== element) return;
      if (loaded) {
        restoreConversationPrependAnchor(element, anchor);
        continueFillingViewport =
          hasEarlier && element.scrollHeight <= element.clientHeight + LOAD_EARLIER_THRESHOLD;
      } else {
        earlierFailed = true;
      }
    } catch {
      earlierFailed = true;
    } finally {
      if (viewport === element) {
        atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 56;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      suspendFollow = false;
      loadingEarlier = false;
      if (continueFillingViewport && viewport === element) {
        requestAnimationFrame(() => void loadEarlier());
      }
    }
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
    onscroll={updateScrollState}
    onwheel={(event) => event.deltaY < 0 && updateScrollState()}
  >
    {#if children}
      <div class="conversation-content">
        {#if hasEarlier && onLoadEarlier}
          <div
            class="history-fallback"
            class:failed={earlierFailed}
            aria-busy={loadingEarlier}
          >
            <button
              type="button"
              disabled={loadingEarlier}
              onclick={() => void loadEarlier(true)}
            >
              {earlierLabel}
            </button>
            {#if earlierFailed && earlierErrorLabel}
              <p role="alert">{earlierErrorLabel}</p>
            {/if}
          </div>
        {/if}
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
    padding: 8px max(var(--spacing-sm), calc((100% - 800px) / 2)) 20px;
    scrollbar-gutter: stable;
  }

  .conversation-content {
    display: grid;
    gap: 22px;
  }

  .history-fallback {
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

  .history-fallback.failed,
  .history-fallback:focus-within {
    align-items: center;
    clip: auto;
    clip-path: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    height: auto;
    justify-self: center;
    margin: 0;
    overflow: visible;
    position: static;
    white-space: normal;
    width: auto;
  }

  .history-fallback button {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    min-height: 36px;
    padding: 0 14px;
  }

  .history-fallback button:hover {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .history-fallback button:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  .history-fallback button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .history-fallback p {
    color: var(--color-danger);
    font-size: 12px;
    margin: 0;
    text-align: center;
  }

  .jump-latest {
    align-items: center;
    backdrop-filter: blur(10px);
    background: color-mix(in srgb, var(--color-surface) 88%, transparent);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-full);
    bottom: 10px;
    box-shadow: var(--shadow-card, 0 4px 16px rgb(15 23 42 / 12%));
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    gap: 6px;
    left: 50%;
    min-height: 40px;
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
      padding-inline: var(--spacing-sm);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .conversation-scroll {
      scroll-behavior: auto;
    }
  }
</style>
