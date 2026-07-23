import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "vitest";

test("pnpm scripts warn instead of auto-installing during hooks", async () => {
  const workspaceConfig = await readFile(resolve("pnpm-workspace.yaml"), "utf8");

  assert.match(
    workspaceConfig,
    /^verifyDepsBeforeRun:\s*warn\s*$/m,
    "pnpm run/exec must stay read-only while prek hides unstaged manifests",
  );
});
