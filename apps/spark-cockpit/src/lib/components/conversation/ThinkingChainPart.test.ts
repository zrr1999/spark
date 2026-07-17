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

  it("keeps execution details during work, then collapses into a reusable step timeline", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('class="thinking-chain {chainState}"');
    expect(source).toContain("bind:open={expanded}");
    expect(source).toContain("onclick={toggleExpanded}");
    expect(source).toContain("expanded = !expanded");
    expect(source).toContain("{#if expanded}");
    expect(source).toContain('statusLabel("failed")');
    expect(source).toContain("margin-inline: 0 auto");
    expect(source).toContain("min-height: 22px");
    expect(source).toContain("{statusLabel}");
    expect(source).toContain('class="chain-step {step.type} {presentationStatus}"');
    expect(source).toContain("stepStatus(step)");
    expect(source).toContain("index * 90");
    expect(source).toContain("grid-template-columns: 18px minmax(0, 1fr)");
    expect(source).toContain("chain-step-reveal");
    expect(source).toContain("animation: chain-pulse");
    expect(source).toContain('previousState === "streaming" && chainState === "complete"');
    expect(source).toContain("previousActive && !active");
    expect(source).toContain("@media (hover: hover) and (pointer: fine)");
    expect(source).toContain(":global(.conversation-message:hover)");
    expect(source).not.toContain("pointer-events: none");
  });

  it("suppresses empty completed chains and explains empty streaming or failed chains", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("isVisibleThinkingChain(chainState, steps)");
    expect(source).toContain("visibleThinkingChainSteps(steps)");
    expect(source).toContain("labels.chainEmpty");
    expect(source).toContain("labels.chainFailed");
  });
});
