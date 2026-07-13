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
  };

  let { state, steps, labels, statusLabel }: Props = $props();
</script>

<details class="thinking-chain" open={state === "streaming"}>
  <summary>
    <span class:streaming={state === "streaming"} class="chain-icon">
      <Icon name="spark" size={14} stroke={2.1} />
    </span>
    <span>{state === "streaming" ? labels.chainStreaming : labels.chain}</span>
    <span class="disclosure"><Icon name="chevron-down" size={14} /></span>
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

  .chain-icon {
    align-items: center;
    display: inline-flex;
  }

  .chain-icon.streaming {
    color: var(--color-primary);
  }

  .disclosure {
    display: inline-flex;
    transition: transform 120ms ease;
  }

  details[open] .disclosure {
    transform: rotate(180deg);
  }

  .chain-steps {
    display: grid;
    gap: 8px;
    padding: 2px 4px 10px 21px;
  }

  .redacted {
    color: var(--color-ink-subtle);
    font-size: 12px;
    margin: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .disclosure {
      transition: none;
    }
  }
</style>
