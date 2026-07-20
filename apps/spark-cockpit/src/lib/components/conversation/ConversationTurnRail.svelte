<script lang="ts">
  export type ConversationTurnRailItem = Readonly<{
    id: string;
    label: string;
    summary: string;
    meta: string;
    actor: "user" | "session";
  }>;

  type Props = {
    label: string;
    items: readonly ConversationTurnRailItem[];
    positions?: Readonly<Record<string, number>>;
    activeId?: string;
    onNavigate?: (id: string) => void;
  };

  let {
    label,
    items,
    positions = {},
    activeId = "",
    onNavigate,
  }: Props = $props();

  function fallbackPosition(index: number) {
    if (items.length <= 1) return 50;
    return (index / (items.length - 1)) * 100;
  }

  function markerPosition(item: ConversationTurnRailItem, index: number) {
    return positions[item.id] ?? fallbackPosition(index);
  }

  function markerLabel(item: ConversationTurnRailItem) {
    return item.summary ? `${item.label}: ${item.summary}` : item.label;
  }
</script>

<nav class="turn-rail" aria-label={label} data-testid="conversation-turn-rail">
  {#each items as item, index (item.id)}
    <button
      class="turn-marker {item.actor}"
      class:active={item.id === activeId}
      type="button"
      style={`--turn-position: ${markerPosition(item, index)}%`}
      aria-label={markerLabel(item)}
      aria-current={item.id === activeId ? "location" : undefined}
      onclick={() => onNavigate?.(item.id)}
    >
      <span class="turn-tick" aria-hidden="true"></span>
      <span class="turn-preview" aria-hidden="true">
        <span class="turn-preview-meta">
          <strong>{item.label}</strong>
          <small>{item.meta}</small>
        </span>
        <span class="turn-preview-summary">{item.summary}</span>
      </span>
    </button>
  {/each}
</nav>

<style>
  .turn-rail {
    bottom: 12px;
    left: 0;
    pointer-events: none;
    position: absolute;
    top: 12px;
    width: 22px;
    z-index: 4;
  }

  .turn-marker {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: flex;
    height: 12px;
    justify-content: flex-start;
    left: 0;
    overflow: visible;
    padding: 0;
    pointer-events: auto;
    position: absolute;
    top: clamp(0.5%, var(--turn-position), 99.5%);
    transform: translateY(-50%);
    width: 22px;
  }

  .turn-tick {
    background: color-mix(in srgb, var(--color-ink-subtle) 38%, transparent);
    border-radius: 999px;
    display: block;
    height: 1px;
    margin-left: 6px;
    transition:
      background 120ms ease,
      height 120ms ease,
      margin 120ms ease,
      width 120ms ease;
    width: 6px;
  }

  .turn-marker:hover .turn-tick,
  .turn-marker:focus-visible .turn-tick {
    background: var(--color-primary);
    margin-left: 3px;
    width: 11px;
  }

  .turn-marker.active .turn-tick {
    background: var(--color-ink);
    height: 2px;
    margin-left: 0;
    width: 22px;
  }

  .turn-marker:focus-visible {
    border-radius: 4px;
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .turn-preview {
    background: color-mix(in srgb, var(--color-surface) 94%, transparent);
    border: 1px solid var(--color-border);
    border-radius: 9px;
    box-shadow: var(--shadow-card, 0 6px 20px rgb(15 23 42 / 14%));
    display: none;
    gap: 4px;
    left: 27px;
    max-width: min(300px, calc(100vw - 88px));
    padding: 8px 10px;
    position: absolute;
    text-align: left;
    top: 50%;
    transform: translateY(-50%);
    width: max-content;
  }

  .turn-marker:hover .turn-preview,
  .turn-marker:focus-visible .turn-preview {
    display: grid;
  }

  .turn-preview-meta {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }

  .turn-preview-meta strong {
    color: var(--color-ink);
    font-size: 11px;
    font-weight: 700;
  }

  .turn-preview-meta small {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 500;
  }

  .turn-preview-summary {
    color: var(--color-ink-muted);
    display: -webkit-box;
    font-size: 11px;
    line-height: 1.45;
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  @media (max-width: 720px) {
    .turn-rail {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .turn-tick {
      transition: none;
    }
  }
</style>
