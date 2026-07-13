<script lang="ts">
  import Icon from "$lib/Icon.svelte";

  type Props = {
    text: string;
    copyLabel: string;
    copiedLabel: string;
  };

  let { text, copyLabel, copiedLabel }: Props = $props();
  let copied = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyMessage() {
    if (!text.trim() || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => (copied = false), 1_500);
    } catch {
      copied = false;
    }
  }
</script>

<div class="message-actions">
  <button
    type="button"
    aria-label={copied ? copiedLabel : copyLabel}
    title={copied ? copiedLabel : copyLabel}
    disabled={!text.trim()}
    onclick={copyMessage}
  >
    <Icon name={copied ? "check" : "copy"} size={14} stroke={2.1} />
    <span>{copied ? copiedLabel : copyLabel}</span>
  </button>
</div>

<style>
  .message-actions {
    align-items: center;
    display: flex;
    min-height: 32px;
  }

  button {
    align-items: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    gap: 5px;
    min-height: 32px;
    padding: 0 7px;
  }

  button:hover:not(:disabled) {
    background: var(--color-surface-soft);
    border-color: var(--color-border-soft);
    color: var(--color-ink-muted);
  }

  button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  button:disabled {
    cursor: default;
    opacity: 0.45;
  }

  @media (hover: hover) {
    .message-actions {
      opacity: 0;
      transition: opacity 120ms ease;
    }

    :global(.conversation-message:hover) .message-actions,
    :global(.conversation-message:focus-within) .message-actions {
      opacity: 1;
    }
  }
</style>
