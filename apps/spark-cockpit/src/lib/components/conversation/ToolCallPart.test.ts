import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), "ToolCallPart.svelte");

describe("ToolCallPart component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("keeps every tool call collapsed by default, including live and approval work", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('<details class="tool-part {state}" class:nested>');
    expect(source).not.toContain("bind:open");
    expect(source).not.toContain('open={state === "running" || state === "awaiting-approval"}');
    expect(source).toContain("<summary>");
    expect(source).toContain('class="disclosure"');
    expect(source).not.toContain("nested && Boolean(preview)");
  });
});
