import { sveltekit } from "@sveltejs/kit/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { dependencySourcemapDiagnosticFilter } from "./src/lib/vite-diagnostics";

/**
 * Browser project for Cockpit interaction and DOM behavior.
 * Requires: `pnpm exec playwright install chromium`
 * Run from the repository root: `pnpm run test:browser:cockpit`
 */
export default defineConfig({
  plugins: [dependencySourcemapDiagnosticFilter(), sveltekit()],
  optimizeDeps: {
    // Lucide publishes Svelte source and its generated bundle maps every icon
    // to a package-external path. Transform it directly so browser-test logs
    // are not flooded by one sourcemap warning per icon.
    exclude: ["@lucide/svelte"],
  },
  resolve: {
    conditions: ["browser"],
  },
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.ts"],
    setupFiles: ["vitest-browser-svelte"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
