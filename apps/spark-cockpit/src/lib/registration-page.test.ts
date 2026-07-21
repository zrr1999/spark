import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const pagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../routes/(console)/[workspaceId]/settings/registration/+page.svelte",
);

describe("workspace registration page contract", () => {
  it("compiles as a Svelte page", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(() => compile(source, { filename: pagePath, generate: "server" })).not.toThrow();
  });

  it("shows the connected directory path as the workspace identity", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain('class="binding-path"');
    expect(source).toContain("class:pending={!binding.localPath}");
    expect(source).toContain("binding.localPath ?? t.bindings.pathPending");
    expect(source).not.toContain("binding.localPath ?? binding.localWorkspaceKey");
    expect(source).not.toContain("<strong>{binding.displayName}</strong>");
    expect(source).toContain('<Icon name="folder" size={13} />');
    expect(source).toContain("white-space: normal");
    expect(source).toContain("overflow-wrap: anywhere");
  });

  it("keeps daemon registration without workspace browser-access minting", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain('action="?/createEnrollmentToken"');
    expect(source).not.toContain('action="?/createWorkspaceAccessToken"');
    expect(source).not.toContain("form.workspaceAccessToken");
    expect(source).not.toContain("t.access.");
    expect(source).not.toContain("workspaceRegisterCommand");
    expect(source).not.toContain("device-commands");
  });
});
