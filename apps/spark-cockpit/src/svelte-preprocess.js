import { transformWithOxc } from "vite";

/** @type {import("svelte/compiler").PreprocessorGroup} */
export const typescriptWithSvelteImports = {
  name: "typescript-with-svelte-imports",
  async script({ attributes, content, filename = "" }) {
    if (attributes.lang !== "ts") return;
    const { code, map } = await transformWithOxc(content, filename, {
      lang: "ts",
      target: "esnext",
      tsconfig: {
        compilerOptions: {
          importsNotUsedAsValues: "preserve",
          preserveValueImports: true,
          verbatimModuleSyntax: true,
        },
      },
    });
    return { code, map };
  },
};
