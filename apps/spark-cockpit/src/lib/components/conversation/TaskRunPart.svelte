<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import type { ConversationPartLabels, ConversationTaskState } from "./types";

  type Props = {
    taskRef: string;
    title: string;
    state: ConversationTaskState;
    summary?: string;
    labels: ConversationPartLabels;
    statusLabel: (status: string) => string;
  };

  let { taskRef, title, state, summary, labels, statusLabel }: Props = $props();
</script>

<details class="task-part {state}">
  <summary>
    <span class="task-name"><Icon name="check" size={14} />{title}</span>
    <span>{statusLabel(state)}</span>
    <span class="disclosure"><Icon name="chevron-down" size={14} /></span>
  </summary>
  <div class="task-content">
    {#if summary?.trim()}<p>{summary}</p>{/if}
    <code>{labels.task} · {taskRef}</code>
  </div>
</details>

<style>
  .task-part {
    border: 1px solid var(--color-border-soft);
    border-radius: 9px;
    overflow: hidden;
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
    min-height: 38px;
    padding: 0 10px;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  .task-name {
    align-items: center;
    display: inline-flex;
    font-weight: 650;
    gap: 7px;
    min-width: 0;
  }

  .disclosure {
    display: inline-flex;
    transition: transform 120ms ease;
  }

  details[open] .disclosure {
    transform: rotate(180deg);
  }

  .task-content {
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    gap: 6px;
    padding: 10px;
  }

  p {
    color: var(--color-ink-muted);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
  }

  code {
    color: var(--color-ink-subtle);
    font-family: var(--font-mono, monospace);
    font-size: 10px;
  }
</style>
