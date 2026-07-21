<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import ReasoningPart from "./ReasoningPart.svelte";
  import ToolCallPart from "./ToolCallPart.svelte";
  import {
    isVisibleThinkingChain,
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
  let needsFailureSummary = $derived(thinkingChainNeedsFailureSummary(steps));
  let shouldRender = $derived(isVisibleThinkingChain(chainState, steps));
  let expanded = $state(false);
  let userToggled = $state(false);

  // Cursor/Codex: open while the turn is executing, fold shut when it finishes.
  $effect(() => {
    if (chainState === "streaming" || active) {
      expanded = true;
      userToggled = false;
      return;
    }
    if (!userToggled) expanded = false;
  });

  function stepStatus(step: ConversationChainStep): "complete" | "active" | "pending" {
    if (step.type === "reasoning" || step.type === "commentary") {
      return step.state === "streaming" ? "active" : "complete";
    }
    if (step.state === "pending") return "pending";
    if (step.state === "running" || step.state === "awaiting-approval") return "active";
    return "complete";
  }

  function stepIcon(step: ConversationChainStep) {
    if (step.type === "tool") return "activity" as const;
    if (step.type === "commentary") return "message" as const;
    return "spark" as const;
  }

  function toggleExpanded(event: MouseEvent) {
    event.preventDefault();
    expanded = !expanded;
    userToggled = true;
  }
</script>

{#if shouldRender}
  <details class="thinking-chain {chainState}" bind:open={expanded}>
    <summary onclick={toggleExpanded}>
      <span class:streaming={chainState === "streaming"} class="chain-icon" aria-hidden="true">
        <Icon name="spark" size={11} stroke={2.1} />
      </span>
      <span class="chain-label">
        {chainState === "streaming" ? labels.chainStreaming : labels.chain}
      </span>
      <span class="disclosure" aria-hidden="true"><Icon name="chevron-down" size={11} /></span>
    </summary>
    {#if expanded}
      <div class="chain-steps">
        {#each visibleSteps as step, index (`${step.type}:${index}:${step.type === "tool" ? step.callId : "r"}`)}
          {@const presentationStatus = stepStatus(step)}
          <div class="chain-step {step.type} {presentationStatus}">
            <span class="step-rail" aria-hidden="true">
              <span class="step-icon"><Icon name={stepIcon(step)} size={13} stroke={2} /></span>
            </span>
            <div class="step-body">
              {#if step.type === "reasoning" || step.type === "commentary"}
                {#if step.type === "reasoning" && step.redacted}
                  <p class="redacted">{labels.reasoning}</p>
                {:else if step.summary.trim()}
                  <ReasoningPart
                    summary={step.summary}
                    state={step.state}
                    redacted={step.type === "reasoning" ? step.redacted : false}
                    labels={labels}
                    nested
                  />
                {/if}
              {:else}
                <ToolCallPart
                  callId={step.callId}
                  name={step.name}
                  state={step.state}
                  summary={step.summary}
                  labels={labels}
                  {statusLabel}
                  nested
                />
              {/if}
            </div>
          </div>
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
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  details[open] .disclosure {
    transform: rotate(180deg);
  }

  .chain-steps {
    display: grid;
    gap: 12px;
    margin-top: 7px;
    padding: 2px 5px 9px 7px;
  }

  .chain-step {
    display: grid;
    gap: 9px;
    grid-template-columns: 18px minmax(0, 1fr);
    min-width: 0;
  }

  .step-rail {
    align-items: start;
    display: flex;
    justify-content: center;
    position: relative;
  }

  .step-rail::after {
    background: var(--color-border);
    content: "";
    position: absolute;
    bottom: -14px;
    left: 50%;
    top: 20px;
    width: 1px;
  }

  .chain-step:last-child .step-rail::after {
    display: none;
  }

  .step-icon {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    display: inline-flex;
    height: 18px;
    justify-content: center;
    position: relative;
    width: 18px;
    z-index: 1;
  }

  .chain-step.active .step-icon {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
    animation: chain-pulse 1.4s ease-in-out infinite;
  }

  .chain-step.pending {
    opacity: 0.52;
  }

  .step-body {
    min-width: 0;
    padding-top: 1px;
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
    .chain-step.active .step-icon,
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
