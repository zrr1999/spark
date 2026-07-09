<script lang="ts">
  import {
    commandDeliveryDetail,
    commandDeliveryHeadline,
    type CommandDeliveryDisplayCommand,
  } from "$lib/command-delivery-display";
  import Icon from "$lib/Icon.svelte";
  import ProjectMainSessionChatPanel from "$lib/ProjectMainSessionChatPanel.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { buildCockpitProjectTaskDisplay } from "$lib/project-task-display";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import PageHeader from "$lib/ui/PageHeader.svelte";
  import Panel from "$lib/ui/Panel.svelte";
  import StatCard from "$lib/ui/StatCard.svelte";
  import { workspaceControlControlLabel } from "$lib/workspace-control-display";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, form } = $props();
  let t = $derived(data.messages.project);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(workspacePath({ slug: data.project.workspaceSlug }));
  let pendingInboxCount = $derived(
    data.inboxItems.filter((item) => item.status === "pending").length,
  );
  let readyCount = $derived(data.taskSummary.byGroup.ready ?? 0);
  let blockedCount = $derived(data.taskSummary.byGroup.blocked ?? 0);
  let runningCount = $derived(data.taskSummary.byGroup.running ?? 0);
  let doneCount = $derived(data.taskSummary.byGroup.done ?? 0);
  let projectTaskDisplay = $derived(
    buildCockpitProjectTaskDisplay({
      project: { name: data.project.name },
      projectKind: data.projectKind,
      tasks: data.tasks,
      taskSummary: data.taskSummary,
    }),
  );
  type Command = CommandDeliveryDisplayCommand & {
    status: string;
    rejectedAt: string | null;
  };

  let canStartTask = $derived(
    data.ownerBinding?.bindingStatus === "available" &&
      data.workspaceControl.control.serverMutationAllowed,
  );
  let startButtonLabel = $derived(
    !data.ownerBinding
      ? t.command.noRunnerOwner
      : !canStartTask
        ? t.command.workspaceUnavailable
        : t.command.queueTask,
  );
  let workspaceControlLabel = $derived(
    workspaceControlControlLabel(data.workspaceControl.control, data.messages.home.workspaceControl),
  );
  let ownerCommandNote = $derived(
    data.ownerBinding
      ? `${t.command.ownerPrefix} ${data.ownerBinding.displayName} · ${data.ownerBinding.runtimeName}${
          canStartTask ? "" : ` · ${workspaceControlLabel}`
        }`
      : "",
  );
  let taskPanelBadge = $derived(
    data.latestSnapshot
      ? `${t.tasks.versionPrefix}${data.latestSnapshot.snapshotVersion}`
      : undefined,
  );

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function deliveryHeadline(command: Command) {
    return commandDeliveryHeadline(command, t.command.delivery);
  }

  function deliveryDetail(command: Command) {
    return commandDeliveryDetail(command, t.command.delivery, formatRelative);
  }

  function taskMetaLine(task: (typeof data.tasks)[number]) {
    const parts = [task.clusterTitle, task.agentRef].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
</script>

{#snippet projectStatusBadge()}
  <span class="status-pill {data.project.status}">{statusLabel(data.project.status)}</span>
{/snippet}

<svelte:head>
  <title>{data.project.name} · Spark</title>
</svelte:head>

<section class="project-page">
  <PageHeader
    eyebrow="{data.project.workspaceName} / {t.hero.projectLabel}"
    title={data.project.name}
    lede={data.project.description ?? `/${data.project.slug}`}
    badge={projectStatusBadge}
  />

  {#if data.projectKind && (data.projectKind.badge || data.projectKind.panels.length > 0)}
    <Panel title={data.projectKind.title} kicker="Project kind" badge={data.projectKind.badge}>
      {#if data.projectKind.panels.length > 0}
        <div class="kind-panels">
          {#each data.projectKind.panels as panel}
            <article class="kind-panel-item">
              <span>{panel.label}</span>
              <strong>{panel.text}</strong>
            </article>
          {/each}
        </div>
      {/if}
    </Panel>
  {/if}

  <section class="metrics" aria-label={t.metrics.aria}>
    <StatCard
      label={t.metrics.pendingInbox}
      value={pendingInboxCount}
      tone="warning"
      featured={pendingInboxCount > 0}
      icon="inbox"
    />
    <StatCard label={t.metrics.tasks} value={data.taskSummary.total} tone="primary" icon="activity" />
    <StatCard
      label={t.metrics.dependencies}
      value={data.taskSummary.dependencyCount}
      icon="cube"
    />
    <StatCard
      label={t.metrics.linkedInvocations}
      value={data.taskSummary.linkedInvocationCount}
      tone="purple"
      icon="agents"
    />
  </section>

  <section class="status-summary" aria-label={t.graph.statusSummaryAria}>
    <span class="status-pill ready">{t.graph.ready} {readyCount}</span>
    <span class="status-pill blocked">{t.graph.blocked} {blockedCount}</span>
    <span class="status-pill running">{t.graph.running} {runningCount}</span>
    <span class="status-pill done">{t.graph.done} {doneCount}</span>
  </section>

  <section class="cockpit-board" aria-label={t.graph.title}>
    <div class="board-tasks">
      <Panel
        title={t.tasks.title}
        kicker={t.tasks.kicker}
        badge={taskPanelBadge}
        compact
        ariaLabelledby="tasks-title"
        note={data.latestSnapshot
          ? `${t.tasks.receivedPrefix} ${formatRelative(data.latestSnapshot.receivedAt)}`
          : undefined}
      >
        {#if data.tasks.length === 0}
          <EmptyState title={t.tasks.empty} body={t.tasks.emptyBody} icon="activity" compact>
            {#snippet actions()}
              <button type="button" class="empty-cta" onclick={() => document.getElementById("cockpit-chat-prompt")?.focus()}>
                {t.tasks.emptyAction}
              </button>
            {/snippet}
          </EmptyState>
        {:else}
          <div class="task-list">
            {#each data.tasks as task}
              {@const taskDisplay = projectTaskDisplay.tasksByRuntimeId[task.runtimeTaskId]}
              <article class="task-row">
                <div class="task-main">
                  <div class="task-heading">
                    <div>
                      <h3>{taskDisplay?.title ?? task.title}</h3>
                      {#if taskDisplay?.handle && taskDisplay.handle !== "task"}
                        <p class="task-handle">{taskDisplay.handle}</p>
                      {/if}
                      {#if taskDisplay?.statusLine}
                        <p class="task-status-line">{taskDisplay.statusLine}</p>
                      {/if}
                      {#if taskMetaLine(task)}
                        <p class="task-meta">{taskMetaLine(task)}</p>
                      {/if}
                    </div>
                    <span class="status-pill {task.statusGroup}">{statusLabel(task.status)}</span>
                  </div>
                  {#if task.description && task.description !== task.title}
                    <p class="task-description">{task.description}</p>
                  {/if}

                  {#if task.blockers.length > 0 || task.dependents.length > 0}
                    <div class="dependency-grid">
                      {#if task.blockers.length > 0}
                        <div>
                          <span class="meta-label">{t.tasks.dependsOn}</span>
                          <div class="chip-list">
                            {#each task.blockers as blocker}
                              <span class="chip">{blocker.title}</span>
                            {/each}
                          </div>
                        </div>
                      {/if}
                      {#if task.dependents.length > 0}
                        <div>
                          <span class="meta-label">{t.tasks.unblocks}</span>
                          <div class="chip-list">
                            {#each task.dependents as dependent}
                              <span class="chip">{dependent.title}</span>
                            {/each}
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/if}
                </div>

                <aside class="task-side" aria-label={`${t.tasks.invocationLinksAria} ${task.title}`}>
                  {#if task.invocationLinks.length > 0}
                    <span class="meta-label">{t.tasks.invocationLinks}</span>
                    <div class="invocation-links">
                      {#each task.invocationLinks as invocation}
                        <span class="chip">
                          {invocation.agentName ?? common.fallback.runner}
                          <small>{statusLabel(invocation.status)}</small>
                        </span>
                      {/each}
                    </div>
                  {/if}
                  <p class="artifact-counts">
                    {task.inputArtifactCount} {t.tasks.inputs} · {task.outputArtifactCount}
                    {t.tasks.outputs}
                  </p>
                </aside>
              </article>
            {/each}
          </div>
        {/if}
      </Panel>
    </div>

    <div class="board-inbox">
      <Panel
        title={t.inbox.title}
        kicker={t.inbox.kicker}
        badge={pendingInboxCount > 0 ? String(pendingInboxCount) : undefined}
        compact
        ariaLabelledby="inbox-title"
      >
        {#if data.inboxItems.length === 0}
          <EmptyState title={t.inbox.empty} body={t.inbox.emptyBody} icon="inbox" compact>
            {#snippet actions()}
              <a class="empty-cta" href={`${workspaceUrl}/inbox`}>{t.inbox.emptyAction}</a>
            {/snippet}
          </EmptyState>
        {:else}
          <div class="decision-list">
            {#each data.inboxItems as item}
              <a class="decision-row" href={`${workspaceUrl}/inbox/${item.id}`}>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.kind} · {item.urgency}</p>
                </div>
                <span class="status-pill {item.status}">{statusLabel(item.status)}</span>
              </a>
            {/each}
          </div>
        {/if}
      </Panel>
    </div>

    <div class="board-evidence">
      <Panel
        title={t.artifacts.title}
        kicker={t.artifacts.kicker}
        badge={data.artifacts.length > 0 ? String(data.artifacts.length) : undefined}
        compact
        ariaLabelledby="artifacts-title"
      >
        {#if data.artifacts.length === 0}
          <EmptyState title={t.artifacts.empty} body={t.artifacts.emptyBody} icon="artifacts" compact>
            {#snippet actions()}
              <a class="empty-cta" href={`${workspaceUrl}/artifacts`}>{t.artifacts.emptyAction}</a>
            {/snippet}
          </EmptyState>
        {:else}
          <div class="evidence-list">
            {#each data.artifacts as artifact}
              <a class="evidence-row" href={`${workspaceUrl}/artifacts/${artifact.id}`}>
                <div class="evidence-icon" aria-hidden="true">
                  <Icon name="artifacts" size={18} />
                </div>
                <div>
                  <h3>{artifact.title}</h3>
                  <p>{artifact.kind} · {artifact.format}</p>
                  <small>{formatRelative(artifact.createdAt)}</small>
                </div>
              </a>
            {/each}
          </div>
        {/if}
      </Panel>
    </div>
  </section>

  <ProjectMainSessionChatPanel
    {data}
    {form}
    {canStartTask}
    {startButtonLabel}
    {ownerCommandNote}
    {workspaceUrl}
    {statusLabel}
    {formatRelative}
    {deliveryHeadline}
    {deliveryDetail}
  />
</section>

<style>
  @import "$lib/ui/status-pill.css";
  .project-page {
    display: grid;
    gap: var(--spacing-xl);
  }

  .metrics {
    display: grid;
    gap: var(--spacing-lg);
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .kind-panels {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-md);
  }

  .kind-panel-item {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    min-width: 180px;
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .kind-panel-item span {
    color: var(--color-ink-subtle);
    display: block;
    font-size: var(--text-caption);
    text-transform: uppercase;
  }

  .kind-panel-item strong {
    color: var(--color-ink);
    display: block;
    font-size: var(--text-body-medium);
    margin-top: var(--spacing-xxs);
  }

  .status-summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
  }

  .cockpit-board {
    align-items: start;
    display: grid;
    gap: var(--spacing-lg);
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr);
  }

  .decision-list,
  .task-list,
  .evidence-list {
    display: grid;
    gap: var(--spacing-xs);
  }

  .decision-row,
  .task-row,
  .evidence-row {
    background: var(--color-surface);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    color: inherit;
    text-decoration: none;
    transition:
      background-color 120ms ease,
      border-color 120ms ease;
  }

  .decision-row,
  .evidence-row {
    align-items: center;
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 10px 12px;
  }

  .decision-row:hover,
  .evidence-row:hover {
    background: var(--color-surface-soft);
    border-color: var(--color-border);
  }

  .task-row {
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: minmax(0, 1fr) 200px;
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .task-row:hover {
    background: var(--color-surface-soft);
    border-color: var(--color-border);
  }

  h3,
  p {
    margin: 0;
  }

  h3 {
    color: var(--color-ink);
    font-size: var(--text-card-title);
    font-weight: var(--weight-card-title);
    line-height: var(--leading-card-title);
  }

  .decision-row p,
  .evidence-row p,
  .task-description,
  .artifact-counts,
  .muted,
  .task-meta {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
  }

  .evidence-row small {
    color: var(--color-ink-subtle);
    display: block;
    font-size: var(--text-caption);
    margin-top: var(--spacing-xxs);
  }

  .evidence-icon {
    align-items: center;
    background: var(--color-primary-weak);
    border-radius: var(--rounded-sm);
    color: var(--color-primary);
    display: none;
    height: 32px;
    justify-content: center;
    width: 32px;
  }

  .task-main,
  .task-side {
    display: grid;
    gap: var(--spacing-sm);
  }

  .task-heading {
    align-items: start;
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
  }

  .task-status-line {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
    margin-top: var(--spacing-xxs);
  }

  .task-handle {
    color: var(--color-ink-muted);
    font-family: var(--font-mono);
    font-size: var(--text-mono);
    line-height: var(--leading-mono);
    margin-top: 2px;
  }

  .empty-cta {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: inline-flex;
    font: inherit;
    font-size: var(--text-button);
    font-weight: var(--weight-button);
    min-height: 36px;
    padding: 8px 12px;
    text-decoration: none;
  }

  .empty-cta:hover {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .dependency-grid {
    display: grid;
    gap: var(--spacing-sm);
    grid-template-columns: 1fr 1fr;
  }

  .meta-label {
    color: var(--color-ink-muted);
    display: block;
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    letter-spacing: 0.04em;
    margin-bottom: var(--spacing-xxs);
    text-transform: uppercase;
  }

  .chip-list,
  .invocation-links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    align-items: center;
    background: var(--color-canvas);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-full);
    color: var(--color-ink-muted);
    display: inline-flex;
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    gap: 6px;
    padding: 4px 8px;
  }

  .chip small {
    color: var(--color-ink-subtle);
    font-weight: var(--weight-caption-medium);
  }

  @media (min-width: 1024px) and (max-width: 1279px) {
    .cockpit-board {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }

    .board-evidence {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 1023px) {
    .metrics,
    .cockpit-board {
      grid-template-columns: 1fr;
    }

    .board-inbox {
      order: 1;
    }

    .board-tasks {
      order: 2;
    }

    .board-evidence {
      order: 3;
    }

    .task-row,
    .dependency-grid {
      grid-template-columns: 1fr;
    }

    .task-heading {
      flex-direction: column;
    }
  }
</style>
