<script lang="ts">
  import Icon from "$lib/Icon.svelte";

  type Props = {
    artifactRef: string;
    title: string;
    kind?: string;
    state?: string;
    summary?: string;
    statusLabel: (status: string) => string;
  };

  let { artifactRef, title, kind, state, summary, statusLabel }: Props = $props();
</script>

<article class="artifact-part">
  <header>
    <span class="artifact-icon" aria-hidden="true"><Icon name="artifacts" size={15} /></span>
    <div class="artifact-title">
      <strong>{title}</strong>
      <code>{artifactRef}</code>
    </div>
    {#if kind}<span class="artifact-kind">{kind}</span>{/if}
    {#if state}<span class="artifact-state {state}">{statusLabel(state)}</span>{/if}
  </header>
  {#if summary?.trim()}<p>{summary}</p>{/if}
</article>

<style>
  .artifact-part {
    background: var(--color-surface);
    border: 1px solid var(--color-border-soft);
    border-radius: 10px;
    display: grid;
    gap: 8px;
    padding: 11px 12px;
  }

  header {
    align-items: center;
    display: grid;
    gap: 9px;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
  }

  .artifact-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: 7px;
    color: var(--color-primary);
    display: inline-flex;
    height: 28px;
    justify-content: center;
    width: 28px;
  }

  .artifact-title {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .artifact-title strong {
    color: var(--color-ink);
    font-size: 12px;
    font-weight: 700;
    overflow: hidden;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  code,
  .artifact-kind,
  .artifact-state {
    color: var(--color-ink-subtle);
    font-size: 10px;
  }

  code {
    font-family: var(--font-mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artifact-kind,
  .artifact-state {
    background: var(--color-surface-soft);
    border-radius: 999px;
    font-weight: 650;
    padding: 3px 7px;
  }

  .artifact-state.failed,
  .artifact-state.error,
  .artifact-state.blocked {
    background: var(--color-danger-weak, #fef2f2);
    color: var(--color-danger-strong, #b91c1c);
  }

  p {
    color: var(--color-ink-muted);
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  @media (max-width: 640px) {
    header {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .artifact-kind,
    .artifact-state {
      display: none;
    }
  }
</style>
