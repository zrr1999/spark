<script lang="ts">
  import { page } from "$app/state";
  import Icon from "$lib/Icon.svelte";
  import {
    buildConsoleNavGroups,
    COCKPIT_SETTINGS_HREF,
    currentConsolePageLabel,
    isConsoleNavItemActive,
    isControlPlanePath,
  } from "$lib/console-nav";
  import CockpitTopbar from "$lib/shell/CockpitTopbar.svelte";
  import type { CockpitSearchSession } from "$lib/shell/cockpit-search";
  import { workspaceSwitcherHref as buildWorkspaceSwitcherHref } from "$lib/workbench-nav";
  import { workspacePath } from "$lib/workspace-routes";

  let { data, children } = $props();

  let t = $derived(data.messages.layout);
  let consoleMessages = $derived(data.messages.console);
  let workspaceOptions = $derived(data.workspaces ?? []);
  let searchSessions = $derived((data.sessions ?? []) as CockpitSearchSession[]);
  let mobileNavigationOpen = $state(false);
  let lastConsolePath = $state("");
  let isControlPlane = $derived(
    data.isGlobalConsole ?? isControlPlanePath(page.url.pathname),
  );
  let activeWorkspacePath = $derived(
    data.activeWorkspace ? workspacePath(data.activeWorkspace) : "",
  );
  let hasActiveWorkspace = $derived(Boolean(data.activeWorkspace));
  let navLabels = $derived({
    createWorkspace: t.user.createWorkspace,
    webAccess: consoleMessages.nav.webAccess,
    workspaceDetails: consoleMessages.nav.workspaceDetails,
    channels: t.nav.channels,
    registration: consoleMessages.nav.registration,
    modelsProviders: t.nav.models,
    invocationDiagnostics: data.messages.invocationDiagnostics.navLabel,
    updateStatus: data.messages.updateStatus.navLabel,
  });
  let navGroups = $derived(
    buildConsoleNavGroups({
      workspaceHrefPrefix: hasActiveWorkspace ? activeWorkspacePath : null,
      includeControlPlaneNav: isControlPlane || !hasActiveWorkspace,
      includeWorkspaceNav: !isControlPlane && hasActiveWorkspace,
      nav: navLabels,
      groups: {
        cockpit: consoleMessages.navGroups.cockpit,
        daemon: consoleMessages.navGroups.daemon,
        workspace: data.activeWorkspace
          ? `${consoleMessages.navGroups.workspace} · ${data.activeWorkspace.name}`
          : consoleMessages.navGroups.workspace,
      },
    }),
  );

  $effect(() => {
    const pathname = page.url.pathname;
    if (lastConsolePath !== pathname) {
      lastConsolePath = pathname;
      mobileNavigationOpen = false;
    }
  });

  function isActive(href: string) {
    return isConsoleNavItemActive({ pathname: page.url.pathname, href });
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

  function closeMobileNavigation() {
    mobileNavigationOpen = false;
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && mobileNavigationOpen) closeMobileNavigation();
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="console-shell">
  <CockpitTopbar
    activeWorkspace={isControlPlane ? null : data.activeWorkspace}
    common={data.messages.common}
    layout={t}
    navigationControls="console-navigation"
    navigationExpanded={mobileNavigationOpen}
    onToggleNavigation={() => (mobileNavigationOpen = !mobileNavigationOpen)}
    sessions={searchSessions}
    sessionMessages={data.messages.sessions}
    showWorkspaceMenu={!isControlPlane}
    workspaceHref={workspaceSwitcherHref}
    workspaces={workspaceOptions}
  />

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

      {#if !isControlPlane && hasActiveWorkspace}
        <div class="console-nav-footer">
          <a
            class="nav-link cockpit-settings-link"
            href={COCKPIT_SETTINGS_HREF}
            onclick={closeMobileNavigation}
          >
            <Icon name="settings" size={18} />
            <span>{consoleMessages.openCockpitSettings}</span>
          </a>
        </div>
      {/if}
    </aside>

    <div class="console-main">
      <div class="console-contextbar">
        <nav class="breadcrumb" aria-label={t.aria.breadcrumb}>
          <span>{consoleMessages.badge}</span>
          <Icon name="chevron" size={14} stroke={2.2} />
          {#if data.activeWorkspace && !isControlPlane}
            <a href={activeWorkspacePath}>{data.activeWorkspace.name}</a>
            <Icon name="chevron" size={14} stroke={2.2} />
          {/if}
          <span>{currentConsolePageLabel({ pathname: page.url.pathname, nav: navLabels })}</span>
        </nav>
      </div>

      <main class="console-content">
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

  .console-shell {
    display: grid;
    grid-template-rows: 52px minmax(0, 1fr);
    height: 100dvh;
    overflow: hidden;
  }

  .console-body {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    min-height: 0;
  }

  .console-nav {
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    padding: 18px 14px;
  }

  .console-nav > nav {
    flex: 1 1 auto;
    min-height: 0;
  }

  .console-nav-footer {
    border-top: 1px solid var(--color-border);
    flex: 0 0 auto;
    margin-top: auto;
    padding-top: 12px;
  }

  .nav-group {
    display: grid;
    gap: 7px;
    margin-bottom: 20px;
  }

  .nav-group-label {
    color: var(--color-ink-disabled);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.06em;
    margin: 0;
    padding: 0 10px;
    text-transform: uppercase;
  }

  .nav-group-items {
    display: grid;
    gap: 2px;
  }

  .nav-link {
    align-items: center;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: flex;
    font-size: 13px;
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

  .console-main {
    display: grid;
    grid-template-rows: 42px minmax(0, 1fr);
    min-height: 0;
    min-width: 0;
  }

  .console-contextbar {
    align-items: center;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    display: flex;
    padding: 0 24px;
  }

  .breadcrumb {
    align-items: center;
    color: var(--color-ink-disabled);
    display: flex;
    font-size: 12px;
    font-weight: 700;
    gap: 8px;
    min-width: 0;
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

  .breadcrumb > span:last-child {
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .console-content {
    min-height: 0;
    overflow-y: auto;
    padding: var(--spacing-xl) var(--spacing-xxl) var(--spacing-section);
  }

  .console-nav-backdrop {
    display: none;
  }

  @media (max-width: 900px) {
    .console-body {
      grid-template-columns: minmax(0, 1fr);
    }

    .console-nav {
      border-right: 1px solid var(--color-border);
      box-shadow: var(--shadow-popover);
      height: calc(100dvh - 52px);
      inset: 52px auto 0 0;
      max-width: min(280px, 88vw);
      opacity: 0;
      position: fixed;
      transform: translateX(-100%);
      transition:
        opacity 140ms ease,
        transform 140ms ease,
        visibility 140ms ease;
      visibility: hidden;
      width: min(280px, 88vw);
      z-index: 55;
    }

    .console-nav.mobile-open {
      opacity: 1;
      transform: translateX(0);
      visibility: visible;
    }

    .console-nav-backdrop {
      background: rgb(15 23 42 / 24%);
      border: 0;
      display: block;
      inset: 52px 0 0;
      padding: 0;
      position: fixed;
      z-index: 50;
    }
  }

  @media (max-width: 640px) {
    .console-contextbar {
      padding-inline: var(--spacing-md);
    }

    .console-content {
      padding: var(--spacing-lg) var(--spacing-md) var(--spacing-xxl);
    }
  }
</style>
