<script lang="ts">
  import type { SlashCommandSuggestion } from "./slash-command";

  type Props = {
    id: string;
    suggestions: readonly SlashCommandSuggestion[];
    activeIndex: number;
    ariaLabel?: string;
    hint?: string;
    onActiveIndexChange?: (index: number) => void;
    onSelect?: (suggestion: SlashCommandSuggestion) => void;
  };

  let {
    id,
    suggestions,
    activeIndex,
    ariaLabel = "Slash commands",
    hint,
    onActiveIndexChange,
    onSelect,
  }: Props = $props();

  let menuElement = $state<HTMLElement | null>(null);

  $effect(() => {
    const option = menuElement?.querySelector<HTMLElement>(`#${optionId(activeIndex)}`);
    option?.scrollIntoView?.({ block: "nearest" });
  });

  function optionId(index: number): string {
    return `${id}-option-${index}`;
  }

  function preserveInputFocus(event: PointerEvent) {
    event.preventDefault();
  }

  function selectSuggestion(suggestion: SlashCommandSuggestion, index: number) {
    onActiveIndexChange?.(index);
    onSelect?.(suggestion);
  }
</script>

{#if suggestions.length > 0}
  <section class="slash-command-surface">
    <div
      class="slash-command-menu"
      {id}
      bind:this={menuElement}
      role="listbox"
      aria-label={ariaLabel}
    >
      {#each suggestions as suggestion, index (suggestion.id)}
        <button
          class="slash-command-option"
          class:active={index === activeIndex}
          id={optionId(index)}
          type="button"
          role="option"
          tabindex="-1"
          aria-selected={index === activeIndex}
          onpointerdown={preserveInputFocus}
          onmouseenter={() => onActiveIndexChange?.(index)}
          onclick={() => selectSuggestion(suggestion, index)}
        >
          <code>/{suggestion.command}</code>
          <span class="slash-command-copy">
            <strong>{suggestion.title}</strong>
            {#if suggestion.description}
              <small>{suggestion.description}</small>
            {/if}
          </span>
        </button>
      {/each}
    </div>
    {#if hint}<p class="slash-command-hint">{hint}</p>{/if}
  </section>
{/if}

<style>
  .slash-command-surface {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    box-shadow: 0 14px 34px rgb(15 23 42 / 14%);
    min-width: 0;
    overflow: hidden;
  }

  .slash-command-menu {
    display: grid;
    gap: 3px;
    max-height: min(20rem, 42vh);
    min-width: 0;
    overflow-y: auto;
    padding: 5px;
  }

  .slash-command-hint {
    border-top: 1px solid var(--color-border-soft);
    color: var(--color-ink-subtle);
    font-size: 10px;
    line-height: 1.35;
    margin: 0;
    padding: 6px 10px;
  }

  .slash-command-option {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--rounded-sm);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: grid;
    font: inherit;
    gap: 10px;
    grid-template-columns: minmax(5.5rem, auto) minmax(0, 1fr);
    min-height: 44px;
    padding: 7px 9px;
    text-align: left;
    width: 100%;
  }

  .slash-command-option:hover,
  .slash-command-option.active {
    background: var(--color-primary-weak);
    color: var(--color-ink);
  }

  .slash-command-option:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  code {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .slash-command-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  strong {
    color: inherit;
    font-size: 12px;
    line-height: 1.25;
  }

  small {
    color: var(--color-ink-subtle);
    font-size: 10px;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
