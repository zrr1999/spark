import { defineConfig } from "vitest/config";

/** Root integration suite under test/. Separate from package Vitest and root vite-plus fmt/lint. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/process/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 2,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
