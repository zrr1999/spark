<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";

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

<section class="settings-page" aria-labelledby="settings-title">
  <header class="settings-header">
    <div>
      <p class="eyebrow">{t.hero.eyebrow}</p>
      <h1 id="settings-title">{t.hero.title}</h1>
      <p class="lede">{t.hero.lede}</p>
    </div>
    <a class="secondary-action" href={data.registrationPath}>
      <Icon name="play" size={16} stroke={2.2} />
      <span>{t.hero.createToken}</span>
    </a>
  </header>

  <section class="panel-card workspace-settings" aria-labelledby="workspace-settings-title">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">{t.workspace.kicker}</p>
        <h2 id="workspace-settings-title">{t.workspace.title}</h2>
        <p>{t.workspace.body}</p>
      </div>
      <span class="status-pill {data.workspace.status}">
        {statusLabel(data.workspace.status)}
      </span>
    </div>

    <form class="workspace-form" method="POST" action="?/updateWorkspace">
      <label>
        <span>{t.workspace.name}</span>
        <input name="name" value={data.workspace.name} required />
      </label>
      <label>
        <span>{t.workspace.slug}</span>
        <input name="slug" value={data.workspace.slug} required />
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
  </section>
</section>

<style>
  .settings-page {
    display: grid;
    gap: 18px;
  }

  .settings-header {
    align-items: start;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    gap: 16px;
    justify-content: space-between;
    padding-bottom: 14px;
  }

  .eyebrow {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0;
    margin: 0 0 8px;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    color: var(--color-ink);
    font-size: 26px;
    line-height: 1.16;
  }

  h2 {
    color: var(--color-ink);
    font-size: 18px;
    line-height: 1.3;
  }

  .lede,
  .panel-heading p {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.5;
  }

  .settings-header .lede {
    margin-top: 8px;
    max-width: 760px;
  }

  .panel-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    display: grid;
    gap: 14px;
    padding: 16px;
  }

  .panel-heading {
    align-items: center;
    display: flex;
    gap: 12px;
    justify-content: space-between;
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

  .form-message {
    background: var(--color-warning-weak);
    border: 1px solid var(--color-warning-soft);
    border-radius: 8px;
    color: var(--color-warning-strong);
    font-size: 13px;
    padding: 12px;
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

  .status-pill.active {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  .status-pill.archived {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  @media (max-width: 640px) {
    .settings-header,
    .panel-heading,
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
