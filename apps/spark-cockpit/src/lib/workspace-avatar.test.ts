import { describe, expect, it } from "vitest";
import {
  workspaceAvatarColorIndex,
  workspaceAvatarStyle,
  workspaceInitial,
} from "./workspace-avatar";

describe("workspace avatar", () => {
  it("projects the same workspace to a stable palette entry", () => {
    const workspace = { id: "ws_123", slug: "spark", name: "Spark" };

    expect(workspaceAvatarColorIndex(workspace)).toBe(workspaceAvatarColorIndex({ ...workspace }));
    expect(workspaceAvatarStyle(workspace)).toBe(workspaceAvatarStyle({ ...workspace }));
    expect(workspaceAvatarStyle(workspace)).toMatch(
      /^--avatar-bg: #[0-9A-F]{6}; --avatar-border: #[0-9A-F]{6}; --avatar-ink: #[0-9A-F]{6};$/,
    );
  });

  it("uses the visible name initial and falls back to the slug", () => {
    expect(workspaceInitial({ name: " spark", slug: "fallback" })).toBe("S");
    expect(workspaceInitial({ name: "", slug: "delta" })).toBe("D");
    expect(workspaceInitial(undefined)).toBe("?");
  });

  it("keeps the empty fallback inside the shared palette", () => {
    expect(workspaceAvatarColorIndex(undefined)).toBeGreaterThanOrEqual(0);
    expect(workspaceAvatarColorIndex(undefined)).toBeLessThan(8);
  });
});
