import { describe, expect, it } from "vitest";
import {
  buildConsoleNavGroups,
  currentConsolePageLabel,
  isConsoleNavItemActive,
  type ConsoleNavGroupLabels,
  type ConsoleNavLabels,
} from "./console-nav";

const nav: ConsoleNavLabels = {
  modelsProviders: "Models & providers",
  channels: "Message platforms",
  workspaceSettings: "Basics",
  registration: "Runtime registration",
  createWorkspace: "Create workspace",
};

const groups: ConsoleNavGroupLabels = {
  global: "Global",
  workspace: "Workspace",
  setup: "Setup",
};

describe("console nav", () => {
  it("builds console groups with workspace items when a workspace is active", () => {
    const result = buildConsoleNavGroups({
      activeWorkspacePath: "/local",
      hasActiveWorkspace: true,
      nav,
      groups,
    });

    expect(result.map((group) => [group.id, group.label])).toEqual([
      ["global", "Global"],
      ["workspace", "Workspace"],
      ["setup", "Setup"],
    ]);
    expect(result[0]?.items.map((item) => item.href)).toEqual(["/settings/models"]);
    expect(result[1]?.items.map((item) => item.href)).toEqual([
      "/local/settings",
      "/local/settings/channels",
      "/local/settings/registration",
    ]);
    expect(result[2]?.items[0]).toMatchObject({ href: "/workspaces/new" });
  });

  it("omits workspace group when no workspace is active", () => {
    const result = buildConsoleNavGroups({
      activeWorkspacePath: "",
      hasActiveWorkspace: false,
      nav,
      groups,
    });
    expect(result.map((group) => group.id)).toEqual(["global", "setup"]);
  });

  it("keeps global model settings and workspace settings active states distinct", () => {
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
    expect(currentConsolePageLabel({ pathname: "/settings/models", nav })).toBe(
      "Models & providers",
    );
    expect(currentConsolePageLabel({ pathname: "/workspaces/new", nav })).toBe("Create workspace");
    expect(currentConsolePageLabel({ pathname: "/local/settings", nav })).toBe("Basics");
  });
});
