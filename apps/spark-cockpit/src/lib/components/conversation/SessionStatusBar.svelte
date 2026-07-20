<script lang="ts">
  import {
    describeSessionStatus,
    formatCompactTokenCount,
    formatContextUsage,
    formatSessionCost,
    formatSessionStatusPercent,
    type SessionStatusBarLabels,
  } from "./session-status";

  type Props = {
    labels: SessionStatusBarLabels;
    cwd: string;
    gitBranch?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    latestCacheHitPercent?: number;
    contextTokens?: number;
    contextWindow?: number;
  };

  let {
    labels,
    cwd,
    gitBranch,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    latestCacheHitPercent,
    contextTokens,
    contextWindow,
  }: Props = $props();

  let input = $derived(formatCompactTokenCount(inputTokens && inputTokens > 0 ? inputTokens : undefined));
  let output = $derived(formatCompactTokenCount(outputTokens && outputTokens > 0 ? outputTokens : undefined));
  let cacheRead = $derived(formatCompactTokenCount(cacheReadTokens && cacheReadTokens > 0 ? cacheReadTokens : undefined));
  let cacheWrite = $derived(formatCompactTokenCount(cacheWriteTokens && cacheWriteTokens > 0 ? cacheWriteTokens : undefined));
  let cacheHit = $derived(
    cacheReadTokens || cacheWriteTokens
      ? formatSessionStatusPercent(latestCacheHitPercent)
      : undefined,
  );
  let cost = $derived(formatSessionCost(costUsd && costUsd > 0 ? costUsd : undefined));
  let context = $derived(formatContextUsage(contextTokens, contextWindow));
  let hasUsage = $derived(Boolean(input || output || cacheRead || cacheWrite || cacheHit || cost || context));
  let statusDescription = $derived(
    describeSessionStatus(labels, {
      cwd,
      gitBranch,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd,
      latestCacheHitPercent,
      contextTokens,
      contextWindow,
    }),
  );
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (slash actions move focus to this live status surface) -->
<section
  class="session-status-bar"
  role="group"
  tabindex="-1"
  data-session-status-bar
  aria-label={labels.bar}
  title={statusDescription}
>
  <div class="workspace-context" title={`${labels.workingDirectory}: ${cwd}`}>
    <span class="cwd">{cwd}</span>
    {#if gitBranch?.trim()}
      <span
        class="branch"
        data-priority="low"
        title={`${labels.branch}: ${gitBranch.trim()}`}
      >({gitBranch.trim()})</span>
    {/if}
  </div>

  {#if hasUsage}
    <div class:has-core={Boolean(context)} class="usage-context" aria-label={labels.context}>
      {#if input}
        <span
          class="metric"
          data-priority="medium"
          title={`${labels.inputTokens}: ${inputTokens}`}
        >
          <span class="sr-only">{labels.inputTokens}: {inputTokens}</span>
          <span aria-hidden="true">↑{input}</span>
        </span>
      {/if}
      {#if output}
        <span
          class="metric"
          data-priority="medium"
          title={`${labels.outputTokens}: ${outputTokens}`}
        >
          <span class="sr-only">{labels.outputTokens}: {outputTokens}</span>
          <span aria-hidden="true">↓{output}</span>
        </span>
      {/if}
      {#if cacheRead}
        <span
          class="metric"
          data-priority="low"
          title={`${labels.cacheReadTokens}: ${cacheReadTokens}`}
        >
          <span class="sr-only">{labels.cacheReadTokens}: {cacheReadTokens}</span>
          <span aria-hidden="true">R{cacheRead}</span>
        </span>
      {/if}
      {#if cacheWrite}
        <span
          class="metric"
          data-priority="low"
          title={`${labels.cacheWriteTokens}: ${cacheWriteTokens}`}
        >
          <span class="sr-only">{labels.cacheWriteTokens}: {cacheWriteTokens}</span>
          <span aria-hidden="true">W{cacheWrite}</span>
        </span>
      {/if}
      {#if cacheHit}
        <span
          class="metric"
          data-priority="low"
          title={`${labels.cacheHit}: ${cacheHit}`}
        >
          <span class="sr-only">{labels.cacheHit}: {cacheHit}</span>
          <span aria-hidden="true">CH{cacheHit}</span>
        </span>
      {/if}
      {#if cost}
        <span class="metric" data-priority="medium" title={`${labels.cost}: ${cost}`}>
          <span class="sr-only">{labels.cost}: {cost}</span>
          <span aria-hidden="true">{cost}</span>
        </span>
      {/if}
      {#if context}
        <span class="metric context" data-priority="high" title={`${labels.context}: ${context}`}>
          <span class="sr-only">{labels.context}: {context}</span>
          <span aria-hidden="true">{context}</span>
        </span>
      {/if}
    </div>
  {/if}

</section>

<style>
  .session-status-bar {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--color-ink-subtle);
    container: session-status / inline-size;
    display: flex;
    font-family: var(--font-mono);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    gap: 0;
    line-height: 1.25;
    min-height: 24px;
    min-width: 0;
    overflow: hidden;
    padding: 0 2px;
    white-space: nowrap;
  }

  .session-status-bar:focus-visible {
    border-radius: var(--rounded-sm);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .workspace-context,
  .usage-context {
    align-items: center;
    display: flex;
    gap: 8px;
    min-width: 0;
  }

  .workspace-context {
    color: var(--color-ink-muted);
    flex: 1 1 14rem;
    font-weight: 650;
    overflow: hidden;
  }

  .cwd {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .branch {
    color: var(--color-ink-subtle);
    flex: 0 0 auto;
  }

  .usage-context {
    border-left: 1px solid var(--color-border-soft);
    flex: 0 0 auto;
    margin-left: 9px;
    padding-left: 9px;
  }

  .metric {
    color: var(--color-ink-muted);
    flex: 0 0 auto;
    font-weight: 650;
  }

  .context {
    color: var(--color-primary);
  }

  .sr-only {
    border: 0;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  @container session-status (max-width: 720px) {
    [data-priority="low"] {
      display: none;
    }
  }

  @container session-status (max-width: 520px) {
    [data-priority="medium"] {
      display: none;
    }

    .usage-context:not(.has-core) {
      display: none;
    }
  }
</style>
