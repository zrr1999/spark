import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const modelSelectorRoot = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(modelSelectorRoot, "../../../..");
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

  it("keeps model changes on the existing SvelteKit form path", () => {
    const workspace = readFileSync(join(appRoot, "src/lib/SessionsWorkspace.svelte"), "utf8");

    expect(workspace).toContain("<ModelPicker");
    expect(workspace).toContain('action="?/selectModel"');
    expect(workspace).toContain("use:enhance={enhanceSelectModel}");
    expect(workspace).toContain("sessionModelForm?.requestSubmit()");
  });
});
