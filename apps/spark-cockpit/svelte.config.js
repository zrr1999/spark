import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { typescriptWithSvelteImports } from "./src/svelte-preprocess.js";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // Vite+ routes vitePreprocess({ script: true }) through Oxc, whose default
  // import elision drops component imports referenced only from Svelte markup.
  // Streamdown ships TypeScript Svelte sources, so preserve value imports in
  // this explicit Oxc preprocessing pass before applying the standard hooks.
  preprocess: [typescriptWithSvelteImports, vitePreprocess()],
  kit: {
    adapter: adapter({ out: "build" }),
    alias: {
      $ui: "../../packages/ui/src",
    },
  },
};

export default config;
