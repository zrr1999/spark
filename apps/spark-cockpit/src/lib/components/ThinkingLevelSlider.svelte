<script module lang="ts">
  export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
  export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
</script>

<script lang="ts">
  import { Popover, Slider } from "bits-ui";

  type Props = {
    value?: string;
    name?: string;
    label?: string;
    disabled?: boolean;
    compact?: boolean;
    form?: string;
    onValueCommit?: (value: ThinkingLevel) => void;
  };

  let {
    value = $bindable("medium"),
    name = "thinkingLevel",
    label,
    disabled = false,
    compact = false,
    form,
    onValueCommit,
  }: Props = $props();

  let open = $state(false);
  let index = $derived(levelIndex(value));

  function levelIndex(level: string) {
    const found = THINKING_LEVELS.indexOf(level as ThinkingLevel);
    return found >= 0 ? found : THINKING_LEVELS.indexOf("medium");
  }

  function levelAt(next: number): ThinkingLevel {
    return THINKING_LEVELS[next] ?? "medium";
  }

  function commitIndex(next: number) {
    const level = levelAt(next);
    value = level;
    onValueCommit?.(level);
  }
</script>

<div class="thinking-slider" class:compact class:disabled>
  <Popover.Root bind:open>
    <Popover.Trigger
      class="thinking-trigger"
      type="button"
      {disabled}
      aria-label={label ?? name}
      title={`${label ?? name}: ${value}`}
    >
      <span class="thinking-label">{label ?? value}</span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        class="thinking-popover-panel"
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
      >
        <div class="thinking-popover-body">
          <div class="thinking-popover-header">
            {#if label}
              <span class="thinking-popover-label">{label}</span>
            {/if}
            <span class="thinking-popover-value">{value}</span>
          </div>
          <div class="thinking-control">
            <Slider.Root
              type="single"
              class="thinking-track"
              min={0}
              max={THINKING_LEVELS.length - 1}
              step={1}
              value={index}
              {disabled}
              aria-label={label ?? name}
              onValueChange={(next) => {
                value = levelAt(next);
              }}
              onValueCommit={commitIndex}
            >
              {#snippet children({ tickItems, thumbItems })}
                <span class="thinking-range-track" aria-hidden="true"></span>
                <Slider.Range class="thinking-range" />
                {#each tickItems as tick (tick.index)}
                  <Slider.Tick class="thinking-tick" index={tick.index} />
                {/each}
                {#each thumbItems as thumb (thumb.index)}
                  <Slider.Thumb
                    class="thinking-thumb"
                    index={thumb.index}
                    aria-valuetext={value}
                  />
                {/each}
              {/snippet}
            </Slider.Root>
          </div>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
  <input type="hidden" {name} {value} {form} {disabled} />
</div>

<style>
  .thinking-slider {
    align-items: center;
    display: inline-flex;
    flex: 0 0 auto;
    min-width: 0;
  }

  .thinking-slider.disabled {
    opacity: 0.62;
  }

  .thinking-slider :global(.thinking-trigger) {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    cursor: pointer;
    display: inline-flex;
    gap: 8px;
    min-height: 34px;
    padding: 0 10px;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }

  .thinking-slider.compact :global(.thinking-trigger) {
    min-height: 30px;
    padding: 0 8px;
  }

  .thinking-slider :global(.thinking-trigger:hover:not(:disabled)) {
    background: var(--color-surface-soft);
    border-color: var(--color-border-strong, var(--color-border));
  }

  .thinking-slider :global(.thinking-trigger:focus-visible) {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .thinking-slider :global(.thinking-trigger:disabled) {
    cursor: not-allowed;
  }

  .thinking-label {
    color: var(--color-ink);
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 650;
  }

  /* Portal content is outside the component tree — keep these global. */
  :global(.thinking-popover-panel) {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    box-shadow: var(--shadow-md, 0 8px 24px rgb(0 0 0 / 12%));
    outline: none;
    padding: 10px 12px;
    z-index: 40;
  }

  :global(.thinking-popover-panel .thinking-popover-body) {
    display: grid;
    gap: 8px;
    min-width: 180px;
  }

  :global(.thinking-popover-panel .thinking-popover-header) {
    align-items: baseline;
    display: flex;
    gap: 12px;
    justify-content: space-between;
    min-width: 0;
  }

  :global(.thinking-popover-panel .thinking-popover-label) {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 650;
  }

  :global(.thinking-popover-panel .thinking-control) {
    display: block;
    min-width: 160px;
  }

  :global(.thinking-popover-panel .thinking-popover-value) {
    color: var(--color-ink);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    font-weight: 650;
    margin-left: auto;
    min-width: 4.5ch;
    text-align: right;
  }

  :global(.thinking-popover-panel .thinking-track) {
    align-items: center;
    display: flex;
    height: 18px;
    position: relative;
    touch-action: none;
    user-select: none;
    width: 100%;
  }

  :global(.thinking-popover-panel .thinking-range-track) {
    background: var(--color-border-soft);
    border-radius: 999px;
    height: 3px;
    left: 0;
    position: absolute;
    right: 0;
  }

  :global(.thinking-popover-panel .thinking-range) {
    background: var(--color-primary);
    border-radius: 999px;
    height: 3px;
    position: absolute;
  }

  :global(.thinking-popover-panel .thinking-tick) {
    background: var(--color-ink-subtle);
    border-radius: 999px;
    height: 5px;
    opacity: 0.55;
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 1px;
  }

  :global(.thinking-popover-panel .thinking-thumb) {
    background: var(--color-surface);
    border: 2px solid var(--color-primary);
    border-radius: 999px;
    box-shadow: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 8%));
    cursor: grab;
    display: block;
    height: 14px;
    outline: none;
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 14px;
  }

  :global(.thinking-popover-panel .thinking-thumb:focus-visible) {
    box-shadow: var(--shadow-focus);
  }

  :global(.thinking-popover-panel .thinking-thumb[data-dragging]) {
    cursor: grabbing;
  }
</style>
