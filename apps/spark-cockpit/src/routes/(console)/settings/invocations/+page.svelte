<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { Button, Input, PageHeader } from "$lib/ui";

  let { data } = $props();

  let copy = $derived(data.messages.invocationDiagnostics);
  let common = $derived(data.messages.common);
  let diagnostics = $derived(data.diagnostics);
  let counts = $derived(diagnostics.daemon?.invocations);
  let selected = $derived(diagnostics.selected);
  let pageStart = $derived(diagnostics.list.total === 0 ? 0 : diagnostics.list.offset + 1);
  let pageEnd = $derived(
    Math.min(diagnostics.list.total, diagnostics.list.offset + diagnostics.list.invocations.length),
  );
  let previousOffset = $derived(Math.max(0, diagnostics.list.offset - diagnostics.list.limit));
  let nextOffset = $derived(diagnostics.list.offset + diagnostics.list.limit);
  let statuses = $derived([
    { value: "all", label: copy.statusAll },
    { value: "failed", label: common.status.failed },
    { value: "running", label: common.status.running },
    { value: "queued", label: common.status.queued },
    { value: "succeeded", label: common.status.succeeded },
    { value: "cancelled", label: common.status.cancelled },
  ]);

  function invocationHref(invocationId: string) {
    const query = new URLSearchParams();
    query.set("status", data.filters.status);
    if (data.filters.sessionId) query.set("session", data.filters.sessionId);
    if (data.filters.offset > 0) query.set("offset", String(data.filters.offset));
    query.set("invocation", invocationId);
    return `/settings/invocations?${query}`;
  }

  function pageHref(offset: number) {
    const query = new URLSearchParams();
    query.set("status", data.filters.status);
    if (data.filters.sessionId) query.set("session", data.filters.sessionId);
    if (offset > 0) query.set("offset", String(offset));
    return `/settings/invocations?${query}`;
  }

  function formatTime(value: string | undefined) {
    return value ? formatRelativeTime(value, data.locale, common) : common.never;
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function eventPayload(payload: Record<string, unknown>) {
    const serialized = JSON.stringify(payload, null, 2);
    return serialized.length <= 4_000 ? serialized : `${serialized.slice(0, 4_000)}\n...`;
  }
</script>

<svelte:head><title>{copy.headTitle}</title></svelte:head>

<section class="invocation-diagnostics">
  <PageHeader eyebrow={copy.eyebrow} title={copy.title} lede={copy.lede} />

  {#if !diagnostics.available}
    <div class="notice error" role="alert">
      <Icon name="warning" size={18} />
      <span><strong>{copy.daemonUnavailable}</strong><small>{diagnostics.error}</small></span>
    </div>
  {:else}
    <section class="health-band" aria-label={copy.healthAria}>
      <div><span>{common.status.queued}</span><strong>{counts?.queued ?? 0}</strong><small>{formatTime(diagnostics.daemon?.invocationHealth.oldestQueuedAt)}</small></div>
      <div><span>{common.status.running}</span><strong>{counts?.running ?? 0}</strong><small>{formatTime(diagnostics.daemon?.invocationHealth.oldestRunningAt)}</small></div>
      <div><span>{common.status.failed}</span><strong>{counts?.failed ?? 0}</strong><small>{copy.historyCount}</small></div>
      <div><span>{common.status.succeeded}</span><strong>{counts?.succeeded ?? 0}</strong><small>{copy.historyCount}</small></div>
      <div><span>{common.status.cancelled}</span><strong>{counts?.cancelled ?? 0}</strong><small>{copy.historyCount}</small></div>
    </section>
  {/if}

  <form class="filters" method="GET">
    <label>
      <span>{copy.statusFilter}</span>
      <select name="status" value={data.filters.status}>
        {#each statuses as status}
          <option value={status.value}>{status.label}</option>
        {/each}
      </select>
    </label>
    <label class="session-filter">
      <span>{copy.sessionFilter}</span>
      <Input name="session" value={data.filters.sessionId} placeholder={copy.sessionPlaceholder} />
    </label>
    <Button type="submit"><Icon name="search" size={15} />{copy.apply}</Button>
  </form>

  <div class="diagnostic-workspace" class:with-detail={Boolean(selected)}>
    <section class="invocation-list" aria-labelledby="invocation-list-title">
      <div class="section-heading">
        <div>
          <h2 id="invocation-list-title">{copy.listTitle}</h2>
          <p>{pageStart}-{pageEnd} / {diagnostics.list.total}</p>
        </div>
        <div class="pagination">
          <Button
            variant="secondary"
            size="compact"
            href={pageHref(previousOffset)}
            disabled={diagnostics.list.offset === 0}
            ariaLabel={copy.previous}
          ><Icon name="chevron" size={15} /></Button>
          <Button
            variant="secondary"
            size="compact"
            href={pageHref(nextOffset)}
            disabled={pageEnd >= diagnostics.list.total}
            ariaLabel={copy.next}
          ><Icon name="chevron" size={15} /></Button>
        </div>
      </div>

      {#if diagnostics.list.invocations.length === 0}
        <p class="empty">{copy.empty}</p>
      {:else}
        <div class="invocation-table">
          <div class="table-head" aria-hidden="true">
            <span>{copy.invocation}</span><span>{copy.session}</span><span>{copy.attempt}</span><span>{copy.updated}</span>
          </div>
          {#each diagnostics.list.invocations as invocation}
            <a
              class="invocation-row"
              class:selected={selected?.status.invocationId === invocation.invocationId}
              href={invocationHref(invocation.invocationId)}
            >
              <span class="identity">
                <code>{invocation.invocationId}</code>
                <span class="status-pill {invocation.status}">{statusLabel(invocation.status)}</span>
                {#if invocation.errorCode}<small>{invocation.errorCode}</small>{/if}
              </span>
              <code>{invocation.sessionId ?? "-"}</code>
              <span>{invocation.attemptCount}</span>
              <time>{formatTime(invocation.updatedAt)}</time>
            </a>
          {/each}
        </div>
      {/if}
    </section>

    {#if selected}
      <aside class="invocation-detail" aria-labelledby="invocation-detail-title">
        <div class="detail-heading">
          <div>
            <p>{copy.detailEyebrow}</p>
            <h2 id="invocation-detail-title"><code>{selected.status.invocationId}</code></h2>
          </div>
          <a class="close-detail" href={pageHref(data.filters.offset)} aria-label={copy.closeDetail} title={copy.closeDetail}>
            <Icon name="close" size={17} />
          </a>
        </div>
        <dl class="status-grid">
          <div><dt>{copy.statusFilter}</dt><dd><span class="status-pill {selected.status.status}">{statusLabel(selected.status.status)}</span></dd></div>
          <div><dt>{copy.session}</dt><dd><code>{selected.status.sessionId ?? "-"}</code></dd></div>
          <div><dt>{copy.cursor}</dt><dd>{selected.status.eventCursor}</dd></div>
          <div><dt>{copy.updated}</dt><dd>{formatTime(selected.status.updatedAt)}</dd></div>
          {#if selected.status.retryOfInvocationId}
            <div class="wide"><dt>{copy.retryOf}</dt><dd><code>{selected.status.retryOfInvocationId}</code></dd></div>
          {/if}
        </dl>
        {#if selected.status.error}
          <section class="failure" aria-labelledby="failure-title">
            <h3 id="failure-title">{selected.status.error.code ?? copy.failure}</h3>
            <p>{selected.status.error.message}</p>
          </section>
        {/if}
        <section class="events" aria-labelledby="events-title">
          <div class="event-heading"><h3 id="events-title">{copy.eventsTitle}</h3><span>{selected.events.events.length}</span></div>
          {#if selected.events.events.length === 0}
            <p class="empty">{copy.noEvents}</p>
          {:else}
            <div class="event-list">
              {#each selected.events.events as event}
                <details>
                  <summary><span><strong>{event.sequence}</strong>{event.kind}</span><time>{formatTime(event.createdAt)}</time></summary>
                  <pre>{eventPayload(event.payload)}</pre>
                </details>
              {/each}
            </div>
          {/if}
        </section>
      </aside>
    {/if}
  </div>
</section>

<style>
  @import "$lib/ui/status-pill.css";

  .invocation-diagnostics {
    display: grid;
    gap: var(--spacing-xl);
    min-width: 0;
    width: 100%;
  }

  .notice {
    align-items: flex-start;
    background: var(--color-danger-soft);
    border: 1px solid var(--color-danger-border);
    border-radius: var(--rounded-md);
    color: var(--color-danger-strong);
    display: flex;
    gap: var(--spacing-sm);
    padding: var(--spacing-md);
  }

  .notice span { display: grid; gap: var(--spacing-xxs); }
  .notice small { color: inherit; }

  .health-band {
    border-block: 1px solid var(--color-border);
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .health-band > div {
    display: grid;
    gap: var(--spacing-xxs);
    padding: var(--spacing-md) var(--spacing-lg);
  }

  .health-band > div + div { border-left: 1px solid var(--color-border-soft); }
  .health-band span, .health-band small { color: var(--color-ink-subtle); font-size: var(--text-caption); }
  .health-band strong { font-size: 24px; }

  .filters {
    align-items: end;
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: minmax(160px, 220px) minmax(220px, 420px) auto;
  }

  .filters label { display: grid; gap: var(--spacing-xs); }
  .filters label > span { color: var(--color-ink-muted); font-size: var(--text-caption); font-weight: 600; }
  .filters select {
    appearance: none;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    font: inherit;
    min-height: 40px;
    padding: 7px 36px 7px 11px;
  }

  .diagnostic-workspace {
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    display: grid;
    min-height: 420px;
    min-width: 0;
    overflow: hidden;
  }

  .diagnostic-workspace.with-detail { grid-template-columns: minmax(520px, 1fr) minmax(360px, 44%); }
  .invocation-list { min-width: 0; }
  .invocation-detail { border-left: 1px solid var(--color-border); min-width: 0; }

  .section-heading, .detail-heading, .event-heading {
    align-items: center;
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
  }

  .section-heading, .detail-heading { border-bottom: 1px solid var(--color-border); min-height: 58px; padding: var(--spacing-sm) var(--spacing-md); }
  .section-heading > div:first-child { display: grid; gap: 2px; }
  .section-heading h2, .detail-heading h2, .event-heading h3 { font-size: var(--text-card-title); margin: 0; }
  .section-heading p, .detail-heading p { color: var(--color-ink-subtle); font-size: var(--text-caption); margin: 0; }
  .pagination { display: flex; gap: var(--spacing-xs); }
  .pagination :global(.ui-button:first-child svg) { transform: rotate(180deg); }

  .table-head, .invocation-row {
    align-items: center;
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: minmax(260px, 1.5fr) minmax(150px, 1fr) 72px 120px;
  }

  .table-head {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 650;
    padding: 9px var(--spacing-md);
  }

  .invocation-row {
    border-top: 1px solid var(--color-border-soft);
    color: var(--color-ink-muted);
    min-height: 58px;
    padding: 8px var(--spacing-md);
    text-decoration: none;
  }

  .invocation-row:hover, .invocation-row.selected { background: var(--color-primary-weak); }
  .identity { align-items: center; display: flex; flex-wrap: wrap; gap: var(--spacing-xs); min-width: 0; }
  code { font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
  .identity small { color: var(--color-danger-strong); font-size: 11px; width: 100%; }
  .invocation-row time, .invocation-row > span { font-size: var(--text-caption); }
  .status-pill { font-size: 11px; }
  .empty { color: var(--color-ink-subtle); margin: 0; padding: var(--spacing-xl); }

  .invocation-detail { background: var(--color-surface); }
  .detail-heading p { color: var(--color-primary); font-weight: 650; text-transform: uppercase; }
  .close-detail { align-items: center; border-radius: var(--rounded-md); color: var(--color-ink-muted); display: flex; height: 32px; justify-content: center; width: 32px; }
  .close-detail:hover { background: var(--color-surface-soft); color: var(--color-ink); }

  .status-grid { display: grid; grid-template-columns: 1fr 1fr; margin: 0; }
  .status-grid > div { border-bottom: 1px solid var(--color-border-soft); display: grid; gap: var(--spacing-xxs); padding: var(--spacing-md); }
  .status-grid > div:nth-child(even) { border-left: 1px solid var(--color-border-soft); }
  .status-grid > .wide { grid-column: 1 / -1; }
  .status-grid dt { color: var(--color-ink-subtle); font-size: 11px; }
  .status-grid dd { margin: 0; }

  .failure { background: var(--color-danger-soft); border-bottom: 1px solid var(--color-danger-border); color: var(--color-danger-strong); padding: var(--spacing-md); }
  .failure h3, .failure p { margin: 0; }
  .failure h3 { font-size: var(--text-body); }
  .failure p { font-size: var(--text-caption); margin-top: var(--spacing-xs); white-space: pre-wrap; }

  .events { display: grid; gap: var(--spacing-sm); padding: var(--spacing-md); }
  .event-heading span { color: var(--color-ink-subtle); font-size: var(--text-caption); }
  .event-list { display: grid; }
  .event-list details { border-top: 1px solid var(--color-border-soft); }
  .event-list summary { align-items: center; cursor: pointer; display: flex; gap: var(--spacing-sm); justify-content: space-between; padding: 10px 0; }
  .event-list summary span { align-items: center; display: flex; font-size: var(--text-caption); gap: var(--spacing-sm); min-width: 0; }
  .event-list summary strong { color: var(--color-primary); min-width: 28px; }
  .event-list summary time { color: var(--color-ink-subtle); font-size: 11px; }
  .event-list pre { background: var(--color-surface-soft); font-size: 11px; line-height: 1.55; margin: 0 0 var(--spacing-sm); max-height: 280px; overflow: auto; padding: var(--spacing-sm); white-space: pre-wrap; }

  @media (max-width: 1120px) {
    .diagnostic-workspace.with-detail { grid-template-columns: 1fr; }
    .invocation-detail { border-left: 0; border-top: 1px solid var(--color-border); }
  }

  @media (max-width: 760px) {
    .health-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .health-band > div + div { border-left: 0; }
    .health-band > div:nth-child(even) { border-left: 1px solid var(--color-border-soft); }
    .filters { grid-template-columns: 1fr; }
    .diagnostic-workspace { overflow-x: auto; }
    .invocation-list { min-width: 680px; }
    .invocation-detail { min-width: 0; }
  }
</style>
