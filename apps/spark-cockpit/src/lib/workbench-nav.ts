import type { IconName } from "./icons";

export interface WorkbenchNavLabels {
  home: string;
  overview: string;
  projects: string;
  inbox: string;
  repos: string;
  agents: string;
  artifacts: string;
  settings: string;
}

export interface WorkbenchNavGroupLabels {
  work: string;
  library: string;
  runtime: string;
  system: string;
}

export interface WorkbenchPageLabels {
  setupGuide: string;
  overview: string;
  settings: string;
  comingSoon: string;
}

export interface WorkbenchNavItem {
  href: string;
  label: string;
  icon: IconName;
  disabled?: boolean;
}

export interface WorkbenchNavGroup {
  id: keyof WorkbenchNavGroupLabels;
  label: string;
  items: WorkbenchNavItem[];
}

export function buildWorkbenchNavGroups(input: {
  activeWorkspacePath: string;
  hasActiveWorkspace: boolean;
  nav: WorkbenchNavLabels;
  groups: WorkbenchNavGroupLabels;
}): WorkbenchNavGroup[] {
  const workspaceRoot = input.activeWorkspacePath || "/";
  const workspaceRoute = (suffix: string) => `${input.activeWorkspacePath}${suffix}` || suffix;

  return [
    {
      id: "work",
      label: input.groups.work,
      items: [
        {
          href: workspaceRoot,
          label: input.hasActiveWorkspace ? input.nav.overview : input.nav.home,
          icon: "home",
        },
        { href: workspaceRoute("/projects"), label: input.nav.projects, icon: "folder" },
        { href: workspaceRoute("/inbox"), label: input.nav.inbox, icon: "inbox" },
      ],
    },
    {
      id: "library",
      label: input.groups.library,
      items: [
        { href: workspaceRoute("/artifacts"), label: input.nav.artifacts, icon: "artifacts" },
        { href: workspaceRoute("/repos"), label: input.nav.repos, icon: "repos" },
      ],
    },
    {
      id: "runtime",
      label: input.groups.runtime,
      items: [{ href: workspaceRoute("/agents"), label: input.nav.agents, icon: "agents" }],
    },
    {
      id: "system",
      label: input.groups.system,
      items: [{ href: workspaceRoute("/settings"), label: input.nav.settings, icon: "settings" }],
    },
  ];
}

export function isWorkbenchNavItemActive(input: {
  pathname: string;
  href: string;
  activeWorkspacePath: string;
}): boolean {
  if (
    input.href === "/" ||
    (input.activeWorkspacePath && input.href === input.activeWorkspacePath)
  ) {
    return input.pathname === input.href;
  }

  return input.pathname === input.href || input.pathname.startsWith(`${input.href}/`);
}

export function currentWorkbenchPageLabel(input: {
  pathname: string;
  nav: WorkbenchNavLabels;
  pages: WorkbenchPageLabels;
}): string {
  if (input.pathname === "/") {
    return input.pages.setupGuide;
  }

  const section = input.pathname.split("/").filter(Boolean)[1] ?? "";
  if (!section) {
    return input.pages.overview;
  }

  if (section === "projects") return input.nav.projects;
  if (section === "inbox") return input.nav.inbox;
  if (section === "repos") return input.nav.repos;
  if (section === "agents") return input.nav.agents;
  if (section === "artifacts") return input.nav.artifacts;
  if (section === "settings") return input.pages.settings;

  return input.pages.comingSoon;
}
