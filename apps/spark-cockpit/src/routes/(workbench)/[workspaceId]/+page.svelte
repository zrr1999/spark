<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { daemonDisplayStatus, type DaemonDisplayStatus } from "$lib/daemon-status";
  import { workspaceControlDisplay } from "$lib/workspace-control-display";
  import { workspacePath } from "$lib/workspace-routes";

  let { data } = $props();

  let t = $derived(data.messages.home);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(
    data.workspaces[0] ? workspacePath(data.workspaces[0]) : "/",
  );
  let availableRunnerBindings = $derived(
    data.runnerBindings.filter(
      (binding) =>
        binding.status === "available" && binding.runtimeStatus === "online",
    ),
  );
  const runnerStatusOrder: DaemonDisplayStatus[] = [
    "online",
    "registered",
    "offline",
    "draining",
    "disabled",
  ];
  let controlDisplay = $derived(
    workspaceControlDisplay(data.workspaceControl, t.workspaceControl),
  );

  function countRunners(status: (typeof runnerStatusOrder)[number]) {
    return data.runnerConnections.filter((runner) => daemonDisplayStatus(runner) === status)
      .length;
  }

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }
</script>

<svelte:head>
  <title>{data.workspaces.length === 0 ? t.emptyHeadTitle : t.headTitle}</title>
</svelte:head>

<section class="hero" aria-labelledby="home-title">
  <div>
    <p class="eyebrow">
      {data.workspaces.length === 0
        ? t.noWorkspaceHero.eyebrow
        : t.hero.eyebrow}
    </p>
    <h1 id="home-title">
      {data.workspaces.length === 0 ? t.noWorkspaceHero.title : t.hero.title}
    </h1>
    <p class="lede">
      {data.workspaces.length === 0 ? t.noWorkspaceHero.lede : t.hero.lede}
    </p>
  </div>
  <div class="hero-actions">
    <a class="secondary-action" href={`${workspaceUrl}/settings`}
      >{t.hero.openSettings}</a
    >
  </div>
</section>

<section class="control-strip" aria-label={t.workspaceControl.aria}>
  <div class="control-summary">
    <span class="control-kicker">{t.workspaceControl.aria}</span>
    <strong>{controlDisplay.controlLabel}</strong>
  </div>
  <div class="control-status-list">
    <span class="control-chip {data.workspaceControl.connection.status}">
      <span class="control-chip-dot" aria-hidden="true"></span>
      {controlDisplay.connectionLabel}
    </span>
    <span
      class="control-chip {data.workspaceControl.borrowed?.borrowed ? 'borrowed' : 'available'}"
    >
      <span class="control-chip-dot" aria-hidden="true"></span>
      {controlDisplay.borrowedLabel}
    </span>
    <span class="control-chip executor-{data.workspaceControl.executor?.state ?? 'none'}">
      <span class="control-chip-dot" aria-hidden="true"></span>
      {controlDisplay.executorLabel}
    </span>
  </div>
</section>

<section class="metrics" aria-label={t.metrics.aria}>
  <article class="metric orange featured">
    <div class="metric-icon"><Icon name="inbox" size={28} /></div>
    <div>
      <span>{t.metrics.pendingInbox}</span>
      <strong>0</strong>
      <small>{t.metrics.pendingInboxHint}</small>
    </div>
  </article>
  <article class="metric blue">
    <div class="metric-icon"><Icon name="folder" size={28} /></div>
    <div>
      <span>{t.metrics.workspaces}</span>
      <strong>{data.workspaces.length}</strong>
      <small>{data.ownerBindings.length} {common.boundToRunner}</small>
    </div>
  </article>
  <article class="metric green">
    <div class="metric-icon"><Icon name="activity" size={28} /></div>
    <div>
      <span>{t.metrics.runnerConnections}</span>
      <strong>{data.runnerConnections.length}</strong>
      <small
        >{countRunners("online")}
        {common.online} · {data.connectedSessionCount}
        {common.activeWs}</small
      >
    </div>
  </article>
  <article class="metric purple">
    <div class="metric-icon"><Icon name="cube" size={28} /></div>
    <div>
      <span>{t.metrics.workspaceBindings}</span>
      <strong>{data.runnerBindings.length}</strong>
      <small>{common.reportedByConnectedRunners}</small>
    </div>
  </article>
</section>

