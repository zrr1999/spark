<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import type { AppMessages } from "$lib/i18n";
  import SparkLogo from "$lib/SparkLogo.svelte";
  import { workspaceAvatarStyle, workspaceInitial } from "$lib/workspace-avatar";
  import CockpitSearch from "./CockpitSearch.svelte";
  import type { CockpitSearchSession, CockpitSearchWorkspace } from "./cockpit-search";

  interface Props {
    activeWorkspace?: CockpitSearchWorkspace | null;
    common: AppMessages["common"];
    layout: AppMessages["layout"];
    navigationControls: string;
    navigationExpanded: boolean;
    onToggleNavigation: () => void;
    sessions?: CockpitSearchSession[];
    sessionMessages: AppMessages["sessions"];
    workspaceHref: (workspace: CockpitSearchWorkspace) => string;
    workspaces?: CockpitSearchWorkspace[];
  }

  let {
    activeWorkspace = null,
    common,
    layout,
    navigationControls,
    navigationExpanded,
    onToggleNavigation,
    sessions = [],
    sessionMessages,
    workspaceHref,
    workspaces = [],
  }: Props = $props();

  let accountMenuOpen = $state(false);
  let accountMenuElement = $state<HTMLDivElement>();
  let activeWorkspaceLabel = $derived(
    activeWorkspace?.name ?? layout.user.workspaceSection,
  );

  function toggleAccountMenu(event: MouseEvent) {
    event.stopPropagation();
    accountMenuOpen = !accountMenuOpen;
  }

  function closeAccountMenu() {
    accountMenuOpen = false;
  }

  function handleWindowClick(event: MouseEvent) {
    if (!accountMenuOpen || !accountMenuElement) return;
    const target = event.target;
    if (target instanceof Node && accountMenuElement.contains(target)) return;
    closeAccountMenu();
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") closeAccountMenu();
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<header class="cockpit-topbar">
  <div class="topbar-brand">
    <button
      class="navigation-toggle"
      type="button"
      aria-controls={navigationControls}
      aria-expanded={navigationExpanded}
      aria-label={layout.aria.workspaceNavigation}
      onclick={onToggleNavigation}
    >
      <Icon name={navigationExpanded ? "close" : "menu"} size={18} stroke={2.2} />
    </button>
    <a class="brand-mark" href="/sessions" aria-label={layout.aria.home}>
      <SparkLogo size={32} />
      <span class="brand-name">{layout.brand.name}</span>
    </a>
  </div>

  <CockpitSearch
    {activeWorkspace}
    {common}
    {sessions}
    {workspaces}
    {layout}
    {sessionMessages}
  />

  <div
    class="account-menu"
    class:open={accountMenuOpen}
    bind:this={accountMenuElement}
  >
    <button
      class="user-menu"
      aria-controls="cockpit-workspace-menu"
      aria-expanded={accountMenuOpen}
      aria-haspopup="menu"
      aria-label={layout.aria.workspaceMenu}
      onclick={toggleAccountMenu}
      type="button"
    >
      <span
        class="workspace-avatar workspace-switcher-avatar"
        style={workspaceAvatarStyle(activeWorkspace)}
        aria-hidden="true"
      >
        {workspaceInitial(activeWorkspace)}
      </span>
      <span class="user-copy">{activeWorkspaceLabel}</span>
      <Icon name="chevron-down" size={14} stroke={2.4} />
    </button>

    <div
      class="account-popover"
      id="cockpit-workspace-menu"
      role="menu"
      aria-label={layout.aria.workspaceMenu}
      aria-hidden={!accountMenuOpen}
      tabindex="-1"
    >
      <div class="account-menu-label">{layout.user.switchWorkspace}</div>
      {#if workspaces.length === 0}
        <div class="account-menu-empty">{layout.user.noWorkspaces}</div>
      {:else}
        <div class="workspace-list">
          {#each workspaces as workspace}
            <a
              class="account-menu-item"
              class:selected={workspace.id === activeWorkspace?.id}
              href={workspaceHref(workspace)}
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
                {#if workspace.id === activeWorkspace?.id}
                  <small>{layout.user.currentWorkspace}</small>
                {/if}
              </span>
              {#if workspace.id === activeWorkspace?.id}
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
        <span>{layout.user.createWorkspace}</span>
      </a>
    </div>
  </div>
</header>

<style>
  button {
    font: inherit;
  }

  .cockpit-topbar {
    align-items: center;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(180px, 1fr) auto minmax(180px, 1fr);
    height: 52px;
    padding: 0 14px 0 16px;
    position: relative;
    z-index: 60;
  }

  .topbar-brand {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-self: start;
    min-width: 0;
  }

  .brand-mark {
    align-items: center;
    color: var(--color-ink);
    display: inline-flex;
    gap: 8px;
    min-width: 0;
    text-decoration: none;
  }

  .brand-name {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .navigation-toggle {
    align-items: center;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 7px;
    color: var(--color-ink-muted);
    cursor: pointer;
    display: none;
    flex: 0 0 auto;
    height: 32px;
    justify-content: center;
    padding: 0;
    width: 32px;
  }

  .navigation-toggle:hover,
  .navigation-toggle:focus-visible {
    background: var(--color-surface-soft);
    color: var(--color-ink);
    outline: none;
  }

  .account-menu {
    justify-self: end;
    position: relative;
  }

  .user-menu {
    align-items: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    gap: 8px;
    min-height: 40px;
    padding: 4px 7px;
  }

  .user-menu:hover,
  .user-menu:focus-visible,
  .account-menu.open .user-menu {
    background: var(--color-surface-soft);
    color: var(--color-ink);
    outline: none;
  }

  .user-copy {
    color: var(--color-ink);
    font-size: 13px;
    font-weight: 600;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-avatar {
    background: var(--avatar-bg, var(--color-surface-soft));
    border: 1px solid var(--avatar-border, var(--color-border));
    border-radius: 6px;
    color: var(--avatar-ink, var(--color-ink-subtle));
    display: grid;
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 700;
    height: 24px;
    line-height: 1;
    place-items: center;
    text-transform: uppercase;
    width: 24px;
  }

  .workspace-switcher-avatar {
    height: 26px;
    width: 26px;
  }

  .account-popover {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    box-shadow: var(--shadow-popover);
    min-width: 260px;
    opacity: 0;
    overflow: hidden;
    padding: 6px;
    pointer-events: none;
    position: absolute;
    right: 0;
    top: calc(100% + 7px);
    transform: translateY(-4px);
    transition:
      opacity 120ms ease,
      transform 120ms ease,
      visibility 120ms ease;
    visibility: hidden;
    z-index: 80;
  }

  .account-menu.open .account-popover {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
    visibility: visible;
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
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    display: grid;
    font-size: 13px;
    font-weight: 500;
    gap: 10px;
    grid-template-columns: 24px minmax(0, 1fr) 16px;
    min-height: 40px;
    padding: 6px 10px;
    text-decoration: none;
  }

  .account-menu-item.create-item {
    grid-template-columns: 24px minmax(0, 1fr);
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

  .workspace-item-copy strong,
  .workspace-item-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-item-copy strong {
    font-size: 13px;
    font-weight: 600;
  }

  .workspace-item-copy small {
    color: var(--color-ink-subtle);
    font-size: 11px;
  }

  @media (max-width: 900px) {
    .navigation-toggle {
      display: inline-flex;
    }

    .cockpit-topbar {
      grid-template-columns: minmax(132px, 1fr) auto minmax(132px, 1fr);
    }
  }

  @media (max-width: 560px) {
    .cockpit-topbar {
      gap: 8px;
      grid-template-columns: auto minmax(0, 1fr) auto;
      padding: 0 8px;
    }

    .brand-name,
    .user-copy {
      display: none;
    }

    .brand-mark {
      gap: 0;
    }

    .user-menu {
      gap: 4px;
      padding-inline: 5px;
    }
  }
</style>
