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
    /** When true, render without an outer chrome already provided by ThinkingChainPart. */
    nested?: boolean;
  };

  let {
    callId: _callId,
    name,
    state,
    summary,
    labels,
    statusLabel,
    nested = false,
  }: Props = $props();

  let preview = $derived(summary?.trim() ?? "");
  let headline = $derived(preview ? firstLine(preview) : "");

  function firstLine(value: string) {
    const line = value.split(/\r?\n/u).find((entry) => entry.trim());
    if (!line) return "";
    return line.length <= 120 ? line : `${line.slice(0, 117)}…`;
  }
</script>

<details
  class="tool-part {state}"
  class:nested
  open={state === "running" || state === "awaiting-approval" || (nested && Boolean(preview))}
>
  <summary>
    <span class="tool-name"><Icon name="activity" size={14} />{name}</span>
    {#if headline}
      <span class="tool-preview">{headline}</span>
    {/if}
    <span class="tool-state">{statusLabel(state)}</span>
    <span class="disclosure"><Icon name="chevron-down" size={14} /></span>
  </summary>
  <div class="tool-content">
    {#if preview}
      <pre>{preview}</pre>
    {:else}
      <p class="empty">{labels.tool} · {statusLabel(state)}</p>
    {/if}
  </div>
</details>

<style>
  .tool-part {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: 9px;
    overflow: hidden;
  }

  .tool-part.nested {
    background: transparent;
    border-color: var(--color-border-soft);
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

  summary:has(.tool-preview) {
    grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto auto;
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

  .tool-preview {
    color: var(--color-ink-subtle);
    font-family: var(--font-mono, monospace);
    font-size: 11px;
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

  .tool-content pre,
  .tool-content .empty {
    color: var(--color-ink-muted);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .tool-content pre {
    font-family: var(--font-mono, monospace);
    max-height: 320px;
    overflow: auto;
  }

  @media (prefers-reduced-motion: reduce) {
    .disclosure {
      transition: none;
    }
  }
</style>
