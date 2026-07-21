import { describe, expect, it } from "vitest";
import {
  buildConsoleNavGroups,
  currentConsolePageLabel,
  isConsoleNavItemActive,
  isGlobalConsolePath,
  type ConsoleNavGroupLabels,
  type ConsoleNavLabels,
} from "./console-nav";

const nav: ConsoleNavLabels = {
  modelsProviders: "Models & providers",
  invocationDiagnostics: "Invocation diagnostics",
  channels: "Message platforms",
  workspaceSettings: "Basics",
  registration: "Runtime registration",
  webAccess: "Browser access",
  createWorkspace: "Create workspace",
};

const groups: ConsoleNavGroupLabels = {
  cockpit: "Cockpit",
  daemon: "Daemon",
  workspace: "Workspace · Local",
};

describe("console nav", () => {
  it("keeps control-plane items global and workspace connection under workspace", () => {
    const result = buildConsoleNavGroups({
      activeWorkspacePath: "/local",
      hasActiveWorkspace: true,
      includeWorkspaceNav: true,
      nav,
      groups,
    });

    expect(result.map((group) => [group.id, group.label])).toEqual([
      ["cockpit", "Cockpit"],
      ["daemon", "Daemon"],
      ["workspace", "Workspace · Local"],
    ]);
    expect(result[0]?.items.map((item) => item.href)).toEqual([
      "/workspaces/new",
      "/settings/access",
    ]);
    expect(result[1]?.items.map((item) => item.href)).toEqual([
      "/settings/models",
      "/settings/invocations",
    ]);
    expect(result[2]?.items.map((item) => item.href)).toEqual([
      "/local/settings",
      "/local/settings/channels",
      "/local/settings/registration",
    ]);
  });

  it("hides workspace nav on global control-plane pages", () => {
    const result = buildConsoleNavGroups({
      activeWorkspacePath: "/local",
      hasActiveWorkspace: true,
      includeWorkspaceNav: false,
      nav,
      groups,
    });
    expect(result.map((group) => group.id)).toEqual(["cockpit", "daemon"]);
    expect(result[0]?.items.map((item) => item.href)).toEqual([
      "/workspaces/new",
      "/settings/access",
    ]);
  });

  it("identifies global console paths", () => {
    expect(isGlobalConsolePath("/settings/access")).toBe(true);
    expect(isGlobalConsolePath("/settings/invocations")).toBe(true);
    expect(isGlobalConsolePath("/workspaces/new")).toBe(true);
    expect(isGlobalConsolePath("/local/settings/registration")).toBe(false);
  });

  it("keeps Cockpit, daemon, and workspace active states distinct", () => {
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
