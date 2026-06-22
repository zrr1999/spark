<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import {
    enumLabel,
    formatRelativeTime,
    statusLabel as getStatusLabel,
  } from "$lib/i18n";
  import { workspacePath } from "$lib/workspace-routes";

  let { data } = $props();
  let t = $derived(data.messages.inbox);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(data.workspace ? workspacePath(data.workspace) : "/");

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function urgencyLabel(urgency: string) {
    return enumLabel(urgency, common.urgency);
  }
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<section class="inbox-page">
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
    <article class="metric featured">
      <span>{t.metrics.pending}</span>
      <strong>{data.counts.pending}</strong>
    </article>
    <article class="metric">
      <span>{t.metrics.resolved}</span>
      <strong>{data.counts.resolved}</strong>
    </article>
    <article class="metric">
      <span>{t.metrics.archived}</span>
      <strong>{data.counts.archived}</strong>
    </article>
  </section>

  {#if !data.workspace}
    <section class="panel empty-state">
      <div class="empty-icon"><Icon name="inbox" size={28} /></div>
      <h2>{t.emptyWorkspace.title}</h2>
      <p>{t.emptyWorkspace.body}</p>
      <a class="secondary-action" href={workspaceUrl}>{t.emptyWorkspace.action}</a>
    </section>
  {:else if data.inboxItems.length === 0}
    <section class="panel empty-state">
      <div class="empty-icon"><Icon name="inbox" size={28} /></div>
      <h2>{t.empty.title}</h2>
      <p>{t.empty.body}</p>
    </section>
  {:else}
    <section class="panel" aria-labelledby="inbox-list-title">
      <div class="panel-header">
          <div>
            <p class="panel-kicker">{data.workspace.name}</p>
            <h2 id="inbox-list-title">{t.list.title}</h2>
          </div>
        <span class="panel-badge">{data.inboxItems.length} {t.list.totalSuffix}</span>
      </div>

      <div class="inbox-list">
        {#each data.inboxItems as item}
          <a class="inbox-row" href={`${workspaceUrl}/inbox/${item.id}`}>
            <div class="row-icon"><Icon name="inbox" size={22} /></div>
            <div>
              <div class="row-title">
                <h3>{item.title}</h3>
                <span class="urgency {item.urgency}">{urgencyLabel(item.urgency)}</span>
              </div>
              <p>{item.summary}</p>
              <small>
                {item.projectName ?? common.fallback.workspaceScope} · {item.runtimeName ?? common.fallback.runner} · {formatRelative(item.createdAt)}
              </small>
            </div>
            <div class="delivery-copy">
              {#if item.latestResponseStatus}
                <span>{statusLabel(item.latestResponseStatus)}{item.latestResponseAckedAt ? ` · ${t.list.acked}` : ""}</span>
              {:else}
                <span>{t.list.awaitingAnswer}</span>
              {/if}
            </div>
            <span class="status-pill {item.status}">{statusLabel(item.status)}</span>
          </a>
        {/each}
      </div>
    </section>
  {/if}
</section>

<style>
  .inbox-page {
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
  .inbox-row p,
  .inbox-row small,
  .empty-state p,
  .delivery-copy {
    color: var(--color-ink-subtle);
    line-height: 1.55;
  }

  .lede {
    margin-top: 10px;
    max-width: 760px;
  }

  .metrics {
    display: grid;
    gap: 18px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .metric,
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: var(--shadow-card-raised);
  }

  .metric {
    padding: 22px;
  }

  .metric.featured {
    background: var(--color-warning-weak);
    border-color: var(--color-warning-soft);
  }

  .metric span {
    color: var(--color-ink-subtle);
    display: block;
    font-size: 13px;
    font-weight: 750;
    margin-bottom: 10px;
  }

  .metric strong {
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
  .status-pill,
  .urgency {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
    text-transform: capitalize;
  }

  .panel-badge {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .status-pill.pending {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .status-pill.resolved {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  .urgency {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .urgency.high {
    background: var(--color-danger-soft);
    color: var(--color-danger-strong);
  }

  .inbox-list {
    display: grid;
    gap: 10px;
    padding: 18px;
  }

  .inbox-row {
    align-items: center;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    color: inherit;
    display: grid;
    gap: 16px;
    grid-template-columns: 48px minmax(0, 1fr) auto auto;
    padding: 16px;
    text-decoration: none;
  }

  .inbox-row:hover {
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

  .delivery-copy {
    font-size: 12px;
    white-space: nowrap;
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
    .inbox-row {
      grid-template-columns: 1fr;
    }
  }
</style>
