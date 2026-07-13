<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import type { ConversationPartLabels, ConversationToolState } from "./types";

  type Props = {
    callId: string;
    name: string;
    state: ConversationToolState;
    summary?: string;
    labels: ConversationPartLabels;
    statusLabel: (status: string) => string;
  };

  let { callId, name, state, summary, labels, statusLabel }: Props = $props();
</script>

<details class="tool-part {state}">
  <summary>
    <span class="tool-name"><Icon name="activity" size={14} />{name}</span>
    <span class="tool-state">{statusLabel(state)}</span>
    <span class="disclosure"><Icon name="chevron-down" size={14} /></span>
  </summary>
  <div class="tool-content">
    {#if summary?.trim()}<p>{summary}</p>{/if}
    <code>{labels.tool} · {callId}</code>
  </div>
</details>

<style>
  .tool-part {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: 9px;
    overflow: hidden;
  }

  .tool-part.running,
  .tool-part.awaiting-approval {
    border-color: var(--color-primary-soft);
  }

  .tool-part.failed {
    border-color: var(--color-danger-soft, var(--color-border));
  }

  summary {
    align-items: center;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: grid;
    font-size: 12px;
    gap: 10px;
    grid-template-columns: minmax(0, 1fr) auto auto;
    list-style: none;
    min-height: 40px;
    padding: 0 10px;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:focus-visible {
    box-shadow: inset var(--shadow-focus);
    outline: none;
  }

  .tool-name {
    align-items: center;
    display: inline-flex;
    font-weight: 650;
    gap: 7px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-state {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 650;
  }

  .disclosure {
    display: inline-flex;
    transition: transform 120ms ease;
  }

  details[open] .disclosure {
    transform: rotate(180deg);
  }

  .tool-content {
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    gap: 6px;
    padding: 10px;
  }

  .tool-content p {
    color: var(--color-ink-muted);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .tool-content code {
    color: var(--color-ink-subtle);
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    overflow-wrap: anywhere;
  }

  @media (prefers-reduced-motion: reduce) {
    .disclosure {
      transition: none;
    }
  }
</style>