<section class="dashboard-grid">
  <section class="panel primary-panel" aria-labelledby="workspace-title">
    <div class="panel-header">
      <div>
        <p class="panel-kicker">{t.panels.projectionState}</p>
        <h2 id="workspace-title">{t.panels.workspaces}</h2>
      </div>
      <span class="panel-badge">{t.panels.sqliteBacked}</span>
    </div>

    {#if data.workspaces.length === 0}
      <div class="empty-state">
        <div class="empty-icon"><Icon name="folder" size={34} /></div>
        <h3>{t.emptyWorkspace.title}</h3>
        <p>
          {t.emptyWorkspace.body}
        </p>
        <div class="steps" aria-label={t.emptyWorkspace.stepsAria}>
          {#each t.emptyWorkspace.steps as step, index}
            <article>
              <span>{index + 1}</span>
              <div>
                <h4>{step.title}</h4>
                <p>
                  {step.description}
                </p>
              </div>
            </article>
          {/each}
          {#if availableRunnerBindings.length > 0}
            <form
              class="workspace-create-form"
              method="POST"
              action="?/createWorkspace"
            >
              <label>
                <span>{t.emptyWorkspace.form.name}</span>
                <input
                  name="name"
                  value={availableRunnerBindings[0].displayName}
                  required
                />
              </label>
              <label>
                <span>{t.emptyWorkspace.form.slug}</span>
                <input
                  name="slug"
                  value={availableRunnerBindings[0].localWorkspaceKey}
                  required
                />
              </label>
              <label>
                <span>{t.emptyWorkspace.form.runnerBinding}</span>
                <select name="runtimeWorkspaceBindingId" required>
                  {#each availableRunnerBindings as binding}
                    <option value={binding.id}
                      >{binding.displayName} · {binding.runtimeName}</option
                    >
                  {/each}
                </select>
              </label>
              <button class="primary-action" type="submit"
                >{t.emptyWorkspace.form.submit}</button
              >
            </form>
          {:else}
            <button class="disabled-action" type="button" disabled>
              <span>{t.emptyWorkspace.action}</span>
              <small class="soon-badge">{common.comingSoon}</small>
            </button>
          {/if}
        </div>
      </div>
    {:else}
      <div class="workspace-list">
        {#each data.workspaces as workspace}
          <article class="workspace-row">
            <div class="row-icon"><Icon name="folder" size={24} /></div>
            <div>
              <h3>{workspace.name}</h3>
              <p>{workspace.description ?? `/${workspace.slug}`}</p>
            </div>
            <span class="status-pill {workspace.status}"
              >{statusLabel(workspace.status)}</span
            >
            <time>{t.updatedPrefix} {formatRelative(workspace.updatedAt)}</time>
          </article>
        {/each}
      </div>
    {/if}
  </section>

  <aside class="panel side-panel" aria-labelledby="connections-title">
    <div class="panel-header compact">
      <div>
        <p class="panel-kicker">{t.panels.settingsConnections}</p>
        <h2 id="connections-title">{t.panels.runnerHealth}</h2>
      </div>
    </div>

    {#if data.runnerConnections.length === 0}
      <div class="compact-empty">
        <div class="empty-icon small"><Icon name="activity" size={24} /></div>
        <h3>{t.runnerEmpty.title}</h3>
        <p>{t.runnerEmpty.body} <code>{t.runnerEmpty.code}</code>.</p>
      </div>
    {:else}
      <div class="connection-list">
        {#each data.runnerConnections as runner}
          {@const displayStatus = daemonDisplayStatus(runner)}
          <article class="connection-row {displayStatus}">
            <div class="connection-dot" aria-hidden="true"></div>
            <div>
              <h3>{runner.name}</h3>
              <p>{runner.protocolVersion ?? t.protocolPending}</p>
            </div>
            <span
              >{formatRelative(
                runner.lastHeartbeatAt ?? runner.updatedAt,
              )}</span
            >
          </article>
        {/each}
      </div>
    {/if}
  </aside>
</section>

<section class="lower-grid">
  <section class="panel" aria-labelledby="bindings-title">
    <div class="panel-header compact">
      <div>
        <p class="panel-kicker">{t.panels.runnerOwnedTruth}</p>
        <h2 id="bindings-title">{t.panels.workspaceBindings}</h2>
      </div>
    </div>

    {#if data.runnerBindings.length === 0}
      <div class="compact-empty horizontal">
        <div class="empty-icon small"><Icon name="cube" size={24} /></div>
        <p>{t.bindingsEmpty}</p>
      </div>
    {:else}
      <div class="binding-list">
        {#each data.runnerBindings as binding}
          <article class="binding-row {binding.status}">
            <div>
              <h3>{binding.displayName}</h3>
              <p>{binding.runtimeName} · {binding.localWorkspaceKey}</p>
            </div>
            <span class="status-pill {binding.status}"
              >{statusLabel(binding.status)}</span
            >
            <time
              >{formatRelative(
                binding.lastSnapshotAt ?? binding.updatedAt,
              )}</time
            >
          </article>
        {/each}
      </div>
    {/if}
  </section>

  <section class="panel" aria-labelledby="events-title">
    <div class="panel-header compact">
      <div>
        <p class="panel-kicker">{t.panels.appendOnlyAudit}</p>
        <h2 id="events-title">{t.panels.recentEvents}</h2>
      </div>
    </div>

    {#if data.recentEvents.length === 0}
      <div class="compact-empty horizontal">
        <div class="empty-icon small"><Icon name="archive" size={24} /></div>
        <p>{t.eventsEmpty}</p>
      </div>
    {:else}
      <div class="event-list">
        {#each data.recentEvents as event}
          <article class="event-row">
            <div class="event-icon"><Icon name="archive" size={18} /></div>
            <div>
              <h3>{event.kind}</h3>
              <p>
                {event.actorKind}{event.subjectKind
                  ? ` · ${event.subjectKind}`
                  : ""}
              </p>
            </div>
            <time>{formatRelative(event.createdAt)}</time>
          </article>
        {/each}
      </div>
    {/if}
  </section>
</section>

<style>
  .hero {
    align-items: center;
    display: flex;
    gap: 24px;
    justify-content: space-between;
    margin-bottom: 26px;
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
  h4,
  p {
    margin: 0;
  }

  h1 {
    color: var(--color-ink);
    font-size: 34px;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }

  .lede {
    color: var(--color-ink-subtle);
    line-height: 1.6;
    margin-top: 10px;
    max-width: 760px;
  }

  .hero-actions {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    gap: 12px;
  }

  .primary-action,
  .secondary-action {
    align-items: center;
    border-radius: 12px;
    display: inline-flex;
    font-weight: 750;
    height: 44px;
    justify-content: center;
    padding: 0 16px;
    text-decoration: none;
    white-space: nowrap;
  }

  .primary-action {
    background: var(--color-primary);
    color: var(--color-surface);
  }

  .secondary-action {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
  }

  .disabled-action {
    align-items: center;
    background: var(--color-canvas);
    border: 1px dashed var(--color-border-strong);
    border-radius: 12px;
    color: var(--color-ink-subtle);
    cursor: not-allowed;
    display: inline-flex;
    font: inherit;
    font-weight: 800;
    gap: 8px;
    height: 42px;
    justify-content: center;
    justify-self: start;
    padding: 0 14px;
  }

  .disabled-action .soon-badge {
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    font-size: 11px;
    font-weight: 800;
    padding: 4px 8px;
    white-space: nowrap;
  }

  .metrics {
    display: grid;
    gap: 18px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-bottom: 24px;
  }

  .metric,
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: var(--shadow-card-raised);
  }

  .metric {
    align-items: center;
    display: flex;
    gap: 20px;
    min-height: 138px;
    padding: 24px;
  }

  .metric.featured {
    background: var(--color-warning-weak);
    border-color: var(--color-warning-soft);
  }

  .metric-icon,
  .empty-icon,
  .row-icon,
  .event-icon {
    align-items: center;
    border-radius: 999px;
    display: grid;
    flex: 0 0 auto;
    place-items: center;
  }

  .metric-icon {
    height: 64px;
    width: 64px;
  }

  .metric span {
    color: var(--color-ink-subtle);
    display: block;
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .metric strong {
    color: var(--color-ink);
    display: block;
    font-size: 34px;
    line-height: 1;
    margin-bottom: 12px;
  }

  .metric small {
    color: var(--color-ink-subtle);
    font-size: 13px;
  }

  .blue .metric-icon,
  .blue .row-icon {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .green .metric-icon {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  .orange .metric-icon {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .purple .metric-icon {
    background: var(--color-purple-soft);
    color: var(--color-purple);
  }

  .control-strip {
    align-items: center;
    background: linear-gradient(135deg, var(--color-surface), var(--color-surface-soft));
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: var(--shadow-card);
    display: grid;
    gap: 18px;
    grid-template-columns: minmax(220px, 0.8fr) minmax(0, 1.6fr);
    margin: 0 0 24px;
    padding: 16px 18px;
  }

  .control-summary {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  .control-kicker {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .control-summary strong {
    color: var(--color-ink);
    font-size: 16px;
    line-height: 1.35;
  }

  .control-status-list {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: flex-end;
    min-width: 0;
  }

  .control-chip {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: 13px;
    font-weight: 750;
    gap: 8px;
    min-height: 34px;
    padding: 0 12px;
    white-space: nowrap;
  }

  .control-chip-dot {
    background: var(--color-ink-disabled);
    border-radius: 999px;
    height: 8px;
    width: 8px;
  }

  .control-chip.connected,
  .control-chip.available,
  .control-chip.executor-online {
    background: var(--color-success-soft);
    border-color: color-mix(in srgb, var(--color-success) 24%, transparent);
    color: var(--color-success);
  }

  .control-chip.connected .control-chip-dot,
  .control-chip.available .control-chip-dot,
  .control-chip.executor-online .control-chip-dot {
    background: var(--color-success);
  }

  .control-chip.disconnected,
  .control-chip.executor-none {
    background: var(--color-surface);
    color: var(--color-ink-subtle);
  }

  .control-chip.borrowed,
  .control-chip.executor-starting {
    background: var(--color-warning-weak);
    border-color: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .control-chip.borrowed .control-chip-dot,
  .control-chip.executor-starting .control-chip-dot {
    background: var(--color-warning);
  }

  .control-chip.executor-unhealthy {
    background: var(--color-danger-soft);
    border-color: color-mix(in srgb, var(--color-danger) 22%, transparent);
    color: var(--color-danger);
  }

  .control-chip.executor-unhealthy .control-chip-dot {
    background: var(--color-danger);
  }

  .dashboard-grid {
    align-items: start;
    display: grid;
    gap: 24px;
    grid-template-columns: minmax(0, 1fr) 400px;
    margin-bottom: 24px;
  }

  .lower-grid {
    display: grid;
    gap: 24px;
    grid-template-columns: 1fr 1fr;
  }

  .panel-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    gap: 16px;
    justify-content: space-between;
    padding: 24px 28px;
  }

  .panel-header.compact {
    padding: 22px 24px;
  }

  h2 {
    color: var(--color-ink);
    font-size: 18px;
  }

  .panel-badge {
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
  }

  .empty-state {
    display: grid;
    justify-items: center;
    padding: 54px 42px 46px;
    text-align: center;
  }

  .empty-icon {
    background: var(--color-primary-weak);
    color: var(--color-primary);
    height: 72px;
    margin-bottom: 20px;
    width: 72px;
  }

  .empty-icon.small {
    height: 46px;
    margin: 0;
    width: 46px;
  }

  .empty-state h3,
  .compact-empty h3 {
    color: var(--color-ink);
    font-size: 18px;
    margin-bottom: 10px;
  }

  .empty-state > p,
  .compact-empty p,
  .workspace-row p,
  .binding-row p,
  .connection-row p,
  .event-row p,
  .steps p {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.55;
  }

  .empty-state > p {
    max-width: 680px;
  }

  code {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-ink-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.92em;
    padding: 1px 5px;
  }

  .steps {
    display: grid;
    gap: 14px;
    margin-top: 30px;
    max-width: 780px;
    text-align: left;
    width: 100%;
  }

  .steps article {
    align-items: flex-start;
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    display: flex;
    gap: 14px;
    padding: 16px;
  }

  .steps span {
    background: var(--color-primary);
    border-radius: 999px;
    color: var(--color-surface);
    display: grid;
    flex: 0 0 auto;
    font-size: 12px;
    font-weight: 850;
    height: 26px;
    place-items: center;
    width: 26px;
  }

  .steps h4 {
    color: var(--color-ink);
    font-size: 14px;
    margin-bottom: 4px;
  }

  .workspace-create-form {
    background: var(--color-surface);
    border: 1px solid var(--color-primary-soft);
    border-radius: 16px;
    display: grid;
    gap: 14px;
    grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
    padding: 16px;
  }

  .workspace-create-form label {
    display: grid;
    gap: 6px;
  }

  .workspace-create-form label span {
    background: transparent;
    color: var(--color-ink-subtle);
    display: block;
    font-size: 12px;
    font-weight: 750;
    height: auto;
    text-transform: uppercase;
    width: auto;
  }

  .workspace-create-form input,
  .workspace-create-form select {
    background: var(--color-canvas);
    border: 1px solid var(--color-border-strong);
    border-radius: 10px;
    color: var(--color-ink);
    font: inherit;
    min-height: 42px;
    padding: 0 12px;
  }

  .workspace-create-form .primary-action {
    align-self: end;
    border: 0;
    cursor: pointer;
  }

  .compact-empty {
    display: grid;
    gap: 14px;
    padding: 28px 24px;
  }

  .compact-empty.horizontal {
    align-items: center;
    display: flex;
  }

  .workspace-list,
  .binding-list,
  .event-list,
  .connection-list {
    display: grid;
    padding: 18px;
  }

  .workspace-row,
  .binding-row,
  .event-row,
  .connection-row {
    align-items: center;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    display: grid;
    gap: 16px;
    padding: 16px;
  }

  .workspace-row {
    grid-template-columns: 52px minmax(0, 1fr) auto auto;
  }

  .binding-row {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .event-row {
    grid-template-columns: 42px minmax(0, 1fr) auto;
  }

  .connection-row {
    grid-template-columns: 12px minmax(0, 1fr) auto;
  }

  .workspace-row + .workspace-row,
  .binding-row + .binding-row,
  .event-row + .event-row,
  .connection-row + .connection-row {
    margin-top: 10px;
  }

  .row-icon,
  .event-icon {
    background: var(--color-primary-weak);
    color: var(--color-primary);
    height: 42px;
    width: 42px;
  }

  .workspace-row h3,
  .binding-row h3,
  .connection-row h3,
  .event-row h3 {
    color: var(--color-ink);
    font-size: 15px;
    line-height: 1.4;
  }

  .status-pill {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
    text-transform: capitalize;
    white-space: nowrap;
  }

  .status-pill.active,
  .status-pill.available,
  .status-pill.online {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  .status-pill.archived,
  .status-pill.unavailable,
  .status-pill.offline,
  .status-pill.disabled {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .status-pill.indexing,
  .status-pill.registered,
  .status-pill.draining {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill.degraded {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  time,
  .connection-row span {
    color: var(--color-ink-subtle);
    font-size: 12px;
    white-space: nowrap;
  }

  .connection-dot {
    background: var(--color-ink-disabled);
    border-radius: 999px;
    height: 10px;
    width: 10px;
  }

  .connection-row.online .connection-dot {
    background: var(--color-success);
    box-shadow: 0 0 0 5px rgba(22, 163, 74, 0.12);
  }

  .connection-row.registered .connection-dot,
  .connection-row.draining .connection-dot {
    background: var(--color-primary);
    box-shadow: 0 0 0 5px rgba(37, 99, 235, 0.12);
  }

  .connection-row.disabled .connection-dot {
    background: var(--color-danger);
    box-shadow: 0 0 0 5px rgba(239, 68, 68, 0.1);
  }

  @media (max-width: 1280px) {
    .metrics,
    .dashboard-grid,
    .lower-grid {
      grid-template-columns: 1fr 1fr;
    }

    .primary-panel {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 900px) {
    .hero,
    .hero-actions {
      align-items: flex-start;
      flex-direction: column;
    }

    .metrics,
    .dashboard-grid,
    .lower-grid {
      grid-template-columns: 1fr;
    }

    .control-strip {
      align-items: flex-start;
      grid-template-columns: 1fr;
    }

    .control-status-list {
      justify-content: flex-start;
    }

    .control-chip {
      white-space: normal;
    }

    .workspace-row,
    .binding-row,
    .event-row,
    .connection-row {
      align-items: flex-start;
      grid-template-columns: 1fr;
    }
  }

  :global(.setup-content) .metrics,
  :global(.setup-content) .lower-grid {
    display: none;
  }

  :global(.setup-content) .hero {
    align-items: flex-end;
    margin: 0 auto 32px;
    max-width: 1180px;
  }

  :global(.setup-content) .dashboard-grid {
    grid-template-columns: minmax(0, 760px) minmax(320px, 420px);
    justify-content: center;
    margin-bottom: 0;
  }

  :global(.setup-content) .primary-panel {
    grid-column: auto;
  }

  @media (max-width: 900px) {
    :global(.setup-content) .dashboard-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
