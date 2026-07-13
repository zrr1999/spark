<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { daemonDisplayStatus, type DaemonDisplayStatus } from "$lib/daemon-status";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import PageHeader from "$lib/ui/PageHeader.svelte";

  let { data, form } = $props();

  let t = $derived(data.messages.settings);
  let common = $derived(data.messages.common);
  let runnerSummary = $derived([
    {
      label: t.metrics.runnerConnections,
      value: data.runnerConnections.filter((runner) => daemonDisplayStatus(runner) === "online").length,
    },
    {
      label: t.metrics.workspaceBindings,
      value: data.runnerBindings.length,
    },
    {
      label: t.metrics.offlineRunners,
      value: countRunners("offline"),
    },
  ]);

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function countRunners(status: DaemonDisplayStatus) {
    return data.runnerConnections.filter((runner) => daemonDisplayStatus(runner) === status)
      .length;
  }

  function enrollmentStatus(token: {
    expiresAt: string | null;
    usedAt: string | null;
    revokedAt: string | null;
  }) {
    if (token.revokedAt) {
      return "revoked";
    }
    if (token.usedAt) {
      return "used";
    }
    if (token.expiresAt && token.expiresAt < new Date().toISOString()) {
      return "expired";
    }
    return "ready";
  }
</script>

<svelte:head>
  <title>{t.enrollment.title} · {t.headTitle}</title>
</svelte:head>

