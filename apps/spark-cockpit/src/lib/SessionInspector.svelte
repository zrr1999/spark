<script lang="ts">
  import { untrack } from "svelte";

  import Icon from "$lib/Icon.svelte";
  import type { IconName } from "$lib/icons";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import type {
    SessionInspectorLabels,
    SessionInspectorTab,
    SessionWorkbenchView,
  } from "$lib/session-workbench";

  let {
    view,
    labels,
    instanceId,
    statusLabel = (status: string) => status,
    initialTab = "runs",
  }: {
    view: SessionWorkbenchView;
    labels: SessionInspectorLabels;
    instanceId: string;
    statusLabel?: (status: string) => string;
    initialTab?: SessionInspectorTab;
  } = $props();

  let activeTab = $state<SessionInspectorTab>(untrack(() => initialTab));
  let tabs = $derived<{ id: SessionInspectorTab; label: string; icon: IconName }[]>([
    { id: "runs", label: labels.tabs.runs, icon: "activity" },
    { id: "changes", label: labels.tabs.changes, icon: "repos" },
    { id: "evidence", label: labels.tabs.evidence, icon: "artifacts" },
    { id: "context", label: labels.tabs.context, icon: "folder" },
  ]);

  function statusClass(status: string) {
    return status.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  }

  function progressValue(progress: number) {
    return Math.min(1, Math.max(0, progress));
  }

  function tabId(tab: SessionInspectorTab) {
    return `${instanceId}-${tab}-tab`;
  }

  function panelId(tab: SessionInspectorTab) {
    return `${instanceId}-${tab}-panel`;
  }

  function headingId(section: SessionInspectorTab | "tasks") {
    return `${instanceId}-${section}-heading`;
  }

  function handleTabKeydown(event: KeyboardEvent, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    activeTab = tabs[nextIndex].id;
    const tabList = (event.currentTarget as HTMLElement).parentElement;
    tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  }
</script>

