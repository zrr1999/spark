<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import ReasoningPart from "./ReasoningPart.svelte";
  import ToolCallPart from "./ToolCallPart.svelte";
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

  let { state, steps, labels, statusLabel, active = false }: Props = $props();
  let hasTerminalIssue = $derived(
    steps.some(
      (step) =>
        step.type === "tool" &&
        (step.state === "failed" || step.state === "denied" || step.state === "cancelled"),
    ),
  );
</script>

<details class="thinking-chain {state}" open={active || state === "streaming" || hasTerminalIssue}>
  <summary>
    <span class:streaming={state === "streaming"} class="chain-icon">
      <Icon name="spark" size={11} stroke={2.1} />
    </span>
    <span class="chain-label">
      {state === "streaming" ? labels.chainStreaming : labels.chain}
    </span>
    <span class="disclosure"><Icon name="chevron-down" size={11} /></span>
  </summary>
  <div class="chain-steps">
    {#each steps as step, index (`${step.type}:${index}:${step.type === "tool" ? step.callId : "r"}`)}
      {#if step.type === "reasoning" || step.type === "commentary"}
        <div class="chain-step {step.type}">
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
  </div>
</details>

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
    margin-inline: auto;
    max-width: min(100%, 320px);
    min-height: 22px;
    padding: 0 3px;
    width: fit-content;
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

  .redacted {
    color: var(--color-ink-subtle);
    font-size: 12px;
    margin: 0;
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
</style>
