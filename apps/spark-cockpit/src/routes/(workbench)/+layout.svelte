<script lang="ts">
  import { page } from "$app/state";
  import Icon from "$lib/Icon.svelte";
  import WorkbenchSessionRail from "$lib/WorkbenchSessionRail.svelte";
  import CockpitTopbar from "$lib/shell/CockpitTopbar.svelte";
  import type { CockpitSearchSession } from "$lib/shell/cockpit-search";
  import {
    buildWorkbenchNavItems,
    isWorkbenchNavItemActive,
    settingsHubHref,
    workspaceSwitcherHref as buildWorkspaceSwitcherHref,
  } from "$lib/workbench-nav";
  import { workspacePath } from "$lib/workspace-routes";

  interface SessionRecord extends CockpitSearchSession {
    activityUpdatedAt?: string;
    createdAt: string;
    updatedAt: string;
  }

  let { data, children } = $props();

  let t = $derived(data.messages.layout);
  let common = $derived(data.messages.common);
  let workspaceOptions = $derived(data.workspaces ?? []);
  let mobileSidebarOpen = $state(false);
  let lastWorkbenchPath = $state("");
  let activeWorkspacePath = $derived(
    data.activeWorkspace ? workspacePath(data.activeWorkspace) : "",
  );
  let settingsHref = $derived(settingsHubHref(data.activeWorkspace?.slug));
  let selectedSessionId = $derived(sessionIdFromPath(page.url.pathname));
  let sidebarSessions = $derived((data.sessions ?? []) as SessionRecord[]);
  let navItems = $derived(
    buildWorkbenchNavItems({
      activeWorkspacePath,
      hasActiveWorkspace: Boolean(data.activeWorkspace),
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

  function sessionIdFromPath(pathname: string) {
    if (!pathname.startsWith("/sessions/")) return null;
    try {
      const id = decodeURIComponent(
        pathname.slice("/sessions/".length).split("/")[0] ?? "",
      ).trim();
      return id || null;
    } catch {
      return null;
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="shell">
  <CockpitTopbar
    activeWorkspace={data.activeWorkspace}
    {common}
    layout={t}
    navigationControls="workbench-sidebar"
    navigationExpanded={mobileSidebarOpen}
    onToggleNavigation={() => (mobileSidebarOpen = !mobileSidebarOpen)}
    sessions={sidebarSessions}
    sessionMessages={data.messages.sessions}
    workspaceHref={workspaceSwitcherHref}
    workspaces={workspaceOptions}
  />

  <div class="shell-body">
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
        locale={data.locale}
        {common}
        messages={{
          workspaceConversation: data.messages.sessions.workspaceConversation,
          daemonConversation: data.messages.sessions.daemonConversation,
          searchPlaceholder: data.messages.sessions.searchPlaceholder,
          emptyTitle: data.messages.sessions.emptyTitle,
          daemonUnavailableTitle: data.messages.sessions.daemonUnavailableTitle,
          daemonUnavailableBody: data.messages.sessions.daemonUnavailableBody,
          listLabel: data.messages.sessions.listLabel,
          untitledConversation: data.messages.sessions.untitledConversation,
          unknownWorkspace: data.messages.sessions.unknownWorkspace,
          daemonGroup: data.messages.sessions.daemonGroup,
          channelSessionBadge: data.messages.sessions.channelSessionBadge,
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
    border-radius: 8px;
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
    padding: 26px 36px 40px;
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
      padding: 22px 18px 32px;
    }

    .content:has(:global(.sessions-stage)) {
      padding: 0;
    }
  }
</style>
