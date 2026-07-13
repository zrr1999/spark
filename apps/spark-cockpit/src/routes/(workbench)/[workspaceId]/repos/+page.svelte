<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { enumLabel, formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import PageHeader from "$lib/ui/PageHeader.svelte";
  import Panel from "$lib/ui/Panel.svelte";
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
  <PageHeader eyebrow={t.hero.eyebrow} title={t.hero.title} lede={t.hero.lede} />

  {#if !data.workspace}
    <Panel>
      <EmptyState title={t.emptyWorkspace.title} body={t.emptyWorkspace.body} icon="repos">
        {#snippet actions()}
          <a class="secondary-action" href={workspaceUrl}>{t.emptyWorkspace.action}</a>
        {/snippet}
      </EmptyState>
    </Panel>
  {:else}
    <section class="resource-grid">
      <Panel
        class="resource-list-panel"
        title={t.list.title}
        badge="{data.resources.length} {t.list.totalSuffix}"
        ariaLabelledby="resource-list-title"
        padded={false}
      >
        {#if data.resources.length === 0}
          <EmptyState title={t.list.emptyTitle} body={t.list.emptyBody} icon="repos" compact />
        {:else}
          <div class="resource-list">
            {#each data.resources as resource}
              <article class="resource-row">
                <div class="row-icon"><Icon name="repos" size={22} /></div>
                <div class="resource-copy">
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
                  <button class="secondary-action compact" type="submit">
                    {resource.status === "archived" ? t.list.restore : t.list.archive}
                  </button>
                </form>
              </article>
            {/each}
          </div>
        {/if}
      </Panel>

      <Panel class="create-panel" title={t.create.title} compact>
        {#if form?.message}
          <div class="form-error" role="alert">{form.message}</div>
        {/if}

        <form class="create-form" method="POST" action="?/createResource">
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
          <button class="primary-action" type="submit"><Icon name="plus" size={16} />{t.create.submit}</button>
        </form>
      </Panel>
    </section>
  {/if}
</section>

<style>
  @import "$lib/ui/status-pill.css";

  .resources-page {
    display: grid;
    gap: var(--spacing-xl);
  }

  .resource-grid {
    align-items: start;
    display: grid;
    gap: var(--spacing-lg);
    grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
  }

  .resource-list {
    display: grid;
    gap: var(--spacing-xs);
    padding: var(--spacing-md);
  }

  .resource-row {
    align-items: center;
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: 44px minmax(0, 1fr) auto auto;
    padding: var(--spacing-sm);
  }

  .resource-copy { min-width: 0; }
  .resource-copy p, .resource-copy small { color: var(--color-ink-subtle); line-height: var(--leading-caption); }
  .resource-copy p, .resource-copy small, h3 { margin: 0; overflow-wrap: anywhere; }
  .resource-copy small { font-size: var(--text-caption); }

  .row-title {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
    margin-bottom: var(--spacing-xxs);
  }

  h3 { font-size: var(--text-card-title); }

  .row-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    display: flex;
    height: 44px;
    justify-content: center;
    width: 44px;
  }

  .kind-pill {
    background: var(--color-primary-weak);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    padding: 3px 7px;
  }

  .create-form, .create-form label { display: grid; gap: var(--spacing-xs); }
  .create-form { gap: var(--spacing-md); }
  .create-form label > span { color: var(--color-ink-muted); font-size: var(--text-caption); font-weight: var(--weight-caption-medium); }

  input:not([type="hidden"]), select, textarea {
    background: var(--color-canvas);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    font: inherit;
    padding: 10px 12px;
    width: 100%;
  }

  textarea { resize: vertical; }

  .primary-action, .secondary-action {
    align-items: center;
    border-radius: var(--rounded-md);
    display: inline-flex;
    font: inherit;
    font-size: var(--text-button);
    font-weight: var(--weight-button);
    gap: var(--spacing-xs);
    justify-content: center;
    min-height: 40px;
    padding: 0 var(--spacing-md);
    text-decoration: none;
  }

  .primary-action { background: var(--color-primary); border: 0; color: var(--color-on-primary); cursor: pointer; }
  .secondary-action { background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-ink-muted); cursor: pointer; }
  .secondary-action.compact { min-height: 34px; padding-inline: var(--spacing-sm); }
  .form-error { background: var(--color-danger-weak); border-radius: var(--rounded-md); color: var(--color-danger-strong); font-size: var(--text-caption); padding: var(--spacing-sm); }

  @media (max-width: 1100px) {
    .resource-grid { grid-template-columns: 1fr; }
    :global(.create-panel) { order: -1; }
  }

  @media (max-width: 560px) {
    .resource-row { align-items: start; grid-template-columns: 40px minmax(0, 1fr); }
    .resource-row > .status-pill, .resource-row > form { grid-column: 2; justify-self: start; }
    .row-icon { height: 40px; width: 40px; }
  }
</style>
