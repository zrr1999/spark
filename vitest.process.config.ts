import { defineConfig } from "vitest/config";

/** Real-process source-distribution contracts. Keep separate from unit/integration tests. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/process/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
