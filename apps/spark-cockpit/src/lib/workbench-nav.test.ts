import { describe, expect, it } from "vitest";
import {
  buildWorkbenchNavItems,
  currentWorkbenchPageLabel,
  isWorkbenchNavItemActive,
  workspaceSwitcherHref,
  type WorkbenchNavLabels,
  type WorkbenchPageLabels,
} from "./workbench-nav";
import { workspacePath } from "./workspace-routes";

const nav: WorkbenchNavLabels = {
  overview: "Overview",
  sessions: "Sessions",
  inbox: "Inbox",
  artifacts: "Artifacts",
  repos: "Resources",
};

const pages: WorkbenchPageLabels = {
  overview: "Overview",
  comingSoon: "Coming soon",
};

describe("workbench nav", () => {
  it("builds a flat secondary nav without group labels", () => {
    const result = buildWorkbenchNavItems({
      activeWorkspacePath: "/local",
      hasActiveWorkspace: true,
      nav,
    });

    expect(result.map((item) => item.label)).toEqual([
      "Overview",
      "Inbox",
      "Artifacts",
      "Resources",
    ]);
    expect(result[0]).toMatchObject({ href: "/local", icon: "home" });
    expect(result[2]).toMatchObject({ href: "/local/artifacts", icon: "artifacts" });
    expect(result[3]).toMatchObject({ href: "/local/repos", icon: "repos" });
  });

  it("returns no secondary items when no workspace is active", () => {
    const result = buildWorkbenchNavItems({
      activeWorkspacePath: "",
      hasActiveWorkspace: false,
      nav,
    });

    expect(result).toEqual([]);
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
        pathname: "/sessions/sess_1",
        href: "/sessions",
        activeWorkspacePath: "/local",
      }),
    ).toBe(true);
    expect(
      isWorkbenchNavItemActive({
        pathname: "/sessions",
        href: "/local",
        activeWorkspacePath: "/local",
      }),
    ).toBe(false);
  });

  it("derives breadcrumb page labels for workbench routes", () => {
    expect(currentWorkbenchPageLabel({ pathname: "/local", nav, pages })).toBe("Overview");
    expect(currentWorkbenchPageLabel({ pathname: "/sessions/sess_1", nav, pages })).toBe(
      "Sessions",
    );
    expect(currentWorkbenchPageLabel({ pathname: "/local/artifacts/art-1", nav, pages })).toBe(
      "Artifacts",
    );
    expect(currentWorkbenchPageLabel({ pathname: "/local/repos", nav, pages })).toBe("Resources");
  });

  it("keeps global routes on switch and preserves workspace-scoped suffixes", () => {
    expect(
      workspaceSwitcherHref({
        pathname: "/sessions",
        origin: "http://127.0.0.1:5173",
        activeWorkspacePath: "/local",
        targetWorkspaceSlug: "other",
        workspacePath,
      }),
    ).toBe("/sessions?workspace=other");
    expect(
      workspaceSwitcherHref({
        pathname: "/local/inbox",
        origin: "http://127.0.0.1:5173",
        activeWorkspacePath: "/local",
        targetWorkspaceSlug: "other",
        workspacePath,
      }),
    ).toBe("/other/inbox");
  });
});
