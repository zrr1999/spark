import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../routes/(console)/settings/access",
);

describe("cockpit browser access page", () => {
  it("compiles as a Svelte page", () => {
    const source = readFileSync(resolve(root, "+page.svelte"), "utf8");
    expect(() =>
      compile(source, { filename: "access/+page.svelte", generate: "server" }),
    ).not.toThrow();
  });

  it("mints Cockpit access keys at /login instead of workspace login", () => {
    const page = readFileSync(resolve(root, "+page.svelte"), "utf8");
    const server = readFileSync(resolve(root, "+page.server.ts"), "utf8");

    expect(server).toContain("createCockpitAccessToken");
    expect(server).toContain("listCockpitAccessTokens");
    expect(server).toContain('new URL("/login"');
    expect(server).not.toContain("createWorkspaceAccessToken");
    expect(page).toContain('action="?/createAccessToken"');
    expect(page).toContain("form.accessToken");
    expect(page).toContain("t.access.title");
  });
});
