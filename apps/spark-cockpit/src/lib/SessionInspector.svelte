<script lang="ts">
  import { untrack } from "svelte";

  import Icon from "$lib/Icon.svelte";
  import type { IconName } from "$lib/icons";
  import EmptyState from "$lib/ui/EmptyState.svelte";
  import type {
    SessionInspectorLabels,
    SessionInspectorTab,
    SessionWorkbenchMailMessage,
    SessionWorkbenchTask,
    SessionWorkbenchView,
  } from "$lib/session-workbench";

  let {
    view,
    labels,
    instanceId,
    statusLabel = (status: string) => status,
    initialTab = "summary",
  }: {
    view: SessionWorkbenchView;
    labels: SessionInspectorLabels;
    instanceId: string;
    statusLabel?: (status: string) => string;
    initialTab?: SessionInspectorTab;
  } = $props();

  let activeTab = $state<SessionInspectorTab>(untrack(() => initialTab));
  let tabs = $derived<{ id: SessionInspectorTab; label: string; icon: IconName }[]>([
    { id: "summary", label: labels.tabs.summary, icon: "activity" },
    { id: "changes", label: labels.tabs.changes, icon: "repos" },
    { id: "tasks", label: labels.tabs.tasks, icon: "folder" },
    { id: "mailbox", label: labels.tabs.mailbox, icon: "inbox" },
  ]);
  let taskGroups = $derived(groupTasksByProject(view.tasks));
  let unreadMailCount = $derived(
    view.mailbox.filter((message) => message.status === "unread").length,
  );

  function statusClass(status: string) {
    return status.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  }

  function mailKindLabel(kind: "request" | "question" | "notification") {
    if (kind === "request") return labels.mailRequest;
    if (kind === "question") return labels.mailQuestion;
    return labels.mailNotification;
  }

  function mailStatusLabel(status: "unread" | "read" | "acknowledged") {
    if (status === "unread") return labels.mailUnread;
    if (status === "read") return labels.mailRead;
    return labels.mailAcknowledged;
  }

  function mailDeliveryLabel(
    status: NonNullable<SessionWorkbenchMailMessage["channelDelivery"]>["status"],
  ) {
    if (status === "pending") return labels.mailDeliveryPending;
    if (status === "delivered") return labels.mailDeliveryDelivered;
    if (status === "failed") return labels.mailDeliveryFailed;
    return labels.mailDeliveryUncertain;
  }

  function compactTimestamp(value: string) {
    return value.slice(0, 16).replace("T", " ");
  }

  function tabId(tab: SessionInspectorTab) {
    return `${instanceId}-${tab}-tab`;
  }

  function panelId(tab: SessionInspectorTab) {
    return `${instanceId}-${tab}-panel`;
  }

  function headingId(section: SessionInspectorTab) {
    return `${instanceId}-${section}-heading`;
  }

  function sessionTodoHeadingId() {
    return `${instanceId}-session-todo-heading`;
  }

  function groupTasksByProject(tasks: SessionWorkbenchTask[]) {
    const groups = new Map<string, { projectRef: string | null; tasks: SessionWorkbenchTask[] }>();
    for (const task of tasks) {
      const key = task.projectRef ?? "";
      const group = groups.get(key) ?? { projectRef: task.projectRef, tasks: [] };
      group.tasks.push(task);
      groups.set(key, group);
    }
    return [...groups.values()];
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
  <div class="session-todo-rail" aria-label={labels.sessionTodoHeading}>
    {#if view.sessionTodo === null}
      <EmptyState
        title={labels.noSessionTodoTitle}
        body={labels.noSessionTodoBody}
        icon="check"
        compact
      />
    {:else}
      <section
        class="inspector-section session-todo-section"
        aria-labelledby={sessionTodoHeadingId()}
      >
        <header class="session-todo-header">
          <div>
            <h2 id={sessionTodoHeadingId()}>{labels.sessionTodoHeading}</h2>
            <p>{view.sessionTodo.summary}</p>
          </div>
          <a href={`#${view.sessionTodo.anchor}`}>{labels.openSessionTodo}</a>
        </header>
        {#if view.sessionTodo.items.length > 0}
          <ul class="session-todo-list" aria-label={labels.todoList}>
            {#each view.sessionTodo.items as todo (todo.id)}
              <li>
                <span class={`todo-state ${statusClass(todo.status)}`} aria-hidden="true"></span>
                <span class="todo-content">{todo.content}</span>
                <span class={`status-pill ${statusClass(todo.status)}`}>
                  {statusLabel(todo.status)}
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="session-todo-empty">{labels.noActiveSessionTodo}</p>
        {/if}
      </section>
    {/if}
  </div>

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
        {#if tab.id === "mailbox" && unreadMailCount > 0}
          <span class="tab-count" aria-label={`${unreadMailCount} ${labels.mailUnread}`}>
            {unreadMailCount > 99 ? "99+" : unreadMailCount}
          </span>
        {/if}
      </button>
    {/each}
  </div>

  <div
    id={panelId(activeTab)}
    class="inspector-panel"
    role="tabpanel"
    aria-labelledby={tabId(activeTab)}
  >
    {#if activeTab === "summary"}
      <section class="inspector-section" aria-labelledby={headingId("summary")}>
        <h2 id={headingId("summary")}>{labels.summaryHeading}</h2>
        <dl class="context-list">
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
            <dd title={view.context.cwd ?? labels.unavailable}><code>{view.context.cwd ?? labels.unavailable}</code></dd>
          </div>
          <div>
            <dt>{labels.model}</dt>
            <dd title={view.context.model?.displayLabel ?? labels.unavailable}>{view.context.model?.displayLabel ?? labels.unavailable}</dd>
          </div>
          <div>
            <dt>{labels.sessionId}</dt>
            <dd title={view.context.sessionId}><code>{view.context.sessionId}</code></dd>
          </div>
          <div>
            <dt>{labels.createdAt}</dt>
            <dd title={view.context.createdAt ?? labels.unavailable}>
              {view.context.createdAt
                ? compactTimestamp(view.context.createdAt)
                : labels.unavailable}
            </dd>
          </div>
          <div>
            <dt>{labels.updatedAt}</dt>
            <dd title={view.context.updatedAt ?? labels.unavailable}>{view.context.updatedAt ? compactTimestamp(view.context.updatedAt) : labels.unavailable}</dd>
          </div>
        </dl>
      </section>

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
    {:else if activeTab === "tasks"}
      {#if view.tasks.length === 0}
        <EmptyState title={labels.noTasksTitle} body={labels.noTasksBody} icon="folder" compact />
      {:else}
        <section class="inspector-section" aria-labelledby={headingId("tasks")}>
          <h2 id={headingId("tasks")}>{labels.tasksHeading}</h2>
          {#if view.tasks.length > 0}
            <div class="project-list">
              {#each taskGroups as group (group.projectRef ?? "unassigned")}
                <section class="project-group">
                  <header class="project-header">
                    <Icon name="folder" size={15} />
                    {#if group.projectRef}
                      <code>{group.projectRef}</code>
                    {:else}
                      <span>{labels.unassignedProject}</span>
                    {/if}
                  </header>
                  <div class="card-list">
                    {#each group.tasks as task (task.id)}
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
                          <ul class="task-todos" aria-label={labels.todoList}>
                            {#each task.todos as todo (todo.id)}
                              <li>
                                <span class={`todo-state ${statusClass(todo.status)}`} aria-hidden="true"></span>
                                <span class="todo-content">{todo.content}</span>
                                <span class={`status-pill ${statusClass(todo.status)}`}>
                                  {statusLabel(todo.status)}
                                </span>
                              </li>
                            {/each}
                          </ul>
                        {/if}
                      </article>
                    {/each}
                  </div>
                </section>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    {:else if activeTab === "mailbox"}
      {#if view.mailbox.length === 0}
        <EmptyState title={labels.noMailboxTitle} body={labels.noMailboxBody} icon="inbox" compact />
      {:else}
        <section class="inspector-section" aria-labelledby={headingId("mailbox")}>
          <h2 id={headingId("mailbox")}>{labels.mailboxHeading}</h2>
          <div class="card-list">
            {#each view.mailbox as message (message.id)}
              <article class="inspector-card mailbox-card">
                <header class="card-header">
                  <div class="card-title">
                    <Icon name={message.kind === "request" ? "inbox" : "spark"} size={16} />
                    <div>
                      <h3>{message.subject ?? message.intent}</h3>
                      <p>
                        {mailKindLabel(message.kind)} · {labels.mailFrom} {message.fromSessionId}
                      </p>
                    </div>
                  </div>
                  <div class="mail-statuses">
                    {#if message.channelDelivery}
                      <span
                        class={`status-pill mail-delivery-status ${statusClass(message.channelDelivery.status)}`}
                      >
                        {mailDeliveryLabel(message.channelDelivery.status)}
                      </span>
                    {/if}
                    <span class={`status-pill mail-read-status ${statusClass(message.status)}`}>
                      {mailStatusLabel(message.status)}
                    </span>
                  </div>
                </header>
                {#if message.body}
                  <p class="card-summary mail-body">{message.body}</p>
                {/if}
                <time datetime={message.createdAt} title={message.createdAt}>
                  {compactTimestamp(message.createdAt)}
                </time>
              </article>
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </div>
</section>

<style>
  @import "$lib/ui/status-pill.css";

  .session-inspector {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-xl);
    container-type: inline-size;
    min-width: 0;
    overflow: hidden;
  }

  .session-todo-rail {
    border-bottom: 1px solid var(--color-border);
    min-width: 0;
    padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
  }

  .session-todo-section {
    margin: 0;
  }

  .inspector-tabs {
    align-items: stretch;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    min-width: 0;
    overflow: hidden;
    padding: 0 4px;
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
    justify-content: center;
    min-height: 42px;
    min-width: 0;
    padding: 0 3px;
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
    min-height: 300px;
  }

  .inspector-section {
    display: grid;
    gap: var(--spacing-md);
    padding: var(--spacing-lg);
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

  .project-list,
  .project-group {
    display: grid;
    gap: var(--spacing-md);
  }

  .session-todo-header {
    align-items: start;
    display: flex;
    gap: var(--spacing-md);
    justify-content: space-between;
    min-width: 0;
  }

  .session-todo-header > div {
    min-width: 0;
  }

  .session-todo-header h2,
  .session-todo-header p {
    margin: 0;
  }

  .session-todo-header h2 {
    color: var(--color-ink);
    font-size: var(--text-section-title);
    font-weight: var(--weight-section-title);
  }

  .session-todo-header p {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
    line-height: var(--leading-body);
    margin-top: var(--spacing-xxs);
    overflow-wrap: anywhere;
  }

  .session-todo-header a {
    color: var(--color-primary);
    flex: 0 0 auto;
    font-size: var(--text-caption);
    font-weight: 650;
    text-decoration: none;
  }

  .session-todo-header a:hover {
    text-decoration: underline;
  }

  .session-todo-list {
    display: grid;
    gap: 0;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .session-todo-list li {
    align-items: start;
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    font-size: var(--text-body);
    gap: var(--spacing-sm);
    grid-template-columns: auto minmax(0, 1fr) auto;
    line-height: var(--leading-body);
    padding: var(--spacing-md) 0;
  }

  .session-todo-list li:last-child {
    padding-bottom: 0;
  }

  .session-todo-empty {
    border-top: 1px solid var(--color-border-soft);
    color: var(--color-ink-subtle);
    font-size: var(--text-body);
    margin: 0;
    padding-top: var(--spacing-md);
  }

  .project-group + .project-group {
    border-top: 1px solid var(--color-border-soft);
    padding-top: var(--spacing-md);
  }

  .project-header {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    gap: var(--spacing-xs);
    min-width: 0;
  }

  .project-header code,
  .project-header span {
    font-size: var(--text-caption);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .mailbox-card time {
    color: var(--color-ink-subtle);
    font-size: var(--text-caption);
  }

  .mail-statuses {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xxs);
    justify-content: flex-end;
  }

  .mail-delivery-status.uncertain {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .mail-body {
    display: -webkit-box;
    line-clamp: 4;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
  }

  .tab-count {
    align-items: center;
    background: var(--color-primary);
    border-radius: 999px;
    color: white;
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 9px;
    font-weight: 700;
    justify-content: center;
    line-height: 1;
    min-height: 16px;
    min-width: 16px;
    padding: 0 4px;
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

  .task-todos {
    display: grid;
    gap: 6px;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .task-todos li {
    align-items: start;
    display: grid;
    font-size: var(--text-caption);
    gap: 7px;
    grid-template-columns: auto minmax(0, 1fr) auto;
    line-height: var(--leading-body);
  }

  .todo-state {
    background: var(--color-ink-subtle);
    border-radius: 999px;
    height: 7px;
    margin-top: 5px;
    width: 7px;
  }

  .todo-state.in_progress {
    background: var(--color-primary);
  }

  .todo-state.blocked {
    background: var(--color-warning);
  }

  .todo-state.done {
    background: var(--color-success);
  }

  .todo-state.cancelled {
    background: var(--color-ink-disabled);
  }

  .todo-content {
    color: var(--color-ink-muted);
    overflow-wrap: anywhere;
  }

  pre,
  code {
    font-family: var(--font-mono);
  }

  .artifact-preview {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    font-size: var(--text-caption);
    line-height: 1.5;
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
    gap: var(--spacing-sm);
    grid-template-columns: 92px minmax(0, 1fr);
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-list code {
    font-size: var(--text-caption);
  }

  @container (max-width: 360px) {
    .inspector-tabs button :global(svg) {
      display: none;
    }
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
