<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import ChannelSessionIcon from "$lib/ChannelSessionIcon.svelte";
  import {
    channelSessionPresentation,
    sessionHasChannelBinding,
    type ChannelSessionLabels,
  } from "$lib/channel-session-title";
  import { visibleConversationActivityStatus } from "$lib/conversation-status";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import {
    groupWorkbenchSessionsByType,
    type WorkbenchSessionType,
  } from "$lib/workbench-session-groups";
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
    bindings?: Array<{ kind: string; adapter?: string; externalKey?: string }>;
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
    sessionsAvailable = true,
    locale,
    common,
    messages,
  }: {
    sessions: SessionRecord[];
    workspaces: WorkspaceOption[];
    activeWorkspaceId?: string | null;
    selectedSessionId?: string | null;
    sessionsAvailable?: boolean;
    locale: string;
    common: Parameters<typeof getStatusLabel>[1];
    messages: {
      workspaceConversation: string;
      daemonConversation: string;
      searchPlaceholder: string;
      emptyTitle: string;
      daemonUnavailableTitle: string;
      daemonUnavailableBody: string;
      listLabel: string;
      untitledConversation: string;
      unknownWorkspace: string;
      daemonGroup: string;
      channelSessionBadge: string;
      channelLabels: ChannelSessionLabels;
      sessionTypes: Record<WorkbenchSessionType, string>;
      archiveSubmit: string;
    };
  } = $props();

  let filter = $state("");

  let filteredSessions = $derived(
    sessions.filter((session) => {
      if (!isSessionVisibleInWorkbenchRail(session, activeWorkspaceId)) return false;
      const query = filter.trim().toLowerCase();
      if (!query) return true;
      const scopeLabel = sessionScopeLabel(session).toLowerCase();
      const presentation = sessionPresentation(session);
      return (
        session.sessionId.toLowerCase().includes(query) ||
        (session.title ?? "").toLowerCase().includes(query) ||
        presentation.title.toLowerCase().includes(query) ||
        (presentation.channel?.label.toLowerCase().includes(query) ?? false) ||
        scopeLabel.includes(query)
      );
    }),
  );

  let grouped = $derived(
    groupWorkbenchSessionsByType(filteredSessions, {
      channelLabels: messages.channelLabels,
      fallback: messages.untitledConversation,
      labels: messages.sessionTypes,
    }),
  );

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

  function sessionPresentation(session: SessionRecord) {
    return channelSessionPresentation(session, {
      labels: messages.channelLabels,
      fallback: messages.untitledConversation,
    });
  }

  function sessionTitle(session: SessionRecord) {
    return sessionPresentation(session).title;
  }
</script>

