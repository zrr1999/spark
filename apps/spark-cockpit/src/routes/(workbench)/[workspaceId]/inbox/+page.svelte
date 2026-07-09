<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import {
    enumLabel,
    formatRelativeTime,
    statusLabel as getStatusLabel,
  } from "$lib/i18n";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import PageHeader from "$lib/ui/PageHeader.svelte";
  import Panel from "$lib/ui/Panel.svelte";
  import StatCard from "$lib/ui/StatCard.svelte";
  import { workspacePath } from "$lib/workspace-routes";

  let { data } = $props();
  let t = $derived(data.messages.inbox);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(data.workspace ? workspacePath(data.workspace) : "/");
  let pendingItems = $derived(data.inboxItems.filter((item) => item.status === "pending"));
  let otherItems = $derived(data.inboxItems.filter((item) => item.status !== "pending"));

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
  <PageHeader eyebrow={t.hero.eyebrow} title={t.hero.title} lede={t.hero.lede} />

  <section class="metrics" aria-label={t.metrics.aria}>
    <StatCard
      label={t.metrics.pending}
      value={data.counts.pending}
      tone="warning"
      featured={data.counts.pending > 0}
      icon="inbox"
    />
    <StatCard label={t.metrics.resolved} value={data.counts.resolved} tone="success" icon="check" />
    <StatCard label={t.metrics.archived} value={data.counts.archived} icon="archive" />
  </section>

  {#if !data.workspace}
    <Panel>
      <EmptyState title={t.emptyWorkspace.title} body={t.emptyWorkspace.body} icon="inbox">
        {#snippet actions()}
          <a class="empty-cta" href={workspaceUrl}>{t.emptyWorkspace.action}</a>
        {/snippet}
      </EmptyState>
    </Panel>
  {:else if data.inboxItems.length === 0}
    <Panel>
      <EmptyState title={t.empty.title} body={t.empty.body} icon="inbox" />
    </Panel>
  {:else}
    {#if pendingItems.length > 0}
      <Panel
        title={t.list.awaitingAnswer}
        kicker={t.hero.eyebrow}
        badge="{pendingItems.length} {t.list.totalSuffix}"
        ariaLabelledby="inbox-pending-title"
      >
        <div class="inbox-list">
          {#each pendingItems as item}
            <a class="inbox-row pending" href={`${workspaceUrl}/inbox/${item.id}`}>
              <div class="row-icon"><Icon name="inbox" size={22} /></div>
              <div>
                <div class="row-title">
                  <h3>{item.title}</h3>
                  <span class="urgency {item.urgency}">{urgencyLabel(item.urgency)}</span>
                </div>
                <p>{item.summary}</p>
                <small>
                  {item.projectName ?? common.fallback.workspaceScope} · {formatRelative(item.createdAt)}
                </small>
              </div>
              <span class="status-pill {item.status}">{statusLabel(item.status)}</span>
            </a>
          {/each}
        </div>
      </Panel>
    {/if}

    {#if otherItems.length > 0}
      <Panel
        title={t.list.title}
        kicker={data.workspace.name}
        badge="{otherItems.length} {t.list.totalSuffix}"
        ariaLabelledby="inbox-list-title"
        compact
      >
        <div class="inbox-list">
          {#each otherItems as item}
            <a class="inbox-row" href={`${workspaceUrl}/inbox/${item.id}`}>
              <div class="row-icon"><Icon name="inbox" size={22} /></div>
              <div>
                <div class="row-title">
                  <h3>{item.title}</h3>
                  <span class="urgency {item.urgency}">{urgencyLabel(item.urgency)}</span>
                </div>
                <p>{item.summary}</p>
                <small>
                  {item.projectName ?? common.fallback.workspaceScope} · {formatRelative(item.createdAt)}
                </small>
              </div>
              <div class="delivery-copy">
                {#if item.latestResponseStatus}
                  <span
                    >{statusLabel(item.latestResponseStatus)}{item.latestResponseAckedAt
                      ? ` · ${t.list.acked}`
                      : ""}</span
                  >
                {:else}
                  <span>{t.list.awaitingAnswer}</span>
                {/if}
              </div>
              <span class="status-pill {item.status}">{statusLabel(item.status)}</span>
            </a>
          {/each}
        </div>
      </Panel>
    {/if}
  {/if}
</section>

<style>
  @import "$lib/ui/status-pill.css";

  .inbox-page {
    display: grid;
    gap: var(--spacing-xl);
  }

  .metrics {
    display: grid;
    gap: var(--spacing-lg);
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .inbox-list {
    display: grid;
    gap: var(--spacing-xs);
  }

  .inbox-row {
    align-items: center;
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    color: inherit;
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: 48px minmax(0, 1fr) auto;
    padding: var(--spacing-md);
    text-decoration: none;
  }

  .inbox-row.pending {
    border-color: var(--color-warning-soft);
    background: var(--color-warning-weak);
  }

  .inbox-row:hover {
    border-color: var(--color-border);
    background: var(--color-surface-soft);
  }

  .row-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    display: flex;
    height: 48px;
    justify-content: center;
    width: 48px;
  }

  .row-title {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 4px;
  }

  h3,
  p {
    margin: 0;
  }

  h3 {
    font-size: var(--text-card-title);
    font-weight: var(--weight-card-title);
  }

  p,
  small,
  .delivery-copy {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
  }

  .urgency {
    border-radius: var(--rounded-sm);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    padding: 2px 8px;
    text-transform: capitalize;
  }

  .urgency.high,
  .urgency.urgent {
    background: var(--color-danger-soft);
    color: var(--color-danger-strong);
  }

  .urgency.normal,
  .urgency.medium {
    background: var(--color-warning-soft);
    color: var(--color-warning-strong);
  }

  .urgency.low {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .empty-cta {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: var(--text-button);
    font-weight: var(--weight-button);
    min-height: 36px;
    padding: 8px 12px;
    text-decoration: none;
  }

  @media (max-width: 900px) {
    .metrics,
    .inbox-row {
      grid-template-columns: 1fr;
    }
  }
</style>
