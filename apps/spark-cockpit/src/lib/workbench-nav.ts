import type { IconName } from "./icons";

export interface WorkbenchNavLabels {
  overview: string;
  sessions: string;
  inbox: string;
  artifacts: string;
  repos: string;
}

export interface WorkbenchPageLabels {
  overview: string;
  comingSoon: string;
}

export interface WorkbenchNavItem {
  href: string;
  label: string;
  icon: IconName;
}

export function buildWorkbenchNavItems(input: {
  activeWorkspacePath: string;
  hasActiveWorkspace: boolean;
  nav: WorkbenchNavLabels;
}): WorkbenchNavItem[] {
  const workspaceRoot = input.activeWorkspacePath;
  if (!input.hasActiveWorkspace || !workspaceRoot) return [];

  const workspaceRoute = (suffix: string) => `${workspaceRoot}${suffix}`;

  // Sessions live in the persistent sidebar rail; keep only secondary surfaces here.
  return [
    {
      href: workspaceRoot,
      label: input.nav.overview,
      icon: "home",
    },
    { href: workspaceRoute("/inbox"), label: input.nav.inbox, icon: "inbox" },
    { href: workspaceRoute("/artifacts"), label: input.nav.artifacts, icon: "artifacts" },
    { href: workspaceRoute("/repos"), label: input.nav.repos, icon: "repos" },
  ];
}

export function isWorkbenchNavItemActive(input: {
  pathname: string;
  href: string;
  activeWorkspacePath: string;
}): boolean {
  if (!input.href) return false;

  if (
    input.href === "/" ||
    (input.activeWorkspacePath && input.href === input.activeWorkspacePath)
  ) {
    return input.pathname === input.href;
  }

  if (input.href === "/sessions") {
    return input.pathname === "/sessions" || input.pathname.startsWith("/sessions/");
  }

  return input.pathname === input.href || input.pathname.startsWith(`${input.href}/`);
}

export function currentWorkbenchPageLabel(input: {
  pathname: string;
  nav: WorkbenchNavLabels;
  pages: WorkbenchPageLabels;
}): string {
  const segments = input.pathname.split("/").filter(Boolean);
  const top = segments[0] ?? "";
  if (top === "sessions") return input.nav.sessions;

  const section = segments[1] ?? "";
  if (!section) {
    return input.pages.overview;
  }

  if (section === "inbox") return input.nav.inbox;
  if (section === "agents") return input.nav.artifacts;
  if (section === "artifacts") return input.nav.artifacts;
  if (section === "repos") return input.nav.repos;

  return input.pages.comingSoon;
}

export function isWorkspaceScopedPath(pathname: string, activeWorkspacePath: string): boolean {
  return (
    Boolean(activeWorkspacePath) &&
    (pathname === activeWorkspacePath || pathname.startsWith(`${activeWorkspacePath}/`))
  );
}

export function workspaceSwitcherHref(input: {
  pathname: string;
  origin: string;
  activeWorkspacePath: string;
  targetWorkspaceSlug: string;
  workspacePath: (workspace: { slug: string }, suffix?: string) => string;
}): string {
  const { pathname } = input;
  if (
    pathname === "/sessions" ||
    pathname.startsWith("/sessions/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/workspaces/new" ||
    pathname.startsWith("/workspaces/new/")
  ) {
    const url = new URL(pathname, input.origin);
    url.searchParams.set("workspace", input.targetWorkspaceSlug);
    return `${url.pathname}?${url.searchParams.toString()}`;
  }

  if (isWorkspaceScopedPath(pathname, input.activeWorkspacePath)) {
    const suffix = pathname.slice(input.activeWorkspacePath.length);
    return input.workspacePath({ slug: input.targetWorkspaceSlug }, suffix);
  }

  return input.workspacePath({ slug: input.targetWorkspaceSlug });
}
