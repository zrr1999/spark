#!/usr/bin/env node
/**
 * Experimental: generate Kysely types with kysely-codegen + better-sqlite3.
 *
 * Prefer `src/types.ts` (handwritten) — codegen loses enum unions and marks
 * PRIMARY KEY columns as nullable. Use `scripts/check-schema-types.mjs` for the
 * committed gate. This script remains for spot-checking codegen quality.
 *
 * Usage: node --experimental-strip-types scripts/generate-types.mjs
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "../src/migrate.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDir = join(packageRoot, ".codegen-tmp");
const dbPath = join(tempDir, "spark.sqlite");
const outPath = join(packageRoot, "src", "generated-types.ts");

mkdirSync(tempDir, { recursive: true });
try {
  const db = new DatabaseSync(dbPath);
  migrate(db);
  db.close();

  const result = spawnSync(
    join(packageRoot, "node_modules", ".bin", "kysely-codegen"),
    ["--dialect", "sqlite", "--url", dbPath, "--out-file", outPath],
    { cwd: packageRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  console.log(`wrote experimental ${outPath}`);
  console.log(
    "Note: do not commit generated-types.ts as the public API; handwritten types.ts remains canonical.",
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
