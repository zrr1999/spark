import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const responseRoot = dirname(fileURLToPath(import.meta.url));
const responsePath = join(responseRoot, "Response.svelte");
const libRoot = resolve(responseRoot, "../..");

describe("Svelte AI Elements Response boundary", () => {
  it("compiles the source-derived Response component", () => {
    const source = readFileSync(responsePath, "utf8");

    expect(() => compile(source, { filename: responsePath, generate: "server" })).not.toThrow();
  });

  it("enables the complete Response stack and keeps Streamdown props composable", () => {
    const source = readFileSync(responsePath, "utf8");

    expect(source).toContain('from "streamdown-svelte"');
    expect(source).toContain("const richMarkdownPlugins = { cjk, math, mermaid }");
    expect(source).toContain("githubLightDefault");
    expect(source).toContain("githubDarkDefault");
    expect(source).toContain("{...restProps}");
    expect(source).toContain('[data-streamdown="code-block"]');
    expect(source).toContain('[data-streamdown="table-wrapper"]');
    expect(source).toContain('[data-streamdown="mermaid"]');
  });

  it("wires streaming repair only to the active Spark UI block and escapes raw HTML", () => {
    const safeMarkdown = readFileSync(join(libRoot, "SafeMarkdown.svelte"), "utf8");
    const sparkUiRenderer = readFileSync(join(libRoot, "SparkUiRenderer.svelte"), "utf8");
    const agentStream = readFileSync(join(libRoot, "AgentMdxStream.svelte"), "utf8");

    expect(safeMarkdown).toContain('mode={streaming ? "streaming" : "static"}');
    expect(safeMarkdown).toContain("parseIncompleteMarkdown");
    expect(safeMarkdown).toContain('caret={streaming ? "block" : undefined}');
    expect(safeMarkdown).toContain("renderHtml={false}");
    expect(sparkUiRenderer).toContain("streaming && index === document.blocks.length - 1");
    expect(sparkUiRenderer).toContain("streaming={blockStreaming}");
    expect(agentStream).toContain("streamCaretOwnedByMarkdown");
  });

  it("pins upstream provenance and retains the MIT notice", () => {
    const vendor = readFileSync(join(responseRoot, "VENDOR.md"), "utf8");
    const license = readFileSync(join(responseRoot, "UPSTREAM-LICENSE.txt"), "utf8");

    expect(vendor).toContain("fa4bc217f84bc571378bc371332a154106772614");
    expect(vendor).toContain("https://svelte-ai-elements.vercel.app/r/response.json");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 Sikandar Bhide");
  });
});
