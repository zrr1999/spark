<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import PageHeader from "$lib/ui/PageHeader.svelte";
  import { workspaceAvatarStyle, workspaceInitial } from "$lib/workspace-avatar";
  import { workspacePath, workspaceSessionsPath } from "$lib/workspace-routes";

  let { data } = $props();

  let t = $derived(data.messages.home);
  let common = $derived(data.messages.common);
  let workspaces = $derived(data.workspaces);
  let onlineCount = $derived(
    workspaces.filter((workspace) => workspace.runtimeStatus === "online").length,
  );

  function formatRelative(value: string | null | undefined) {
    return formatRelativeTime(value ?? null, data.locale, common);
  }

  function statusLabel(status: string | null | undefined) {
    return getStatusLabel(status ?? "unavailable", common);
  }

  function workspaceHref(workspace: (typeof workspaces)[number]) {
    return workspaceSessionsPath(workspace);
  }

  function connectionLabel(workspace: (typeof workspaces)[number]) {
    if (!workspace.bindingName) return t.workspaceHome.noConnection;
    return workspace.bindingName;
  }
</script>

{#snippet headerActions()}
  <a class="secondary-action" href="/settings/access">{t.workspaceHome.webAccess}</a>
  <a class="primary-action" href="/workspaces/new">
    <Icon name="plus" size={16} />
    {t.hero.setUpRunner}
  </a>
{/snippet}

<svelte:head>
  <title>{t.workspaceHome.headTitle}</title>
</svelte:head>

<section class="workspace-directory" data-testid="workspace-directory">
  <PageHeader
    eyebrow={t.workspaceHome.eyebrow}
    title={t.workspaceHome.title}
    lede={t.workspaceHome.lede}
    actions={headerActions}
  />

  <section class="summary" aria-label={t.workspaceHome.summaryAria}>
    <div class="summary-card">
      <span class="summary-label">{t.metrics.workspaces}</span>
      <strong>{workspaces.length}</strong>
    </div>
    <div class="summary-card">
      <span class="summary-label">{t.metrics.runnerConnections}</span>
      <strong>{onlineCount}</strong>
    </div>
    <div class="summary-card">
      <span class="summary-label">{t.metrics.pendingInbox}</span>
      <strong>{workspaces.reduce((sum, workspace) => sum + workspace.pendingInboxCount, 0)}</strong>
    </div>
  </section>

  <section class="catalog" aria-labelledby="workspace-catalog-title">
    <div class="catalog-heading">
      <div>
        <p class="eyebrow">{t.workspaceHome.catalogEyebrow}</p>
        <h2 id="workspace-catalog-title">{t.workspaceHome.catalogTitle}</h2>
      </div>
    </div>

    {#if workspaces.length === 0}
      <div class="empty">
        <Icon name="folder" size={28} />
        <h3>{t.noWorkspaceHero.title}</h3>
        <p>{t.noWorkspaceHero.lede}</p>
        <div class="empty-actions">
          <a class="primary-action" href="/workspaces/new">{t.hero.setUpRunner}</a>
        </div>
      </div>
    {:else}
      <ul class="workspace-grid">
        {#each workspaces as workspace (workspace.id)}
          <li>
            <a class="workspace-card" href={workspaceHref(workspace)}>
              <span class="avatar" style={workspaceAvatarStyle(workspace)}>
                {workspaceInitial(workspace)}
              </span>
              <span class="card-copy">
                <strong>{workspace.name}</strong>
                <small>/{workspace.slug}</small>
                <span class="meta">
                  <span>{connectionLabel(workspace)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{statusLabel(workspace.runtimeStatus ?? workspace.bindingStatus)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatRelative(workspace.updatedAt)}</span>
                </span>
                <span class="counts">
                  <span>{workspace.pendingInboxCount} {t.workspaceHome.pendingLabel}</span>
                  <span>{workspace.artifactCount} {t.workspaceHome.artifactsLabel}</span>
                </span>
              </span>
              <Icon name="chevron" size={18} />
            </a>
            <a class="settings-link" href={`${workspacePath(workspace)}/settings/registration`}>
              {t.workspaceHome.connectionSettings}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>

<style>
  .workspace-directory {
    display: grid;
    gap: 1.5rem;
    padding: 1.25rem 1.5rem 2rem;
  }

  .summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .summary-card {
    display: grid;
    gap: 0.35rem;
    padding: 0.9rem 1rem;
    border: 1px solid var(--color-line);
    border-radius: 0.9rem;
    background: var(--color-panel);
  }

  .summary-label {
    color: var(--color-muted);
    font-size: 0.8rem;
  }

  .summary-card strong {
    font-size: 1.4rem;
    font-weight: 650;
  }

  .catalog {
    display: grid;
    gap: 1rem;
  }

  .catalog-heading {
    display: grid;
    gap: 0.2rem;
  }

  .eyebrow {
    margin: 0 0 0.2rem;
    color: var(--color-muted);
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .catalog-heading h2 {
    margin: 0;
    font-size: 1.15rem;
  }

  .workspace-grid {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .workspace-grid > li {
    display: grid;
    gap: 0.35rem;
  }

  .workspace-card {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.9rem;
    align-items: center;
    padding: 1rem 1.1rem;
    border: 1px solid var(--color-line);
    border-radius: 1rem;
    background: var(--color-panel);
    color: inherit;
    text-decoration: none;
  }

  .workspace-card:hover {
    border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-line));
  }

  .avatar {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border: 1px solid var(--avatar-border);
    border-radius: 0.8rem;
    background: var(--avatar-bg);
    color: var(--avatar-ink);
    font-weight: 700;
  }

  .card-copy {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .card-copy strong {
    font-size: 1rem;
  }

  .card-copy small,
  .meta,
  .counts {
    color: var(--color-muted);
    font-size: 0.82rem;
  }

  .meta,
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .settings-link {
    justify-self: start;
    margin-left: 3.4rem;
    color: var(--color-muted);
    font-size: 0.8rem;
    text-decoration: none;
  }

  .settings-link:hover {
    color: var(--color-accent);
  }

  .empty {
    display: grid;
    gap: 0.55rem;
    justify-items: start;
    padding: 1.5rem;
    border: 1px dashed var(--color-line);
    border-radius: 1rem;
    background: color-mix(in srgb, var(--color-panel) 80%, transparent);
  }

  .empty h3 {
    margin: 0;
  }

  .empty p {
    margin: 0;
    color: var(--color-muted);
  }

  .empty-actions,
  :global(.page-header-actions) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }

  .primary-action,
  .secondary-action {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.85rem;
    border-radius: 999px;
    font-size: 0.9rem;
    text-decoration: none;
  }

  .primary-action {
    background: var(--color-ink);
    color: var(--color-canvas);
  }

  .secondary-action {
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    color: var(--color-ink);
  }

  @media (max-width: 720px) {
    .summary {
      grid-template-columns: 1fr;
    }

    .settings-link {
      margin-left: 0;
    }
  }
</style>
