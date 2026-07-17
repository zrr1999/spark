import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { transformWithEsbuild } from "vite";

const typescriptWithSvelteImports = {
  name: "typescript-with-svelte-imports",
  async script({ attributes, content, filename = "" }) {
    if (attributes.lang !== "ts") return;
    const { code, map } = await transformWithEsbuild(content, filename, {
      loader: "ts",
      target: "esnext",
      tsconfigRaw: {
        compilerOptions: {
          importsNotUsedAsValues: "preserve",
          preserveValueImports: true,
        },
      },
    });
    return { code, map };
  },
};

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // Vite+ currently routes vitePreprocess({ script: true }) through Oxc, which
  // drops component imports referenced only from Svelte markup. Streamdown
  // ships TypeScript Svelte sources, so use Vite's esbuild transform until Oxc
  // can preserve those value imports too.
  preprocess: [typescriptWithSvelteImports, vitePreprocess()],
  kit: {
    adapter: adapter({ out: "build" }),
    alias: {
      $ui: "../../packages/ui/src",
    },
  },
};

export default config;
