import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../routes/(workbench)");

describe("workbench home workspace directory", () => {
  it("renders a workspace picker instead of redirecting into sessions", () => {
    const server = readFileSync(join(root, "+page.server.ts"), "utf8");
    const page = readFileSync(join(root, "+page.svelte"), "utf8");
    const layout = readFileSync(join(root, "+layout.server.ts"), "utf8");

    expect(server).toContain("loadWorkbenchHome");
    expect(server).not.toContain("workspaceSessionsPath");
    expect(page).toContain('data-testid="workspace-directory"');
    expect(page).toContain("/workspaces/new");
    expect(page).toContain("/settings/access");
    expect(page).toContain("connectionSettings");
    expect(page).toContain("webAccess");
    expect(page).not.toContain("manageConnections");
    expect(page).not.toContain('href="/login"');
    expect(layout).toContain("isWorkspaceDirectory");
    expect(layout).toContain("!isWorkspaceDirectory && activeWorkspaceId");
    expect(layout).not.toContain('href="/login"');

    const shell = readFileSync(join(root, "+layout.svelte"), "utf8");
    expect(shell).toContain("showNavigationToggle={!isWorkspaceDirectory}");
    expect(shell).toContain("showWorkspaceMenu={!isWorkspaceDirectory}");
    expect(shell).toContain("class:directory-mode={isWorkspaceDirectory}");
    expect(shell).not.toContain("directory-nav");
  });
});
