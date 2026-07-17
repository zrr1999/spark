import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const modelSelectorRoot = dirname(fileURLToPath(import.meta.url));
const pinnedCommit = "fa4bc217f84bc571378bc371332a154106772614";

describe("source-derived model selector boundary", () => {
  it("pins source provenance and the upstream license", () => {
    const vendor = readFileSync(join(modelSelectorRoot, "VENDOR.md"), "utf8");
    const license = readFileSync(join(modelSelectorRoot, "UPSTREAM-LICENSE.txt"), "utf8");

    expect(vendor).toContain("https://github.com/SikandarJODD/ai-elements");
    expect(vendor).toContain(pinnedCommit);
    expect(vendor).toContain("source-derived composition");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 Sikandar Bhide");
  });

  it("uses only presentation primitives and local provider marks", () => {
    const source = readFileSync(join(modelSelectorRoot, "ModelPicker.svelte"), "utf8");

    expect(source).toContain('from "bits-ui"');
    expect(source).not.toMatch(/from\s+["']ai["']/);
    expect(source).not.toContain("@ai-sdk/svelte");
    expect(source).not.toContain("models.dev");
    expect(source).not.toContain("UIMessage");
    expect(source).not.toContain("FileUIPart");
  });

  it("compiles the unified model and reasoning control", () => {
    const picker = readFileSync(join(modelSelectorRoot, "ModelPicker.svelte"), "utf8");
    const runtimeControl = readFileSync(
      join(modelSelectorRoot, "ModelRuntimeControl.svelte"),
      "utf8",
    );

    expect(() =>
      compile(picker, {
        filename: join(modelSelectorRoot, "ModelPicker.svelte"),
        generate: "server",
      }),
    ).not.toThrow();
    expect(() =>
      compile(runtimeControl, {
        filename: join(modelSelectorRoot, "ModelRuntimeControl.svelte"),
        generate: "server",
      }),
    ).not.toThrow();
    expect(picker).toContain("open = $bindable(false)");
    expect(picker).not.toContain("primary-action");
    expect(picker).not.toContain("thinking-section");
    expect(runtimeControl).toContain("bind:open");
    expect(runtimeControl).toContain("thinking-control");
    expect(runtimeControl).toContain("reasoningSupported");
  });
});
