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
  import { workspacePath } from "$lib/workspace-routes";

  let { data } = $props();
  let t = $derived(data.messages.inbox);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(data.workspace ? workspacePath(data.workspace) : "/");
  type InboxFilter = "all" | "pending" | "resolved" | "archived";
  let filter = $state<InboxFilter>("all");
  let visibleItems = $derived(
    filter === "all" ? data.inboxItems : data.inboxItems.filter((item) => item.status === filter),
  );

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return t.status[status as keyof typeof t.status] ?? getStatusLabel(status, common);
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
    <div class="status-tabs" role="group" aria-label={t.metrics.aria}>
      <button class:active={filter === "all"} type="button" onclick={() => (filter = "all")}>{t.list.all}<span>{data.inboxItems.length}</span></button>
      <button class:active={filter === "pending"} type="button" onclick={() => (filter = "pending")}>{t.metrics.pending}<span>{data.counts.pending}</span></button>
      <button class:active={filter === "resolved"} type="button" onclick={() => (filter = "resolved")}>{t.metrics.resolved}<span>{data.counts.resolved}</span></button>
      <button class:active={filter === "archived"} type="button" onclick={() => (filter = "archived")}>{t.metrics.archived}<span>{data.counts.archived}</span></button>
    </div>

    <Panel
      title={filter === "pending" ? t.list.awaitingAnswer : t.list.history}
      badge="{visibleItems.length} {t.list.totalSuffix}"
      ariaLabelledby="inbox-list-title"
      compact
    >
      {#if visibleItems.length === 0}
        <EmptyState title={t.empty.title} body={t.empty.body} icon="inbox" compact />
      {:else}
        <div class="inbox-list">
          {#each visibleItems as item}
            <a class="inbox-row" class:pending={item.status === "pending"} href={`${workspaceUrl}/inbox/${item.id}`}>
              <div class="row-icon"><Icon name="inbox" size={22} /></div>
              <div>
                <div class="row-title">
                  <h3>{item.title}</h3>
                  <span class="urgency {item.urgency}">{urgencyLabel(item.urgency)}</span>
                </div>
                <p>{item.summary}</p>
                <small>{formatRelative(item.createdAt)}</small>
              </div>
              <span class="status-pill {item.status}">{statusLabel(item.status)}</span>
            </a>
          {/each}
        </div>
      {/if}
    </Panel>
  {/if}
</section>

<style>
  @import "$lib/ui/status-pill.css";

  .inbox-page {
    display: grid;
    gap: var(--spacing-xl);
  }

  .status-tabs {
    align-items: center;
    background: var(--color-surface-soft);
    border-radius: var(--rounded-md);
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xxs);
    padding: var(--spacing-xxs);
    width: fit-content;
  }

  .status-tabs button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: calc(var(--rounded-md) - 2px);
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    gap: var(--spacing-xs);
    min-height: 34px;
    padding: 0 var(--spacing-sm);
  }

  .status-tabs button.active {
    background: var(--color-surface);
    box-shadow: var(--shadow-card);
    color: var(--color-ink);
  }

  .status-tabs button span {
    background: var(--color-canvas);
    border-radius: var(--rounded-full);
    padding: 1px 6px;
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
  small {
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
    .inbox-row {
      grid-template-columns: 1fr;
    }
  }
</style>
