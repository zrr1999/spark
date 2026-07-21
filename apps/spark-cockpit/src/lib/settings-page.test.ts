import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const pagePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../routes/(console)/[workspaceId]/settings/+page.svelte",
);

describe("workspace settings page contract", () => {
  it("compiles as a Svelte page", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(() => compile(source, { filename: pagePath, generate: "server" })).not.toThrow();
  });

  it("presents local path as the primary workspace identity", () => {
    const source = readFileSync(pagePath, "utf8");

    expect(source).toContain("t.workspace.localPath");
    expect(source).toContain("data.workspace.localPath");
    expect(source).toContain("readonly={hasLocalPath}");
    expect(source).toContain("t.workspace.nameHint");
    expect(source).not.toContain("Name and address");
  });
});
