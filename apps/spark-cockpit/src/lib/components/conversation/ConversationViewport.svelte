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
  import type { LoadEarlierOutcome } from "./types";

  const LOAD_EARLIER_THRESHOLD = 96;
  const MIN_TURN_RAIL_ITEMS = 6;
  const TURN_RAIL_INSET = 12;
  const TURN_RAIL_MARKER_GAP = 10;
  /** Soft cooldown after a transient miss (busy / race) before scroll retries. */
  const EARLIER_RETRY_COOLDOWN_MS = 800;
  /** Longer cooldown after a hard fetch failure. */
  const EARLIER_ERROR_COOLDOWN_MS = 2_000;

  type Props = {
    label: string;
    followKey?: string | number | null;
    announcement?: string;
    jumpToLatestLabel: string;
    hasEarlier?: boolean;
    onLoadEarlier?: () => Promise<LoadEarlierOutcome>;
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
    onLoadEarlier,
    navigationItems = [],
    children,
    empty,
  }: Props = $props();

  let viewport: HTMLDivElement | null = $state(null);
  let content: HTMLDivElement | null = $state(null);
  let atBottom = $state(true);
  let loadingEarlier = $state(false);
  let retryAfterMs = $state(0);
  let suspendFollow = $state(false);
  let initialScrollComplete = $state(false);
  let followAnimationFrame: number | undefined;
  let navigationAnimationFrame: number | undefined;
  let navigationPositions = $state<Record<string, number>>({});
  let activeNavigationId = $state("");
  let viewportWidth = $state(Number.POSITIVE_INFINITY);
  let showNavigationRail = $derived(
    viewportWidth > 520 && navigationItems.length >= MIN_TURN_RAIL_ITEMS,
  );

  $effect(() => {
    if (!hasEarlier) retryAfterMs = 0;
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
    viewportWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      viewportWidth = element.clientWidth;
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
    scheduleNavigationUpdate();
    if (initialScrollComplete && viewport.scrollTop <= LOAD_EARLIER_THRESHOLD) {
      void loadEarlier();
    }
  }

  async function loadEarlier() {
    const element = viewport;
    if (!element || !hasEarlier || !onLoadEarlier || loadingEarlier) return;
    if (Date.now() < retryAfterMs) return;
    if (element.scrollTop > LOAD_EARLIER_THRESHOLD) return;

    const anchor = captureConversationPrependAnchor(element);
    let continueFillingViewport = false;
    loadingEarlier = true;
    suspendFollow = true;
    cancelScheduledFollow();
    try {
      const outcome = await onLoadEarlier();
      await tick();
      if (viewport !== element) return;
      switch (outcome) {
        case "loaded":
          restoreConversationPrependAnchor(element, anchor);
          scheduleNavigationUpdate();
          retryAfterMs = 0;
          continueFillingViewport =
            hasEarlier && element.scrollHeight <= element.clientHeight + LOAD_EARLIER_THRESHOLD;
          break;
        case "busy":
          retryAfterMs = Date.now() + EARLIER_RETRY_COOLDOWN_MS;
          break;
        case "exhausted":
          retryAfterMs = 0;
          break;
        case "error":
          retryAfterMs = Date.now() + EARLIER_ERROR_COOLDOWN_MS;
          break;
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
          retryAfterMs = Date.now() + EARLIER_ERROR_COOLDOWN_MS;
          break;
        }
      }
    } catch {
      retryAfterMs = Date.now() + EARLIER_ERROR_COOLDOWN_MS;
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
      <div class="conversation-content" bind:this={content} aria-busy={loadingEarlier}>
        {#if loadingEarlier && hasEarlier}
          <div class="history-loading" aria-hidden="true"></div>
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

  .conversation-scroll.with-navigation {
    padding-left: max(calc(var(--spacing-sm) + 30px), calc((100% - 800px) / 2 + 30px));
  }

  .conversation-content {
    display: grid;
    gap: 22px;
  }

  .history-loading {
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--color-border-soft) 80%, transparent),
      transparent
    );
    border-radius: 999px;
    height: 2px;
    justify-self: stretch;
    margin: 0 0 4px;
    opacity: 0.7;
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
