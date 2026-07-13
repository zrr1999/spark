<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { enumLabel, formatByteSize, formatRelativeTime } from "$lib/i18n";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import PageHeader from "$lib/ui/PageHeader.svelte";
  import Panel from "$lib/ui/Panel.svelte";
  import { workspacePath } from "$lib/workspace-routes";

  let { data } = $props();
  let t = $derived(data.messages.artifacts);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(data.workspace ? workspacePath(data.workspace) : "/");

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function formatSize(value: number | null) {
    return formatByteSize(value, data.locale, common);
  }

  function scopeLabel(scope: string) {
    return enumLabel(scope, common.scope);
  }

  function displayTitle(title: string) {
    return title.match(/^Role run .*? for (.+)$/i)?.[1] ?? title;
  }
</script>

<svelte:head>
  <title>{t.headTitle}</title>
</svelte:head>

<section class="artifacts-page">
  <PageHeader eyebrow={t.hero.eyebrow} title={t.hero.title} lede={t.hero.lede} />

  {#if !data.workspace}
    <Panel>
      <EmptyState title={t.emptyWorkspace.title} body={t.emptyWorkspace.body} icon="artifacts" actions={emptyWorkspaceAction} />
    </Panel>
  {:else if data.artifacts.length === 0}
    <Panel>
      <EmptyState title={t.empty.title} body={t.empty.body} icon="artifacts" />
    </Panel>
  {:else}
    <Panel title={t.list.title} badge="{data.artifacts.length} {t.list.projectedSuffix}" ariaLabelledby="artifact-list-title">

      <div class="artifact-list">
        {#each data.artifacts as artifact}
          <a class="artifact-row" href={`${workspaceUrl}/artifacts/${artifact.id}`}>
            <div class="row-icon"><Icon name="artifacts" size={22} /></div>
            <div>
              <div class="row-title">
                <h3>{displayTitle(artifact.title)}</h3>
                <span class="scope-pill {artifact.scope}">{scopeLabel(artifact.scope)}</span>
              </div>
              <p>
                {artifact.kind} · {artifact.format} · {formatSize(artifact.sizeBytes)}
              </p>
              <small>
                {formatRelative(artifact.createdAt)}
              </small>
            </div>
            <Icon name="chevron" size={18} />
          </a>
        {/each}
      </div>
    </Panel>
  {/if}
</section>

{#snippet emptyWorkspaceAction()}
  <a class="secondary-action" href={workspaceUrl}>{t.emptyWorkspace.action}</a>
{/snippet}

<style>
  .artifacts-page {
    display: grid;
    gap: var(--spacing-xl);
  }

  h3,
  p {
    margin: 0;
  }

  .artifact-list {
    display: grid;
    gap: var(--spacing-xs);
  }

  .artifact-row {
    align-items: center;
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    color: inherit;
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: 48px minmax(0, 1fr) auto;
    padding: var(--spacing-md);
    text-decoration: none;
    transition: border-color 120ms ease;
  }

  .artifact-row > div {
    min-width: 0;
  }

  .artifact-row:hover {
    border-color: var(--color-border);
  }

  .artifact-row p,
  .artifact-row small {
    color: var(--color-ink-subtle);
    line-height: var(--leading-body);
  }

  .row-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    display: grid;
    height: 48px;
    place-items: center;
    width: 48px;
  }

  .row-title {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
    margin-bottom: var(--spacing-xxs);
    min-width: 0;
  }

  .row-title h3,
  .artifact-row p,
  .artifact-row small {
    overflow-wrap: anywhere;
  }

  .scope-pill {
    border-radius: var(--rounded-full);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    padding: 4px 8px;
    text-transform: capitalize;
  }

  .scope-pill.project {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .scope-pill.workspace {
    background: var(--color-purple-soft);
    color: var(--color-purple);
  }

  .secondary-action {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: var(--text-button);
    font-weight: var(--weight-button);
    min-height: 40px;
    justify-content: center;
    padding: 0 var(--spacing-md);
    text-decoration: none;
  }

  @media (max-width: 560px) {
    .artifact-row {
      grid-template-columns: 40px minmax(0, 1fr) auto;
      padding: var(--spacing-sm);
    }

    .row-icon { height: 40px; width: 40px; }
  }
</style>
