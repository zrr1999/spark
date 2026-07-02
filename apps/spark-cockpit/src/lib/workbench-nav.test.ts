import { describe, expect, it } from "vitest";
import {
  buildWorkbenchNavGroups,
  currentWorkbenchPageLabel,
  isWorkbenchNavItemActive,
  type WorkbenchNavGroupLabels,
  type WorkbenchNavLabels,
  type WorkbenchPageLabels,
} from "./workbench-nav";

const nav: WorkbenchNavLabels = {
  home: "Home",
  overview: "Overview",
  projects: "Projects",
  inbox: "Inbox",
  repos: "Repos",
  agents: "Agents",
  artifacts: "Artifacts",
  settings: "Settings",
};

const groups: WorkbenchNavGroupLabels = {
  work: "Work",
  library: "Library",
  runtime: "Runtime",
  system: "System",
};

const pages: WorkbenchPageLabels = {
  setupGuide: "Setup guide",
  overview: "Overview",
  settings: "Settings",
  comingSoon: "Coming soon",
};

describe("workbench nav", () => {
  it("builds the grouped Spark Cockpit navigation taxonomy", () => {
    const result = buildWorkbenchNavGroups({
      activeWorkspacePath: "/local",
      hasActiveWorkspace: true,
      nav,
      groups,
    });

    expect(result.map((group) => [group.id, group.label])).toEqual([
      ["work", "Work"],
      ["library", "Library"],
      ["system", "System"],
    ]);
    expect(result.map((group) => group.items.map((item) => item.label))).toEqual([
      ["Overview", "Projects", "Inbox"],
      ["Artifacts"],
      ["Settings"],
    ]);
    expect(result[0]?.items[0]).toMatchObject({ href: "/local", icon: "home" });
    expect(result[1]?.items[0]).toMatchObject({ href: "/local/artifacts", icon: "artifacts" });
  });

  it("keeps root overview active exact and nested sections active by prefix", () => {
    expect(
      isWorkbenchNavItemActive({
        pathname: "/local",
        href: "/local",
        activeWorkspacePath: "/local",
      }),
    ).toBe(true);
    expect(
      isWorkbenchNavItemActive({
        pathname: "/local/projects/abc",
        href: "/local/projects",
        activeWorkspacePath: "/local",
      }),
    ).toBe(true);
    expect(
      isWorkbenchNavItemActive({
        pathname: "/local/projects",
        href: "/local",
        activeWorkspacePath: "/local",
      }),
    ).toBe(false);
  });

  it("derives breadcrumb page labels for existing routes and nested detail pages", () => {
    expect(currentWorkbenchPageLabel({ pathname: "/", nav, pages })).toBe("Setup guide");
    expect(currentWorkbenchPageLabel({ pathname: "/local", nav, pages })).toBe("Overview");
    expect(currentWorkbenchPageLabel({ pathname: "/local/artifacts/art-1", nav, pages })).toBe(
      "Artifacts",
    );
    expect(
      currentWorkbenchPageLabel({ pathname: "/local/settings/registration", nav, pages }),
    ).toBe("Settings");
  });
});
