<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, form } = $props();
  let t = $derived(data.messages.project);
  let common = $derived(data.messages.common);
  let workspaceUrl = $derived(workspacePath({ slug: data.project.workspaceSlug }));
  let readyCount = $derived(data.taskSummary.byGroup.ready ?? 0);
  let blockedCount = $derived(data.taskSummary.byGroup.blocked ?? 0);
  let runningCount = $derived(data.taskSummary.byGroup.running ?? 0);
  let doneCount = $derived(data.taskSummary.byGroup.done ?? 0);
  type Command = {
    status: string;
    deliveryStatus: string | null;
    attemptCount: number | null;
    lastAttemptAt: string | null;
    ackedAt: string | null;
    rejectedAt: string | null;
    rejectCode: string | null;
    rejectMessage: string | null;
    runtimeWorkspaceName: string | null;
    runtimeName: string | null;
    runtimeStatus: string | null;
  };

  let canStartTask = $derived(data.ownerBinding?.bindingStatus === "available");
  let startButtonLabel = $derived(
    !data.ownerBinding
      ? t.command.noRunnerOwner
      : data.ownerBinding.bindingStatus !== "available"
        ? t.command.workspaceUnavailable
        : t.command.queueTask,
  );
  let ownerCommandNote = $derived(
    data.ownerBinding
      ? `${t.command.ownerPrefix} ${data.ownerBinding.displayName} · ${data.ownerBinding.runtimeName}${
          data.ownerBinding.runtimeStatus === "online"
            ? ""
            : ` · ${t.command.offlinePending}`
        }`
      : "",
  );

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function deliveryHeadline(command: Command) {
    switch (command.deliveryStatus) {
      case "pending":
        return command.runtimeStatus === "online"
          ? t.command.delivery.pendingOnline
          : t.command.delivery.pendingOffline;
      case "sent":
        return t.command.delivery.sent;
      case "acked":
        return t.command.delivery.acked;
      case "rejected":
        return t.command.delivery.rejected;
      case "failed":
        return t.command.delivery.failed;
      case "cancelled":
        return t.command.delivery.cancelled;
      default:
        return t.command.delivery.none;
    }
  }

  function deliveryDetail(command: Command) {
    const target = [command.runtimeWorkspaceName, command.runtimeName].filter(Boolean).join(" · ");
    const attempts = command.attemptCount
      ? `${command.attemptCount} ${
          command.attemptCount === 1
            ? t.command.delivery.attemptSingular
            : t.command.delivery.attemptPlural
        }`
      : t.command.delivery.notAttempted;

    if (command.deliveryStatus === "rejected") {
      return [target, command.rejectCode, command.rejectMessage].filter(Boolean).join(" · ");
    }
    if (command.deliveryStatus === "acked") {
      return [target, command.ackedAt ? `${t.command.delivery.ackedPrefix} ${formatRelative(command.ackedAt)}` : null]
        .filter(Boolean)
        .join(" · ");
    }
    if (command.deliveryStatus === "sent") {
      return [target, attempts, command.lastAttemptAt ? `${t.command.delivery.sentPrefix} ${formatRelative(command.lastAttemptAt)}` : null]
        .filter(Boolean)
        .join(" · ");
    }

    return [target, attempts].filter(Boolean).join(" · ");
  }
</script>

<svelte:head>
  <title>{data.project.name} · Spark</title>
</svelte:head>

