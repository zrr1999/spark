import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), "ArtifactPart.svelte");

describe("ArtifactPart component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("renders daemon artifact references without inventing a Cockpit route", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("<strong>{title}</strong>");
    expect(source).toContain("<code>{artifactRef}</code>");
    expect(source).not.toContain("artifactHref");
    expect(source).not.toContain("/artifacts/");
    expect(source).not.toContain("<a ");
  });
});
