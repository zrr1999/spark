<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { tick, type Snippet } from "svelte";
  import ConversationTurnRail, {
    type ConversationTurnRailItem,
  } from "./ConversationTurnRail.svelte";
  import {
    captureConversationPrependAnchor,
    restoreConversationPrependAnchor,
  } from "./conversation-scroll-anchor";

  const LOAD_EARLIER_THRESHOLD = 96;
  const MIN_TURN_RAIL_ITEMS = 6;
  const TURN_RAIL_INSET = 12;
  const TURN_RAIL_MARKER_GAP = 10;

  type Props = {
    label: string;
    followKey?: string | number | null;
    announcement?: string;
    jumpToLatestLabel: string;
    hasEarlier?: boolean;
    earlierLabel?: string;
    earlierErrorLabel?: string;
    onLoadEarlier?: () => Promise<boolean>;
    navigationItems?: readonly ConversationTurnRailItem[];
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
    navigationItems = [],
    children,
    empty,
  }: Props = $props();

  let viewport: HTMLDivElement | null = $state(null);
  let content: HTMLDivElement | null = $state(null);
  let atBottom = $state(true);
  let loadingEarlier = $state(false);
  let earlierFailed = $state(false);
  let suspendFollow = $state(false);
  let initialScrollComplete = $state(false);
  let followAnimationFrame: number | undefined;
  let navigationAnimationFrame: number | undefined;
  let navigationPositions = $state<Record<string, number>>({});
  let activeNavigationId = $state("");
  let showNavigationRail = $derived(navigationItems.length >= MIN_TURN_RAIL_ITEMS);

  $effect(() => {
    if (!hasEarlier) earlierFailed = false;
  });

  $effect(() => {
    if (followKey === null && initialScrollComplete) return;
    if (suspendFollow) return;
    if (!viewport || (!atBottom && initialScrollComplete)) return;
    void tick().then(scheduleScrollToLatest);
  });

  $effect(() => {
    if (!viewport) return;
    const element = viewport;
    const contentElement = content;
    const observer = new ResizeObserver(() => {
      if (atBottom && !suspendFollow) scheduleScrollToLatest();
      scheduleNavigationUpdate();
    });
    observer.observe(element);
    if (contentElement) observer.observe(contentElement);
    return () => {
      observer.disconnect();
      cancelScheduledFollow();
      cancelScheduledNavigationUpdate();
    };
  });

  $effect(() => {
    const items = navigationItems;
    if (!viewport || !content || items.length < MIN_TURN_RAIL_ITEMS) {
      navigationPositions = {};
      activeNavigationId = "";
      return;
    }
    void tick().then(scheduleNavigationUpdate);
  });

  $effect(() => {
    const element = viewport;
    if (!element || !initialScrollComplete || !hasEarlier || earlierFailed) return;
    void tick().then(() => {
      if (viewport === element && element.scrollTop <= LOAD_EARLIER_THRESHOLD) {
        void loadEarlier();
      }
    });
  });

  function updateScrollState() {
    if (!viewport) return;
    atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 56;
    scheduleNavigationUpdate();
    if (
      initialScrollComplete &&
      !earlierFailed &&
      viewport.scrollTop <= LOAD_EARLIER_THRESHOLD
    ) {
      void loadEarlier();
    }
  }

  async function loadEarlier(force = false) {
    const element = viewport;
    if (!element || !hasEarlier || !onLoadEarlier || loadingEarlier) return;
    if (!force && earlierFailed) return;
    if (!force && element.scrollTop > LOAD_EARLIER_THRESHOLD) return;

    const anchor = captureConversationPrependAnchor(element);
    let continueFillingViewport = false;
    loadingEarlier = true;
    earlierFailed = false;
    suspendFollow = true;
    cancelScheduledFollow();
    try {
      const loaded = await onLoadEarlier();
      await tick();
      if (viewport !== element) return;
      if (loaded) {
        restoreConversationPrependAnchor(element, anchor);
        scheduleNavigationUpdate();
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

  function scheduleScrollToLatest() {
    const element = viewport;
    if (
      !element ||
      suspendFollow ||
      (!atBottom && initialScrollComplete) ||
      followAnimationFrame !== undefined
    ) {
      return;
    }
    followAnimationFrame = requestAnimationFrame(() => {
      followAnimationFrame = undefined;
      if (
        viewport !== element ||
        suspendFollow ||
        (!atBottom && initialScrollComplete)
      ) {
        return;
      }
      scrollToLatest("auto");
    });
  }

  function cancelScheduledFollow() {
    if (followAnimationFrame === undefined) return;
    cancelAnimationFrame(followAnimationFrame);
    followAnimationFrame = undefined;
  }

  function scheduleNavigationUpdate() {
    if (navigationAnimationFrame !== undefined) return;
    navigationAnimationFrame = requestAnimationFrame(() => {
      navigationAnimationFrame = undefined;
      updateNavigationState();
    });
  }

  function cancelScheduledNavigationUpdate() {
    if (navigationAnimationFrame === undefined) return;
    cancelAnimationFrame(navigationAnimationFrame);
    navigationAnimationFrame = undefined;
  }

  function updateNavigationState() {
    const element = viewport;
    if (!element || !showNavigationRail) return;

    const messageElements = new Map(
      [...element.querySelectorAll<HTMLElement>("[data-message-id]")].flatMap((node) =>
        node.dataset.messageId ? [[node.dataset.messageId, node] as const] : [],
      ),
    );
    const measuredItems = navigationItems.flatMap((item) => {
      const target = messageElements.get(item.id);
      return target ? [{ id: item.id, top: target.offsetTop }] : [];
    });
    if (measuredItems.length === 0) return;

    const railHeight = Math.max(1, element.clientHeight - TURN_RAIL_INSET * 2);
    const markerSpan = Math.min(
      Math.max(0, railHeight - 2),
      (measuredItems.length - 1) * TURN_RAIL_MARKER_GAP,
    );
    const markerStart = (railHeight - markerSpan) / 2;
    const markerStep = measuredItems.length > 1 ? markerSpan / (measuredItems.length - 1) : 0;
    navigationPositions = Object.fromEntries(
      measuredItems.map((item, index) => [
        item.id,
        ((markerStart + index * markerStep) / railHeight) * 100,
      ]),
    );

    const focusLine = element.scrollTop + Math.min(160, element.clientHeight * 0.3);
    let activeId = measuredItems[0]?.id ?? "";
    for (const item of measuredItems) {
      if (item.top > focusLine) break;
      activeId = item.id;
    }
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 56) {
      activeId = measuredItems.at(-1)?.id ?? activeId;
    }
    activeNavigationId = activeId;
  }

  function scrollToNavigationItem(id: string) {
    const element = viewport;
    if (!element) return;
    const target = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (node) => node.dataset.messageId === id,
    );
    if (!target) return;

    activeNavigationId = id;
    initialScrollComplete = true;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
    element.scrollTo({ top: Math.max(0, target.offsetTop - 18), behavior });
  }

  function scrollToLatest(behavior: ScrollBehavior = "smooth") {
    if (!viewport) return;
    cancelScheduledFollow();
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    atBottom = true;
    initialScrollComplete = true;
    scheduleNavigationUpdate();
  }
</script>

<section class="conversation-viewport" aria-label={label} role="log" aria-live="off">
  <div
    class="conversation-scroll"
    class:with-navigation={showNavigationRail}
    bind:this={viewport}
    onscroll={updateScrollState}
    onwheel={(event) => event.deltaY < 0 && updateScrollState()}
  >
    {#if children}
      <div class="conversation-content" bind:this={content}>
        {#if earlierFailed && hasEarlier && onLoadEarlier}
          <div
            class="history-fallback"
            aria-busy={loadingEarlier}
          >
            <button
              type="button"
              disabled={loadingEarlier}
              onclick={() => void loadEarlier(true)}
            >
              {earlierLabel}
            </button>
            {#if earlierErrorLabel}
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

  {#if showNavigationRail}
    <ConversationTurnRail
      label={label}
      items={navigationItems}
      positions={navigationPositions}
      activeId={activeNavigationId}
      onNavigate={scrollToNavigationItem}
    />
  {/if}

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
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 6px;
    justify-self: center;
    margin: 0;
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

  @media (min-width: 721px) and (max-width: 960px) {
    .conversation-scroll.with-navigation {
      padding-left: calc(var(--spacing-sm) + 22px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .conversation-scroll {
      scroll-behavior: auto;
    }
  }
</style>
