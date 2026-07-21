<script lang="ts">
  import { browser } from "$app/environment";
  import { invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import Icon from "$lib/Icon.svelte";
  import {
    parsePendingAskEvent,
    pendingAskEventCursor,
    shouldInvalidatePendingAsk,
  } from "$lib/pending-ask";
  import WorkbenchSessionRail from "$lib/WorkbenchSessionRail.svelte";
  import CockpitTopbar from "$lib/shell/CockpitTopbar.svelte";
  import type { CockpitSearchSession } from "$lib/shell/cockpit-search";
  import {
    buildWorkbenchNavItems,
    isWorkbenchNavItemActive,
    settingsHubHref,
    workspaceSwitcherHref as buildWorkspaceSwitcherHref,
  } from "$lib/workbench-nav";
  import { workbenchSessionIdFromPath, workspacePath } from "$lib/workspace-routes";

  interface SessionRecord extends CockpitSearchSession {
    activityUpdatedAt?: string;
    createdAt: string;
    updatedAt: string;
  }

  let { data, children } = $props();

  let t = $derived(data.messages.layout);
  let common = $derived(data.messages.common);
  let workspaceOptions = $derived(data.workspaces ?? []);
  let activeWorkspaceId = $derived(data.activeWorkspace?.id ?? null);
  let mobileSidebarOpen = $state(false);
  let lastWorkbenchPath = $state("");
  let activeWorkspacePath = $derived(
    data.activeWorkspace ? workspacePath(data.activeWorkspace) : "",
  );
  let settingsHref = $derived(settingsHubHref(data.activeWorkspace?.slug));
  let selectedSessionId = $derived(workbenchSessionIdFromPath(page.url.pathname));
  let isWorkspaceDirectory = $derived(page.url.pathname === "/");
  let sidebarSessions = $derived((data.sessions ?? []) as SessionRecord[]);
  let navItems = $derived(
    buildWorkbenchNavItems({
      activeWorkspacePath,
      hasActiveWorkspace: Boolean(data.activeWorkspace) && !isWorkspaceDirectory,
      nav: t.nav,
    }),
  );

  $effect(() => {
    const pathname = page.url.pathname;
    if (lastWorkbenchPath !== pathname) {
      lastWorkbenchPath = pathname;
      mobileSidebarOpen = false;
    }
  });

  $effect(() => {
    const workspaceId = activeWorkspaceId;
    if (!browser || !workspaceId) return;

    let stopped = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let invalidationTimer: number | undefined;

    const invalidatePendingAsk = () => {
      if (invalidationTimer !== undefined) return;
      invalidationTimer = window.setTimeout(() => {
        invalidationTimer = undefined;
        void invalidateAll();
      }, 100);
    };

    const connect = () => {
      if (stopped) return;
      const url = new URL("/api/v1/events", window.location.origin);
      const cursor = readPendingAskCursor();
      if (cursor) url.searchParams.set("cursor", cursor);

      eventSource = new EventSource(url);
      eventSource.addEventListener("spark-cockpit.event", (message) => {
        const event = parsePendingAskEvent(message.data);
        if (!event) return;
        writePendingAskCursor(pendingAskEventCursor(event));
        if (shouldInvalidatePendingAsk(event, workspaceId)) invalidatePendingAsk();
      });
      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        if (!stopped) reconnectTimer = window.setTimeout(connect, 2_000);
      };
    };

    connect();
    return () => {
      stopped = true;
      eventSource?.close();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (invalidationTimer !== undefined) window.clearTimeout(invalidationTimer);
    };
  });

  function isActive(href: string) {
    return isWorkbenchNavItemActive({
      pathname: page.url.pathname,
      href,
      activeWorkspacePath,
    });
  }

  function workspaceSwitcherHref(workspace: { slug: string }) {
    return buildWorkspaceSwitcherHref({
      pathname: page.url.pathname,
      origin: page.url.origin,
      activeWorkspacePath,
      targetWorkspaceSlug: workspace.slug,
      workspacePath,
    });
  }

  function closeMobileSidebar() {
    mobileSidebarOpen = false;
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && mobileSidebarOpen) closeMobileSidebar();
  }

  const pendingAskCursorKey = "spark-cockpit:pending-ask:events-cursor";

  function readPendingAskCursor() {
    try {
      return window.sessionStorage.getItem(pendingAskCursorKey);
    } catch {
      return null;
    }
  }

  function writePendingAskCursor(cursor: string) {
    try {
      window.sessionStorage.setItem(pendingAskCursorKey, cursor);
    } catch {
      // Database-backed layout loading remains authoritative when storage is unavailable.
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="shell">
  <CockpitTopbar
    activeWorkspace={isWorkspaceDirectory ? null : data.activeWorkspace}
    {common}
    layout={t}
    navigationControls="workbench-sidebar"
    navigationExpanded={mobileSidebarOpen}
    onToggleNavigation={() => (mobileSidebarOpen = !mobileSidebarOpen)}
    sessions={sidebarSessions}
    sessionMessages={data.messages.sessions}
    showNavigationToggle={!isWorkspaceDirectory}
    showWorkspaceMenu={!isWorkspaceDirectory}
    workspaceHref={workspaceSwitcherHref}
    workspaces={workspaceOptions}
  />

  <div class="shell-body" class:directory-mode={isWorkspaceDirectory}>
    {#if !isWorkspaceDirectory}
      {#if mobileSidebarOpen}
        <button
          class="mobile-sidebar-backdrop"
          type="button"
          aria-label={t.aria.closeWorkspaceNavigation}
          onclick={closeMobileSidebar}
        ></button>
      {/if}

      <aside
        class="sidebar"
        class:mobile-open={mobileSidebarOpen}
        id="workbench-sidebar"
        aria-label={t.aria.workspaceNavigation}
      >
        <WorkbenchSessionRail
          sessions={sidebarSessions}
          workspaces={workspaceOptions}
          activeWorkspaceId={data.activeWorkspace?.id ?? null}
          selectedSessionId={selectedSessionId}
          sessionsAvailable={data.sessionsAvailable}
          sessionControlAvailable={data.sessionControlAvailable}
          locale={data.locale}
          {common}
          messages={{
            newSession: data.messages.sessions.newSession,
            searchPlaceholder: data.messages.sessions.searchPlaceholder,
            emptyTitle: data.messages.sessions.emptyTitle,
            daemonUnavailableTitle: data.messages.sessions.daemonUnavailableTitle,
            daemonUnavailableBody: data.messages.sessions.daemonUnavailableBody,
            listLabel: data.messages.sessions.listLabel,
            untitledConversation: data.messages.sessions.untitledConversation,
            unknownWorkspace: data.messages.sessions.unknownWorkspace,
            channelSessionBadge: data.messages.sessions.channelSessionBadge,
            channelLabels: data.messages.sessions.channelLabels,
            sessionTypes: data.messages.sessions.sessionTypes,
            archiveSubmit: data.messages.sessions.archiveSubmit,
          }}
        />

        <nav class="secondary-nav" aria-label={t.aria.workspaceNavigation}>
          {#each navItems as item}
            <a class="nav-link" class:active={isActive(item.href)} href={item.href}>
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </a>
          {/each}
          <a class="nav-link" href={settingsHref}>
            <Icon name="settings" size={18} stroke={2.2} />
            <span>{t.user.settings}</span>
          </a>
        </nav>
      </aside>
    {/if}

    <div class="workspace">
      <main class="content">
        {@render children()}
      </main>
    </div>
  </div>
</div>

<style>
  :global(body) {
    background: var(--color-canvas);
    color: var(--color-ink);
    font-family:
      Inter,
      Geist Sans,
      ui-sans-serif,
      system-ui,
      sans-serif;
  }

  .shell {
    display: grid;
    grid-template-rows: 52px minmax(0, 1fr);
    height: 100dvh;
    overflow: hidden;
  }

  .shell-body {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    min-height: 0;
  }

  .shell-body.directory-mode {
    grid-template-columns: minmax(0, 1fr);
  }

  .sidebar {
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    padding: 10px;
  }

  .secondary-nav {
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    flex: 0 0 auto;
    gap: 2px;
    padding-top: 8px;
  }

  .nav-link {
    align-items: center;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: flex;
    font-size: 13px;
    font-weight: 500;
    gap: 10px;
    min-height: 40px;
    padding: 0 10px;
    text-decoration: none;
  }

  .nav-link:hover {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  .nav-link.active {
    background: var(--color-primary-weak);
    color: var(--color-primary);
    font-weight: 600;
  }

  .workspace {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
  }

  .content {
    container-type: inline-size;
    min-height: 0;
    overflow: auto;
    padding: var(--spacing-xl) var(--spacing-xxl) var(--spacing-section);
  }

  .content:has(:global(.sessions-stage)) {
    overflow: hidden;
    padding: 0;
  }

  .mobile-sidebar-backdrop {
    display: none;
  }

  @media (max-width: 1000px) {
    .shell-body {
      grid-template-columns: 240px minmax(0, 1fr);
    }

  }

  @media (max-width: 900px) {
    .shell-body {
      grid-template-columns: minmax(0, 1fr);
    }

    .sidebar {
      border-right: 1px solid var(--color-border);
      box-shadow: var(--shadow-popover);
      height: calc(100dvh - 52px);
      inset: 52px auto 0 0;
      max-width: min(320px, 88vw);
      opacity: 0;
      position: fixed;
      transform: translateX(-100%);
      transition:
        opacity 140ms ease,
        transform 140ms ease,
        visibility 140ms ease;
      visibility: hidden;
      width: min(320px, 88vw);
      z-index: 55;
    }

    .sidebar.mobile-open {
      opacity: 1;
      transform: translateX(0);
      visibility: visible;
    }

    .mobile-sidebar-backdrop {
      background: rgb(15 23 42 / 24%);
      border: 0;
      display: block;
      inset: 52px 0 0;
      padding: 0;
      position: fixed;
      z-index: 50;
    }

    .content {
      padding: var(--spacing-lg) var(--spacing-md) var(--spacing-xxl);
    }

    .content:has(:global(.sessions-stage)) {
      padding: 0;
    }
  }
</style>
