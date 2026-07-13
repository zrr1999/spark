<script lang="ts">
  import AgentMdxStream from "$lib/AgentMdxStream.svelte";
  import Icon from "$lib/Icon.svelte";
  import ApprovalPart from "./ApprovalPart.svelte";
  import ArtifactPart from "./ArtifactPart.svelte";
  import ErrorPart from "./ErrorPart.svelte";
  import MessageActions from "./MessageActions.svelte";
  import ReasoningPart from "./ReasoningPart.svelte";
  import TaskRunPart from "./TaskRunPart.svelte";
  import ThinkingChainPart from "./ThinkingChainPart.svelte";
  import ToolCallPart from "./ToolCallPart.svelte";
  import type { ConversationMessageView, ConversationPartLabels } from "./types";

  type Props = {
    item: ConversationMessageView;
    userLabel: string;
    assistantLabel: string;
    copyLabel: string;
    copiedLabel: string;
    partLabels: ConversationPartLabels;
    relativeTime: (value: string) => string;
    statusLabel: (status: string) => string;
  };

  let {
    item,
    userLabel,
    assistantLabel,
    copyLabel,
    copiedLabel,
    partLabels,
    relativeTime,
    statusLabel,
  }: Props = $props();

  let actorLabel = $derived(
    item.actor === "user" ? (item.senderLabel ?? userLabel) : assistantLabel,
  );
  let hasCopyableText = $derived(item.parts.some((part) => part.type === "text"));
</script>

<article class="conversation-message {item.actor}" data-message-id={item.id}>
  <span class="actor-mark" aria-hidden="true">
    {#if item.actor === "spark"}
      <Icon name="spark" size={16} />
    {:else}
      {actorLabel.slice(0, 1)}
    {/if}
  </span>
  <div class="message-column">
    <header class="message-meta">
      <strong>{actorLabel}</strong>
      <time datetime={item.timestamp}>{relativeTime(item.timestamp)}</time>
      {#if item.status}
        <span class="message-status {item.status}">{statusLabel(item.status)}</span>
      {/if}
    </header>

    <div class="message-content">
      {#if item.title && item.title !== item.body}<h2>{item.title}</h2>{/if}
      {#each item.parts as part, partIndex (`${item.id}:${part.type}:${partIndex}`)}
        {#if part.type === "text"}
          {#if item.actor === "spark"}
            <div class="assistant-content">
              <AgentMdxStream source={part.text} streaming={part.streaming} />
            </div>
          {:else}
            <p class="user-content">{part.text}</p>
          {/if}
        {:else if part.type === "reasoning"}
          <ReasoningPart
            summary={part.summary}
            state={part.state}
            redacted={part.redacted}
            labels={partLabels}
          />
        {:else if part.type === "commentary"}
          <ReasoningPart summary={part.summary} state={part.state} labels={partLabels} />
        {:else if part.type === "chain"}
          <ThinkingChainPart
            state={part.state}
            steps={part.steps}
            labels={partLabels}
            {statusLabel}
          />
        {:else if part.type === "tool"}
          <ToolCallPart
            callId={part.callId}
            name={part.name}
            state={part.state}
            summary={part.summary}
            labels={partLabels}
            {statusLabel}
          />
        {:else if part.type === "task"}
          <TaskRunPart
            taskRef={part.taskRef}
            title={part.title}
            state={part.state}
            summary={part.summary}
            labels={partLabels}
            {statusLabel}
          />
        {:else if part.type === "approval"}
          <ApprovalPart
            requestId={part.requestId}
            title={part.title}
            state={part.state}
            kind={part.kind}
            summary={part.summary}
            labels={partLabels}
            {statusLabel}
          />
        {:else if part.type === "artifact"}
          <ArtifactPart
            artifactRef={part.artifactRef}
            title={part.title}
            kind={part.kind}
            state={part.state}
            summary={part.summary}
            {statusLabel}
          />
        {:else if part.type === "error"}
          <ErrorPart title={part.title} message={part.message} code={part.code} />
        {:else}
          <p class="unknown-part">{partLabels.unknown}: {part.label}</p>
        {/if}
      {/each}
      {#if item.meta}<small>{item.meta}</small>{/if}
    </div>

    {#if hasCopyableText}
      <MessageActions text={item.body} {copyLabel} {copiedLabel} />
    {/if}
  </div>
</article>

<style>
  .conversation-message {
    align-items: start;
    display: grid;
    gap: 11px;
    grid-template-columns: 30px minmax(0, 1fr);
  }

  .conversation-message.user {
    grid-template-columns: minmax(0, 1fr) 30px;
  }

  .actor-mark {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 11px;
    font-weight: 700;
    height: 30px;
    justify-content: center;
    width: 30px;
  }

  .conversation-message.spark .actor-mark {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .conversation-message.user .actor-mark {
    grid-column: 2;
    grid-row: 1;
  }

  .message-column {
    min-width: 0;
  }

  .conversation-message.user .message-column {
    display: grid;
    grid-column: 1;
    grid-row: 1;
    justify-items: end;
    justify-self: end;
    max-width: min(88%, 720px);
  }

  .message-meta {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    min-height: 24px;
  }

  .conversation-message.user .message-meta {
    justify-content: flex-end;
  }

  .message-meta strong {
    color: var(--color-ink);
    font-size: 12px;
    font-weight: 700;
  }

  .message-meta time,
  .message-content small {
    color: var(--color-ink-subtle);
    font-size: 11px;
  }

  .message-content {
    display: grid;
    gap: 9px;
    min-width: 0;
  }

  .conversation-message.user .message-content {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: 12px;
    margin-top: 3px;
    padding: 11px 13px;
    width: fit-content;
  }

  .message-content h2 {
    color: var(--color-ink);
    font-size: 13px;
    font-weight: 650;
    margin: 0;
  }

  .user-content {
    color: var(--color-ink-muted);
    font-size: 14px;
    line-height: 1.6;
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .assistant-content {
    color: var(--color-ink-muted);
    font-size: 14px;
    line-height: 1.65;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .unknown-part {
    background: var(--color-surface-soft);
    border: 1px dashed var(--color-border);
    border-radius: 8px;
    color: var(--color-ink-subtle);
    font-size: 11px;
    margin: 0;
    padding: 8px 10px;
  }

  .message-status {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 10px;
    font-weight: 650;
    padding: 3px 7px;
    text-transform: capitalize;
  }

  .message-status.running,
  .message-status.streaming,
  .message-status.pending,
  .message-status.queued {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .message-status.failed,
  .message-status.error {
    background: var(--color-danger-weak, #fef2f2);
    color: var(--color-danger-strong, #b91c1c);
  }

  @media (max-width: 640px) {
    .conversation-message {
      gap: 8px;
      grid-template-columns: 26px minmax(0, 1fr);
    }

    .conversation-message.user {
      grid-template-columns: minmax(0, 1fr) 26px;
    }

    .conversation-message.user .message-column {
      max-width: 94%;
    }

    .actor-mark {
      border-radius: 7px;
      height: 26px;
      width: 26px;
    }
  }
</style>
