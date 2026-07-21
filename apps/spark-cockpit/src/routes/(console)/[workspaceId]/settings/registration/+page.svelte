<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { daemonDisplayStatus, type DaemonDisplayStatus } from "$lib/daemon-status";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { Button, Field, Input, PageHeader } from "$lib/ui";

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

  <details class="token-fallback" open>
    <summary>
      <span>
        <strong>{t.enrollment.tokenFallbackTitle}</strong>
        <small>{t.enrollment.tokenFallbackBody}</small>
      </span>
    </summary>
    <section class="panel-card fallback-card">
    {#if data.loopbackServerOrigin}
      <p class="loopback-warning" role="note">{t.enrollment.loopbackWarning}</p>
    {:else if data.insecureRemoteServerOrigin}
      <p class="loopback-warning" role="note">{t.enrollment.insecureHttpWarning}</p>
    {/if}
    <form class="token-form" method="POST" action="?/createEnrollmentToken">
      <Field id="enrollment-label" label={t.enrollment.label} reserveMeta={false}>
        <Input id="enrollment-label" name="label" placeholder={t.enrollment.labelPlaceholder} />
      </Field>
      <Button type="submit">
        <Icon name="plus" size={16} stroke={2.4} />
        <span>{t.enrollment.createToken}</span>
      </Button>
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
                <Button variant="secondary" size="compact" type="submit" disabled={status !== "ready"}>
                  {t.enrollment.revoke}
                </Button>
              </form>
            </div>
          {/each}
        </div>
      {/if}
    </article>
    </section>
  </details>

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
      {#if form?.intent === "workspaceBinding" && form?.message}
        <p class="form-message" role="status">{form.message}</p>
      {/if}
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
                <strong
                  class="binding-path"
                  class:pending={!binding.localPath}
                  title={binding.localPath ?? t.bindings.pathPending}
                >
                  <Icon name="folder" size={13} />
                  <span>{binding.localPath ?? t.bindings.pathPending}</span>
                </strong>
                <small>{binding.runtimeName} · {binding.localWorkspaceKey}</small>
              </div>
              <span class="status-pill {binding.status}">{statusLabel(binding.status)}</span>
              <time>{formatRelative(binding.updatedAt)}</time>
              <form
                method="POST"
                action="?/unbindWorkspace"
                onsubmit={(event) => {
                  if (!confirm(t.bindings.unbindConfirm)) event.preventDefault();
                }}
              >
                <input type="hidden" name="bindingId" value={binding.id} />
                <Button variant="danger" size="compact" type="submit">{t.bindings.unbind}</Button>
              </form>
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
    gap: var(--spacing-lg);
    max-width: 1120px;
    min-width: 0;
    width: 100%;
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
    border-radius: var(--rounded-lg);
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

  .device-heading {
    align-items: start;
    display: flex;
    gap: 16px;
    justify-content: space-between;
  }

  .device-heading > div {
    display: grid;
    gap: 5px;
  }

  .device-heading p,
  .token-fallback summary small {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.5;
  }

  .device-heading :global(svg) {
    color: var(--color-primary);
    flex: 0 0 auto;
  }

  .loopback-warning {
    background: var(--color-warning-weak);
    border: 1px solid var(--color-warning-soft);
    border-radius: var(--rounded-md);
    color: var(--color-warning-strong);
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
    padding: 10px 12px;
  }

  .token-fallback {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    overflow: hidden;
  }

  .token-fallback > summary {
    cursor: pointer;
    list-style: none;
    padding: 14px 16px;
  }

  .token-fallback > summary::-webkit-details-marker {
    display: none;
  }

  .token-fallback > summary span {
    display: grid;
    gap: 3px;
  }

  .token-fallback[open] > summary {
    border-bottom: 1px solid var(--color-border);
  }

  .fallback-card {
    border: 0;
    border-radius: 0;
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
    border-radius: var(--rounded-full);
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

  .token-display {
    display: grid;
    gap: 6px;
  }

  .token-display span {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 750;
  }

  .token-created,
  .form-message,
  .empty-state {
    border-radius: var(--rounded-md);
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
    border-radius: var(--rounded-md);
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
    border-radius: var(--rounded-sm);
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
    border-radius: var(--rounded-md);
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
    grid-template-columns: minmax(0, 1fr) auto auto auto;
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

  .runner-row .binding-path {
    align-items: flex-start;
    display: flex;
    gap: 6px;
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
  }

  .binding-path span {
    font-family: var(--font-mono);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .binding-path.pending span {
    color: var(--color-ink-subtle);
    font-family: inherit;
    font-style: italic;
  }

  .binding-path :global(svg) {
    flex: 0 0 auto;
    margin-top: 2px;
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
    border-radius: var(--rounded-lg);
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
    border-radius: var(--rounded-full);
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
    border-radius: var(--rounded-full);
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
