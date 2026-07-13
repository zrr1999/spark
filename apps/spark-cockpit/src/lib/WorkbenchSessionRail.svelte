<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { visibleConversationActivityStatus } from "$lib/conversation-status";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import { orderWorkbenchSessionsByAttention } from "$lib/workbench-session-order";
  import {
    daemonIdentityForWorkbenchSession,
    isSessionVisibleInWorkbenchRail,
    workbenchSessionScope,
  } from "$lib/workbench-session-scope";

  type SessionRecord = {
    sessionId: string;
    workspaceId?: string;
    scope?:
      | { kind: "workspace"; workspaceId: string }
      | { kind: "daemon"; daemonId?: string; daemonLabel?: string };
    title?: string;
    status: string;
    activityStatus?: string;
    activityUpdatedAt?: string;
    createdAt: string;
    updatedAt: string;
  };

  type WorkspaceOption = {
    id: string;
    slug: string;
    name: string;
  };

  let {
    sessions,
    workspaces,
    activeWorkspaceId = null,
    selectedSessionId = null,
    locale,
    common,
    messages,
  }: {
    sessions: SessionRecord[];
    workspaces: WorkspaceOption[];
    activeWorkspaceId?: string | null;
    selectedSessionId?: string | null;
    locale: string;
    common: Parameters<typeof getStatusLabel>[1];
    messages: {
      workspaceConversation: string;
      daemonConversation: string;
      searchPlaceholder: string;
      emptyTitle: string;
      listLabel: string;
      untitledConversation: string;
      unknownWorkspace: string;
      daemonGroup: string;
    };
  } = $props();

  let filter = $state("");

  let filteredSessions = $derived(
    sessions.filter((session) => {
      if (!isSessionVisibleInWorkbenchRail(session, activeWorkspaceId)) return false;
      const query = filter.trim().toLowerCase();
      if (!query) return true;
      const scopeLabel = sessionScopeLabel(session).toLowerCase();
      return (
        session.sessionId.toLowerCase().includes(query) ||
        (session.title ?? "").toLowerCase().includes(query) ||
        scopeLabel.includes(query)
      );
    }),
  );

  let grouped = $derived(groupByWorkspace(filteredSessions));

  function workspaceLabel(workspaceId: string) {
    return (
      workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
      messages.unknownWorkspace
    );
  }

  function sessionScopeLabel(session: SessionRecord) {
    const scope = workbenchSessionScope(session);
    if (scope.kind === "workspace") return workspaceLabel(scope.workspaceId);
    if (scope.kind === "daemon") {
      const identity = daemonIdentityForWorkbenchSession(session);
      return `${messages.daemonGroup} · ${identity?.label ?? scope.daemonId}`;
    }
    return messages.unknownWorkspace;
  }

  function groupByWorkspace(items: SessionRecord[]) {
    const map = new Map<
      string,
      { kind: "workspace" | "daemon"; label: string; sessions: SessionRecord[] }
    >();
    for (const session of items) {
      const scope = workbenchSessionScope(session);
      if (scope.kind === "unknown") continue;
      const key =
        scope.kind === "workspace"
          ? `workspace:${scope.workspaceId}`
          : `daemon:${scope.daemonId}`;
      const current = map.get(key) ?? {
        kind: scope.kind,
        label: sessionScopeLabel(session),
        sessions: [],
      };
      current.sessions.push(session);
      map.set(key, current);
    }
    return [...map.entries()]
      .map(([key, group]) => ({
        key,
        ...group,
        sessions: orderWorkbenchSessionsByAttention(group.sessions),
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "workspace" ? -1 : 1;
        return left.label.localeCompare(right.label);
      });
  }

  function relative(value: string) {
    return formatRelativeTime(value, locale as "en" | "zh-CN", common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function activityStatus(session: SessionRecord) {
    return session.activityStatus ?? session.status;
  }

  function displayedActivityStatus(session: SessionRecord) {
    return visibleConversationActivityStatus(activityStatus(session));
  }

  function sessionTitle(session: SessionRecord) {
    const title = session.title || messages.untitledConversation;
    const infoflow = title.match(/^channel infoflow:(group|user):(.+)$/i);
    if (!infoflow) return title;
    const scope = infoflow[1] === "group"
      ? locale.toLowerCase().startsWith("zh") ? "如流群聊" : "Infoflow group"
      : locale.toLowerCase().startsWith("zh") ? "如流私聊" : "Infoflow chat";
    return `${scope} · ${infoflow[2]}`;
  }
</script>

<div class="session-rail">
  <div class="new-session-actions">
    {#if activeWorkspaceId}
      <a class="new-session" href="/sessions?new=workspace">
        <Icon name="workspace" size={15} stroke={2.2} />
        <span>{messages.workspaceConversation}</span>
      </a>
    {/if}
    <a class="new-session" href="/sessions?new=daemon">
      <Icon name="spark" size={15} stroke={2.2} />
      <span>{messages.daemonConversation}</span>
    </a>
  </div>

  <label class="session-filter">
    <Icon name="search" size={15} stroke={2.1} />
    <input
      bind:value={filter}
      type="search"
      aria-label={messages.searchPlaceholder}
      placeholder={messages.searchPlaceholder}
    />
  </label>

  {#if filteredSessions.length === 0}
    <p class="session-empty">{messages.emptyTitle}</p>
  {:else}
    <div class="session-groups" aria-label={messages.listLabel}>
      {#each grouped as group (group.key)}
        <section class="session-group">
          <h2>
            <span>{group.label}</span>
            <span>{group.sessions.length}</span>
          </h2>
          {#each group.sessions as session}
            {@const displayedStatus = displayedActivityStatus(session)}
            <a
              class="session-item"
              class:active={session.sessionId === selectedSessionId}
              aria-current={session.sessionId === selectedSessionId ? "page" : undefined}
              href={`/sessions/${session.sessionId}`}
            >
              <span class="session-title-row">
                <strong>{sessionTitle(session)}</strong>
                {#if displayedStatus}
                <span
                  class="session-status {displayedStatus}"
                  title={statusLabel(displayedStatus)}
                >
                  <span aria-hidden="true"></span>
                  <span>{statusLabel(displayedStatus)}</span>
                </span>
                {/if}
              </span>
              <small>{relative(session.activityUpdatedAt ?? session.updatedAt)}</small>
            </a>
          {/each}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .session-rail {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }

  .new-session-actions {
    display: grid;
    gap: 4px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .new-session-actions > :only-child {
    grid-column: 1 / -1;
  }

  .new-session {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    color: var(--color-ink);
    display: inline-flex;
    font-size: 13px;
    font-weight: 600;
    gap: 6px;
    justify-content: center;
    min-height: 40px;
    padding: 0 8px;
    text-align: center;
    text-decoration: none;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }

  .new-session:hover {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .session-filter {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    color: var(--color-ink-subtle);
    display: flex;
    gap: 8px;
    min-height: 40px;
    padding: 0 10px;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .session-filter:focus-within {
    background: var(--color-surface);
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    color: var(--color-ink);
  }

  .session-filter input {
    background: transparent;
    border: 0;
    color: inherit;
    font: inherit;
    font-size: 13px;
    min-height: 38px;
    outline: none;
    width: 100%;
  }

  .session-empty {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.45;
    margin: 8px 4px 0;
  }

  .session-groups {
    display: grid;
    gap: 12px;
    min-height: 0;
    overflow: auto;
    padding: 4px 0 2px;
  }

  .session-group {
    display: grid;
    gap: 2px;
  }

  .session-group h2 {
    align-items: center;
    color: var(--color-ink-disabled);
    display: flex;
    font-size: 11px;
    font-weight: 600;
    justify-content: space-between;
    letter-spacing: 0.06em;
    margin: 0 0 4px 10px;
    padding-right: 6px;
    text-transform: uppercase;
  }

  .session-group h2 span:last-child {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 10px;
    letter-spacing: 0;
    line-height: 1;
    min-width: 18px;
    padding: 4px 6px;
    text-align: center;
  }

  .session-item {
    border-radius: 8px;
    color: var(--color-ink-muted);
    display: grid;
    gap: 2px;
    padding: 8px 10px;
    text-decoration: none;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .session-item:hover {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  .session-item.active {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .session-item strong {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-title-row {
    align-items: center;
    display: grid;
    gap: 8px;
    grid-template-columns: minmax(0, 1fr) auto;
    min-width: 0;
  }

  .session-status {
    align-items: center;
    color: var(--color-ink-subtle);
    display: inline-flex;
    font-size: 10px;
    font-weight: 700;
    gap: 5px;
    line-height: 1;
    min-width: 0;
    text-transform: capitalize;
  }

  .session-status > span:first-child {
    background: var(--color-ink-disabled);
    border-radius: 999px;
    display: inline-block;
    height: 6px;
    width: 6px;
  }

  .session-status > span:last-child {
    max-width: 64px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-status.running > span:first-child,
  .session-status.queued > span:first-child,
  .session-status.ready > span:first-child,
  .session-status.active > span:first-child {
    background: var(--color-primary);
  }

  .session-status.completed > span:first-child,
  .session-status.succeeded > span:first-child {
    background: var(--color-success);
  }

  .session-status.blocked > span:first-child,
  .session-status.pending > span:first-child {
    background: var(--color-warning);
  }

  .session-status.archived > span:first-child {
    background: var(--color-warning);
  }

  .session-status.failed > span:first-child,
  .session-status.error > span:first-child {
    background: var(--color-danger);
  }

  .session-item small {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 500;
  }

  .session-item.active small {
    color: color-mix(in srgb, var(--color-primary) 72%, var(--color-ink-subtle));
  }
</style>
