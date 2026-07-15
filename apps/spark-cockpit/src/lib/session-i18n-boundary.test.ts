import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("conversation i18n boundary", () => {
  it("takes conversation workbench copy from the shared dictionary", () => {
    const source = readFileSync(join(appRoot, "src/lib/SessionsWorkspace.svelte"), "utf8");

    expect(source).toContain("messages.workbench");
    expect(source).not.toContain("let isZh");
    expect(source).not.toMatch(/[\u3400-\u9fff]/);
  });

  it("renders the resolved locale into the document language", () => {
    const template = readFileSync(join(appRoot, "src/app.html"), "utf8");
    const hooks = readFileSync(join(appRoot, "src/hooks.server.ts"), "utf8");

    expect(template).toContain('<html lang="%spark.locale%">');
    expect(hooks).toContain('html.replace("%spark.locale%", locale)');
    expect(hooks).toContain("resolveRequestLocale");
  });

  it("does not give shared selects an English-only fallback", () => {
    const source = readFileSync(join(appRoot, "src/lib/ui/Select.svelte"), "utf8");

    expect(source).toContain("placeholder = label");
    expect(source).not.toContain('placeholder = "Select"');
  });
});
