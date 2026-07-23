import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

/**
 * Node unit/integration tests stay the default fast path.
 * Browser interaction tests run separately through `pnpm run test:browser:cockpit`.
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
