import type { IconName } from "./icons";

export type ConsoleNavCopy = {
  createWorkspace: string;
  webAccess: string;
  workspaceDetails: string;
  channels: string;
  registration: string;
  modelsProviders: string;
  invocationDiagnostics: string;
  updateStatus: string;
};

export type ConsoleNavGroupCopy = {
  cockpit: string;
  daemon: string;
  workspace: string;
};

export type ConsoleNavItem = {
  href: string;
  label: string;
  icon: IconName;
};

export type ConsoleNavGroup = {
  id: keyof ConsoleNavGroupCopy;
  label: string;
  items: ConsoleNavItem[];
};

/** Independent control-plane settings — not tied to daemon or workspace. */
export function isControlPlanePath(pathname: string): boolean {
  if (pathname === "/workspaces/new" || pathname.startsWith("/workspaces/new/")) {
    return true;
  }
  if (pathname === "/settings/access" || pathname.startsWith("/settings/access/")) {
    return true;
  }
  return false;
}

/** @deprecated Prefer isControlPlanePath. */
export function isGlobalConsolePath(pathname: string): boolean {
  return isControlPlanePath(pathname);
}

export const COCKPIT_SETTINGS_HREF = "/settings/access";

export function buildConsoleNavGroups(input: {
  nav: ConsoleNavCopy;
  groups: ConsoleNavGroupCopy;
  workspaceHrefPrefix: string | null;
  includeControlPlaneNav?: boolean;
  includeWorkspaceNav?: boolean;
}): ConsoleNavGroup[] {
  const includeControlPlaneNav = input.includeControlPlaneNav ?? true;
  const includeWorkspaceNav = input.includeWorkspaceNav ?? true;
  const groups: ConsoleNavGroup[] = [];

  if (includeControlPlaneNav) {
    groups.push({
      id: "cockpit",
      label: input.groups.cockpit,
      items: [
        { href: "/workspaces/new", label: input.nav.createWorkspace, icon: "plus" },
        { href: COCKPIT_SETTINGS_HREF, label: input.nav.webAccess, icon: "user" },
      ],
    });
  }

  if (includeWorkspaceNav && input.workspaceHrefPrefix) {
    const prefix = input.workspaceHrefPrefix;
    groups.push({
      id: "workspace",
      label: input.groups.workspace,
      items: [
        { href: `${prefix}/settings`, label: input.nav.workspaceDetails, icon: "folder" },
        { href: `${prefix}/settings/channels`, label: input.nav.channels, icon: "activity" },
        { href: `${prefix}/settings/registration`, label: input.nav.registration, icon: "play" },
      ],
    });
    groups.push({
      id: "daemon",
      label: input.groups.daemon,
      items: [
        { href: "/settings/models", label: input.nav.modelsProviders, icon: "spark" },
        {
          href: "/settings/invocations",
          label: input.nav.invocationDiagnostics,
          icon: "activity",
        },
        { href: "/settings/update", label: input.nav.updateStatus, icon: "retry" },
      ],
    });
  }

  return groups;
}

export function isConsoleNavItemActive(input: { pathname: string; href: string }): boolean {
  if (!input.href) return false;

  if (input.href === "/settings") {
    return input.pathname === "/settings";
  }

  if (input.href === "/settings/access") {
    return input.pathname === input.href || input.pathname.startsWith(`${input.href}/`);
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
  nav: ConsoleNavCopy;
  createWorkspaceFallback?: string;
}): string {
  const segments = input.pathname.split("/").filter(Boolean);
  const top = segments[0] ?? "";

  if (top === "settings") {
    if (segments[1] === "access") return input.nav.webAccess;
    if (segments[1] === "channels") return input.nav.channels;
    if (segments[1] === "models") return input.nav.modelsProviders;
    if (segments[1] === "invocations") return input.nav.invocationDiagnostics;
    if (segments[1] === "update") return input.nav.updateStatus;
    return input.nav.modelsProviders;
  }

  if (top === "workspaces" && segments[1] === "new") {
    return input.nav.createWorkspace;
  }

  if (segments[1] === "settings") {
    if (segments[2] === "registration") return input.nav.registration;
    if (segments[2] === "channels") return input.nav.channels;
    return input.nav.workspaceDetails;
  }

  return input.createWorkspaceFallback ?? input.nav.modelsProviders;
}