<section class="project-page">
  <header class="hero">
    <div>
      <p class="eyebrow">{data.project.workspaceName} / {t.hero.projectLabel}</p>
      <h1>{data.project.name}</h1>
      <p class="lede">{data.project.description ?? `/${data.project.slug}`}</p>
    </div>
    <span class="status-pill {data.project.status}">{statusLabel(data.project.status)}</span>
  </header>

  {#if data.projectKind && (data.projectKind.badge || data.projectKind.panels.length > 0)}
    <section class="panel kind-panel" aria-label="Project kind">
      <div class="kind-heading">
        <div>
          <p class="panel-kicker">Project kind</p>
          <h2>{data.projectKind.title}</h2>
        </div>
        {#if data.projectKind.badge}
          <span class="panel-badge">{data.projectKind.badge}</span>
        {/if}
      </div>
      {#if data.projectKind.panels.length > 0}
        <div class="kind-panels">
          {#each data.projectKind.panels as panel}
            <article>
              <span>{panel.label}</span>
              <strong>{panel.text}</strong>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  <section class="metrics" aria-label={t.metrics.aria}>
    <article>
      <span>{t.metrics.pendingInbox}</span>
      <strong>{data.inboxItems.filter((item) => item.status === "pending").length}</strong>
    </article>
    <article>
      <span>{t.metrics.tasks}</span>
      <strong>{data.taskSummary.total}</strong>
    </article>
    <article>
      <span>{t.metrics.dependencies}</span>
      <strong>{data.taskSummary.dependencyCount}</strong>
    </article>
    <article>
      <span>{t.metrics.linkedInvocations}</span>
      <strong>{data.taskSummary.linkedInvocationCount}</strong>
    </article>
  </section>

  <section class="panel summary-panel" aria-labelledby="graph-summary-title">
    <div class="summary-content">
      <div>
        <p class="panel-kicker">{t.graph.kicker}</p>
        <h2 id="graph-summary-title">{t.graph.title}</h2>
        <p class="summary-copy">
          {t.graph.body}
        </p>
      </div>
      <div class="status-summary" aria-label={t.graph.statusSummaryAria}>
        <span class="status-pill ready">{t.graph.ready} {readyCount}</span>
        <span class="status-pill blocked">{t.graph.blocked} {blockedCount}</span>
        <span class="status-pill running">{t.graph.running} {runningCount}</span>
        <span class="status-pill done">{t.graph.done} {doneCount}</span>
      </div>
    </div>

    <form method="POST" action="?/startTask" class="task-start-form">
      <div class="form-heading">
        <div>
          <p class="meta-label">{t.command.metaLabel}</p>
          <h3>{t.command.title}</h3>
        </div>
        {#if data.ownerBinding}
          <span class="status-pill {data.ownerBinding.runtimeStatus}"
            >{statusLabel(data.ownerBinding.runtimeStatus)}</span
          >
        {:else}
          <span class="status-pill blocked">{t.command.noOwner}</span>
        {/if}
      </div>

      <label>
        <span>{t.command.titleLabel}</span>
        <input
          name="title"
          value={form?.values?.title ?? t.command.titleDefault}
          placeholder={t.command.titleDefault}
          required
        />
      </label>
      <label>
        <span>{t.command.promptLabel}</span>
        <textarea
          name="prompt"
          rows="4"
          placeholder={t.command.promptPlaceholder}
          required>{form?.values?.prompt ?? ""}</textarea
        >
      </label>
      {#if form?.message}
        <p class:form-error={!form?.queuedCommandId} class="form-message">{form.message}</p>
      {/if}
      <button type="submit" disabled={!canStartTask}>
        <Icon name="play" size={16} stroke={2.3} />
        <span>{startButtonLabel}</span>
      </button>
      {#if ownerCommandNote}
        <p class="command-note">{ownerCommandNote}</p>
      {/if}

      <div class="command-deliveries" aria-label={t.command.recentAria}>
        <div class="command-deliveries-heading">
          <span class="meta-label">{t.command.recentLabel}</span>
          <small>{data.commands.length} {t.command.shownSuffix}</small>
        </div>
        {#if data.commands.length === 0}
          <p class="command-note">{t.command.empty}</p>
        {:else}
          {#each data.commands as command}
            <article class="command-delivery-row">
              <header>
                <div>
                  <strong>{command.title ?? command.kind}</strong>
                  <small>{command.id} · {formatRelative(command.createdAt)}</small>
                </div>
                <span class="status-pill {command.deliveryStatus ?? command.status}">
                  {statusLabel(command.deliveryStatus ?? command.status)}
                </span>
              </header>
              <p>{deliveryHeadline(command)}</p>
              {#if deliveryDetail(command)}
                <small>{deliveryDetail(command)}</small>
              {/if}
            </article>
          {/each}
        {/if}
      </div>
    </form>
  </section>

  <section class="grid">
    <section class="panel" aria-labelledby="tasks-title">
      <div class="panel-header">
        <div>
          <p class="panel-kicker">{t.tasks.kicker}</p>
          <h2 id="tasks-title">{t.tasks.title}</h2>
          {#if data.latestSnapshot}
            <p class="panel-note">
              {t.tasks.snapshotPrefix} {data.latestSnapshot.runtimeSnapshotId} · {t.tasks.receivedPrefix} {formatRelative(
                data.latestSnapshot.receivedAt,
              )}
            </p>
          {/if}
        </div>
        {#if data.latestSnapshot}
          <span class="panel-badge">{t.tasks.versionPrefix}{data.latestSnapshot.snapshotVersion}</span>
        {/if}
      </div>

      {#if data.tasks.length === 0}
        <div class="compact-empty">
          <Icon name="activity" size={24} />
          <p>{t.tasks.empty}</p>
        </div>
      {:else}
        <div class="graph-list">
          {#each data.tasks as task}
            <article class="graph-row">
              <div class="task-main">
                <div class="task-heading">
                  <div>
                    <h3>{task.title}</h3>
                    <p>
                      {task.runtimeTaskId}{task.clusterTitle ? ` · ${task.clusterTitle}` : ""}{task.agentRef
                        ? ` · ${task.agentRef}`
                        : ""}
                    </p>
                  </div>
                  <span class="status-pill {task.statusGroup}">{statusLabel(task.status)}</span>
                </div>
                {#if task.description}
                  <p class="task-description">{task.description}</p>
                {/if}

                <div class="dependency-grid">
                  <div>
                    <span class="meta-label">{t.tasks.dependsOn}</span>
                    {#if task.blockers.length === 0}
                      <p class="muted">{t.tasks.noUpstream}</p>
                    {:else}
                      <div class="chip-list">
                        {#each task.blockers as blocker}
                          <span class="chip">{blocker.title} · {blocker.kind}</span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                  <div>
                    <span class="meta-label">{t.tasks.unblocks}</span>
                    {#if task.dependents.length === 0}
                      <p class="muted">{t.tasks.noDownstream}</p>
                    {:else}
                      <div class="chip-list">
                        {#each task.dependents as dependent}
                          <span class="chip">{dependent.title}</span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              </div>

              <aside class="task-side" aria-label={`${t.tasks.invocationLinksAria} ${task.title}`}>
                <span class="meta-label">{t.tasks.invocationLinks}</span>
                {#if task.invocationLinks.length === 0}
                  <p class="muted">{t.tasks.noInvocation}</p>
                {:else}
                  <div class="invocation-links">
                    {#each task.invocationLinks as invocation}
                      <a href={`#invocation-${invocation.id}`}>
                        <span>{invocation.agentName ?? common.fallback.runner}</span>
                        <small>{statusLabel(invocation.status)}</small>
                      </a>
                    {/each}
                  </div>
                {/if}
                <p class="artifact-counts">
                  {task.inputArtifactCount} {t.tasks.inputs} · {task.outputArtifactCount} {t.tasks.outputs}
                </p>
              </aside>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <aside class="panel" aria-labelledby="inbox-title">
      <div class="panel-header compact">
        <div>
          <p class="panel-kicker">{t.inbox.kicker}</p>
          <h2 id="inbox-title">{t.inbox.title}</h2>
        </div>
      </div>

      {#if data.inboxItems.length === 0}
        <div class="compact-empty"><Icon name="inbox" size={24} /><p>{t.inbox.empty}</p></div>
      {:else}
        <div class="list compact-list">
          {#each data.inboxItems as item}
            <a class="row compact-row linked-row" href={`${workspaceUrl}/inbox/${item.id}`}>
              <div>
                <h3>{item.title}</h3>
                <p>{item.kind} · {item.urgency}</p>
              </div>
              <span class="status-pill {item.status}">{statusLabel(item.status)}</span>
            </a>
          {/each}
        </div>
      {/if}
    </aside>
  </section>

  <section class="grid lower">
    <section class="panel" aria-labelledby="invocations-title">
      <div class="panel-header compact">
        <div>
          <p class="panel-kicker">{t.invocations.kicker}</p>
          <h2 id="invocations-title">{t.invocations.title}</h2>
        </div>
      </div>
      {#if data.invocations.length === 0}
        <div class="compact-empty"><Icon name="activity" size={24} /><p>{t.invocations.empty}</p></div>
      {:else}
        <div class="list compact-list">
          {#each data.invocations as invocation}
            <article id={`invocation-${invocation.id}`} class="row compact-row">
              <div>
                <h3>{invocation.agentName ?? common.fallback.runner}</h3>
                <p>{invocation.runtimeInvocationId}</p>
              </div>
              <span class="status-pill {invocation.status}">{statusLabel(invocation.status)}</span>
              <time>{formatRelative(invocation.updatedAt)}</time>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <section class="panel" aria-labelledby="artifacts-title">
      <div class="panel-header compact">
        <div>
          <p class="panel-kicker">{t.artifacts.kicker}</p>
          <h2 id="artifacts-title">{t.artifacts.title}</h2>
        </div>
      </div>
      {#if data.artifacts.length === 0}
        <div class="compact-empty"><Icon name="artifacts" size={24} /><p>{t.artifacts.empty}</p></div>
      {:else}
        <div class="list compact-list">
          {#each data.artifacts as artifact}
            <a class="row compact-row linked-row" href={`${workspaceUrl}/artifacts/${artifact.id}`}>
              <div>
                <h3>{artifact.title}</h3>
                <p>{artifact.kind} · {artifact.format} · {artifact.source}</p>
              </div>
              <time>{formatRelative(artifact.createdAt)}</time>
            </a>
          {/each}
        </div>
      {/if}
    </section>
  </section>

  <section class="panel logs-panel" aria-labelledby="logs-title">
    <div class="panel-header compact">
      <div>
        <p class="panel-kicker">{t.logs.kicker}</p>
        <h2 id="logs-title">{t.logs.title}</h2>
      </div>
    </div>
    {#if data.logChunks.length === 0}
      <div class="compact-empty"><Icon name="activity" size={24} /><p>{t.logs.empty}</p></div>
    {:else}
      <div class="log-list">
        {#each data.logChunks as log}
          <article>
            <header>
              <span>{log.stream}</span>
              <small>{log.runtimeInvocationId} · #{log.sequence}</small>
            </header>
            <pre>{log.content}</pre>
          </article>
        {/each}
      </div>
    {/if}
  </section>
</section>

<style>
  .project-page {
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
  .row p,
  .panel-note,
  .compact-empty p,
  .summary-copy,
  .muted,
  .task-description,
  .artifact-counts {
    color: var(--color-ink-subtle);
    line-height: 1.55;
  }

  .metrics,
  .grid {
    display: grid;
    gap: 18px;
  }

  .metrics {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .kind-heading,
  .kind-panels {
    display: flex;
    gap: 16px;
  }

  .kind-heading {
    align-items: center;
    justify-content: space-between;
    padding: 22px 24px 0;
  }

  .kind-heading h2 {
    margin: 0;
  }

  .kind-panels {
    flex-wrap: wrap;
    padding: 18px 24px 24px;
  }

  .kind-panels article {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    min-width: 180px;
    padding: 14px 16px;
  }

  .kind-panels span {
    color: var(--color-ink-subtle);
    display: block;
    font-size: 12px;
    text-transform: uppercase;
  }

  .kind-panels strong {
    display: block;
    margin-top: 6px;
  }

  .metrics article,
  .panel {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 16px;
    box-shadow: var(--shadow-card-raised);
  }

  .metrics article {
    padding: 22px;
  }

  .metrics span {
    color: var(--color-ink-subtle);
    display: block;
    font-size: 13px;
    font-weight: 750;
    margin-bottom: 10px;
  }

  .metrics strong {
    color: var(--color-ink);
    font-size: 32px;
  }

  .summary-panel {
    align-items: start;
    display: grid;
    gap: 24px;
    grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
    padding: 24px 28px;
  }

  .summary-content,
  .task-start-form {
    display: grid;
    gap: 16px;
  }

  .summary-copy {
    margin-top: 8px;
  }

  .status-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  .task-start-form {
    border-left: 1px solid var(--color-border);
    padding-left: 24px;
  }

  .form-heading {
    align-items: start;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }

  .task-start-form label {
    color: var(--color-ink-muted);
    display: grid;
    font-size: 12px;
    font-weight: 800;
    gap: 6px;
    text-transform: uppercase;
  }

  .task-start-form input,
  .task-start-form textarea {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: var(--color-ink);
    font: inherit;
    font-size: 14px;
    line-height: 1.45;
    padding: 9px 12px;
    text-transform: none;
  }

  .task-start-form input:focus,
  .task-start-form textarea:focus {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .task-start-form button {
    align-items: center;
    background: var(--color-primary);
    border: 0;
    border-radius: 8px;
    color: var(--color-surface);
    display: inline-flex;
    font-weight: 700;
    gap: 8px;
    justify-content: center;
    min-height: 40px;
    padding: 9px 14px;
  }

  .task-start-form button:not(:disabled):hover {
    background: var(--color-primary-hover);
  }

  .task-start-form button:disabled {
    background: var(--color-border);
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }

  .form-message,
  .command-note {
    color: var(--color-primary);
    font-size: 12px;
    line-height: 1.45;
  }

  .form-message.form-error {
    color: var(--color-danger);
  }

  .command-deliveries {
    border-top: 1px solid var(--color-border);
    display: grid;
    gap: 10px;
    padding-top: 14px;
  }

  .command-deliveries-heading,
  .command-delivery-row header {
    align-items: center;
    display: flex;
    gap: 10px;
    justify-content: space-between;
  }

  .command-deliveries-heading small,
  .command-delivery-row small {
    color: var(--color-ink-subtle);
    font-size: 12px;
  }

  .command-delivery-row {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    display: grid;
    gap: 8px;
    padding: 12px;
  }

  .command-delivery-row strong {
    color: var(--color-ink);
    display: block;
    font-size: 13px;
  }

  .command-delivery-row p {
    color: var(--color-ink-muted);
    font-size: 13px;
    font-weight: 700;
  }

  .grid {
    align-items: start;
    grid-template-columns: minmax(0, 1fr) 380px;
  }

  .grid.lower {
    grid-template-columns: 1fr 1fr;
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

  .panel-note {
    font-size: 13px;
  }

  .panel-badge,
  .status-pill {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
    text-transform: capitalize;
    white-space: nowrap;
  }

  .panel-badge,
  .status-pill.running,
  .status-pill.delivered,
  .status-pill.sent {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .status-pill.done,
  .status-pill.completed,
  .status-pill.succeeded,
  .status-pill.resolved,
  .status-pill.acked {
    background: var(--color-success-soft);
    color: var(--color-success);
  }

  .status-pill.blocked,
  .status-pill.pending,
  .status-pill.queued,
  .status-pill.ready {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .status-pill.failed,
  .status-pill.cancelled,
  .status-pill.rejected {
    background: var(--color-danger-soft);
    color: var(--color-danger-strong);
  }

  .list,
  .graph-list {
    display: grid;
    gap: 10px;
    padding: 18px;
  }

  .compact-list {
    padding: 14px;
  }

  .row,
  .graph-row {
    border: 1px solid var(--color-border);
    border-radius: 14px;
    gap: 14px;
    padding: 16px;
  }

  .row {
    align-items: center;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .graph-row {
    align-items: start;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 220px;
  }

  .compact-row {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .linked-row {
    color: inherit;
    text-decoration: none;
  }

  .linked-row:hover {
    border-color: var(--color-primary-soft);
  }

  .task-main,
  .task-side {
    display: grid;
    gap: 12px;
  }

  .task-heading {
    align-items: start;
    display: flex;
    gap: 16px;
    justify-content: space-between;
  }

  .dependency-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: 1fr 1fr;
  }

  .meta-label {
    color: var(--color-ink-muted);
    display: block;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.04em;
    margin-bottom: 6px;
    text-transform: uppercase;
  }

  .chip-list,
  .invocation-links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip,
  .invocation-links a {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 700;
    padding: 6px 9px;
  }

  .invocation-links a {
    display: inline-flex;
    gap: 6px;
    text-decoration: none;
  }

  .invocation-links a:hover {
    border-color: var(--color-focus-ring);
    color: var(--color-primary);
  }

  .invocation-links small {
    color: var(--color-ink-subtle);
    font-weight: 800;
  }

  .artifact-counts,
  .muted,
  .task-description {
    font-size: 13px;
  }

  .compact-empty {
    align-items: center;
    color: var(--color-primary);
    display: flex;
    gap: 12px;
    padding: 24px;
  }

  .log-list {
    display: grid;
    gap: 10px;
    padding: 16px;
  }

  .log-list article {
    background: var(--color-ink);
    border-radius: 8px;
    color: var(--color-border);
    overflow: hidden;
  }

  .log-list header {
    align-items: center;
    background: var(--color-code-surface-soft);
    color: var(--color-ink-disabled);
    display: flex;
    font-size: 12px;
    justify-content: space-between;
    padding: 8px 12px;
  }

  .log-list span {
    color: var(--color-border);
    font-weight: 800;
    text-transform: uppercase;
  }

  .log-list pre {
    font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
    overflow-x: auto;
    padding: 12px;
    white-space: pre-wrap;
  }

  time {
    color: var(--color-ink-subtle);
    font-size: 12px;
    white-space: nowrap;
  }

  @media (max-width: 1100px) {
    .metrics,
    .grid,
    .grid.lower,
    .graph-row,
    .dependency-grid {
      grid-template-columns: 1fr;
    }

    .summary-panel,
    .task-heading {
      align-items: stretch;
      grid-template-columns: 1fr;
    }

    .kind-heading,
    .task-heading {
      flex-direction: column;
    }

    .task-start-form {
      border-left: 0;
      border-top: 1px solid var(--color-border);
      padding-left: 0;
      padding-top: 20px;
    }

    .status-summary {
      justify-content: flex-start;
    }
  }
</style>
