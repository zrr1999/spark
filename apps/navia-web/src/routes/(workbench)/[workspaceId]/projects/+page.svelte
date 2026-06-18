<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { workspacePath } from "$lib/workspace-routes";

  let { data } = $props();
  let t = $derived(data.messages.projects);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(data.workspace ? workspacePath(data.workspace) : "/");

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function projectSummary(project: {
    pendingInboxCount: number;
    runningInvocationCount: number;
    artifactCount: number;
  }) {
    return `${project.pendingInboxCount} ${t.summary.pendingInbox} · ${project.runningInvocationCount} ${t.summary.running} · ${project.artifactCount} ${t.summary.artifacts}`;
  }
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<section class="projects-page">
  <header class="hero">
    <div>
      <p class="eyebrow">{t.hero.eyebrow}</p>
      <h1>{t.hero.title}</h1>
      <p class="lede">
        {t.hero.lede}
      </p>
    </div>
  </header>

  {#if !data.workspace}
    <section class="panel empty-state">
      <div class="empty-icon"><Icon name="folder" size={28} /></div>
      <h2>{t.emptyWorkspace.title}</h2>
      <p>{t.emptyWorkspace.body}</p>
      <a class="secondary-action" href={workspaceUrl}>{t.emptyWorkspace.action}</a>
    </section>
  {:else}
    <section class="grid">
      <section class="panel" aria-labelledby="project-list-title">
        <div class="panel-header">
          <div>
            <p class="panel-kicker">{data.workspace.name}</p>
            <h2 id="project-list-title">{t.list.title}</h2>
          </div>
          <span class="panel-badge">{data.projects.length} {t.list.totalSuffix}</span>
        </div>

        {#if data.projects.length === 0}
          <div class="compact-empty">
            <div class="empty-icon small"><Icon name="folder" size={22} /></div>
            <div>
              <h3>{t.list.emptyTitle}</h3>
              <p>{t.list.emptyBody}</p>
            </div>
          </div>
        {:else}
          <div class="project-list">
            {#each data.projects as project}
              <a class="project-row" href={`${workspaceUrl}/projects/${project.id}`}>
                <div class="project-icon"><Icon name="folder" size={22} /></div>
                <div>
                  <h3>{project.name}</h3>
                  <p>{project.description ?? `/${project.slug}`}</p>
                  <small>{projectSummary(project)}</small>
                </div>
                <span class="status-pill {project.status}">{statusLabel(project.status)}</span>
                <time>{formatRelative(project.updatedAt)}</time>
              </a>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="panel create-panel" aria-labelledby="create-project-title">
        <div class="panel-header compact">
          <div>
            <p class="panel-kicker">{t.create.kicker}</p>
            <h2 id="create-project-title">{t.create.title}</h2>
          </div>
        </div>

        <form method="POST" action="?/createProject">
          <label>
            <span>{t.create.name}</span>
            <input name="name" placeholder={t.create.namePlaceholder} required />
          </label>
          <label>
            <span>{t.create.slug}</span>
            <input name="slug" placeholder={t.create.slugPlaceholder} />
          </label>
          <label>
            <span>{t.create.description}</span>
            <textarea name="description" rows="4" placeholder={t.create.descriptionPlaceholder}></textarea>
          </label>
          <button class="primary-action" type="submit">{t.create.submit}</button>
        </form>
      </aside>
    </section>
  {/if}
</section>

<style>
  .projects-page {
    display: grid;
    gap: 24px;
  }

  .hero {
    align-items: center;
    display: flex;
    justify-content: space-between;
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
  p {
    margin: 0;
  }

  h1 {
    font-size: 34px;
    letter-spacing: -0.03em;
  }

  .lede,
  .compact-empty p,
  .project-row p,
  .project-row small {
    color: var(--color-ink-subtle);
    line-height: 1.55;
  }

  .lede {
    margin-top: 10px;
    max-width: 760px;
  }

  .grid {
    align-items: start;
    display: grid;
    gap: 24px;
    grid-template-columns: minmax(0, 1fr) 380px;
  }

  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: var(--shadow-card-raised);
  }

  .panel-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    justify-content: space-between;
    padding: 24px 28px;
  }

  .panel-header.compact {
    padding: 22px 24px;
  }

  .panel-badge,
  .status-pill {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
    text-transform: capitalize;
  }

  .panel-badge {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .status-pill.running {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill.completed {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  .status-pill.blocked {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .project-list {
    display: grid;
    gap: 10px;
    padding: 18px;
  }

  .project-row {
    align-items: center;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    color: inherit;
    display: grid;
    gap: 16px;
    grid-template-columns: 48px minmax(0, 1fr) auto auto;
    padding: 16px;
    text-decoration: none;
  }

  .project-row:hover {
    border-color: var(--color-primary-soft);
  }

  .project-icon,
  .empty-icon {
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    display: grid;
    place-items: center;
  }

  .project-icon {
    height: 48px;
    width: 48px;
  }

  .empty-icon {
    height: 64px;
    width: 64px;
  }

  .empty-icon.small {
    height: 46px;
    width: 46px;
  }

  .empty-state,
  .compact-empty {
    align-items: center;
    display: grid;
    gap: 14px;
    justify-items: center;
    padding: 42px;
    text-align: center;
  }

  .compact-empty {
    grid-template-columns: 46px minmax(0, 1fr);
    justify-items: start;
    text-align: left;
  }

  .create-panel form {
    display: grid;
    gap: 16px;
    padding: 22px 24px 24px;
  }

  label {
    display: grid;
    gap: 7px;
  }

  label span {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }

  input,
  textarea {
    background: var(--color-canvas);
    border: 1px solid var(--color-border-strong);
    border-radius: 12px;
    color: var(--color-ink);
    font: inherit;
    padding: 11px 12px;
  }

  textarea {
    resize: vertical;
  }

  .primary-action,
  .secondary-action {
    align-items: center;
    border-radius: 12px;
    display: inline-flex;
    font-weight: 800;
    height: 44px;
    justify-content: center;
    padding: 0 16px;
    text-decoration: none;
  }

  .primary-action {
    background: var(--color-primary);
    border: 0;
    color: white;
    cursor: pointer;
  }

  .secondary-action {
    background: white;
    border: 1px solid var(--color-border);
    color: var(--color-ink-muted);
  }

  time {
    color: var(--color-ink-subtle);
    font-size: 12px;
    white-space: nowrap;
  }

  @media (max-width: 1100px) {
    .grid {
      grid-template-columns: 1fr;
    }

    .project-row {
      grid-template-columns: 48px minmax(0, 1fr);
    }
  }
</style>
