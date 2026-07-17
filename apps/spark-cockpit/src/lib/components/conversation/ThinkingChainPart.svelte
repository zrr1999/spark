<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import ReasoningPart from "./ReasoningPart.svelte";
  import ToolCallPart from "./ToolCallPart.svelte";
  import { untrack } from "svelte";
  import {
    isVisibleThinkingChain,
    thinkingChainHasTerminalIssue,
    thinkingChainNeedsFailureSummary,
    visibleThinkingChainSteps,
  } from "./thinking-chain-view";
  import type {
    ConversationChainStep,
    ConversationPartLabels,
  } from "./types";

  type Props = {
    state: "streaming" | "complete";
    steps: ConversationChainStep[];
    labels: ConversationPartLabels;
    statusLabel: (status: string) => string;
    active?: boolean;
  };

  let { state: chainState, steps, labels, statusLabel, active = false }: Props = $props();
  let visibleSteps = $derived(visibleThinkingChainSteps(steps));
  let hasTerminalIssue = $derived(thinkingChainHasTerminalIssue(steps));
  let needsFailureSummary = $derived(thinkingChainNeedsFailureSummary(steps));
  let shouldRender = $derived(isVisibleThinkingChain(chainState, steps));
  let expanded = $state(untrack(() => active && chainState === "streaming"));
  let previousState = $state(untrack(() => chainState));
  let previousActive = $state(untrack(() => active));

  $effect(() => {
    if (active && chainState === "streaming") {
      expanded = true;
    } else if (
      (previousActive && !active) ||
      (previousState === "streaming" && chainState === "complete")
    ) {
      expanded = false;
    }
    previousState = chainState;
    previousActive = active;
  });

  function toggleExpanded(event: MouseEvent) {
    event.preventDefault();
    expanded = !expanded;
  }
</script>

{#if shouldRender}
  <details class="thinking-chain {chainState}" bind:open={expanded}>
    <summary onclick={toggleExpanded}>
      <span class:streaming={chainState === "streaming"} class="chain-icon">
        <Icon name="spark" size={11} stroke={2.1} />
      </span>
      <span class="chain-label">
        {chainState === "streaming" ? labels.chainStreaming : labels.chain}
      </span>
      {#if hasTerminalIssue}
        <span class="chain-issue">{statusLabel("failed")}</span>
      {/if}
      <span class="disclosure"><Icon name="chevron-down" size={11} /></span>
    </summary>
    {#if expanded}
      <div class="chain-steps">
        {#each visibleSteps as step, index (`${step.type}:${index}:${step.type === "tool" ? step.callId : "r"}`)}
          {#if step.type === "reasoning" || step.type === "commentary"}
            <div class="chain-step {step.type}">
              {#if step.type === "reasoning" && step.redacted}
                <p class="redacted">{labels.reasoning}</p>
              {:else}
                <ReasoningPart
                  summary={step.summary}
                  state={step.state}
                  redacted={step.type === "reasoning" ? step.redacted : false}
                  labels={labels}
                  nested
                />
              {/if}
            </div>
          {:else}
            <div class="chain-step tool">
              <ToolCallPart
                callId={step.callId}
                name={step.name}
                state={step.state}
                summary={step.summary}
                labels={labels}
                {statusLabel}
                nested
              />
            </div>
          {/if}
        {/each}
        {#if chainState === "streaming" && visibleSteps.length === 0}
          <p class="chain-empty">{labels.chainEmpty}</p>
        {/if}
        {#if needsFailureSummary}
          <p class="chain-failure">{labels.chainFailed}</p>
        {/if}
      </div>
    {/if}
  </details>
{/if}

<style>
  .thinking-chain {
    color: var(--color-ink-subtle);
    min-width: 0;
  }

  summary {
    align-items: center;
    border-radius: var(--rounded-sm);
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: flex;
    font-size: 11px;
    font-weight: 600;
    gap: 5px;
    list-style: none;
    margin-inline: 0 auto;
    max-width: min(100%, 320px);
    min-height: 22px;
    padding: 0 3px;
    width: fit-content;
    transition:
      color 120ms ease,
      opacity 120ms ease,
      transform 120ms ease;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  summary:hover {
    color: var(--color-ink-muted);
  }

  .chain-icon {
    align-items: center;
    display: inline-flex;
    flex: 0 0 auto;
  }

  .chain-icon.streaming {
    color: var(--color-primary);
    animation: chain-pulse 1.4s ease-in-out infinite;
  }

  .disclosure {
    display: inline-flex;
    flex: 0 0 auto;
    transition: transform 120ms ease;
  }

  .chain-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chain-issue {
    color: var(--color-danger-strong, var(--color-danger));
    flex: 0 0 auto;
    font-size: 10px;
  }

  details[open] .disclosure {
    transform: rotate(180deg);
  }

  .chain-steps {
    border-left: 1px solid var(--color-border);
    display: grid;
    gap: 8px;
    margin: 5px 0 0 7px;
    padding: 2px 4px 10px 15px;
  }

  .redacted,
  .chain-empty,
  .chain-failure {
    color: var(--color-ink-subtle);
    font-size: 12px;
    margin: 0;
  }

  .chain-failure {
    color: var(--color-danger-strong, var(--color-danger));
  }

  @keyframes chain-pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chain-icon.streaming,
    .disclosure {
      animation: none;
      transition: none;
    }
  }

  @media (hover: hover) and (pointer: fine) {
    .thinking-chain.complete summary {
      opacity: 0;
      transform: translateY(2px);
    }

    :global(.conversation-message:hover) .thinking-chain.complete summary,
    .thinking-chain.complete:focus-within summary {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
