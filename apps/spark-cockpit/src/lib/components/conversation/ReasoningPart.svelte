<script lang="ts">
  import AgentMdxStream from "$lib/AgentMdxStream.svelte";
  import Icon from "$lib/Icon.svelte";
  import type { ConversationPartLabels } from "./types";

  type Props = {
    summary: string;
    state: "streaming" | "complete";
    redacted?: boolean;
    labels: ConversationPartLabels;
    /** When true, render body only (already inside ThinkingChainPart). */
    nested?: boolean;
  };

  let { summary, state, redacted = false, labels, nested = false }: Props = $props();
</script>

{#if nested}
  {#if summary.trim() && !redacted}
    <div class="reasoning-content nested">
      <AgentMdxStream source={summary} streaming={state === "streaming"} />
    </div>
  {/if}
{:else}
  <details class="reasoning-part" open={state === "streaming"}>
    <summary>
      <span class:streaming={state === "streaming"} class="reasoning-icon">
        <Icon name="spark" size={14} stroke={2.1} />
      </span>
      <span>{state === "streaming" ? labels.reasoningStreaming : labels.reasoning}</span>
      <span class="disclosure"><Icon name="chevron-down" size={14} /></span>
    </summary>
    {#if summary.trim() && !redacted}
      <div class="reasoning-content">
        <AgentMdxStream source={summary} streaming={state === "streaming"} />
      </div>
    {/if}
  </details>
{/if}

<style>
  .reasoning-part {
    border-left: 2px solid var(--color-border);
    color: var(--color-ink-subtle);
    padding-left: 10px;
  }

  summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-size: 12px;
    font-weight: 650;
    gap: 7px;
    list-style: none;
    min-height: 40px;
    width: fit-content;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:focus-visible {
    border-radius: 6px;
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .reasoning-icon {
    align-items: center;
    display: inline-flex;
  }

  .reasoning-icon.streaming {
    color: var(--color-primary);
  }

  .disclosure {
    display: inline-flex;
    transition: transform 120ms ease;
  }

  details[open] .disclosure {
    transform: rotate(180deg);
  }

  .reasoning-content {
    font-size: 13px;
    line-height: 1.55;
    padding: 4px 4px 8px 21px;
  }

  .reasoning-content.nested {
    padding: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .disclosure {
      transition: none;
    }
  }
</style>