<div class="session-rail">
  <div class="session-toolbar">
    <div class="new-session-actions">
      {#if activeWorkspaceId}
        {#if sessionsAvailable}
          <a
            class="new-session"
            href="/sessions?new=workspace"
            aria-label={messages.workspaceConversation}
            title={messages.workspaceConversation}
          >
            <Icon name="workspace" size={16} stroke={2.2} />
            <span class="sr-only">{messages.workspaceConversation}</span>
          </a>
        {:else}
          <span
            class="new-session disabled"
            role="link"
            aria-disabled="true"
            aria-label={messages.workspaceConversation}
            title={messages.workspaceConversation}
          >
            <Icon name="workspace" size={16} stroke={2.2} />
            <span class="sr-only">{messages.workspaceConversation}</span>
          </span>
        {/if}
      {/if}
      {#if sessionsAvailable}
        <a
          class="new-session"
          href="/sessions?new=daemon"
          aria-label={messages.daemonConversation}
          title={messages.daemonConversation}
        >
          <Icon name="spark" size={16} stroke={2.2} />
          <span class="sr-only">{messages.daemonConversation}</span>
        </a>
      {:else}
        <span
          class="new-session disabled"
          role="link"
          aria-disabled="true"
          aria-label={messages.daemonConversation}
          title={messages.daemonConversation}
        >
          <Icon name="spark" size={16} stroke={2.2} />
          <span class="sr-only">{messages.daemonConversation}</span>
        </span>
      {/if}
    </div>

    <label class="session-filter">
      <Icon name="search" size={15} stroke={2.1} />
      <input
        bind:value={filter}
        type="search"
        aria-label={messages.searchPlaceholder}
        placeholder={messages.searchPlaceholder}
        disabled={!sessionsAvailable}
      />
    </label>
  </div>

  {#if !sessionsAvailable}
    <div class="session-unavailable" role="status">
      <Icon name="warning" size={15} stroke={2.1} />
      <div>
        <strong>{messages.daemonUnavailableTitle}</strong>
        <p>{messages.daemonUnavailableBody}</p>
      </div>
    </div>
  {:else if filteredSessions.length === 0}
    <p class="session-empty">{messages.emptyTitle}</p>
  {:else}
    <div class="session-groups" aria-label={messages.listLabel}>
      {#each grouped as group (group.key)}
        <details class="session-group" open>
          <summary>
            <span>{group.label}</span>
            <span class="group-meta">
              <span class="group-count">{group.sessions.length}</span>
              <span class="group-disclosure" aria-hidden="true">
                <Icon name="chevron-down" size={13} stroke={2.3} />
              </span>
            </span>
          </summary>
          <div class="session-group-items">
            {#each group.sessions as session}
              {@const displayedStatus = displayedActivityStatus(session)}
              {@const isSelected = session.sessionId === selectedSessionId}
              {@const presentation = sessionPresentation(session)}
              {@const canArchive = isSelected && session.status !== "archived" && !sessionHasChannelBinding(session)}
              <div class="session-item-row">
                <a
                  class="session-item"
                  class:active={isSelected}
                  class:has-action={canArchive}
                  aria-current={isSelected ? "page" : undefined}
                  href={`/sessions/${session.sessionId}`}
                >
                  <span class="session-title-row">
                    {#if presentation.channel}
                      <ChannelSessionIcon
                        adapter={presentation.channel.adapter}
                        scope={presentation.channel.scope}
                        label={presentation.channel.label}
                      />
                    {/if}
                    <strong>{presentation.title}</strong>
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
                {#if canArchive}
                  <form class="session-archive-form" method="POST" action="/sessions?/archiveSession">
                    <input type="hidden" name="sessionId" value={session.sessionId} />
                    <button
                      type="submit"
                      aria-label={`${messages.archiveSubmit}: ${sessionTitle(session)}`}
                      title={messages.archiveSubmit}
                    >
                      <Icon name="archive" size={15} stroke={2.1} />
                    </button>
                  </form>
                {/if}
              </div>
            {/each}
          </div>
        </details>
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

  .session-toolbar {
    align-items: stretch;
    display: flex;
    gap: 6px;
    min-width: 0;
  }

  .new-session-actions {
    display: flex;
    flex: 0 0 auto;
    gap: 4px;
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
    justify-content: center;
    height: 36px;
    padding: 0;
    text-align: center;
    text-decoration: none;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
    width: 36px;
  }

  .new-session:hover {
    background: var(--color-primary-weak);
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  .new-session.disabled {
    color: var(--color-ink-disabled);
    cursor: not-allowed;
    opacity: 0.72;
  }

  .new-session.disabled:hover {
    background: var(--color-surface-soft);
    border-color: transparent;
    color: var(--color-ink-disabled);
  }

  .session-filter {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    color: var(--color-ink-subtle);
    display: flex;
    flex: 1 1 auto;
    gap: 8px;
    min-height: 36px;
    min-width: 0;
    padding: 0 10px;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .session-filter:has(input:disabled) {
    opacity: 0.72;
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
    min-height: 34px;
    min-width: 0;
    outline: none;
    width: 100%;
  }

  .session-empty {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.45;
    margin: 8px 4px 0;
  }

  .session-unavailable {
    align-items: flex-start;
    background: color-mix(in srgb, var(--color-warning) 12%, var(--color-surface-soft));
    border: 1px solid color-mix(in srgb, var(--color-warning) 28%, transparent);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: flex;
    gap: 8px;
    margin-top: 4px;
    padding: 10px;
  }

  .session-unavailable :global(svg) {
    color: var(--color-warning);
    flex-shrink: 0;
    margin-top: 1px;
  }

  .session-unavailable strong {
    color: var(--color-ink);
    display: block;
    font-size: 13px;
    font-weight: 650;
    line-height: 1.35;
  }

  .session-unavailable p {
    font-size: 12px;
    line-height: 1.45;
    margin: 4px 0 0;
  }

  .session-groups {
    display: grid;
    gap: 12px;
    min-height: 0;
    overflow: auto;
    padding: 4px 0 2px;
  }

  .session-group {
    min-width: 0;
  }

  .session-group > summary {
    align-items: center;
    border-radius: var(--rounded-sm);
    color: var(--color-ink-disabled);
    cursor: pointer;
    display: flex;
    font-size: 11px;
    font-weight: 600;
    justify-content: space-between;
    letter-spacing: 0.06em;
    list-style: none;
    margin: 0 4px 4px;
    min-height: 28px;
    padding: 0 4px 0 6px;
    text-transform: uppercase;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .session-group > summary::-webkit-details-marker {
    display: none;
  }

  .session-group > summary:hover {
    background: var(--color-surface-soft);
    color: var(--color-ink-subtle);
  }

  .session-group > summary:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }

  .group-meta {
    align-items: center;
    display: inline-flex;
    gap: 3px;
  }

  .group-count {
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

  .group-disclosure {
    display: inline-flex;
    transition: transform 120ms ease;
  }

  .session-group:not([open]) .group-disclosure {
    transform: rotate(-90deg);
  }

  .session-group-items {
    display: grid;
    gap: 2px;
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

  .session-item-row {
    min-width: 0;
    position: relative;
  }

  .session-item.has-action {
    padding-right: 42px;
  }

  .session-archive-form {
    position: absolute;
    right: 7px;
    top: 7px;
  }

  .session-archive-form button {
    align-items: center;
    background: color-mix(in srgb, var(--color-surface) 82%, transparent);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    height: 28px;
    justify-content: center;
    padding: 0;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
    width: 28px;
  }

  .session-archive-form button:hover {
    background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
    border-color: color-mix(in srgb, var(--color-danger) 28%, var(--color-border));
    color: var(--color-danger);
  }

  .session-archive-form button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
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
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  .session-title-row strong {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .sr-only {
    clip: rect(0, 0, 0, 0);
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }
</style>
