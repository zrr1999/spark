import { describe, expect, it } from "vitest";
import { shouldSuppressDependencySourcemapDiagnostic } from "./vite-diagnostics";

describe("Cockpit Vite diagnostics", () => {
  it.each([
    'Sourcemap for "/workspace/apps/spark-cockpit/node_modules/.vite/deps/bits-ui.js" points to a source file outside its package: "/workspace/apps/spark-cockpit/dialog.svelte"',
    'Sourcemap for "/workspace/apps/spark-cockpit/node_modules/.vite/vitest/cache-key/deps/bits-ui.js" points to a source file outside its package: "/workspace/apps/spark-cockpit/dialog.svelte"',
    'Sourcemap for "/workspace/apps/spark-cockpit/node_modules/.vite/deps/@lucide_svelte.js" points to a source file outside its package: "/workspace/apps/spark-cockpit/Icon.svelte"',
    'Sourcemap for "/workspace/node_modules/.pnpm/entities@4.3.0/node_modules/entities/lib/esm/decode.js" points to a source file outside its package: "/workspace/apps/spark-cockpit/decode.ts"',
    'Sourcemap for "/workspace/node_modules/.pnpm/rehype-harden@1.1.8/node_modules/rehype-harden/dist/index.js" points to missing source files',
    [
      "Failed to load source map for /workspace/node_modules/.pnpm/parse5@7.0.0/node_modules/parse5/dist/parser/index.js.",
      "Error: An error occurred while trying to read the map file at index.js.map",
      "Error: ENOENT: no such file or directory, open '/workspace/node_modules/.pnpm/parse5@7.0.0/node_modules/parse5/dist/parser/index.js.map'",
    ].join("\n"),
  ])("suppresses a known dependency-only sourcemap diagnostic", (message) => {
    expect(shouldSuppressDependencySourcemapDiagnostic(message)).toBe(true);
  });

  it.each([
    "Failed to resolve import '$lib/missing'",
    "Sourcemap for /workspace/apps/spark-cockpit/src/lib/Session.svelte is invalid",
    "Failed to load source map for /workspace/apps/spark-cockpit/src/lib/Session.svelte.",
  ])("keeps actionable application diagnostics", (message) => {
    expect(shouldSuppressDependencySourcemapDiagnostic(message)).toBe(false);
  });
});
