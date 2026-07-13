<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import PageHeader from "$lib/ui/PageHeader.svelte";
  import Panel from "$lib/ui/Panel.svelte";

  let { data, form } = $props();

  let t = $derived(data.messages.settings);
  let common = $derived(data.messages.common);
  let workspaceForm = $derived(
    form?.intent === "workspaceSettings" ? form : null,
  );

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<section class="settings-page">
  <PageHeader
    title={t.hero.title}
    lede={t.hero.lede}
    statusLabel={statusLabel(data.workspace.status)}
    statusClass={data.workspace.status}
  />

  <Panel ariaLabel={t.workspace.title}>
    <form class="workspace-form" method="POST" action="?/updateWorkspace">
      <label>
        <span>{t.workspace.name}</span>
        <input name="name" value={data.workspace.name} required />
      </label>
      <label>
        <span>{t.workspace.slug}</span>
        <input name="slug" value={data.workspace.slug} required />
        <small>{t.workspace.slugHint}</small>
      </label>
      <label class="wide-field">
        <span>{t.workspace.description}</span>
        <input
          name="description"
          value={data.workspace.description ?? ""}
          placeholder={t.workspace.descriptionPlaceholder}
        />
      </label>
      <div class="workspace-actions">
        <div class="workspace-meta">
          <span>{t.workspace.created} {formatRelative(data.workspace.createdAt)}</span>
          <span>{t.workspace.updated} {formatRelative(data.workspace.updatedAt)}</span>
        </div>
        <button class="primary-action" type="submit">
          <Icon name="check" size={16} stroke={2.4} />
          <span>{t.workspace.save}</span>
        </button>
      </div>
    </form>

    {#if workspaceForm?.message}
      <p class="form-message" role="status">{workspaceForm.message}</p>
    {/if}
  </Panel>
</section>

<style>
  .settings-page {
    display: grid;
    gap: 18px;
    max-width: 960px;
    min-width: 0;
    width: 100%;
  }

  .workspace-form {
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 0.66fr);
  }

  .workspace-form label {
    display: grid;
    gap: 6px;
  }

  .workspace-form label span {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 750;
  }

  .workspace-form label small {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
  }

  .wide-field,
  .workspace-actions {
    grid-column: 1 / -1;
  }

  .workspace-actions {
    align-items: center;
    border-top: 1px solid var(--color-border);
    display: flex;
    gap: 12px;
    justify-content: space-between;
    padding-top: 12px;
  }

  .workspace-meta {
    color: var(--color-ink-subtle);
    display: flex;
    flex-wrap: wrap;
    font-size: 12px;
    gap: 8px 14px;
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

  .primary-action {
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

  .form-message {
    background: var(--color-warning-weak);
    border: 1px solid var(--color-warning-soft);
    border-radius: 8px;
    color: var(--color-warning-strong);
    font-size: 13px;
    padding: 12px;
  }

  @media (max-width: 640px) {
    .workspace-form {
      align-items: stretch;
      display: grid;
      grid-template-columns: 1fr;
    }

    .workspace-actions {
      align-items: stretch;
      display: grid;
    }
  }
</style>
