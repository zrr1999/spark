import { sveltekit } from "@sveltejs/kit/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type TestProjectConfiguration } from "vitest/config";

/** Opt-in: requires matching Playwright Chromium (`pnpm exec playwright install chromium`). */
const enableBrowserTests = process.env.SPARK_COCKPIT_BROWSER_TESTS === "1";

/**
 * Node unit/integration tests stay the default fast path.
 * Browser project only picks up `*.browser.test.ts` when SPARK_COCKPIT_BROWSER_TESTS=1.
 * Feature safety-net coverage lives in node tests under sessions-workspace/.
 */
const projects: TestProjectConfiguration[] = [
  {
    extends: true,
    test: {
      name: "node",
      environment: "node",
      include: ["src/**/*.test.ts"],
      exclude: ["src/**/*.browser.test.ts"],
    },
  },
];

if (enableBrowserTests) {
  projects.push({
    extends: true,
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
}

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    conditions: ["browser"],
  },
  test: {
    projects,
  },
});
