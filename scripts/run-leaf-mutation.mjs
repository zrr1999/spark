#!/usr/bin/env node
import { spawnSync } from "node:child_process";

/** L0 leaves + L1 Vitest packages for weekly mutation CE. */
const packages = [
  // L0
  "@zendev-lab/spark-retry",
  "@zendev-lab/spark-protocol",
  "@zendev-lab/spark-db",
  "@zendev-lab/spark-system",
  // L1
  "@zendev-lab/spark-channels",
  "@zendev-lab/spark-coordination",
  "@zendev-lab/spark-session",
  "@zendev-lab/spark-artifacts",
  "@zendev-lab/spark-repro",
  "@zendev-lab/spark-i18n",
];

let failed = 0;
for (const name of packages) {
  console.log(`\n=== mutation: ${name} ===\n`);
  const result = spawnSync("pnpm", ["--filter", name, "run", "test:mutation"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`\n[mutation] ${name} exited ${result.status ?? "signal"}\n`);
  }
}

if (failed > 0) {
  console.error(`[mutation] ${failed}/${packages.length} package(s) failed`);
  process.exit(1);
}
console.log(`[mutation] ${packages.length}/${packages.length} package(s) completed`);
