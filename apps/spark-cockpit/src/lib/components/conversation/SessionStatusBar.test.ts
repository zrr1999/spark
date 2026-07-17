import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), "SessionStatusBar.svelte");

describe("SessionStatusBar component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("renders the requested dense metrics with localized accessible labels", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("↑{input}");
    expect(source).toContain("↓{output}");
    expect(source).toContain("R{cacheRead}");
    expect(source).toContain("W{cacheWrite}");
    expect(source).toContain("CH{cacheHit}");
    expect(source).toContain("aria-label={labels.bar}");
    expect(source).toContain("title={statusDescription}");
  });

  it("uses container queries to remove lower-priority detail on narrow bars", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("container: session-status / inline-size;");
    expect(source).toContain("@container session-status (max-width: 720px)");
    expect(source).toContain('[data-priority="low"]');
    expect(source).toContain("@container session-status (max-width: 520px)");
    expect(source).toContain('[data-priority="medium"]');
  });
});
