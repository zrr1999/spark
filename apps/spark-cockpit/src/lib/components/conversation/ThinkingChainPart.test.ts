import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), "ThinkingChainPart.svelte");

describe("ThinkingChainPart component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("keeps active and failed execution details compact without a persistent pill", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('class="thinking-chain {state}"');
    expect(source).toContain('open={active || state === "streaming" || hasTerminalIssue}');
    expect(source).toContain("margin-inline: auto");
    expect(source).toContain("min-height: 22px");
    expect(source).toContain("animation: chain-pulse");
    expect(source).not.toContain("background: var(--color-surface-soft)");
    expect(source).not.toContain("@media (hover: hover) and (pointer: fine)");
    expect(source).not.toContain(":global(.conversation-message:hover)");
    expect(source).not.toContain("min-height: 40px");
  });
});
