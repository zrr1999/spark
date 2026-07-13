<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import type { Snippet } from "svelte";
  import type { ConversationApprovalState, ConversationPartLabels } from "./types";

  type Props = {
    requestId: string;
    title: string;
    state: ConversationApprovalState;
    kind?: string;
    summary?: string;
    labels: ConversationPartLabels;
    statusLabel: (status: string) => string;
    actions?: Snippet;
  };

  let { requestId, title, state, kind, summary, labels, statusLabel, actions }: Props = $props();
</script>

<section class="approval-part {state}" aria-labelledby={`approval-${requestId}`}>
  <header>
    <span class="approval-icon"><Icon name="warning" size={15} /></span>
    <strong id={`approval-${requestId}`}>{title}</strong>
    <span class="approval-state">{statusLabel(state)}</span>
  </header>
  {#if summary?.trim()}<p>{summary}</p>{/if}
  {#if actions && state === "requested"}
    <div class="approval-actions">{@render actions()}</div>
  {/if}
  <code>{kind ?? labels.approval} · {requestId}</code>
</section>

<style>
  .approval-part {
    background: var(--color-warning-soft);
    border: 1px solid var(--color-warning);
    border-radius: 9px;
    display: grid;
    gap: 8px;
    padding: 10px;
  }

  .approval-part.approved,
  .approval-part.resolved {
    background: var(--color-success-weak, var(--color-surface-soft));
    border-color: var(--color-success, var(--color-border));
  }

  .approval-part.rejected,
  .approval-part.cancelled {
    background: var(--color-surface-soft);
    border-color: var(--color-border);
  }

  header {
    align-items: center;
    color: var(--color-ink-muted);
    display: grid;
    font-size: 12px;
    gap: 8px;
    grid-template-columns: auto minmax(0, 1fr) auto;
  }

  .approval-icon {
    align-items: center;
    color: var(--color-warning-strong, var(--color-warning));
    display: inline-flex;
  }

  .approval-state {
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 650;
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

  .approval-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
