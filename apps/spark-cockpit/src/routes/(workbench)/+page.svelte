<script lang="ts">
  import { Dialog as BitsDialog } from "bits-ui";
  import { enhance } from "$app/forms";
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { Button, Dialog, EmptyState, PageHeader, Panel, StatCard } from "$lib/ui";
  import { workspaceAvatarStyle, workspaceInitial } from "$lib/workspace-avatar";
  import { workspacePath, workspaceSessionsPath } from "$lib/workspace-routes";

  let { data, form } = $props();

  let t = $derived(data.messages.home);
  let common = $derived(data.messages.common);
  let workspaces = $derived(data.workspaces);
  let onlineCount = $derived(
    workspaces.filter((workspace) => workspace.runtimeStatus === "online").length,
  );
  let pendingTotal = $derived(
    workspaces.reduce((sum, workspace) => sum + workspace.pendingInboxCount, 0),
  );

  let removeOpen = $state(false);
  let removeTarget = $state<(typeof workspaces)[number] | null>(null);
  let removePending = $state(false);

  let removeConfirmBody = $derived(
    t.workspaceHome.removeConfirmBody.replace("{name}", removeTarget?.name ?? ""),
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

  function openRemoveDialog(workspace: (typeof workspaces)[number]) {
    removeTarget = workspace;
    removeOpen = true;
  }

  function closeRemoveDialog() {
    if (removePending) return;
    removeOpen = false;
    removeTarget = null;
  }
</script>

{#snippet headerActions()}
  <Button variant="secondary" href="/settings/access">{t.workspaceHome.webAccess}</Button>
  <Button href="/workspaces/new">
    <Icon name="plus" size={16} />
    {t.hero.setUpRunner}
  </Button>
{/snippet}

{#snippet emptyActions()}
  <Button href="/workspaces/new">{t.hero.setUpRunner}</Button>
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

  {#if form?.intent === "removeWorkspace" && form.message}
    <p class="flash" role="status">{form.message}</p>
  {/if}

  <section class="summary" aria-label={t.workspaceHome.summaryAria}>
    <StatCard label={t.metrics.workspaces} value={workspaces.length} tone="primary" icon="folder" />
    <StatCard
      label={t.metrics.runnerConnections}
      value={onlineCount}
      tone={onlineCount > 0 ? "success" : "warning"}
      icon="activity"
    />
    <StatCard
      label={t.metrics.pendingInbox}
      value={pendingTotal}
      tone={pendingTotal > 0 ? "warning" : "default"}
      featured={pendingTotal > 0}
      icon="inbox"
    />
  </section>

  <Panel
    kicker={t.workspaceHome.catalogEyebrow}
    title={t.workspaceHome.catalogTitle}
    id="workspace-catalog-title"
    padded={false}
  >
    {#if workspaces.length === 0}
      <EmptyState
        icon="folder"
        title={t.noWorkspaceHero.title}
        body={t.noWorkspaceHero.lede}
        actions={emptyActions}
      />
    {:else}
      <ul class="workspace-list">
        {#each workspaces as workspace (workspace.id)}
          <li class="workspace-row">
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
            <div class="row-actions">
              <Button
                variant="ghost"
                size="compact"
                href={`${workspacePath(workspace)}/settings/registration`}
              >
                {t.workspaceHome.connectionSettings}
              </Button>
              <Button
                variant="ghost"
                size="compact"
                ariaLabel={`${t.workspaceHome.removeWorkspace} ${workspace.name}`}
                onclick={() => openRemoveDialog(workspace)}
              >
                <Icon name="archive" size={14} />
                {t.workspaceHome.removeWorkspace}
              </Button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </Panel>
</section>

<Dialog
  bind:open={removeOpen}
  width="min(440px, calc(100vw - 32px))"
  maxHeight="min(420px, calc(100dvh - 32px))"
  describedBy="remove-workspace-description"
  onOpenChangeComplete={(open) => {
    if (!open) closeRemoveDialog();
  }}
>
  <div class="remove-dialog">
    <header class="remove-dialog-header">
      <div>
        <BitsDialog.Title class="remove-dialog-title">
          {t.workspaceHome.removeConfirmTitle}
        </BitsDialog.Title>
        <BitsDialog.Description id="remove-workspace-description" class="remove-dialog-body">
          {removeConfirmBody}
        </BitsDialog.Description>
      </div>
      <BitsDialog.Close class="remove-dialog-close" aria-label={t.workspaceHome.removeCancel}>
        <Icon name="close" size={17} />
      </BitsDialog.Close>
    </header>
    <footer class="remove-dialog-footer">
      <Button variant="secondary" onclick={closeRemoveDialog} disabled={removePending}>
        {t.workspaceHome.removeCancel}
      </Button>
      {#if removeTarget}
        <form
          method="POST"
          action="?/removeWorkspace"
          use:enhance={() => {
            removePending = true;
            return async ({ update }) => {
              await update();
              removePending = false;
              removeOpen = false;
              removeTarget = null;
            };
          }}
        >
          <input type="hidden" name="workspaceId" value={removeTarget.id} />
          <Button variant="danger" type="submit" disabled={removePending}>
            {t.workspaceHome.removeConfirmAction}
          </Button>
        </form>
      {/if}
    </footer>
  </div>
</Dialog>

<style>
  .workspace-directory {
    display: grid;
    gap: var(--spacing-xl);
    padding: var(--spacing-xl) var(--spacing-xxl) var(--spacing-section);
  }

  .flash {
    background: var(--color-success-soft);
    border: 1px solid color-mix(in srgb, var(--color-success) 28%, var(--color-border));
    border-radius: var(--rounded-md);
    color: var(--color-success);
    font-size: var(--text-caption);
    margin: 0;
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .summary {
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .workspace-list {
    display: grid;
    gap: 0;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .workspace-row {
    border-top: 1px solid var(--color-border);
    display: grid;
    gap: var(--spacing-sm);
    padding: var(--spacing-lg) var(--spacing-xl);
  }

  .workspace-row:first-child {
    border-top: 0;
  }

  .workspace-card {
    align-items: center;
    color: inherit;
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: auto 1fr auto;
    min-width: 0;
    text-decoration: none;
  }

  .workspace-card:hover strong {
    color: var(--color-primary);
  }

  .avatar {
    align-items: center;
    background: var(--avatar-bg);
    border: 1px solid var(--avatar-border);
    border-radius: var(--rounded-md);
    color: var(--avatar-ink);
    display: grid;
    font-weight: 700;
    height: 2.5rem;
    justify-content: center;
    width: 2.5rem;
  }

  .card-copy {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .card-copy strong {
    font-size: var(--text-card-title);
    font-weight: var(--weight-card-title);
  }

  .card-copy small,
  .meta,
  .counts {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  .meta,
  .counts,
  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
  }

  .row-actions {
    margin-left: calc(2.5rem + var(--spacing-md));
  }

  .remove-dialog {
    display: grid;
    gap: var(--spacing-lg);
    padding: var(--spacing-xl);
  }

  .remove-dialog-header {
    align-items: start;
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
  }

  :global(.remove-dialog-title) {
    color: var(--color-ink);
    font-size: var(--text-section-title);
    font-weight: var(--weight-section-title);
    margin: 0;
  }

  :global(.remove-dialog-body) {
    color: var(--color-ink-subtle);
    font-size: var(--text-body);
    line-height: var(--leading-body);
    margin: var(--spacing-xs) 0 0;
  }

  :global(.remove-dialog-close) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    height: 32px;
    justify-content: center;
    width: 32px;
  }

  :global(.remove-dialog-close:hover) {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  .remove-dialog-footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
    justify-content: flex-end;
  }

  @media (max-width: 720px) {
    .workspace-directory {
      padding: var(--spacing-lg) var(--spacing-md) var(--spacing-xxl);
    }

    .summary {
      grid-template-columns: 1fr;
    }

    .row-actions {
      margin-left: 0;
    }
  }
</style>
