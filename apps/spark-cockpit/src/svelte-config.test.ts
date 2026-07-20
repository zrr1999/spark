import { describe, expect, it } from "vitest";
import { typescriptWithSvelteImports } from "./svelte-preprocess.js";

describe("Svelte TypeScript preprocess", () => {
  it("uses Oxc while preserving imports referenced from Svelte markup", async () => {
    const result = await typescriptWithSvelteImports.script!({
      attributes: { lang: "ts" },
      content: 'import Widget from "./Widget.svelte";\nconst value: string = "ok";',
      markup: "",
      filename: "Component.svelte.ts",
    });

    expect(result?.code).toContain('import Widget from "./Widget.svelte"');
    expect(result?.code).toContain('const value = "ok"');
    expect(result?.map).toBeDefined();
  });

  it("leaves non-TypeScript blocks to the standard preprocessors", async () => {
    const result = await typescriptWithSvelteImports.script!({
      attributes: { lang: "js" },
      content: "const value = 1;",
      markup: "",
      filename: "Component.svelte.js",
    });

    expect(result).toBeUndefined();
  });
});
