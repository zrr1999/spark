<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import Icon from "$lib/Icon.svelte";
  import SparkLogo from "$lib/SparkLogo.svelte";
  import WorkbenchSessionRail from "$lib/WorkbenchSessionRail.svelte";
  import { rememberWorkbenchPath } from "$lib/console-nav";
  import {
    buildWorkbenchNavItems,
    currentWorkbenchPageLabel,
    isWorkbenchNavItemActive,
    isWorkspaceScopedPath,
    workspaceSwitcherHref as buildWorkspaceSwitcherHref,
  } from "$lib/workbench-nav";
  import { workspaceAvatarStyle, workspaceInitial } from "$lib/workspace-avatar";
  import { workspacePath } from "$lib/workspace-routes";

  interface WorkbenchSearchResult {
    id: string;
    type: "session" | "workspace";
    title: string;
    description: string | null;
    status?: string;
    href: string;
  }

  interface SessionSearchRecord {
    sessionId: string;
    workspaceId: string;
    title?: string;
    status: string;
    activityStatus?: string;
    activityUpdatedAt?: string;
    createdAt: string;
    updatedAt: string;
  }

  interface WorkspaceOption {
    id: string;
    slug: string;
    name: string;
  }

  let { data, children } = $props();

  let t = $derived(data.messages.layout);
  let common = $derived(data.messages.common);
  let workspaceOptions = $derived(data.workspaces ?? []);
  let accountMenuOpen = $state(false);
  let accountMenuElement = $state<HTMLDivElement>();
  let shortcutLabel = $state("⌘K");
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let selectedSearchIndex = $state(0);
  let searchInputElement = $state<HTMLInputElement>();
  let mobileSidebarOpen = $state(false);
  let lastWorkbenchPath = $state("");
  let activeWorkspacePath = $derived(
    data.activeWorkspace ? workspacePath(data.activeWorkspace) : "",
  );
  let activeWorkspaceLabel = $derived(
    data.activeWorkspace?.name ?? t.user.workspaceSection,
  );
  let selectedSessionId = $derived(sessionIdFromPath(page.url.pathname));
  let sidebarSessions = $derived((data.sessions ?? []) as SessionSearchRecord[]);
  let searchResults = $derived(
    buildSearchResults({
      query: searchQuery,
      sessions: sidebarSessions,
      workspaces: workspaceOptions,
    }),
  );

  onMount(() => {
    shortcutLabel = getPlatformShortcutLabel();
  });

  $effect(() => {
    const pathname = page.url.pathname;
    rememberWorkbenchPath(pathname);
    if (lastWorkbenchPath !== pathname) {
      lastWorkbenchPath = pathname;
      mobileSidebarOpen = false;
    }
  });

  $effect(() => {
    resetSearchSelection(searchOpen, searchQuery, searchResults.length);
  });

  let navItems = $derived(
    buildWorkbenchNavItems({
      activeWorkspacePath,
      hasActiveWorkspace: Boolean(data.activeWorkspace),
      nav: t.nav,
    }),
  );

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

  function currentPageLabel(pathname: string) {
    return currentWorkbenchPageLabel({
      pathname,
      nav: t.nav,
      pages: t.pages,
    });
  }

  function getPlatformShortcutLabel() {
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘K" : "Ctrl K";
  }

  function toggleAccountMenu(event: MouseEvent) {
    event.stopPropagation();
    accountMenuOpen = !accountMenuOpen;
  }

  function closeAccountMenu() {
    accountMenuOpen = false;
  }

  function closeMobileSidebar() {
    mobileSidebarOpen = false;
  }

  function openSearch() {
    closeAccountMenu();
    searchOpen = true;
    requestAnimationFrame(() => searchInputElement?.focus());
  }

  function closeSearch() {
    searchOpen = false;
    searchQuery = "";
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSearchSelection(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSearchSelection(-1);
      return;
    }

    if (event.key === "Enter" && searchResults[selectedSearchIndex]) {
      event.preventDefault();
      void chooseSearchResult(searchResults[selectedSearchIndex]);
    }
  }

  function moveSearchSelection(delta: number) {
    if (searchResults.length === 0) {
      return;
    }

    selectedSearchIndex =
      (selectedSearchIndex + delta + searchResults.length) % searchResults.length;
  }

  function resetSearchSelection(_open: boolean, _query: string, _resultCount: number) {
    selectedSearchIndex = 0;
  }

  async function chooseSearchResult(result: WorkbenchSearchResult) {
    closeSearch();
    await goto(result.href);
  }

  function statusLabel(status: string) {
    const statusMap = common.status as Record<string, string>;
    return statusMap[status] ?? status;
  }

  function buildSearchResults(input: {
    query: string;
    sessions: SessionSearchRecord[];
    workspaces: WorkspaceOption[];
  }): WorkbenchSearchResult[] {
    const query = input.query.trim().toLowerCase();
    if (!query) return [];

    const workspaceById = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
    const sessionResults = input.sessions
      .filter((session) => {
        const workspace = workspaceById.get(session.workspaceId);
        return [session.sessionId, session.title ?? "", workspace?.name ?? "", workspace?.slug ?? ""]
          .join("\n")
          .toLowerCase()
          .includes(query);
      })
      .slice(0, 6)
      .map((session): WorkbenchSearchResult => {
        const workspace = workspaceById.get(session.workspaceId);
        const activityStatus = session.activityStatus ?? session.status;
        return {
          id: session.sessionId,
          type: "session",
          title: session.title || data.messages.sessions.untitledConversation,
          description: workspace
            ? `${workspace.name} · ${statusLabel(activityStatus)}`
            : statusLabel(activityStatus),
          status: activityStatus,
          href: `/sessions/${session.sessionId}`,
        };
      });

    const workspaceResults = input.workspaces
      .filter((workspace) =>
        [workspace.name, workspace.slug].join("\n").toLowerCase().includes(query),
      )
      .slice(0, Math.max(0, 8 - sessionResults.length))
      .map((workspace): WorkbenchSearchResult => ({
        id: workspace.id,
        type: "workspace",
        title: workspace.name,
        description: `/${workspace.slug}`,
        href: workspacePath(workspace),
      }));

    return [...sessionResults, ...workspaceResults];
  }

  function handleWindowClick(event: MouseEvent) {
    if (!accountMenuOpen || !accountMenuElement) {
      return;
    }

    const target = event.target;
    if (target instanceof Node && accountMenuElement.contains(target)) {
      return;
    }

    closeAccountMenu();
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
      return;
    }

    if (event.key === "Escape") {
      if (searchOpen) {
        closeSearch();
        return;
      }

      if (mobileSidebarOpen) {
        closeMobileSidebar();
        return;
      }

      closeAccountMenu();
    }
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

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

  <div class="shell">
    {#if mobileSidebarOpen}
      <button
        class="mobile-sidebar-backdrop open"
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
      <a class="brand-mark" href="/sessions" aria-label={t.aria.home}>
        <SparkLogo size={36} />
        <span class="brand-name">{t.brand.name}</span>
      </a>

      <WorkbenchSessionRail
        sessions={sidebarSessions}
        workspaces={workspaceOptions}
        selectedSessionId={selectedSessionId}
        locale={data.locale}
        common={common}
        messages={{
          newSession: data.messages.sessions.newSession,
          searchPlaceholder: data.messages.sessions.searchPlaceholder,
          emptyTitle: data.messages.sessions.emptyTitle,
          listLabel: data.messages.sessions.listLabel,
          untitledConversation: data.messages.sessions.untitledConversation,
          unknownWorkspace: data.messages.sessions.unknownWorkspace,
        }}
      />

      {#if navItems.length > 0}
        <nav class="secondary-nav" aria-label={t.aria.workspaceNavigation}>
          {#each navItems as item}
            <a class="nav-link" class:active={isActive(item.href)} href={item.href}>
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </a>
          {/each}
        </nav>
      {/if}

      <div class="sidebar-footer">
        <div class="settings-actions">
          <a class="settings-link" href="/settings">
            <Icon name="settings" size={16} stroke={2.2} />
            <span>{t.user.globalSettings}</span>
          </a>
          {#if data.activeWorkspace}
            <a class="settings-link" href={`${activeWorkspacePath}/settings`}>
              <Icon name="folder" size={16} stroke={2.2} />
              <span>{t.user.workspaceSettings}</span>
            </a>
          {/if}
        </div>

        <div
          class="account-menu sidebar-account"
          class:open={accountMenuOpen}
          bind:this={accountMenuElement}
        >
          <button
            class="user-menu"
            aria-controls="account-switcher-menu"
            aria-expanded={accountMenuOpen}
            aria-haspopup="menu"
            aria-label={t.aria.workspaceMenu}
            onclick={toggleAccountMenu}
            type="button"
          >
            <span
              class="workspace-avatar workspace-switcher-avatar"
              style={workspaceAvatarStyle(data.activeWorkspace)}
              aria-hidden="true"
            >
              {workspaceInitial(data.activeWorkspace)}
            </span>
            <span class="user-copy">
              <strong>{activeWorkspaceLabel}</strong>
            </span>
            <Icon name="chevron-down" size={14} stroke={2.4} />
          </button>

          <div
            class="account-popover"
            id="account-switcher-menu"
            role="menu"
            aria-label={t.aria.workspaceMenu}
            aria-hidden={!accountMenuOpen}
            tabindex="-1"
          >
            <div class="account-panel">
              <div class="account-menu-label">{t.user.switchWorkspace}</div>
              {#if workspaceOptions.length === 0}
                <div class="account-menu-empty">{t.user.noWorkspaces}</div>
              {:else}
                <div class="workspace-list">
                  {#each workspaceOptions as workspace}
                    <a
                      class="account-menu-item workspace-item"
                      class:selected={workspace.id === data.activeWorkspace?.id}
                      href={workspaceSwitcherHref(workspace)}
                      onclick={closeAccountMenu}
                      role="menuitem"
                    >
                      <span
                        class="workspace-avatar"
                        style={workspaceAvatarStyle(workspace)}
                        aria-hidden="true"
                      >
                        {workspaceInitial(workspace)}
                      </span>
                      <span class="workspace-item-copy">
                        <strong>{workspace.name}</strong>
                        {#if workspace.id === data.activeWorkspace?.id}
                          <small>{t.user.currentWorkspace}</small>
                        {/if}
                      </span>
                      {#if workspace.id === data.activeWorkspace?.id}
                        <Icon name="check" size={15} stroke={2.4} />
                      {/if}
                    </a>
                  {/each}
                </div>
              {/if}

              <a
                class="account-menu-item create-item"
                href="/workspaces/new"
                onclick={closeAccountMenu}
                role="menuitem"
              >
                <Icon name="plus" size={16} stroke={2.3} />
                <span>{t.user.createWorkspace}</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </aside>

    {#if searchOpen}
      <div class="search-layer">
        <button
          class="search-backdrop"
          type="button"
          aria-label={t.search.close}
          onclick={closeSearch}
        ></button>
        <div
          class="search-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="global-search-title"
        >
          <div class="search-dialog-header">
            <div>
              <p>{t.search.scope}</p>
              <h2 id="global-search-title">{t.search.title}</h2>
            </div>
            <kbd>{shortcutLabel}</kbd>
          </div>

          <label class="search-field">
            <Icon name="search" size={20} />
            <input
              bind:this={searchInputElement}
              bind:value={searchQuery}
              aria-controls="global-search-results"
              autocomplete="off"
              onkeydown={handleSearchKeydown}
              placeholder={t.search.inputPlaceholder}
              type="search"
            />
          </label>

          <div
            class="search-results"
            id="global-search-results"
            role="listbox"
            aria-label={t.search.resultsLabel}
            aria-live="polite"
          >
            {#if !searchQuery.trim()}
              <p class="search-state">{t.search.hint}</p>
            {:else if searchResults.length === 0}
              <p class="search-state">{t.search.empty}</p>
            {:else}
              <p class="search-section-label">{t.search.resultsLabel}</p>
              {#each searchResults as result, index}
                <button
                  class="search-result"
                  class:selected={index === selectedSearchIndex}
                  id={`search-result-${result.id}`}
                  onclick={() => void chooseSearchResult(result)}
                  onmouseenter={() => (selectedSearchIndex = index)}
                  role="option"
                  aria-selected={index === selectedSearchIndex}
                  type="button"
                >
                  <span class="search-result-icon">
                    <Icon name={result.type === "session" ? "agents" : "workspace"} size={18} stroke={2.1} />
                  </span>
                  <span class="search-result-copy">
                    <strong>{result.title}</strong>
                    {#if result.description}
                      <small>{result.description}</small>
                    {/if}
                  </span>
                  {#if result.status}
                    <span class="search-result-meta">
                      <em>{statusLabel(result.status)}</em>
                    </span>
                  {/if}
                </button>
              {/each}
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <div class="workspace">
      <header class="topbar">
        <div class="topbar-leading">
          <button
            class="mobile-nav-toggle"
            type="button"
            aria-controls="workbench-sidebar"
            aria-expanded={mobileSidebarOpen}
            aria-label={t.aria.workspaceNavigation}
            onclick={() => (mobileSidebarOpen = !mobileSidebarOpen)}
          >
            <Icon name={mobileSidebarOpen ? "close" : "menu"} size={18} stroke={2.2} />
          </button>
          <nav class="breadcrumb" aria-label={t.aria.breadcrumb}>
            {#if data.activeWorkspace && isWorkspaceScopedPath(page.url.pathname, activeWorkspacePath)}
              <a href={activeWorkspacePath}>{data.activeWorkspace.name}</a>
              <Icon name="chevron" size={14} stroke={2.2} />
            {/if}
            <span>{currentPageLabel(page.url.pathname)}</span>
          </nav>
        </div>
        <button
          class="topbar-search"
          type="button"
          aria-label={t.aria.globalSearch}
          onclick={openSearch}
        >
          <Icon name="search" size={16} />
          <span>{t.search.placeholder}</span>
          <kbd>{shortcutLabel}</kbd>
        </button>
      </header>

      <main class="content">
        {@render children()}
      </main>
    </div>
  </div>

<style>
  :global(body) {
    margin: 0;
    background: var(--color-canvas);
    color: var(--color-ink);
    font-family:
      Inter,
      Geist Sans,
      ui-sans-serif,
      system-ui,
      sans-serif;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .shell {
    display: grid;
    min-height: 100vh;
    grid-template-columns: 260px minmax(0, 1fr);
  }

  .mobile-sidebar-backdrop,
  .mobile-nav-toggle {
    display: none;
  }

  .sidebar {
    align-self: start;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100vh;
    min-height: 0;
    padding: 14px 10px 10px;
    position: sticky;
    top: 0;
  }

  .brand-mark {
    align-items: center;
    color: var(--color-ink);
    display: inline-flex;
    flex: 0 0 auto;
    gap: 10px;
    margin: 0 6px 2px;
    text-decoration: none;
  }

  .brand-name {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    min-height: 34px;
    padding: 0 10px;
    position: relative;
    text-decoration: none;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  a.nav-link:hover {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  a.nav-link.active {
    background: var(--color-primary-weak);
    color: var(--color-primary);
    font-weight: 600;
  }

  .workspace {
    min-width: 0;
  }

  .topbar {
    align-items: center;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(0, 1fr) auto;
    height: 48px;
    padding: 0 24px 0 28px;
  }

  .topbar-leading {
    align-items: center;
    display: flex;
    gap: 10px;
    min-width: 0;
  }

  .breadcrumb {
    align-items: center;
    color: var(--color-ink-disabled);
    display: inline-flex;
    font-size: 12px;
    font-weight: 700;
    gap: 8px;
    min-width: 0;
    white-space: nowrap;
  }

  .breadcrumb a {
    color: var(--color-ink-subtle);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-decoration: none;
  }

  .breadcrumb a:hover {
    color: var(--color-primary);
  }

  .breadcrumb span {
    color: var(--color-ink);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .topbar-search {
    align-items: center;
    background: var(--color-surface-soft);
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--color-ink-subtle);
    cursor: pointer;
    display: inline-flex;
    gap: 8px;
    min-height: 34px;
    padding: 0 10px;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease,
      color 120ms ease;
  }

  .topbar-search:hover,
  .topbar-search:focus-visible {
    background: var(--color-surface);
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    color: var(--color-ink);
    outline: none;
  }

  .topbar-search span {
    font-size: 13px;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button {
    font: inherit;
  }

  .user-menu {
    align-items: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    gap: 10px;
    min-height: 40px;
    padding: 6px 8px;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
    user-select: none;
  }

  .user-menu:hover,
  .user-menu:focus-visible,
  .account-menu.open .user-menu {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  kbd {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-ink-subtle);
    font:
      700 11px/1 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    padding: 5px 6px;
  }

  .sidebar-footer {
    border-top: 1px solid var(--color-border-soft);
    display: grid;
    flex: 0 0 auto;
    gap: 6px;
    margin-top: auto;
    padding-top: 8px;
  }

  .settings-actions {
    display: grid;
    gap: 2px;
  }

  .settings-link {
    align-items: center;
    border-radius: 8px;
    color: var(--color-ink-muted);
    display: flex;
    font-size: 13px;
    font-weight: 500;
    gap: 10px;
    min-height: 34px;
    padding: 0 10px;
    text-decoration: none;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .settings-link:hover {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  .account-menu {
    position: relative;
  }

  .sidebar-account {
    margin-top: 0;
  }

  .sidebar-account .user-menu {
    justify-content: flex-start;
    width: 100%;
  }

  .sidebar-account .user-menu > :global(svg:last-child) {
    margin-left: auto;
  }

  .user-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
    text-align: left;
  }

  .user-copy strong {
    color: var(--color-ink);
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-popover {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    box-shadow: var(--shadow-popover);
    min-width: 260px;
    opacity: 0;
    overflow: hidden;
    padding: 6px;
    pointer-events: none;
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    transform: translateY(-4px);
    transition:
      opacity 120ms ease,
      transform 120ms ease,
      visibility 120ms ease;
    visibility: hidden;
    width: max(100%, 260px);
    z-index: 40;
  }

  .sidebar-account .account-popover {
    bottom: calc(100% + 8px);
    left: 0;
    right: auto;
    top: auto;
    transform: translateY(4px);
  }

  .account-menu.open .account-popover {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
    visibility: visible;
  }

  .account-panel {
    display: grid;
    gap: 2px;
  }

  .account-menu-item span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-menu-label {
    color: var(--color-ink-disabled);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    padding: 6px 10px 4px;
    text-transform: uppercase;
  }

  .account-menu-empty {
    color: var(--color-ink-disabled);
    font-size: 12px;
    line-height: 1.45;
    padding: 4px 10px 10px;
  }

  .workspace-list {
    display: grid;
    gap: 2px;
    max-height: 220px;
    overflow: auto;
  }

  .account-menu-item {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 8px;
    color: var(--color-ink-muted);
    display: grid;
    font-size: 13px;
    font-weight: 500;
    gap: 10px;
    grid-template-columns: 24px minmax(0, 1fr) 16px;
    min-height: 36px;
    padding: 6px 10px;
    text-align: left;
    text-decoration: none;
    width: 100%;
  }

  .account-menu-item.create-item,
  .account-panel > .account-menu-item:not(.workspace-item) {
    grid-template-columns: 24px minmax(0, 1fr);
  }

  .account-menu-item:not(:disabled) {
    cursor: pointer;
  }

  .account-menu-item:hover {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  .account-menu-item.selected {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .workspace-item-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .workspace-item-copy strong {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-item-copy small {
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-weight: 500;
  }

  .account-menu-item.selected .workspace-item-copy small {
    color: color-mix(in srgb, var(--color-primary) 72%, var(--color-ink-subtle));
  }

  .workspace-avatar {
    background: var(--avatar-bg, var(--color-surface-soft));
    border: 1px solid var(--avatar-border, var(--color-border));
    border-radius: 6px;
    color: var(--avatar-ink, var(--color-ink-subtle));
    display: grid;
    font-size: 11px;
    font-weight: 700;
    height: 24px;
    line-height: 1;
    place-items: center;
    text-transform: uppercase;
    width: 24px;
  }

  .workspace-switcher-avatar {
    flex: 0 0 auto;
    height: 26px;
    width: 26px;
  }

  .search-layer {
    align-items: flex-start;
    display: flex;
    inset: 0;
    justify-content: center;
    padding: 96px 24px 24px;
    position: fixed;
    z-index: 80;
  }

  .search-backdrop {
    background: rgba(15, 23, 42, 0.18);
    border: 0;
    cursor: default;
    inset: 0;
    padding: 0;
    position: absolute;
  }

  .search-dialog {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    box-shadow: var(--shadow-popover);
    color: var(--color-ink);
    display: grid;
    gap: 14px;
    max-height: min(620px, calc(100vh - 140px));
    max-width: 720px;
    overflow: hidden;
    padding: 16px;
    position: relative;
    width: min(720px, 100%);
    z-index: 1;
  }

  .search-dialog-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border-soft);
    display: flex;
    justify-content: space-between;
    padding: 0 2px 12px;
  }

  .search-dialog-header p {
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 800;
    margin: 0 0 4px;
  }

  .search-dialog-header h2 {
    font-size: 18px;
    line-height: 1.35;
    margin: 0;
  }

  .search-field {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: 8px;
    color: var(--color-ink-subtle);
    display: grid;
    gap: 10px;
    grid-template-columns: 20px minmax(0, 1fr);
    min-height: 48px;
    padding: 0 13px;
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .search-field:focus-within {
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
  }

  .search-field input {
    background: transparent;
    border: 0;
    color: var(--color-ink);
    font: inherit;
    min-width: 0;
    outline: none;
    padding: 0;
  }

  .search-results {
    display: grid;
    gap: 6px;
    max-height: 440px;
    overflow: auto;
    padding: 2px;
  }

  .search-state {
    color: var(--color-ink-subtle);
    font-size: 14px;
    line-height: 1.5;
    margin: 0;
    padding: 16px 4px 18px;
  }

  .search-section-label {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 800;
    margin: 0;
    padding: 2px 4px 4px;
  }

  .search-result {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--color-ink);
    cursor: pointer;
    display: grid;
    gap: 12px;
    grid-template-columns: 34px minmax(0, 1fr) auto;
    min-height: 68px;
    padding: 10px 12px;
    text-align: left;
    width: 100%;
  }

  .search-result:hover,
  .search-result.selected {
    background: var(--color-primary-weak);
    border-color: var(--color-focus-ring);
  }

  .search-result-icon {
    align-items: center;
    background: var(--color-surface-soft);
    border-radius: 8px;
    color: var(--color-primary);
    display: inline-flex;
    height: 34px;
    justify-content: center;
    width: 34px;
  }

  .search-result-copy,
  .search-result-meta {
    min-width: 0;
  }

  .search-result-copy {
    display: grid;
    gap: 3px;
  }

  .search-result-copy strong {
    font-size: 14px;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-result-copy small {
    color: var(--color-ink-subtle);
    font-size: 12px;
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-result-meta {
    align-items: flex-end;
    display: grid;
    gap: 5px;
    justify-items: end;
    max-width: 180px;
  }

  .search-result-meta em {
    background: var(--color-surface-soft);
    border-radius: 999px;
    color: var(--color-ink-subtle);
    font-size: 11px;
    font-style: normal;
    font-weight: 800;
    line-height: 1;
    padding: 5px 8px;
    white-space: nowrap;
  }

  .content {
    padding: 26px 36px 40px;
  }

  .content:has(:global(.sessions-stage)) {
    padding: 0;
  }

  @media (max-width: 1000px) {
    .shell {
      grid-template-columns: 240px minmax(0, 1fr);
    }

    .sidebar {
      padding: 14px 10px 10px;
    }

    .brand-mark {
      margin-left: 4px;
    }

    .topbar {
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 0 20px;
    }
  }

  @media (max-width: 700px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
    }

    .sidebar {
      border-bottom: 0;
      border-right: 1px solid var(--color-border);
      box-shadow: var(--shadow-popover);
      height: 100dvh;
      inset: 0 auto 0 0;
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
      z-index: 71;
    }

    .sidebar.mobile-open {
      opacity: 1;
      transform: translateX(0);
      visibility: visible;
    }

    .mobile-sidebar-backdrop {
      background: rgba(15, 23, 42, 0.24);
      border: 0;
      cursor: default;
      display: block;
      inset: 0;
      opacity: 0;
      padding: 0;
      pointer-events: none;
      position: fixed;
      transition: opacity 140ms ease;
      z-index: 70;
    }

    .mobile-sidebar-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }

    .mobile-nav-toggle {
      align-items: center;
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: 7px;
      color: var(--color-ink-muted);
      cursor: pointer;
      display: inline-flex;
      flex: 0 0 auto;
      height: 32px;
      justify-content: center;
      padding: 0;
      width: 32px;
    }

    .mobile-nav-toggle:hover,
    .mobile-nav-toggle:focus-visible {
      background: var(--color-surface-soft);
      color: var(--color-ink);
      outline: none;
    }

    .brand-mark {
      margin-left: 4px;
    }

    .topbar {
      grid-template-columns: minmax(0, 1fr) auto;
      padding: 0 18px;
    }

    .topbar-search span,
    .topbar-search kbd {
      display: none;
    }

    .topbar-search {
      justify-content: center;
      padding: 0;
      width: 34px;
    }

    .content {
      padding: 22px 18px 32px;
    }

    .content:has(:global(.sessions-stage)) {
      padding: 0;
    }

    .search-layer {
      padding: 76px 14px 14px;
    }

    .search-dialog {
      max-height: calc(100vh - 96px);
      padding: 14px;
    }

    .search-result {
      align-items: start;
      grid-template-columns: 34px minmax(0, 1fr);
    }

    .search-result-meta {
      grid-column: 2;
      justify-items: start;
      max-width: 100%;
    }

  }
</style>
