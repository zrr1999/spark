<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { daemonDisplayStatus } from "$lib/daemon-status";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import PageHeader from "$lib/ui/PageHeader.svelte";
  import StatCard from "$lib/ui/StatCard.svelte";
  import { workspaceControlDisplay } from "$lib/workspace-control-display";
  import { workspacePath, workspaceSessionsPath } from "$lib/workspace-routes";

  let { data } = $props();

  let t = $derived(data.messages.home);
  let common = $derived(data.messages.common);
  let workspace = $derived(data.workspaces[0]!);
  let workspaceUrl = $derived(workspacePath(workspace));
  let workspaceSessionsUrl = $derived(workspaceSessionsPath(workspace));
  let controlDisplay = $derived(
    workspaceControlDisplay(data.workspaceControl, t.workspaceControl),
  );
  let onlineRuntimeCount = $derived(
    data.runnerConnections.filter((runner) => daemonDisplayStatus(runner) === "online").length,
  );

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }
</script>

{#snippet workspaceSettingsAction()}
  <a class="secondary-action" href={`${workspaceUrl}/settings`}>
    <Icon name="settings" size={16} />
    {t.hero.openSettings}
  </a>
{/snippet}

<svelte:head>
  <title>{workspace.name} · {t.headTitle}</title>
</svelte:head>

<section class="workspace-overview">
  <PageHeader
    title={workspace.name}
    lede={workspace.description ?? t.hero.lede}
    actions={workspaceSettingsAction}
  />

  <section class="metrics" aria-label={t.metrics.aria}>
    <StatCard
      label={t.metrics.pendingInbox}
      hint={t.metrics.pendingInboxHint}
      value={data.pendingInboxCount}
      tone="warning"
      featured={data.pendingInboxCount > 0}
      icon="inbox"
    />
    <StatCard
      label={t.metrics.runnerConnections}
      value={onlineRuntimeCount}
      hint={controlDisplay.connectionLabel}
      tone={onlineRuntimeCount > 0 ? "success" : "warning"}
      icon="activity"
    />
    <StatCard
      label={t.metrics.workspaceBindings}
      value={data.runnerBindings.length}
      hint={controlDisplay.controlLabel}
      tone="primary"
      icon="folder"
    />
  </section>

  <section class="action-grid" aria-label={t.actions.aria}>
    <a class="action-card primary" href={workspaceSessionsUrl}>
      <span class="action-icon"><Icon name="spark" size={22} /></span>
      <span><strong>{t.actions.conversationTitle}</strong><small>{t.actions.conversationBody}</small></span>
      <Icon name="chevron" size={18} />
    </a>
    <a class="action-card" href={`${workspaceUrl}/inbox`}>
      <span class="action-icon"><Icon name="inbox" size={22} /></span>
      <span><strong>{t.actions.inboxTitle}</strong><small>{t.actions.inboxBody}</small></span>
      <Icon name="chevron" size={18} />
    </a>
    <a class="action-card" href={`${workspaceUrl}/artifacts`}>
      <span class="action-icon"><Icon name="artifacts" size={22} /></span>
      <span><strong>{t.actions.artifactsTitle}</strong><small>{t.actions.artifactsBody}</small></span>
      <Icon name="chevron" size={18} />
    </a>
    <a class="action-card" href={`${workspaceUrl}/repos`}>
      <span class="action-icon"><Icon name="repos" size={22} /></span>
      <span><strong>{t.actions.resourcesTitle}</strong><small>{t.actions.resourcesBody}</small></span>
      <Icon name="chevron" size={18} />
    </a>
  </section>

  <details class="diagnostics">
    <summary>
      <span><strong>{t.panels.diagnostics}</strong><small>{t.panels.diagnosticsHint}</small></span>
      <Icon name="chevron-down" size={18} />
    </summary>
    <div class="diagnostic-body">
      <section aria-labelledby="runtime-title">
        <h2 id="runtime-title">{t.panels.runnerHealth}</h2>
        <div class="status-list">
          <span class="control-chip {data.workspaceControl.connection.status}">{controlDisplay.connectionLabel}</span>
          <span class="control-chip">{controlDisplay.borrowedLabel}</span>
          <span class="control-chip">{controlDisplay.executorLabel}</span>
        </div>
        {#if data.runnerConnections.length > 0}
          <div class="diagnostic-list">
            {#each data.runnerConnections as runner}
              {@const displayStatus = daemonDisplayStatus(runner)}
              <article>
                <div><strong>{runner.name}</strong><small>{runner.protocolVersion ?? t.protocolPending}</small></div>
                <span class="status-pill {displayStatus}">{statusLabel(displayStatus)}</span>
                <time>{formatRelative(runner.lastHeartbeatAt ?? runner.updatedAt)}</time>
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <section aria-labelledby="directories-title">
        <h2 id="directories-title">{t.panels.workspaceBindings}</h2>
        {#if data.runnerBindings.length === 0}
          <p class="empty-copy">{t.bindingsEmpty}</p>
        {:else}
          <div class="diagnostic-list">
            {#each data.runnerBindings as binding}
              <article>
                <div><strong>{binding.displayName}</strong><small>{binding.runtimeName} · {binding.localWorkspaceKey}</small></div>
                <span class="status-pill {binding.status}">{statusLabel(binding.status)}</span>
                <time>{formatRelative(binding.lastSnapshotAt ?? binding.updatedAt)}</time>
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <section aria-labelledby="events-title">
        <h2 id="events-title">{t.panels.recentEvents}</h2>
        {#if data.recentEvents.length === 0}
          <p class="empty-copy">{t.eventsEmpty}</p>
        {:else}
          <div class="diagnostic-list events-list">
            {#each data.recentEvents as event}
              <article>
                <div><strong>{event.kind}</strong><small>{event.actorKind}{event.subjectKind ? ` · ${event.subjectKind}` : ""}</small></div>
                <time>{formatRelative(event.createdAt)}</time>
              </article>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  </details>
</section>

<style>
  @import "$lib/ui/status-pill.css";

  .workspace-overview {
    display: grid;
    gap: var(--spacing-xl);
  }

  .metrics {
    display: grid;
    gap: var(--spacing-lg);
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .action-grid {
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .action-card {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-xl);
    color: inherit;
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: 44px minmax(0, 1fr) auto;
    padding: var(--spacing-lg);
    text-decoration: none;
    transition: border-color 120ms ease, transform 120ms ease;
  }

  .action-card:hover {
    border-color: var(--color-primary-soft);
    transform: translateY(-1px);
  }

  .action-card.primary {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
  }

  .action-card > span:nth-child(2) {
    display: grid;
    gap: var(--spacing-xxs);
    min-width: 0;
  }

  .action-card strong {
    font-size: var(--text-card-title);
  }

  .action-card small,
  .diagnostics small,
  .diagnostics time,
  .empty-copy {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
  }

  .action-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    display: flex;
    height: 44px;
    justify-content: center;
    width: 44px;
  }

  .diagnostics {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-xl);
    overflow: hidden;
  }

  .diagnostics > summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
    list-style: none;
    padding: var(--spacing-lg) var(--spacing-xl);
  }

  .diagnostics > summary::-webkit-details-marker { display: none; }
  .diagnostics > summary > span { display: grid; gap: var(--spacing-xxs); }
  .diagnostics[open] > summary { border-bottom: 1px solid var(--color-border); }
  .diagnostics[open] > summary :global(svg) { transform: rotate(180deg); }

  .diagnostic-body {
    display: grid;
    gap: var(--spacing-xl);
    padding: var(--spacing-xl);
  }

  .diagnostic-body section { display: grid; gap: var(--spacing-sm); }
  .diagnostic-body h2 { font-size: var(--text-card-title); margin: 0; }
  .empty-copy { margin: 0; }

  .status-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
  }

  .control-chip {
    background: var(--color-surface-soft);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
    padding: 6px 10px;
  }

  .control-chip.connected {
    background: var(--color-success-soft);
    color: var(--color-success-strong);
  }

  .diagnostic-list {
    display: grid;
  }

  .diagnostic-list article {
    align-items: center;
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: minmax(0, 1fr) auto auto;
    padding: var(--spacing-sm) 0;
  }

  .diagnostic-list article > div { display: grid; gap: var(--spacing-xxs); min-width: 0; }
  .diagnostic-list strong, .diagnostic-list small { overflow-wrap: anywhere; }
  .events-list article { grid-template-columns: minmax(0, 1fr) auto; }

  .secondary-action {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: var(--text-button);
    font-weight: var(--weight-button);
    gap: var(--spacing-xs);
    min-height: 40px;
    padding: 0 var(--spacing-md);
    text-decoration: none;
  }

  @media (max-width: 900px) {
    .metrics,
    .action-grid { grid-template-columns: 1fr; }
  }

  @media (max-width: 640px) {
    .diagnostic-list article { align-items: start; grid-template-columns: 1fr; }
    .diagnostic-body { padding: var(--spacing-lg); }
  }
</style>
