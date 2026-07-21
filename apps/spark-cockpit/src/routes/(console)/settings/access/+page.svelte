<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { Button, Field, Input, PageHeader } from "$lib/ui";

  let { data, form } = $props();

  let t = $derived(data.messages.settings);
  let common = $derived(data.messages.common);

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function accessStatus(token: {
    expiresAt: string | null;
    usedAt: string | null;
    revokedAt: string | null;
  }) {
    if (token.revokedAt) return "revoked";
    if (token.usedAt) return "used";
    if (token.expiresAt && token.expiresAt < new Date().toISOString()) return "expired";
    return "ready";
  }
</script>

<svelte:head>
  <title>{t.access.title} · {t.headTitle}</title>
</svelte:head>

<section class="access-page">
  <PageHeader title={t.access.title} lede={t.access.body} />

  <section class="panel-card">
    <div class="device-heading">
      <div>
        <h2>{t.access.createHeading}</h2>
        <p>{t.access.createBody}</p>
      </div>
      <Icon name="user" size={20} />
    </div>

    <form class="token-form" method="POST" action="?/createAccessToken">
      <Field id="access-label" label={t.access.label} reserveMeta={false}>
        <Input id="access-label" name="label" placeholder={t.access.labelPlaceholder} />
      </Field>
      <Button type="submit">
        <Icon name="plus" size={16} stroke={2.4} />
        <span>{t.access.createToken}</span>
      </Button>
    </form>

    {#if form?.intent === "cockpitAccess" && form?.accessToken}
      <div class="token-created">
        <div>
          <strong>{t.access.tokenCreatedTitle}</strong>
          <p>{form.message}</p>
        </div>
        <div class="token-display">
          <span>{t.access.loginUrl}</span>
          <pre>{form.loginUrl}</pre>
        </div>
        <div class="token-display">
          <span>{t.access.oneTimeToken}</span>
          <pre>{form.accessToken}</pre>
        </div>
        <small>{t.access.expiresPrefix} {formatRelative(form.accessExpiresAt ?? null)}</small>
      </div>
    {:else if form?.intent === "cockpitAccess" && form?.message}
      <p class="form-message" role="alert">{form.message}</p>
    {/if}

    <article class="token-table">
      <div class="table-heading">
        <h3>{t.access.tableTitle}</h3>
        <span>{data.accessTokens.length} {t.access.tableCount}</span>
      </div>
      {#if data.accessTokens.length === 0}
        <div class="empty-state">
          <Icon name="user" size={20} />
          <div>
            <strong>{t.access.emptyTitle}</strong>
            <p>{t.access.emptyBody}</p>
          </div>
        </div>
      {:else}
        <div class="token-list">
          {#each data.accessTokens as token}
            {@const status = accessStatus(token)}
            <div class="token-row">
              <div>
                <strong>{token.label ?? t.access.defaultTokenLabel}</strong>
              </div>
              <span class="status-pill {status}">{statusLabel(status)}</span>
              <time><small>{t.enrollment.created}</small>{formatRelative(token.createdAt)}</time>
              <time><small>{t.enrollment.expires}</small>{formatRelative(token.expiresAt)}</time>
              <form method="POST" action="?/revokeAccessToken">
                <input type="hidden" name="tokenId" value={token.id} />
                <Button variant="secondary" size="compact" type="submit" disabled={status !== "ready"}>
                  {t.access.revoke}
                </Button>
              </form>
            </div>
          {/each}
        </div>
      {/if}
    </article>
  </section>
</section>

<style>
  .access-page {
    display: grid;
    gap: var(--spacing-lg);
    max-width: 880px;
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

  .panel-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    display: grid;
    gap: 14px;
    padding: 16px;
  }

  .device-heading {
    align-items: start;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }

  .device-heading p,
  .empty-state p,
  .token-created p,
  .token-created small,
  .token-row small {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.5;
  }

  .token-form {
    align-items: end;
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .token-created,
  .empty-state,
  .token-row {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
  }

  .token-created {
    display: grid;
    gap: 12px;
    padding: 14px;
  }

  .token-display {
    display: grid;
    gap: 6px;
  }

  .token-display span {
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 650;
  }

  .token-display pre {
    margin: 0;
    overflow-x: auto;
    padding: 10px 12px;
    border-radius: var(--rounded-sm);
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .token-table {
    display: grid;
    gap: 12px;
  }

  .table-heading {
    align-items: baseline;
    display: flex;
    gap: 10px;
    justify-content: space-between;
  }

  .table-heading span {
    color: var(--color-ink-muted);
    font-size: 13px;
  }

  .empty-state {
    align-items: start;
    display: flex;
    gap: 12px;
    padding: 14px;
  }

  .token-list {
    display: grid;
    gap: 8px;
  }

  .token-row {
    align-items: center;
    display: grid;
    gap: 10px;
    grid-template-columns: minmax(0, 1.4fr) auto minmax(0, 1fr) minmax(0, 1fr) auto;
    padding: 12px 14px;
  }

  .status-pill {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 650;
    padding: 3px 8px;
  }

  .status-pill.ready {
    background: color-mix(in srgb, var(--color-success) 16%, transparent);
    color: var(--color-success);
  }

  .status-pill.used,
  .status-pill.expired,
  .status-pill.revoked {
    background: var(--color-surface);
    color: var(--color-ink-muted);
  }

  .form-message {
    color: var(--color-danger);
    font-size: 13px;
  }

  @media (max-width: 820px) {
    .token-form,
    .token-row {
      grid-template-columns: 1fr;
    }
  }
</style>
