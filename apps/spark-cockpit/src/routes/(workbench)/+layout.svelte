<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import Icon from "$lib/Icon.svelte";
  import SparkLogo from "$lib/SparkLogo.svelte";
  import { workspacePath } from "$lib/workspace-routes";

  interface ProjectSearchResult {
    id: string;
    type: "project";
    title: string;
    description: string | null;
    status: string;
    href: string;
    workspaceId: string;
    workspaceSlug: string;
    workspaceName: string;
    updatedAt: string;
  }

  interface SearchResponse {
    results?: ProjectSearchResult[];
  }

  interface WorkspaceAvatarSource {
    id?: string;
    slug?: string;
    name?: string | null;
  }

  const workspaceAvatarPalette = [
    { background: "#E0F2FE", border: "#BAE6FD", ink: "#0369A1" },
    { background: "#DCFCE7", border: "#BBF7D0", ink: "#15803D" },
    { background: "#FEF3C7", border: "#FDE68A", ink: "#A16207" },
    { background: "#EDE9FE", border: "#DDD6FE", ink: "#6D28D9" },
    { background: "#FFE4E6", border: "#FECDD3", ink: "#BE123C" },
    { background: "#CCFBF1", border: "#99F6E4", ink: "#0F766E" },
    { background: "#E0E7FF", border: "#C7D2FE", ink: "#4338CA" },
    { background: "#FED7AA", border: "#FDBA74", ink: "#C2410C" },
  ] as const;

  let { data, children } = $props();

  let t = $derived(data.messages.layout);
  let common = $derived(data.messages.common);
  let workspaceOptions = $derived(data.workspaces ?? []);
  let accountMenuOpen = $state(false);
  let accountMenuElement = $state<HTMLDivElement>();
  let shortcutLabel = $state("⌘K");
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let searchResults = $state<ProjectSearchResult[]>([]);
  let searchLoading = $state(false);
  let searchError = $state<string | null>(null);
  let selectedSearchIndex = $state(0);
  let searchInputElement = $state<HTMLInputElement>();
  let searchRequestId = 0;
  let isWorkspaceSetup = $derived(page.url.pathname === "/" && !data.activeWorkspace);
  let activeWorkspacePath = $derived(
    data.activeWorkspace ? workspacePath(data.activeWorkspace) : "",
  );
  let activeWorkspaceLabel = $derived(
    data.activeWorkspace?.name ?? t.user.workspaceSection,
  );
  let workspaceAvatarStyles = $derived(buildWorkspaceAvatarStyles(workspaceOptions));

  onMount(() => {
    shortcutLabel = getPlatformShortcutLabel();
  });

  $effect(() => {
    const query = searchQuery.trim();
    const activeWorkspaceId = data.activeWorkspace?.id ?? "";

    if (!searchOpen) {
      searchRequestId += 1;
      return;
    }

    const requestId = ++searchRequestId;
    selectedSearchIndex = 0;
    searchError = null;

    if (!query) {
      searchResults = [];
      searchLoading = false;
      return;
    }

    const controller = new AbortController();
    searchLoading = true;

    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, limit: "8" });
        if (activeWorkspaceId) {
          params.set("workspaceId", activeWorkspaceId);
        }

        const response = await fetch(`/api/search?${params.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(t.search.failed);
        }

        const payload = (await response.json()) as SearchResponse;
        if (requestId !== searchRequestId) {
          return;
        }

        searchResults = payload.results ?? [];
      } catch (caught) {
        if (controller.signal.aborted || requestId !== searchRequestId) {
          return;
        }

        searchResults = [];
        searchError = caught instanceof Error ? caught.message : t.search.failed;
      } finally {
        if (requestId === searchRequestId) {
          searchLoading = false;
        }
      }
    }, 140);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  });

  let navItems = $derived([
    {
      href: activeWorkspacePath || "/",
      label: data.activeWorkspace ? t.nav.overview : t.nav.home,
      icon: "home",
    },
    { href: `${activeWorkspacePath}/projects`, label: t.nav.projects, icon: "folder" },
    { href: `${activeWorkspacePath}/inbox`, label: t.nav.inbox, icon: "inbox" },
    { href: `${activeWorkspacePath}/repos`, label: t.nav.repos, icon: "repos" },
    { href: `${activeWorkspacePath}/agents`, label: t.nav.agents, icon: "agents" },
    {
      href: `${activeWorkspacePath}/artifacts`,
      label: t.nav.artifacts,
      icon: "artifacts",
    },
    { href: `${activeWorkspacePath}/settings`, label: t.nav.settings, icon: "settings" },
  ] as const);

  function isActive(href: string) {
    const pathname = page.url.pathname;
    if (href === "/" || (activeWorkspacePath && href === activeWorkspacePath)) {
      return pathname === href;
    }

    return pathname === href || pathname.startsWith(`${href}/`);
  }

  function currentPageLabel(pathname: string) {
    if (pathname === "/") {
      return t.pages.setupGuide;
    }

    const section = pathname.split("/").filter(Boolean)[1] ?? "";
    if (!section) {
      return t.pages.overview;
    }

    if (section === "projects") {
      return t.nav.projects;
    }

    if (section === "inbox") {
      return t.nav.inbox;
    }

    if (section === "repos") {
      return t.nav.repos;
    }

    if (section === "agents") {
      return t.nav.agents;
    }

    if (section === "artifacts") {
      return t.nav.artifacts;
    }

    if (section === "settings") {
      return t.pages.settings;
    }

    return t.pages.comingSoon;
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

  function openSearch() {
    if (isWorkspaceSetup) {
      return;
    }

    closeAccountMenu();
    searchOpen = true;
    requestAnimationFrame(() => searchInputElement?.focus());
  }

  function closeSearch() {
    searchOpen = false;
    searchQuery = "";
    searchResults = [];
    searchError = null;
    searchLoading = false;
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

  async function chooseSearchResult(result: ProjectSearchResult) {
    closeSearch();
    await goto(result.href);
  }

  function statusLabel(status: string) {
    const statusMap = common.status as Record<string, string>;
    return statusMap[status] ?? status;
  }

  function workspaceInitial(workspace: WorkspaceAvatarSource | null | undefined) {
    const label = (workspace?.name || workspace?.slug || "").trim();
    return Array.from(label)[0]?.toLocaleUpperCase() ?? "?";
  }

  function workspaceAvatarStyle(workspace: WorkspaceAvatarSource | null | undefined) {
    if (workspace?.id && workspaceAvatarStyles.has(workspace.id)) {
      return workspaceAvatarStyles.get(workspace.id);
    }

    return avatarStyleForIndex(hashWorkspace(workspace));
  }

  function buildWorkspaceAvatarStyles(workspaces: WorkspaceAvatarSource[]) {
    const styles = new Map<string, string>();
    const usedByInitial = new Map<string, Set<number>>();

    for (const workspace of workspaces) {
      if (!workspace.id) {
        continue;
      }

      const initial = workspaceInitial(workspace);
      const used = usedByInitial.get(initial) ?? new Set<number>();
      let colorIndex = hashWorkspace(workspace) % workspaceAvatarPalette.length;
      let attempts = 0;

      while (used.has(colorIndex) && attempts < workspaceAvatarPalette.length) {
        colorIndex = (colorIndex + 1) % workspaceAvatarPalette.length;
        attempts += 1;
      }

      used.add(colorIndex);
      usedByInitial.set(initial, used);
      styles.set(workspace.id, avatarStyleForIndex(colorIndex));
    }

    return styles;
  }

  function avatarStyleForIndex(index: number) {
    const color = workspaceAvatarPalette[index % workspaceAvatarPalette.length];
    return `--avatar-bg: ${color.background}; --avatar-border: ${color.border}; --avatar-ink: ${color.ink};`;
  }

  function hashWorkspace(workspace: WorkspaceAvatarSource | null | undefined) {
    const value = `${workspace?.id ?? ""}|${workspace?.slug ?? ""}|${workspace?.name ?? ""}`;
    let hash = 0;

    for (const char of value) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return hash;
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

      closeAccountMenu();
    }
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

{#if isWorkspaceSetup}
  <div class="setup-shell">
    <header class="setup-topbar">
      <a class="setup-brand" href="/" aria-label={t.aria.home}>
        <SparkLogo size={42} />
        <span class="brand-name">{t.brand.name}</span>
      </a>
    </header>

    <main class="setup-content">
      {@render children()}
    </main>
  </div>
{:else}
  <div class="shell">
    <aside class="sidebar" aria-label={t.aria.workspaceNavigation}>
      <a class="brand-mark" href={activeWorkspacePath || "/"} aria-label={t.aria.home}>
        <SparkLogo size={42} />
        <span class="brand-name">{t.brand.name}</span>
      </a>

      <button
        class="global-search sidebar-search"
        type="button"
        aria-label={t.aria.globalSearch}
        onclick={openSearch}
      >
        <Icon name="search" size={18} />
        <span>{t.search.placeholder}</span>
        <kbd>{shortcutLabel}</kbd>
      </button>

      <nav>
        {#each navItems as item}
          {#if "disabled" in item && item.disabled}
            <span class="nav-link disabled" aria-disabled="true">
              <Icon name={item.icon} size={22} />
              <span>{item.label}</span>
              <small class="soon-badge">{common.comingSoon}</small>
            </span>
          {:else}
            <a
              class="nav-link"
              class:active={isActive(item.href)}
              href={item.href}
            >
              <Icon name={item.icon} size={22} />
              <span>{item.label}</span>
            </a>
          {/if}
        {/each}
      </nav>

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
          <span class="user-copy">{activeWorkspaceLabel}</span>
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
          <div class="account-menu-label">{t.user.workspaceSection}</div>
          {#if workspaceOptions.length === 0}
            <div class="account-menu-empty">{t.user.noWorkspaces}</div>
          {:else}
            {#each workspaceOptions as workspace}
              <a
                class="account-menu-item"
                class:selected={workspace.id === data.activeWorkspace?.id}
                href={workspacePath(workspace)}
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
                <span>{workspace.name}</span>
                {#if workspace.id === data.activeWorkspace?.id}
                  <Icon name="check" size={15} stroke={2.4} />
                {/if}
              </a>
            {/each}
          {/if}

          <div class="account-separator"></div>

          <a
            class="account-menu-item"
            href="/?create=workspace"
            onclick={closeAccountMenu}
            role="menuitem"
          >
            <Icon name="plus" size={16} stroke={2.3} />
            <span>{t.user.createWorkspace}</span>
          </a>
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
            aria-label={t.search.projectResults}
            aria-live="polite"
          >
            {#if searchLoading}
              <p class="search-state">{t.search.loading}</p>
            {:else if searchError}
              <p class="search-state error">{searchError}</p>
            {:else if !searchQuery.trim()}
              <p class="search-state">{t.search.hintProjects}</p>
            {:else if searchResults.length === 0}
              <p class="search-state">{t.search.noProjects}</p>
            {:else}
              <p class="search-section-label">{t.search.projectResults}</p>
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
                    <Icon name="folder" size={18} stroke={2.1} />
                  </span>
                  <span class="search-result-copy">
                    <strong>{result.title}</strong>
                    <small>
                      {result.description ||
                        `${result.workspaceName} · /${result.workspaceSlug}`}
                    </small>
                  </span>
                  <span class="search-result-meta">
                    <span>{result.workspaceName}</span>
                    <em>{statusLabel(result.status)}</em>
                  </span>
                </button>
              {/each}
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <div class="workspace">
      <header class="topbar">
        <nav class="breadcrumb" aria-label={t.aria.breadcrumb}>
          {#if data.activeWorkspace}
            <a href={activeWorkspacePath}>{data.activeWorkspace.name}</a>
            <Icon name="chevron" size={14} stroke={2.2} />
          {/if}
          <span>{currentPageLabel(page.url.pathname)}</span>
        </nav>
      </header>

      <main class="content">
        {@render children()}
      </main>
    </div>
  </div>
{/if}

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

  .setup-shell {
    display: grid;
    min-height: 100vh;
    grid-template-rows: auto 1fr;
  }

  .setup-topbar {
    align-items: center;
    display: flex;
    justify-content: space-between;
    padding: 28px clamp(24px, 5vw, 72px) 0;
  }

  .setup-brand {
    align-items: center;
    color: var(--color-ink);
    display: inline-flex;
    gap: 10px;
    text-decoration: none;
  }

  .setup-brand {
    font-weight: 850;
  }

  .setup-content {
    align-self: center;
    margin: 0 auto;
    max-width: 1280px;
    padding: 42px clamp(24px, 5vw, 72px) 72px;
    width: 100%;
  }

  .shell {
    display: grid;
    min-height: 100vh;
    grid-template-columns: 248px minmax(0, 1fr);
  }

  .sidebar {
    align-self: start;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 24px 18px;
    position: sticky;
    top: 0;
  }

  .brand-mark {
    align-items: center;
    color: var(--color-ink);
    display: inline-flex;
    gap: 10px;
    margin: 0 0 18px 18px;
    text-decoration: none;
  }

  .brand-name {
    font-size: 16px;
    font-weight: 800;
    line-height: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  aside nav {
    display: grid;
    gap: 10px;
  }

  .nav-link {
    align-items: center;
    border-radius: 12px;
    color: var(--color-ink-subtle);
    display: flex;
    gap: 14px;
    min-height: 54px;
    padding: 0 18px;
    position: relative;
    text-decoration: none;
    transition:
      background 120ms ease,
      color 120ms ease,
      box-shadow 120ms ease;
  }

  a.nav-link:hover,
  a.nav-link.active {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  a.nav-link.active {
    box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.04);
    font-weight: 700;
  }

  .nav-link.disabled {
    cursor: not-allowed;
    opacity: 0.68;
  }

  .soon-badge {
    background: var(--color-primary-weak);
    border: 0;
    border-radius: 999px;
    color: var(--color-primary);
    font-style: normal;
    font-weight: 800;
    white-space: nowrap;
  }

  .nav-link .soon-badge {
    font-size: 10px;
    margin-left: auto;
    padding: 4px 7px;
  }

  .workspace {
    min-width: 0;
  }

  .topbar {
    align-items: center;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: 48px;
    padding: 0 36px;
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

  button {
    font: inherit;
  }

  .global-search,
  .user-menu {
    align-items: center;
    border-radius: 12px;
    color: var(--color-ink-muted);
    display: inline-flex;
    gap: 10px;
    min-height: 44px;
  }

  .global-search {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    cursor: pointer;
    justify-content: flex-start;
    max-width: 520px;
    padding: 0 12px;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease,
      color 120ms ease;
    width: 100%;
  }

  .global-search:hover,
  .global-search:focus-visible {
    background: var(--color-primary-weak);
    border-color: var(--color-focus-ring);
    box-shadow: var(--shadow-focus);
    color: var(--color-primary);
    outline: none;
  }

  .sidebar-search {
    align-content: center;
    column-gap: 8px;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    justify-content: stretch;
    margin: 0 0 24px;
    max-width: none;
    min-height: 62px;
    padding: 8px 10px;
    row-gap: 5px;
  }

  .sidebar-search :global(svg) {
    align-self: start;
    grid-row: 1 / span 2;
    margin-top: 4px;
  }

  .global-search span {
    color: var(--color-ink-subtle);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .user-menu {
    background: var(--color-surface-soft);
    border: 0;
    border-radius: 8px;
    box-shadow: none;
    cursor: pointer;
    justify-self: end;
    padding: 7px 10px 7px 8px;
    transition:
      background 120ms ease,
      color 120ms ease;
    user-select: none;
  }

  .user-menu:hover,
  .user-menu:focus-visible,
  .account-menu.open .user-menu,
  .account-menu:hover .user-menu,
  .account-menu:focus-within .user-menu {
    background: var(--color-surface-soft);
    color: var(--color-ink);
  }

  .account-menu {
    position: relative;
  }

  .sidebar-account {
    margin-top: auto;
  }

  .sidebar-account .user-menu {
    justify-content: flex-start;
    width: 100%;
  }

  .sidebar-account .user-menu > :global(svg:last-child) {
    margin-left: auto;
  }

  .user-copy {
    color: var(--color-ink-muted);
    font-size: 13px;
    font-weight: 750;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-popover {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: var(--shadow-popover);
    min-width: 236px;
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
    z-index: 20;
  }

  .sidebar-account .account-popover {
    bottom: calc(100% + 8px);
    left: 0;
    min-width: 220px;
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

  .account-menu-item span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-separator {
    background: var(--color-border);
    height: 1px;
    margin: 6px -6px;
  }

  .account-menu-label {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 650;
    padding: 2px 10px 5px;
  }

  .account-menu-empty {
    color: var(--color-ink-disabled);
    font-size: 12px;
    line-height: 1.45;
    padding: 4px 10px 8px;
  }

  .account-menu-item {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: var(--color-ink-muted);
    display: grid;
    font-size: 14px;
    gap: 8px;
    grid-template-columns: 22px minmax(0, 1fr) 16px;
    min-height: 32px;
    padding: 6px 8px;
    text-align: left;
    text-decoration: none;
    width: 100%;
  }

  .account-menu-item:not(:disabled) {
    cursor: pointer;
  }

  .account-menu-item:hover,
  .account-menu-item.selected {
    background: var(--color-canvas);
  }

  .workspace-avatar {
    background: var(--avatar-bg, var(--color-surface-soft));
    border: 1px solid var(--avatar-border, var(--color-border));
    border-radius: 6px;
    color: var(--avatar-ink, var(--color-ink-subtle));
    display: grid;
    font-size: 11px;
    font-weight: 800;
    height: 22px;
    line-height: 1;
    place-items: center;
    text-transform: uppercase;
    width: 22px;
  }

  .workspace-switcher-avatar {
    flex: 0 0 auto;
    height: 20px;
    width: 20px;
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

  .search-state.error {
    color: var(--color-danger-strong);
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

  .search-result-copy small,
  .search-result-meta span {
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

  @media (max-width: 1000px) {
    .shell {
      grid-template-columns: 88px minmax(0, 1fr);
    }

    .brand-mark {
      margin-left: 5px;
    }

    .brand-name {
      display: none;
    }

    .setup-brand .brand-name {
      display: inline;
    }

    .sidebar-search {
      display: grid;
      grid-template-columns: 1fr;
      justify-items: center;
      margin-bottom: 18px;
      min-height: 44px;
      padding: 0;
    }

    .sidebar-search :global(svg) {
      grid-row: auto;
      margin: 0;
    }

    .sidebar-search span,
    .sidebar-search kbd {
      display: none;
    }

    .nav-link {
      justify-content: center;
      padding: 0;
    }

    .nav-link span,
    .nav-link small {
      display: none;
    }

    .topbar {
      grid-template-columns: 1fr;
    }

    .sidebar-account .user-menu {
      justify-content: center;
      padding: 7px;
    }

    .sidebar-account .user-copy,
    .sidebar-account .user-menu > :global(svg:last-child) {
      display: none;
    }

    .sidebar-account .account-popover {
      bottom: 0;
      left: calc(100% + 8px);
      transform: translateX(-4px);
    }

    .sidebar-account.open .account-popover {
      transform: translateX(0);
    }
  }

  @media (max-width: 700px) {
    .setup-topbar {
      padding: 20px 18px 0;
    }

    .setup-content {
      align-self: start;
      padding: 32px 18px 48px;
    }

    .shell {
      grid-template-columns: 72px minmax(0, 1fr);
    }

    .sidebar {
      padding: 18px 10px;
    }

    .brand-mark {
      margin-left: 5px;
    }

    .topbar {
      padding: 0 18px;
    }

    .content {
      padding: 22px 18px 32px;
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
