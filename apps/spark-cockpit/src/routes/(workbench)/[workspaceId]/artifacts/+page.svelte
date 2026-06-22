<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { enumLabel, formatByteSize, formatRelativeTime } from "$lib/i18n";
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
  <header class="hero">
    <div>
      <p class="eyebrow">{t.hero.eyebrow}</p>
      <h1>{t.hero.title}</h1>
      <p class="lede">
        {t.hero.lede}
      </p>
    </div>
  </header>

  <section class="metrics" aria-label={t.metrics.aria}>
    <article>
      <span>{t.metrics.total}</span>
      <strong>{data.counts.total}</strong>
    </article>
    <article>
      <span>{t.metrics.workspaceScope}</span>
      <strong>{data.counts.workspace}</strong>
    </article>
    <article>
      <span>{t.metrics.projectScope}</span>
      <strong>{data.counts.project}</strong>
    </article>
    <article>
      <span>{t.metrics.previewCached}</span>
      <strong>{data.counts.cached}</strong>
    </article>
  </section>

  {#if !data.workspace}
    <section class="panel empty-state">
      <div class="empty-icon"><Icon name="artifacts" size={28} /></div>
      <h2>{t.emptyWorkspace.title}</h2>
      <p>{t.emptyWorkspace.body}</p>
      <a class="secondary-action" href={workspaceUrl}>{t.emptyWorkspace.action}</a>
    </section>
  {:else if data.artifacts.length === 0}
    <section class="panel empty-state">
      <div class="empty-icon"><Icon name="artifacts" size={28} /></div>
      <h2>{t.empty.title}</h2>
      <p>{t.empty.body}</p>
    </section>
  {:else}
    <section class="panel" aria-labelledby="artifact-list-title">
      <div class="panel-header">
          <div>
            <p class="panel-kicker">{data.workspace.name}</p>
          <h2 id="artifact-list-title">{t.list.title}</h2>
        </div>
        <span class="panel-badge">{data.artifacts.length} {t.list.projectedSuffix}</span>
      </div>

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
                {artifact.projectName ?? common.fallback.workspaceEvidence}{artifact.runtimeInvocationId
                  ? ` · ${artifact.runtimeInvocationId}`
                  : ""} · {artifact.linkCount} {t.list.links} · {formatRelative(artifact.createdAt)}
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
    </section>
  {/if}
</section>

<style>
  .artifacts-page {
    display: grid;
    gap: 24px;
  }

  .hero {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .eyebrow,
  .panel-kicker {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0.08em;
    margin: 0 0 8px;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    font-size: 34px;
    letter-spacing: -0.03em;
  }

  .lede,
  .artifact-row p,
  .artifact-row small,
  .empty-state p,
  .cache-copy {
    color: var(--color-ink-subtle);
    line-height: 1.55;
  }

  .lede {
    margin-top: 10px;
    max-width: 820px;
  }

  .metrics {
    display: grid;
    gap: 18px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .metrics article,
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: var(--shadow-card-raised);
  }

  .metrics article {
    padding: 22px;
  }

  .metrics span {
    color: var(--color-ink-subtle);
    display: block;
    font-size: 13px;
    font-weight: 750;
    margin-bottom: 10px;
  }

  .metrics strong {
    color: var(--color-ink);
    font-size: 32px;
  }

  .panel-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    justify-content: space-between;
    padding: 24px 28px;
  }

  .panel-badge,
  .scope-pill,
  .cache-pill {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
    text-transform: capitalize;
  }

  .panel-badge,
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
    color: var(--color-success);
  }

  .cache-pill.missing {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .artifact-list {
    display: grid;
    gap: 10px;
    padding: 18px;
  }

  .artifact-row {
    align-items: center;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    color: inherit;
    display: grid;
    gap: 16px;
    grid-template-columns: 48px minmax(0, 1fr) auto;
    padding: 16px;
    text-decoration: none;
  }

  .artifact-row:hover {
    border-color: var(--color-primary-soft);
  }

  .row-icon,
  .empty-icon {
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    display: grid;
    place-items: center;
  }

  .row-icon {
    height: 48px;
    width: 48px;
  }

  .empty-icon {
    height: 64px;
    width: 64px;
  }

  .row-title {
    align-items: center;
    display: flex;
    gap: 10px;
    margin-bottom: 4px;
  }

  .cache-copy {
    display: grid;
    gap: 6px;
    justify-items: end;
  }

  .empty-state {
    align-items: center;
    display: grid;
    gap: 14px;
    justify-items: center;
    padding: 42px;
    text-align: center;
  }

  .secondary-action {
    align-items: center;
    background: white;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-weight: 800;
    height: 44px;
    justify-content: center;
    padding: 0 16px;
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
