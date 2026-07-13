import type { IconName } from "./icons";

export interface ConsoleNavLabels {
  globalSettings: string;
  modelsProviders: string;
  channels: string;
  workspaceSettings: string;
  registration: string;
  createWorkspace: string;
}

export interface ConsoleNavGroupLabels {
  global: string;
  workspace: string;
  setup: string;
}

export interface ConsoleNavItem {
  href: string;
  label: string;
  icon: IconName;
}

export interface ConsoleNavGroup {
  id: keyof ConsoleNavGroupLabels;
  label: string;
  items: ConsoleNavItem[];
}

export function buildConsoleNavGroups(input: {
  activeWorkspacePath: string;
  hasActiveWorkspace: boolean;
  nav: ConsoleNavLabels;
  groups: ConsoleNavGroupLabels;
}): ConsoleNavGroup[] {
  const workspaceRoute = (suffix: string) =>
    input.activeWorkspacePath ? `${input.activeWorkspacePath}${suffix}` : "";

  const groups: ConsoleNavGroup[] = [
    {
      id: "global",
      label: input.groups.global,
      items: [
        { href: "/settings", label: input.nav.globalSettings, icon: "settings" },
        { href: "/settings/models", label: input.nav.modelsProviders, icon: "spark" },
      ],
    },
  ];

  if (input.hasActiveWorkspace && input.activeWorkspacePath) {
    groups.push({
      id: "workspace",
      label: input.groups.workspace,
      items: [
        {
          href: workspaceRoute("/settings"),
          label: input.nav.workspaceSettings,
          icon: "folder",
        },
        {
          href: workspaceRoute("/settings/channels"),
          label: input.nav.channels,
          icon: "activity",
        },
        {
          href: workspaceRoute("/settings/registration"),
          label: input.nav.registration,
          icon: "play",
        },
      ],
    });
  }

  groups.push({
    id: "setup",
    label: input.groups.setup,
    items: [
      {
        href: "/workspaces/new",
        label: input.nav.createWorkspace,
        icon: "plus",
      },
    ],
  });

  return groups;
}

export function isConsoleNavItemActive(input: { pathname: string; href: string }): boolean {
  if (!input.href) return false;

  if (input.href === "/settings") {
    return input.pathname === "/settings";
  }

  if (input.href.endsWith("/settings/channels") || input.href === "/settings/channels") {
    return (
      input.pathname === input.href ||
      input.pathname.startsWith(`${input.href}/`) ||
      input.pathname === "/settings/channels" ||
      input.pathname.startsWith("/settings/channels/")
    );
  }

  if (input.href === "/workspaces/new") {
    return input.pathname === "/workspaces/new";
  }

  if (input.href.endsWith("/settings/registration")) {
    return input.pathname === input.href || input.pathname.startsWith(`${input.href}/`);
  }

  if (input.href.endsWith("/settings")) {
    return (
      input.pathname === input.href ||
      (input.pathname.startsWith(`${input.href}/`) &&
        !input.pathname.startsWith(`${input.href}/registration`) &&
        !input.pathname.startsWith(`${input.href}/channels`))
    );
  }

  return input.pathname === input.href || input.pathname.startsWith(`${input.href}/`);
}

export function currentConsolePageLabel(input: {
  pathname: string;
  nav: ConsoleNavLabels;
  createWorkspaceFallback?: string;
}): string {
  const segments = input.pathname.split("/").filter(Boolean);
  const top = segments[0] ?? "";

  if (top === "settings") {
    if (segments[1] === "channels") return input.nav.channels;
    if (segments[1] === "models") return input.nav.modelsProviders;
    return input.nav.globalSettings;
  }

  if (top === "workspaces" && segments[1] === "new") {
    return input.nav.createWorkspace;
  }

  if (segments[1] === "settings") {
    if (segments[2] === "registration") return input.nav.registration;
    if (segments[2] === "channels") return input.nav.channels;
    return input.nav.workspaceSettings;
  }

  return input.createWorkspaceFallback ?? input.nav.globalSettings;
}
