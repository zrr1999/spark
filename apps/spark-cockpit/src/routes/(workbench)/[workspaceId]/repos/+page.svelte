<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { enumLabel, formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import {
    Button,
    EmptyState,
    Field,
    Input,
    PageHeader,
    Panel,
    Select,
    Textarea,
  } from "$lib/ui";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, form } = $props();
  let t = $derived(data.messages.repos);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(data.workspace ? workspacePath(data.workspace) : "/");
  let resourceKind = $state("repo");
  let resourceKindGroups = $derived([
    {
      id: "resource-kind",
      options: [
        { value: "repo", label: common.resourceKind.repo },
        { value: "doc", label: common.resourceKind.doc },
        { value: "url", label: common.resourceKind.url },
        { value: "file", label: common.resourceKind.file },
        { value: "tool", label: common.resourceKind.tool },
        { value: "secret_ref", label: common.resourceKind.secret_ref },
        { value: "other", label: common.resourceKind.other },
      ],
    },
  ]);

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
          <Button variant="secondary" href={workspaceUrl}>{t.emptyWorkspace.action}</Button>
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
                  <Button variant="secondary" type="submit">
                    {resource.status === "archived" ? t.list.restore : t.list.archive}
                  </Button>
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
          <Field id="resource-kind" label={t.create.kind} required>
            <Select
              id="resource-kind"
              name="kind"
              bind:value={resourceKind}
              groups={resourceKindGroups}
              label={t.create.kind}
              required
            />
          </Field>
          <Field id="resource-name" label={t.create.name} required>
            <Input id="resource-name" name="name" placeholder={t.create.namePlaceholder} required />
          </Field>
          <Field id="resource-uri" label={t.create.uri}>
            <Input id="resource-uri" name="uri" placeholder={t.create.uriPlaceholder} />
          </Field>
          <Field id="resource-notes" label={t.create.notes}>
            <Textarea id="resource-notes" name="notes" rows={4} placeholder={t.create.notesPlaceholder} />
          </Field>
          <Button type="submit"><Icon name="plus" size={16} />{t.create.submit}</Button>
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

  .create-form { display: grid; gap: var(--spacing-md); }
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
