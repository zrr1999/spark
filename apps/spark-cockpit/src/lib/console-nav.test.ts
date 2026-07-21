import { describe, expect, it } from "vitest";
import {
  buildConsoleNavGroups,
  COCKPIT_SETTINGS_HREF,
  currentConsolePageLabel,
  isConsoleNavItemActive,
  isControlPlanePath,
  isGlobalConsolePath,
  type ConsoleNavCopy,
  type ConsoleNavGroupCopy,
} from "./console-nav";

const nav: ConsoleNavCopy = {
  modelsProviders: "Models & providers",
  invocationDiagnostics: "Invocation diagnostics",
  channels: "Message platforms",
  workspaceDetails: "Basics",
  registration: "Runtime registration",
  webAccess: "Browser access",
  createWorkspace: "Create workspace",
};

const groups: ConsoleNavGroupCopy = {
  cockpit: "Cockpit",
  daemon: "Daemon",
  workspace: "Workspace · Local",
};

describe("console nav", () => {
  it("keeps daemon grouped under workspace settings chrome", () => {
    const result = buildConsoleNavGroups({
      workspaceHrefPrefix: "/local",
      includeControlPlaneNav: false,
      includeWorkspaceNav: true,
      nav,
      groups,
    });

    expect(result.map((group) => [group.id, group.label])).toEqual([
      ["workspace", "Workspace · Local"],
      ["daemon", "Daemon"],
    ]);
    expect(result[0]?.items.map((item) => item.href)).toEqual([
      "/local/settings",
      "/local/settings/channels",
      "/local/settings/registration",
    ]);
    expect(result[1]?.items.map((item) => item.href)).toEqual([
      "/settings/models",
      "/settings/invocations",
    ]);
  });

  it("shows only control-plane items on independent Cockpit settings pages", () => {
    const result = buildConsoleNavGroups({
      workspaceHrefPrefix: "/local",
      includeControlPlaneNav: true,
      includeWorkspaceNav: false,
      nav,
      groups,
    });
    expect(result.map((group) => group.id)).toEqual(["cockpit"]);
    expect(result[0]?.items.map((item) => item.href)).toEqual([
      "/workspaces/new",
      COCKPIT_SETTINGS_HREF,
    ]);
  });

  it("identifies control-plane paths (not workspace daemon settings)", () => {
    expect(isControlPlanePath("/settings/access")).toBe(true);
    expect(isControlPlanePath("/workspaces/new")).toBe(true);
    expect(isControlPlanePath("/settings/invocations")).toBe(false);
    expect(isControlPlanePath("/settings/models")).toBe(false);
    expect(isControlPlanePath("/local/settings/registration")).toBe(false);
    expect(isGlobalConsolePath("/settings/access")).toBe(true);
    expect(isGlobalConsolePath("/settings/models")).toBe(false);
  });

  it("keeps Cockpit and workspace active states distinct", () => {
    expect(isConsoleNavItemActive({ pathname: "/workspaces/new", href: "/workspaces/new" })).toBe(
      true,
    );
    expect(isConsoleNavItemActive({ pathname: "/settings/models", href: "/workspaces/new" })).toBe(
      false,
    );
    expect(isConsoleNavItemActive({ pathname: "/settings/access", href: "/settings/access" })).toBe(
      true,
    );
    expect(isConsoleNavItemActive({ pathname: "/settings/models", href: "/settings/models" })).toBe(
      true,
    );
    expect(
      isConsoleNavItemActive({ pathname: "/local/settings/channels", href: "/settings/models" }),
    ).toBe(false);
    expect(
      isConsoleNavItemActive({
        pathname: "/local/settings/channels",
        href: "/local/settings/channels",
      }),
    ).toBe(true);
    expect(isConsoleNavItemActive({ pathname: "/local/settings", href: "/local/settings" })).toBe(
      true,
    );
    expect(
      isConsoleNavItemActive({
        pathname: "/local/settings/registration",
        href: "/local/settings",
      }),
    ).toBe(false);
  });

  it("labels console pages by their settings scope", () => {
    expect(currentConsolePageLabel({ pathname: "/local/settings/channels", nav })).toBe(
      "Message platforms",
    );
    expect(currentConsolePageLabel({ pathname: "/settings/access", nav })).toBe("Browser access");
    expect(currentConsolePageLabel({ pathname: "/settings/models", nav })).toBe(
      "Models & providers",
    );
    expect(currentConsolePageLabel({ pathname: "/settings/invocations", nav })).toBe(
      "Invocation diagnostics",
    );
    expect(currentConsolePageLabel({ pathname: "/workspaces/new", nav })).toBe("Create workspace");
    expect(currentConsolePageLabel({ pathname: "/local/settings", nav })).toBe("Basics");
    expect(currentConsolePageLabel({ pathname: "/local/settings/registration", nav })).toBe(
      "Runtime registration",
    );
  });
});
