import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

/**
 * Node unit/integration tests stay the default fast path.
 * Browser-mode component tests are opt-in via `vitest.browser.config.ts`
 * (`SPARK_COCKPIT_BROWSER_TESTS=1 pnpm exec vp test run --config vitest.browser.config.ts`).
 * Feature safety-net coverage lives in node tests under sessions-workspace/.
 */
export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    conditions: ["browser"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts"],
  },
});
