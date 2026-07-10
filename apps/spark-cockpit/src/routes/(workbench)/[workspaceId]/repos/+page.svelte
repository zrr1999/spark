<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import {
    enumLabel,
    formatRelativeTime,
    statusLabel as getStatusLabel,
  } from "$lib/i18n";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, form } = $props();
  let t = $derived(data.messages.repos);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(data.workspace ? workspacePath(data.workspace) : "/");

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function kindLabel(kind: string) {
    return enumLabel(kind, common.resourceKind);
  }
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<section class="resources-page">
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
    <article><span>{t.metrics.total}</span><strong>{data.counts.total}</strong></article>
    <article><span>{t.metrics.repos}</span><strong>{data.counts.repo}</strong></article>
    <article><span>{t.metrics.available}</span><strong>{data.counts.available}</strong></article>
    <article><span>{t.metrics.archived}</span><strong>{data.counts.archived}</strong></article>
  </section>

  {#if !data.workspace}
    <section class="panel empty-state">
      <div class="empty-icon"><Icon name="repos" size={28} /></div>
      <h2>{t.emptyWorkspace.title}</h2>
      <p>{t.emptyWorkspace.body}</p>
      <a class="secondary-action" href={workspaceUrl}>{t.emptyWorkspace.action}</a>
    </section>
  {:else}
    <section class="grid">
      <section class="panel" aria-labelledby="resource-list-title">
        <div class="panel-header">
          <div>
            <p class="panel-kicker">{data.workspace.name}</p>
            <h2 id="resource-list-title">{t.list.title}</h2>
          </div>
          <span class="panel-badge">{data.resources.length} {t.list.totalSuffix}</span>
        </div>

        {#if data.resources.length === 0}
          <div class="compact-empty">
            <div class="empty-icon small"><Icon name="repos" size={22} /></div>
            <div>
              <h3>{t.list.emptyTitle}</h3>
              <p>{t.list.emptyBody}</p>
            </div>
          </div>
        {:else}
          <div class="resource-list">
            {#each data.resources as resource}
              <article class="resource-row">
                <div class="row-icon"><Icon name="repos" size={22} /></div>
                <div>
                  <div class="row-title">
                    <h3>{resource.name}</h3>
                    <span class="kind-pill">{kindLabel(resource.kind)}</span>
                  </div>
                  <p>{resource.uri ?? common.fallback.noUri}</p>
                  <small>{resource.projectCount} {t.list.linkedUses} · {t.list.updatedPrefix} {formatRelative(resource.updatedAt)}</small>
                </div>
                <span class="status-pill {resource.status}">{statusLabel(resource.status)}</span>
                <form method="POST" action={resource.status === "archived" ? "?/restoreResource" : "?/archiveResource"}>
                  <input type="hidden" name="resourceId" value={resource.id} />
                  <button class="secondary-action small" type="submit">
                    {resource.status === "archived" ? t.list.restore : t.list.archive}
                  </button>
                </form>
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="panel create-panel" aria-labelledby="create-resource-title">
        <div class="panel-header compact">
          <div>
            <p class="panel-kicker">{t.create.kicker}</p>
            <h2 id="create-resource-title">{t.create.title}</h2>
          </div>
        </div>

        {#if form?.message}
          <div class="form-error" role="alert">{form.message}</div>
        {/if}

        <form method="POST" action="?/createResource">
          <label>
            <span>{t.create.kind}</span>
            <select name="kind" required>
              <option value="repo">{common.resourceKind.repo}</option>
              <option value="doc">{common.resourceKind.doc}</option>
              <option value="url">{common.resourceKind.url}</option>
              <option value="file">{common.resourceKind.file}</option>
              <option value="tool">{common.resourceKind.tool}</option>
              <option value="secret_ref">{common.resourceKind.secret_ref}</option>
              <option value="other">{common.resourceKind.other}</option>
            </select>
          </label>
          <label>
            <span>{t.create.name}</span>
            <input name="name" placeholder={t.create.namePlaceholder} required />
          </label>
          <label>
            <span>{t.create.uri}</span>
            <input name="uri" placeholder={t.create.uriPlaceholder} />
          </label>
          <label>
            <span>{t.create.notes}</span>
            <textarea name="notes" rows="4" placeholder={t.create.notesPlaceholder}></textarea>
          </label>
          <button class="primary-action" type="submit">{t.create.submit}</button>
        </form>
      </aside>
    </section>
  {/if}
</section>

<style>
  .resources-page { display: grid; gap: 24px; }
  .hero { align-items: center; display: flex; justify-content: space-between; }
  .eyebrow, .panel-kicker { color: var(--color-primary); font-size: 12px; font-weight: 750; letter-spacing: 0.08em; margin: 0 0 8px; text-transform: uppercase; }
  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 34px; letter-spacing: -0.03em; }
  .lede, .resource-row p, .resource-row small, .compact-empty p, .empty-state p { color: var(--color-ink-subtle); line-height: 1.55; }
  .lede { margin-top: 10px; max-width: 840px; }
  .metrics, .grid { display: grid; gap: 18px; }
  .metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .grid { align-items: start; grid-template-columns: minmax(0, 1fr) 380px; }
  .metrics article, .panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 16px; box-shadow: var(--shadow-card-raised); }
  .metrics article { padding: 22px; }
  .metrics span { color: var(--color-ink-subtle); display: block; font-size: 13px; font-weight: 750; margin-bottom: 10px; }
  .metrics strong { color: var(--color-ink); font-size: 32px; }
  .panel-header { align-items: center; border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; padding: 24px 28px; }
  .panel-header.compact { padding: 22px 24px; }
  .panel-badge, .status-pill, .kind-pill { border-radius: 999px; font-size: 12px; font-weight: 800; padding: 6px 10px; text-transform: capitalize; }
  .panel-badge, .kind-pill { background: var(--color-primary-weak); color: var(--color-primary); }
  .status-pill { background: var(--color-surface-soft); color: var(--color-ink-subtle); }
  .status-pill.available { background: var(--color-success-soft); color: var(--color-success); }
  .status-pill.archived { background: var(--color-surface-soft); color: var(--color-ink-subtle); }
  .resource-list { display: grid; gap: 10px; padding: 18px; }
  .resource-row { align-items: center; border: 1px solid var(--color-border); border-radius: 14px; display: grid; gap: 16px; grid-template-columns: 48px minmax(0, 1fr) auto auto; padding: 16px; }
  .row-icon, .empty-icon { background: var(--color-primary-weak); border-radius: 999px; color: var(--color-primary); display: grid; place-items: center; }
  .row-icon { height: 48px; width: 48px; }
  .empty-icon { height: 64px; width: 64px; }
  .empty-icon.small { height: 46px; width: 46px; }
  .row-title { align-items: center; display: flex; gap: 10px; margin-bottom: 4px; }
  .compact-empty, .empty-state { align-items: center; display: grid; gap: 14px; justify-items: center; padding: 42px; text-align: center; }
  .compact-empty { grid-template-columns: 46px minmax(0, 1fr); justify-items: start; text-align: left; }
  .create-panel form { display: grid; gap: 16px; padding: 22px 24px 24px; }
  label { display: grid; gap: 7px; }
  label span { color: var(--color-ink-subtle); font-size: 12px; font-weight: 800; text-transform: uppercase; }
  input, select, textarea { background: var(--color-canvas); border: 1px solid var(--color-border-strong); border-radius: 12px; color: var(--color-ink); font: inherit; padding: 11px 12px; }
  textarea { resize: vertical; }
  .primary-action, .secondary-action { align-items: center; border-radius: 12px; display: inline-flex; font-weight: 800; height: 44px; justify-content: center; padding: 0 16px; text-decoration: none; }
  .primary-action { background: var(--color-primary); border: 0; color: white; cursor: pointer; }
  .secondary-action { background: white; border: 1px solid var(--color-border); color: var(--color-ink-muted); cursor: pointer; }
  .secondary-action.small { height: 38px; }
  .form-error { background: var(--color-danger-weak); border-bottom: 1px solid var(--color-danger-soft); color: var(--color-danger-strong); font-weight: 700; padding: 14px 24px; }
  @media (max-width: 1100px) { .metrics, .grid, .resource-row { grid-template-columns: 1fr; } }
</style>