<section class="registration-page">
  <PageHeader title={t.enrollment.title} lede={t.enrollment.body} />

  <div class="summary-grid" aria-label={t.metrics.aria}>
    {#each runnerSummary as item}
      <article class="summary-card">
        <span>{item.label}</span>
        <strong>{item.value}</strong>
      </article>
    {/each}
  </div>

  <section class="panel-card">
    <form class="token-form" method="POST" action="?/createEnrollmentToken">
      <label>
        <span>{t.enrollment.label}</span>
        <input name="label" placeholder={t.enrollment.labelPlaceholder} />
      </label>
      <button class="primary-action" type="submit">
        <Icon name="plus" size={16} stroke={2.4} />
        <span>{t.enrollment.createToken}</span>
      </button>
    </form>

    {#if form?.intent === "runnerEnrollment" && form?.enrollCommand}
      <div class="token-created" aria-label={t.enrollment.tokenCreatedAria}>
        <div>
          <strong>{t.enrollment.tokenCreatedTitle}</strong>
          <p>{form.message}</p>
          <p>{t.enrollment.tokenCreatedHint}</p>
        </div>
        <div class="token-display">
          <span>{t.enrollment.commandLabel}</span>
          <pre>{form.enrollCommand}</pre>
        </div>
        <small>{t.enrollment.expiresPrefix} {formatRelative(form.enrollmentExpiresAt ?? null)}</small>
      </div>
    {:else if form?.intent === "runnerEnrollment" && form?.message}
      <p class="form-message" role="alert">{form.message}</p>
    {/if}

    <article class="token-table">
      <div class="table-heading">
        <h3>{t.enrollment.tableTitle}</h3>
        <span>{data.enrollmentTokens.length} {t.enrollment.tableCount}</span>
      </div>
      {#if data.enrollmentTokens.length === 0}
        <div class="empty-state">
          <Icon name="play" size={20} />
          <div>
            <strong>{t.enrollment.emptyTitle}</strong>
            <p>{t.enrollment.emptyBody}</p>
          </div>
        </div>
      {:else}
        <div class="token-list">
          {#each data.enrollmentTokens as token}
            {@const status = enrollmentStatus(token)}
            <div class="token-row">
              <div>
                <strong>{token.label ?? t.enrollment.defaultTokenLabel}</strong>
              </div>
              <span class="status-pill {status}">{statusLabel(status)}</span>
              <span>
                <small>{t.enrollment.runner}</small>
                {token.runtimeName ?? t.enrollment.notUsed}
              </span>
              <time>
                <small>{t.enrollment.created}</small>
                {formatRelative(token.createdAt)}
              </time>
              <time>
                <small>{t.enrollment.expires}</small>
                {formatRelative(token.expiresAt)}
              </time>
              <form method="POST" action="?/revokeEnrollmentToken">
                <input type="hidden" name="tokenId" value={token.id} />
                <button class="secondary-action compact" type="submit" disabled={status !== "ready"}>
                  {t.enrollment.revoke}
                </button>
              </form>
            </div>
          {/each}
        </div>
      {/if}
    </article>
  </section>

  <details class="connection-diagnostics">
    <summary><span><strong>{t.runner.kicker}</strong><small>{t.runner.routesLabel}</small></span></summary>
    <section class="connections-grid" aria-label={t.navigation.connections}>
    <article class="panel-card">
      <div class="table-heading">
        <div>
          <h2>{t.runner.title}</h2>
        </div>
        <span>{t.runner.badge}</span>
      </div>
      {#if data.runnerConnections.length === 0}
        <div class="empty-state">
          <Icon name="activity" size={20} />
          <div>
            <strong>{t.runner.emptyTitle}</strong>
            <p>{t.runner.emptyBody} <code>/api/v1/runtime/runtimes/register</code>.</p>
          </div>
        </div>
      {:else}
        <div class="runner-list">
          {#each data.runnerConnections as runner}
            {@const displayStatus = daemonDisplayStatus(runner)}
            <div class="runner-row">
              <span class="status-dot {displayStatus}" aria-hidden="true"></span>
              <div>
                <strong>{runner.name}</strong>
                <small>{runner.installationId ?? t.runner.installationMissing}</small>
              </div>
              <span class="status-pill {displayStatus}">{statusLabel(displayStatus)}</span>
              <time>{formatRelative(runner.lastHeartbeatAt ?? runner.updatedAt)}</time>
            </div>
          {/each}
        </div>
      {/if}
    </article>

    <article class="panel-card">
      <div class="table-heading">
        <div>
          <h2>{t.bindings.title}</h2>
        </div>
        <span>{data.runnerBindings.length}</span>
      </div>
      {#if data.runnerBindings.length === 0}
        <div class="empty-state">
          <Icon name="folder" size={20} />
          <div>
            <strong>{t.bindings.emptyTitle}</strong>
            <p>{t.bindings.empty} <code>runtime.hello</code> {t.bindings.emptyRest}</p>
          </div>
        </div>
      {:else}
        <div class="runner-list">
          {#each data.runnerBindings as binding}
            <div class="runner-row binding-row">
              <div>
                <strong>{binding.displayName}</strong>
                <small>{binding.runtimeName} · {binding.localWorkspaceKey}</small>
              </div>
              <span class="status-pill {binding.status}">{statusLabel(binding.status)}</span>
              <time>{formatRelative(binding.updatedAt)}</time>
            </div>
          {/each}
        </div>
      {/if}
    </article>
    </section>
  </details>
</section>

<style>
  .registration-page {
    display: grid;
    gap: 18px;
    max-width: 1120px;
    min-width: 0;
    width: 100%;
  }

  .eyebrow {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0;
    margin: 0 0 8px;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    color: var(--color-ink);
    font-size: 18px;
    line-height: 1.3;
  }

  h3 {
    color: var(--color-ink);
    font-size: 15px;
    line-height: 1.35;
  }

  .empty-state p,
  .token-created p,
  .token-created small,
  .runner-row small,
  .token-row small {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.5;
  }

  .summary-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .summary-card,
  .panel-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .summary-card {
    display: grid;
    gap: 5px;
    padding: 14px 16px;
  }

  .summary-card span {
    color: var(--color-ink-muted);
    font-size: 13px;
    font-weight: 650;
  }

  .summary-card strong {
    color: var(--color-ink);
    font-size: 24px;
    line-height: 1;
  }

  .panel-card {
    display: grid;
    gap: 14px;
    padding: 16px;
  }

  .panel-heading,
  .table-heading {
    align-items: center;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }

  .table-heading span {
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    font-size: 11px;
    font-weight: 800;
    padding: 4px 8px;
    white-space: nowrap;
  }

  .token-form {
    align-items: end;
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(220px, 1fr) auto;
  }

  .token-form label,
  .token-display {
    display: grid;
    gap: 6px;
  }

  .token-form label span,
  .token-display span {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 750;
  }

  input {
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    color: var(--color-ink);
    font: inherit;
    min-height: 40px;
    padding: 0 11px;
  }

  input:focus-visible {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .primary-action,
  .secondary-action {
    align-items: center;
    border-radius: 8px;
    display: inline-flex;
    font-weight: 750;
    gap: 6px;
    height: 40px;
    justify-content: center;
    padding: 0 14px;
    text-decoration: none;
    white-space: nowrap;
  }

  .primary-action {
    background: var(--color-primary);
    border: 0;
    color: var(--color-surface);
  }

  .secondary-action {
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    color: var(--color-ink-muted);
  }

  .secondary-action.compact {
    font-size: 13px;
    height: 30px;
  }

  button:disabled {
    color: var(--color-ink-disabled);
    cursor: not-allowed;
    opacity: 0.65;
  }

  .token-created,
  .form-message,
  .empty-state {
    border-radius: 8px;
    padding: 12px;
  }

  .token-created {
    background: var(--color-canvas);
    border: 1px solid var(--color-border-strong);
    display: grid;
    gap: 10px;
    min-width: 0;
  }

  .token-created pre,
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .token-created pre {
    background: var(--color-ink);
    border-radius: 8px;
    color: var(--color-border);
    font-size: 12px;
    line-height: 1.55;
    margin: 0;
    overflow-x: auto;
    padding: 12px;
    white-space: pre-wrap;
  }

  code {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border);
    border-radius: 5px;
    color: var(--color-ink-muted);
    font-size: 0.92em;
    padding: 1px 5px;
  }

  .form-message {
    background: var(--color-warning-weak);
    border: 1px solid var(--color-warning-soft);
    color: var(--color-warning-strong);
    font-size: 13px;
  }

  .token-table {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    display: grid;
    overflow: hidden;
  }

  .token-table > .table-heading {
    background: var(--color-canvas);
    border-bottom: 1px solid var(--color-border);
    min-height: 38px;
    padding: 0 12px;
  }

  .token-list,
  .runner-list {
    display: grid;
  }

  .token-row,
  .runner-row {
    align-items: center;
    display: grid;
    gap: 10px;
    min-height: 54px;
    padding: 10px 12px;
  }

  .token-row {
    grid-template-columns: minmax(0, 1.3fr) auto minmax(96px, 0.8fr) auto auto auto;
  }

  .runner-row {
    grid-template-columns: 10px minmax(0, 1fr) auto auto;
  }

  .binding-row {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .token-row + .token-row,
  .runner-row + .runner-row {
    border-top: 1px solid var(--color-border);
  }

  .token-row > div,
  .runner-row > div,
  .token-row > span,
  .token-row time {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .token-row strong,
  .token-row small,
  .token-row span,
  .runner-row strong,
  .runner-row small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty-state {
    align-items: start;
    display: grid;
    gap: 10px;
    grid-template-columns: 28px minmax(0, 1fr);
  }

  .empty-state :global(svg) {
    color: var(--color-primary);
    margin-top: 2px;
  }

  .connections-grid {
    display: grid;
    gap: 14px;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    padding: 16px;
  }

  .connection-diagnostics {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .connection-diagnostics > summary {
    cursor: pointer;
    list-style: none;
    padding: 14px 16px;
  }

  .connection-diagnostics > summary::-webkit-details-marker {
    display: none;
  }

  .connection-diagnostics > summary span {
    display: grid;
    gap: 3px;
  }

  .connection-diagnostics > summary small {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 400;
  }

  .connection-diagnostics[open] > summary {
    border-bottom: 1px solid var(--color-border);
  }

  .status-pill {
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 800;
    padding: 4px 8px;
    text-transform: capitalize;
  }

  .status-pill.online,
  .status-pill.available,
  .status-pill.used {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  .status-pill.offline,
  .status-pill.disabled,
  .status-pill.revoked,
  .status-pill.expired,
  .status-pill.unavailable,
  .status-pill.archived {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .status-pill.ready,
  .status-pill.registered,
  .status-pill.draining,
  .status-pill.indexing {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill.degraded {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .status-dot {
    background: var(--color-ink-disabled);
    border-radius: 999px;
    height: 9px;
    width: 9px;
  }

  .status-dot.online {
    background: var(--color-success);
    box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.12);
  }

  .status-dot.registered,
  .status-dot.draining {
    background: var(--color-primary);
    box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
  }

  .status-dot.disabled {
    background: var(--color-danger);
    box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.1);
  }

  time {
    color: var(--color-ink-muted);
    font-size: 12px;
    white-space: nowrap;
  }

  @media (max-width: 980px) {
    .summary-grid,
    .connections-grid {
      grid-template-columns: 1fr;
    }

    .token-row {
      align-items: start;
      grid-template-columns: minmax(0, 1fr) auto;
    }
  }

  @media (max-width: 640px) {
    .panel-heading,
    .table-heading,
    .token-form {
      align-items: stretch;
      display: grid;
      grid-template-columns: 1fr;
    }

    .token-row,
    .runner-row,
    .binding-row {
      align-items: start;
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
