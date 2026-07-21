import { sveltekit } from "@sveltejs/kit/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * Opt-in browser project for SessionsWorkspace component tests.
 * Requires: `pnpm exec playwright install chromium`
 * Run: `SPARK_COCKPIT_BROWSER_TESTS=1 pnpm exec vp test run --config vitest.browser.config.ts`
 */
export default defineConfig({
  plugins: [sveltekit()],
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
