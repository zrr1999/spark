import { describe, expect, it } from "vitest";
import {
  workbenchSessionIdFromPath,
  workbenchSessionsPathFromPathname,
  workspaceSessionPath,
  workspaceSessionsPath,
} from "./workspace-routes";

const workspace = { slug: "spore workspace" };

describe("workspace session routes", () => {
  it("includes the workspace slug in list and detail URLs", () => {
    expect(workspaceSessionsPath(workspace)).toBe("/spore%20workspace/sessions");
    expect(workspaceSessionPath(workspace, "runtime/ops")).toBe(
      "/spore%20workspace/sessions/runtime%2Fops",
    );
  });

  it("parses canonical and legacy session URLs", () => {
    expect(workbenchSessionIdFromPath("/spore/sessions/runtime%2Fops")).toBe("runtime/ops");
    expect(workbenchSessionIdFromPath("/sessions/runtime%2Fops")).toBe("runtime/ops");
    expect(workbenchSessionsPathFromPathname("/spore/sessions/runtime-ops")).toBe(
      "/spore/sessions",
    );
    expect(workbenchSessionsPathFromPathname("/sessions/runtime-ops")).toBe("/sessions");
  });
});
