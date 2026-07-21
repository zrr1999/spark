import { sveltekit } from "@sveltejs/kit/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** Opt-in: requires matching Playwright Chromium (`pnpm exec playwright install chromium`). */
const enableBrowserTests = process.env.SPARK_COCKPIT_BROWSER_TESTS === "1";

const nodeProject = {
  extends: true as const,
  test: {
    name: "node",
    environment: "node" as const,
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts"],
  },
};

const browserProject = {
  extends: true as const,
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.ts"],
    setupFiles: ["vitest-browser-svelte"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" as const }],
    },
  },
};

/**
 * Node unit/integration tests stay the default fast path.
 * Browser project only picks up `*.browser.test.ts` when SPARK_COCKPIT_BROWSER_TESTS=1.
 * Feature safety-net coverage lives in node tests under sessions-workspace/.
 */
export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    conditions: ["browser"],
  },
  test: {
    projects: enableBrowserTests ? [nodeProject, browserProject] : [nodeProject],
  },
});
