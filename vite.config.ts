import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["**/*.md", "prek.toml", "_typos.toml"],
  },
  lint: {
    plugins: ["typescript"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    // NOTE (Phase 1): Oxlint exposes cyclomatic `complexity` and `max-lines` (not
    // Sonar `cognitive-complexity`). Enabling them as warn across the repo floods
    // stdout and makes `vp check --fix` abort (Vite+ panic: EAGAIN on stdout).
    // Keep them off the default lint path; `pnpm run check:complexity` enables
    // only those two rules through CLI overrides for a report-only hotspot scan.
    overrides: [
      {
        files: [
          "packages/**/*.ts",
          "apps/spark-cli/**/*.ts",
          "apps/spark-tui/**/*.ts",
          "test/**/*.ts",
        ],
        env: { node: true },
      },
    ],
  },
});