<section class="session-inspector" aria-label={labels.ariaLabel}>
  <div class="inspector-tabs" role="tablist" aria-label={labels.ariaLabel}>
    {#each tabs as tab, index}
      <button
        id={tabId(tab.id)}
        type="button"
        role="tab"
        aria-controls={panelId(tab.id)}
        aria-selected={activeTab === tab.id}
        tabindex={activeTab === tab.id ? 0 : -1}
        class:active={activeTab === tab.id}
        onclick={() => (activeTab = tab.id)}
        onkeydown={(event) => handleTabKeydown(event, index)}
      >
        <Icon name={tab.icon} size={16} />
        <span>{tab.label}</span>
      </button>
    {/each}
  </div>

  <div
    id={panelId(activeTab)}
    class="inspector-panel"
    role="tabpanel"
    aria-labelledby={tabId(activeTab)}
  >
    {#if activeTab === "runs"}
      {#if view.runs.length === 0 && view.tasks.length === 0}
        <EmptyState title={labels.noRunsTitle} body={labels.noRunsBody} icon="activity" compact />
      {:else}
        {#if view.runs.length > 0}
          <section class="inspector-section" aria-labelledby={headingId("runs")}>
            <h2 id={headingId("runs")}>{labels.runsHeading}</h2>
            <div class="card-list">
              {#each view.runs as run (run.id)}
                <article class="inspector-card">
                  <header class="card-header">
                    <div class="card-title">
                      <Icon name="play" size={16} />
                      <div>
                        <h3>{run.title}</h3>
                        <p>{run.runtimeName ?? run.kind}</p>
                      </div>
                    </div>
                    <span class={`status-pill ${statusClass(run.status)}`}>
                      {statusLabel(run.status)}
                    </span>
                  </header>
                  {#if run.summary}
                    <p class="card-summary">{run.summary}</p>
                  {/if}
                  {#if run.progress !== null}
                    <div class="progress-row">
                      <progress
                        max="1"
                        value={progressValue(run.progress)}
                        aria-label={labels.progress}
                      ></progress>
                      <span>{Math.round(progressValue(run.progress) * 100)}%</span>
                    </div>
                  {/if}
                  {#if run.latestOutput}
                    <details class="output-details">
                      <summary>{labels.latestOutput}</summary>
                      <pre>{run.latestOutput}</pre>
                    </details>
                  {/if}
                </article>
              {/each}
            </div>
          </section>
        {/if}

        {#if view.tasks.length > 0}
          <section class="inspector-section" aria-labelledby={headingId("tasks")}>
            <h2 id={headingId("tasks")}>{labels.tasksHeading}</h2>
            <div class="card-list">
              {#each view.tasks as task (task.id)}
                <article class="inspector-card">
                  <header class="card-header">
                    <div class="card-title">
                      <Icon name="check" size={16} />
                      <div>
                        <h3>{task.title}</h3>
                        {#if task.owner}
                          <p>{task.owner}</p>
                        {/if}
                      </div>
                    </div>
                    <span class={`status-pill ${statusClass(task.status)}`}>
                      {statusLabel(task.status)}
                    </span>
                  </header>
                  {#if task.description}
                    <p class="card-summary">{task.description}</p>
                  {/if}
                  {#if task.todoTotal > 0}
                    <div class="progress-row">
                      <progress
                        max={task.todoTotal}
                        value={task.todoDone}
                        aria-label={labels.progress}
                      ></progress>
                      <span>{task.todoDone}/{task.todoTotal}</span>
                    </div>
                  {/if}
                </article>
              {/each}
            </div>
          </section>
        {/if}
      {/if}
    {:else if activeTab === "changes"}
      {#if view.changes.length === 0}
        <EmptyState title={labels.noChangesTitle} body={labels.noChangesBody} icon="repos" compact />
      {:else}
        <section class="inspector-section" aria-labelledby={headingId("changes")}>
          <h2 id={headingId("changes")}>{labels.changesHeading}</h2>
          <div class="card-list">
            {#each view.changes as artifact (artifact.id)}
              <article class="inspector-card artifact-card">
                <header class="card-header">
                  <div class="card-title">
                    <Icon name="repos" size={16} />
                    <div>
                      <h3>{artifact.title}</h3>
                      <p>{artifact.format}</p>
                      <code class="artifact-ref">{artifact.ref}</code>
                    </div>
                  </div>
                  {#if artifact.status}
                    <span class={`status-pill ${statusClass(artifact.status)}`}>
                      {statusLabel(artifact.status)}
                    </span>
                  {/if}
                </header>
                {#if artifact.preview}
                  <pre class="artifact-preview diff-preview">{artifact.preview}</pre>
                {/if}
              </article>
            {/each}
          </div>
        </section>
      {/if}
    {:else if activeTab === "evidence"}
      {#if view.evidence.length === 0}
        <EmptyState title={labels.noEvidenceTitle} body={labels.noEvidenceBody} icon="artifacts" compact />
      {:else}
        <section class="inspector-section" aria-labelledby={headingId("evidence")}>
          <h2 id={headingId("evidence")}>{labels.evidenceHeading}</h2>
          <div class="card-list">
            {#each view.evidence as artifact (artifact.id)}
              <article class="inspector-card artifact-card">
                <header class="card-header">
                  <div class="card-title">
                    <Icon name="artifacts" size={16} />
                    <div>
                      <h3>{artifact.title}</h3>
                      <p>{artifact.kind} · {artifact.format}</p>
                      <code class="artifact-ref">{artifact.ref}</code>
                    </div>
                  </div>
                  {#if artifact.status}
                    <span class={`status-pill ${statusClass(artifact.status)}`}>
                      {statusLabel(artifact.status)}
                    </span>
                  {/if}
                </header>
                {#if artifact.preview}
                  <pre class="artifact-preview">{artifact.preview}</pre>
                {/if}
              </article>
            {/each}
          </div>
        </section>
      {/if}
    {:else}
      <section class="inspector-section" aria-labelledby={headingId("context")}>
        <h2 id={headingId("context")}>{labels.contextHeading}</h2>
        <dl class="context-list">
          <div>
            <dt>{labels.sessionId}</dt>
            <dd><code>{view.context.sessionId}</code></dd>
          </div>
          <div>
            <dt>{labels.sessionStatus}</dt>
            <dd>
              <span class={`status-pill ${statusClass(view.context.status)}`}>
                {statusLabel(view.context.status)}
              </span>
            </dd>
          </div>
          <div>
            <dt>{labels.workingDirectory}</dt>
            <dd><code>{view.context.cwd ?? labels.unavailable}</code></dd>
          </div>
          <div>
            <dt>{labels.model}</dt>
            <dd>{view.context.model?.displayLabel ?? labels.unavailable}</dd>
          </div>
          <div>
            <dt>{labels.createdAt}</dt>
            <dd>{view.context.createdAt ?? labels.unavailable}</dd>
          </div>
          <div>
            <dt>{labels.updatedAt}</dt>
            <dd>{view.context.updatedAt ?? labels.unavailable}</dd>
          </div>
        </dl>
      </section>
    {/if}
  </div>
</section>

<style>
  @import "$lib/ui/status-pill.css";

  .session-inspector {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-xl);
    min-width: 0;
    overflow: hidden;
  }

  .inspector-tabs {
    align-items: stretch;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    min-width: 0;
    overflow: hidden;
    padding: 0 var(--spacing-sm);
  }

  .inspector-tabs button {
    align-items: center;
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--color-ink-subtle);
    display: inline-flex;
    flex: 1 1 0;
    font: inherit;
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
    gap: var(--spacing-xs);
    min-height: 42px;
    min-width: 0;
    padding: 0 6px;
  }

  .inspector-tabs button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .inspector-tabs button:hover {
    color: var(--color-ink);
  }

  .inspector-tabs button:focus-visible {
    border-radius: var(--rounded-sm);
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .inspector-tabs button.active {
    border-bottom-color: var(--color-primary);
    color: var(--color-primary);
  }

  .inspector-panel {
    min-width: 0;
  }

  .inspector-section {
    display: grid;
    gap: var(--spacing-md);
    padding: var(--spacing-lg);
  }

  .inspector-section + .inspector-section {
    border-top: 1px solid var(--color-border-soft);
  }

  .inspector-section > h2 {
    color: var(--color-ink);
    font-size: var(--text-section-title);
    font-weight: var(--weight-section-title);
    margin: 0;
  }

  .card-list {
    display: grid;
    gap: var(--spacing-sm);
  }

  .inspector-card {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-lg);
    display: grid;
    gap: var(--spacing-sm);
    min-width: 0;
    padding: var(--spacing-md);
  }

  .card-header {
    align-items: flex-start;
    display: flex;
    gap: var(--spacing-sm);
    justify-content: space-between;
    min-width: 0;
  }

  .card-title {
    align-items: flex-start;
    color: var(--color-ink-subtle);
    display: flex;
    gap: var(--spacing-sm);
    min-width: 0;
  }

  .card-title > div {
    min-width: 0;
  }

  .card-title h3 {
    color: var(--color-ink);
    font-size: var(--text-card-title);
    font-weight: var(--weight-card-title);
    line-height: var(--leading-body);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .card-title p,
  .card-summary {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-body);
    margin: var(--spacing-xxs) 0 0;
    overflow-wrap: anywhere;
  }

  .card-summary {
    color: var(--color-ink-muted);
    margin: 0;
  }

  .artifact-ref {
    color: var(--color-ink-subtle);
    display: block;
    font-size: var(--text-caption);
    margin-top: var(--spacing-xxs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .progress-row {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    font-size: var(--text-caption);
    gap: var(--spacing-sm);
  }

  progress {
    accent-color: var(--color-primary);
    flex: 1;
    height: 6px;
    min-width: 80px;
  }

  .output-details {
    border-top: 1px solid var(--color-border-soft);
    padding-top: var(--spacing-sm);
  }

  .output-details summary {
    color: var(--color-ink-subtle);
    cursor: pointer;
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
  }

  pre,
  code {
    font-family: var(--font-mono);
  }

  .output-details pre,
  .artifact-preview {
    background: var(--color-code-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    font-size: var(--text-caption);
    line-height: var(--leading-body);
    margin: var(--spacing-sm) 0 0;
    max-height: 320px;
    overflow: auto;
    padding: var(--spacing-md);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .diff-preview {
    white-space: pre;
    word-break: normal;
  }

  .context-list {
    display: grid;
    gap: 0;
    margin: 0;
  }

  .context-list > div {
    align-items: start;
    border-bottom: 1px solid var(--color-border-soft);
    display: grid;
    gap: var(--spacing-md);
    grid-template-columns: minmax(130px, 0.35fr) minmax(0, 1fr);
    padding: var(--spacing-md) 0;
  }

  .context-list > div:last-child {
    border-bottom: 0;
  }

  .context-list dt {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    font-weight: var(--weight-caption-medium);
  }

  .context-list dd {
    color: var(--color-ink);
    font-size: var(--text-body);
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .context-list code {
    font-size: var(--text-caption);
  }

  @media (max-width: 640px) {
    .inspector-section {
      padding: var(--spacing-md);
    }

    .inspector-tabs {
      padding: 0;
    }

    .inspector-tabs button {
      flex: 1 1 0;
      gap: 4px;
      justify-content: center;
      min-width: 0;
      padding: 0 4px;
    }

    .context-list > div {
      gap: var(--spacing-xs);
      grid-template-columns: 1fr;
    }
  }
</style>
