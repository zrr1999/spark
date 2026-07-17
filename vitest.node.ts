import { defineConfig } from "vitest/config";

/** Shared Node Vitest defaults for Spark packages and apps with colocated src tests. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
