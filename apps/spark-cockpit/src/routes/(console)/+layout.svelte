<script lang="ts">
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import Icon from "$lib/Icon.svelte";
  import SparkLogo from "$lib/SparkLogo.svelte";
  import {
    buildConsoleNavGroups,
    currentConsolePageLabel,
    isConsoleNavItemActive,
    readRememberedWorkbenchPath,
    resolveConsoleReturnPath,
  } from "$lib/console-nav";
  import { workspaceSwitcherHref as buildWorkspaceSwitcherHref } from "$lib/workbench-nav";
  import { workspaceAvatarStyle, workspaceInitial } from "$lib/workspace-avatar";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, children } = $props();

  let t = $derived(data.messages.layout);
  let consoleMessages = $derived(data.messages.console);
  let workspaceOptions = $derived(data.workspaces ?? []);
  let accountMenuOpen = $state(false);
  let accountMenuElement = $state<HTMLDivElement>();
  let mobileNavigationOpen = $state(false);
  let lastConsolePath = $state("");
  let returnPath = $state("/sessions");
  let activeWorkspacePath = $derived(
    data.activeWorkspace ? workspacePath(data.activeWorkspace) : "",
  );
  let activeWorkspaceLabel = $derived(
    data.activeWorkspace?.name ?? t.user.workspaceSection,
  );
  let navGroups = $derived(
    buildConsoleNavGroups({
      activeWorkspacePath,
      hasActiveWorkspace: Boolean(data.activeWorkspace),
      nav: {
        globalSettings: t.nav.globalSettings,
        modelsProviders: t.nav.models,
        channels: t.nav.channels,
        workspaceSettings: t.nav.workspaceSettings,
        registration: consoleMessages.nav.registration,
        createWorkspace: t.user.createWorkspace,
      },
      groups: consoleMessages.navGroups,
    }),
  );

  onMount(() => {
    returnPath = resolveConsoleReturnPath({
      fromQuery: page.url.searchParams.get("from"),
      storedPath: readRememberedWorkbenchPath(),
    });
  });

  $effect(() => {
    const pathname = page.url.pathname;
    if (lastConsolePath !== pathname) {
      lastConsolePath = pathname;
      mobileNavigationOpen = false;
    }
  });

  function isActive(href: string) {
    return isConsoleNavItemActive({
      pathname: page.url.pathname,
      href,
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
    return currentConsolePageLabel({
      pathname,
      nav: {
        globalSettings: t.nav.globalSettings,
        modelsProviders: t.nav.models,
        channels: t.nav.channels,
        workspaceSettings: t.nav.workspaceSettings,
        registration: consoleMessages.nav.registration,
        createWorkspace: t.user.createWorkspace,
      },
    });
  }

  function toggleAccountMenu(event: MouseEvent) {
    event.stopPropagation();
    accountMenuOpen = !accountMenuOpen;
  }

  function closeAccountMenu() {
    accountMenuOpen = false;
  }

  function toggleMobileNavigation() {
    closeAccountMenu();
    mobileNavigationOpen = !mobileNavigationOpen;
  }

  function closeMobileNavigation() {
    mobileNavigationOpen = false;
  }

  function handleWindowClick(event: MouseEvent) {
    if (!accountMenuOpen || !accountMenuElement) return;
    if (!accountMenuElement.contains(event.target as Node)) {
      closeAccountMenu();
    }
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      if (mobileNavigationOpen) {
        closeMobileNavigation();
        return;
      }
      closeAccountMenu();
    }
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div class="console-shell">
  <header class="console-topbar">
    <div class="console-brand-row">
      <a class="brand-mark" href="/sessions" aria-label={t.aria.home}>
        <SparkLogo size={36} />
        <span class="brand-name">{t.brand.name}</span>
      </a>
      <span class="console-badge">{consoleMessages.badge}</span>
    </div>

    <a class="back-to-workbench" href={returnPath}>
      <Icon name="chevron" size={14} stroke={2.2} />
      <span>{consoleMessages.backToWorkbench}</span>
    </a>

    <div
      class="account-menu"
      class:open={accountMenuOpen}
      bind:this={accountMenuElement}
    >
      <button
        class="user-menu"
        aria-controls="console-account-menu"
        aria-expanded={accountMenuOpen}
        aria-haspopup="menu"
        aria-label={t.aria.workspaceMenu}
        onclick={toggleAccountMenu}
        type="button"
      >
        <span
          class="workspace-avatar"
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
        id="console-account-menu"
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
              <span>{workspace.name}</span>
              {#if workspace.id === data.activeWorkspace?.id}
                <Icon name="check" size={15} stroke={2.4} />
              {/if}
            </a>
          {/each}
        {/if}
      </div>
    </div>
  </header>

  <div class="console-body">
    {#if mobileNavigationOpen}
      <button
        class="console-nav-backdrop"
        type="button"
        aria-label={t.aria.closeWorkspaceNavigation}
        onclick={closeMobileNavigation}
      ></button>
    {/if}

    <aside
      class="console-nav"
      class:mobile-open={mobileNavigationOpen}
      id="console-navigation"
      aria-label={consoleMessages.ariaNavigation}
    >
      <nav>
        {#each navGroups as group}
          <section class="nav-group" aria-labelledby={`console-nav-${group.id}`}>
            <h2 class="nav-group-label" id={`console-nav-${group.id}`}>{group.label}</h2>
            <div class="nav-group-items">
              {#each group.items as item}
                <a
                  class="nav-link"
                  class:active={isActive(item.href)}
                  href={item.href}
                  onclick={closeMobileNavigation}
                >
                  <Icon name={item.icon} size={18} />
                  <span>{item.label}</span>
                </a>
              {/each}
            </div>
          </section>
        {/each}
      </nav>
    </aside>

    <div class="console-main">
      <header class="console-breadcrumb-bar">
        <button
          class="console-nav-toggle"
          type="button"
          aria-controls="console-navigation"
          aria-expanded={mobileNavigationOpen}
          aria-label={consoleMessages.ariaNavigation}
          onclick={toggleMobileNavigation}
        >
          <Icon name={mobileNavigationOpen ? "close" : "menu"} size={18} stroke={2.2} />
        </button>
        <nav class="breadcrumb" aria-label={t.aria.breadcrumb}>
          <span>{consoleMessages.badge}</span>
          <Icon name="chevron" size={14} stroke={2.2} />
          {#if data.activeWorkspace && page.url.pathname.includes("/settings") && !page.url.pathname.startsWith("/settings")}
            <a href={activeWorkspacePath}>{data.activeWorkspace.name}</a>
            <Icon name="chevron" size={14} stroke={2.2} />
          {/if}
          <span>{currentPageLabel(page.url.pathname)}</span>
        </nav>
      </header>
      <main class="console-content">
        {@render children()}
      </main>
    </div>
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

  .console-shell {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 100vh;
  }

  .console-topbar {
    align-items: center;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    display: grid;
    gap: 16px;
    grid-template-columns: 1fr auto auto;
    padding: 12px 20px;
  }

  .console-brand-row {
    align-items: center;
    display: flex;
    gap: 12px;
  }

  .brand-mark {
    align-items: center;
    color: inherit;
    display: inline-flex;
    gap: 10px;
    text-decoration: none;
  }

  .brand-name {
    font-size: 18px;
    font-weight: 700;
  }

  .console-badge {
    background: var(--color-primary-weak);
    border-radius: 999px;
    color: var(--color-primary);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.04em;
    padding: 4px 10px;
    text-transform: uppercase;
  }

  .back-to-workbench {
    align-items: center;
    color: var(--color-ink-muted);
    display: inline-flex;
    font-weight: 600;
    gap: 4px;
    text-decoration: none;
  }

  .back-to-workbench :global(svg) {
    transform: rotate(180deg);
  }

  .account-menu {
    position: relative;
  }

  .user-menu {
    align-items: center;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    gap: 8px;
    padding: 6px 10px;
  }

  .user-copy {
    font-size: 14px;
    font-weight: 600;
  }

  .workspace-avatar {
    align-items: center;
    background: var(--avatar-bg);
    border: 1px solid var(--avatar-border);
    border-radius: 999px;
    color: var(--avatar-ink);
    display: inline-flex;
    font-size: 12px;
    font-weight: 800;
    height: 28px;
    justify-content: center;
    width: 28px;
  }

  .account-popover {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 14px;
    box-shadow: 0 12px 40px rgb(15 23 42 / 12%);
    display: none;
    min-width: 240px;
    padding: 8px;
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    z-index: 40;
  }

  .account-menu.open .account-popover {
    display: grid;
    gap: 4px;
  }

  .account-menu-label {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 700;
    padding: 8px 10px 4px;
    text-transform: uppercase;
  }

  .account-menu-empty,
  .account-menu-item {
    border-radius: 10px;
    color: inherit;
    padding: 8px 10px;
    text-decoration: none;
  }

  .account-menu-item {
    align-items: center;
    display: flex;
    gap: 8px;
  }

  .account-menu-item.selected {
    background: var(--color-primary-weak);
  }

  .console-body {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    min-height: 0;
  }

  .console-nav-backdrop,
  .console-nav-toggle {
    display: none;
  }

  .console-nav {
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    padding: 18px 14px;
  }

  .nav-group {
    display: grid;
    gap: 8px;
    margin-bottom: 18px;
  }

  .nav-group-label {
    color: var(--color-ink-subtle);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    margin: 0;
    text-transform: uppercase;
  }

  .nav-group-items {
    display: grid;
    gap: 4px;
  }

  .nav-link {
    align-items: center;
    border-radius: 10px;
    color: var(--color-ink-muted);
    display: flex;
    gap: 10px;
    padding: 8px 10px;
    text-decoration: none;
  }

  .nav-link.active {
    background: var(--color-primary-weak);
    color: var(--color-primary);
    font-weight: 600;
  }

  .console-main {
    display: grid;
    grid-template-rows: auto 1fr;
    min-width: 0;
  }

  .console-breadcrumb-bar {
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    gap: 10px;
    padding: 14px 24px;
  }

  .breadcrumb {
    align-items: center;
    color: var(--color-ink-subtle);
    display: flex;
    gap: 8px;
    min-width: 0;
  }

  .breadcrumb a {
    color: var(--color-ink-muted);
    text-decoration: none;
  }

  .console-content {
    min-height: 0;
  }

  @media (max-width: 900px) {
    .console-body {
      grid-template-columns: minmax(0, 1fr);
    }

    .console-nav {
      border-right: 1px solid var(--color-border);
      box-shadow: var(--shadow-popover);
      height: 100dvh;
      inset: 0 auto 0 0;
      max-width: min(280px, 88vw);
      opacity: 0;
      overflow-y: auto;
      position: fixed;
      transform: translateX(-100%);
      transition:
        opacity 140ms ease,
        transform 140ms ease,
        visibility 140ms ease;
      visibility: hidden;
      width: min(280px, 88vw);
      z-index: 71;
    }

    .console-nav.mobile-open {
      opacity: 1;
      transform: translateX(0);
      visibility: visible;
    }

    .console-nav-backdrop {
      background: rgb(15 23 42 / 24%);
      border: 0;
      cursor: default;
      display: block;
      inset: 0;
      padding: 0;
      position: fixed;
      z-index: 70;
    }

    .console-nav-toggle {
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

    .console-nav-toggle:hover,
    .console-nav-toggle:focus-visible {
      background: var(--color-surface-soft);
      color: var(--color-ink);
      outline: none;
    }

    .console-topbar {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .back-to-workbench {
      grid-column: 1;
      grid-row: 2;
      justify-self: start;
    }

    .account-menu {
      grid-column: 2;
      grid-row: 1 / span 2;
    }
  }

  @media (max-width: 480px) {
    .console-topbar {
      gap: 8px;
      padding: 10px 12px;
    }

    .console-brand-row {
      gap: 8px;
      min-width: 0;
    }

    .brand-name,
    .user-copy {
      display: none;
    }

    .console-badge {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .user-menu {
      padding: 5px 7px;
    }

    .console-breadcrumb-bar {
      padding: 10px 12px;
    }

    .breadcrumb {
      overflow: hidden;
    }

    .breadcrumb > :global(svg) {
      flex: 0 0 auto;
    }

    .breadcrumb > span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
</style>
