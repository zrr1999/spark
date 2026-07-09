<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { enumLabel, formatByteSize, formatRelativeTime } from "$lib/i18n";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import PageHeader from "$lib/ui/PageHeader.svelte";
  import Panel from "$lib/ui/Panel.svelte";
  import StatCard from "$lib/ui/StatCard.svelte";
  import { workspacePath } from "$lib/workspace-routes";

  let { data } = $props();
  let t = $derived(data.messages.artifacts);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(data.workspace ? workspacePath(data.workspace) : "/");

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function formatSize(value: number | null) {
    return formatByteSize(value, data.locale, common);
  }

  function scopeLabel(scope: string) {
    return enumLabel(scope, common.scope);
  }

  function cacheLabel(state: string | null) {
    return state ? statusLabel(state) : t.list.notCached;
  }

  function statusLabel(status: string) {
    return common.status[status as keyof typeof common.status] ?? status.replaceAll("_", " ");
  }
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<section class="artifacts-page">
  <PageHeader eyebrow={t.hero.eyebrow} title={t.hero.title} lede={t.hero.lede} />

  <section class="metrics" aria-label={t.metrics.aria}>
    <StatCard label={t.metrics.total} value={data.counts.total} tone="primary" icon="artifacts" />
    <StatCard label={t.metrics.workspaceScope} value={data.counts.workspace} tone="purple" icon="workspace" />
    <StatCard label={t.metrics.projectScope} value={data.counts.project} tone="primary" icon="folder" />
    <StatCard label={t.metrics.previewCached} value={data.counts.cached} tone="success" icon="archive" />
  </section>

  {#if !data.workspace}
    <Panel>
      <EmptyState title={t.emptyWorkspace.title} body={t.emptyWorkspace.body} icon="artifacts" actions={emptyWorkspaceAction} />
    </Panel>
  {:else if data.artifacts.length === 0}
    <Panel>
      <EmptyState title={t.empty.title} body={t.empty.body} icon="artifacts" />
    </Panel>
  {:else}
    <Panel title={t.list.title} kicker={data.workspace.name} badge="{data.artifacts.length} {t.list.projectedSuffix}" ariaLabelledby="artifact-list-title">

      <div class="artifact-list">
        {#each data.artifacts as artifact}
          <a class="artifact-row" href={`${workspaceUrl}/artifacts/${artifact.id}`}>
            <div class="row-icon"><Icon name="artifacts" size={22} /></div>
            <div>
              <div class="row-title">
                <h3>{artifact.title}</h3>
                <span class="scope-pill {artifact.scope}">{scopeLabel(artifact.scope)}</span>
              </div>
              <p>
                {artifact.kind} · {artifact.format} · {artifact.source} · {formatSize(artifact.sizeBytes)}
              </p>
              <small>
                {artifact.projectName ?? common.fallback.workspaceEvidence} · {artifact.linkCount}
                {t.list.links} · {formatRelative(artifact.createdAt)}
              </small>
            </div>
            <div class="cache-copy">
              <span class="cache-pill {artifact.cacheState ?? 'missing'}">
                {cacheLabel(artifact.cacheState)}
              </span>
              <small>{artifact.runtimeWorkspaceName ?? common.fallback.server}</small>
            </div>
          </a>
        {/each}
      </div>
    </Panel>
  {/if}
</section>

{#snippet emptyWorkspaceAction()}
  <a class="secondary-action" href={workspaceUrl}>{t.emptyWorkspace.action}</a>
{/snippet}

<style>
  .artifacts-page {
    display: grid;
    gap: var(--spacing-xl);
  }

  .metrics {
    display: grid;
    gap: var(--spacing-lg);
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  h3,
  p {
    margin: 0;
  }

  .artifact-list {
    display: grid;
    gap: var(--spacing-xs);
  }

  .artifact-row {
    align-items: center;
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    color: inherit;
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: 48px minmax(0, 1fr) auto;
    padding: var(--spacing-md);
    text-decoration: none;
    transition: border-color 120ms ease;
  }

  .artifact-row:hover {
    border-color: var(--color-border);
  }

  .artifact-row p,
  .artifact-row small,
  .cache-copy {
    color: var(--color-ink-subtle);
    line-height: var(--leading-body);
  }

  .row-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    display: grid;
    height: 48px;
    place-items: center;
    width: 48px;
  }

  .row-title {
    align-items: center;
    display: flex;
    gap: var(--spacing-xs);
    margin-bottom: var(--spacing-xxs);
  }

  .scope-pill,
  .cache-pill {
    border-radius: var(--rounded-full);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    padding: 4px 8px;
    text-transform: capitalize;
  }

  .scope-pill.project {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .scope-pill.workspace {
    background: var(--color-purple-soft);
    color: var(--color-purple);
  }

  .cache-pill {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .cache-pill.ready {
    background: var(--color-success-soft);
    color: var(--color-success-strong);
  }

  .cache-pill.missing {
    background: var(--color-warning-soft);
    color: var(--color-warning-strong);
  }

  .cache-copy {
    display: grid;
    gap: 6px;
    justify-items: end;
  }

  .secondary-action {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: var(--text-button);
    font-weight: var(--weight-button);
    min-height: 40px;
    justify-content: center;
    padding: 0 var(--spacing-md);
    text-decoration: none;
  }

  @media (max-width: 1100px) {
    .metrics,
    .artifact-row {
      grid-template-columns: 1fr;
    }

    .cache-copy {
      justify-items: start;
    }
  }
</style>
