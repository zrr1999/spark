#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const packages = [
  "@zendev-lab/spark-retry",
  "@zendev-lab/spark-protocol",
  "@zendev-lab/spark-db",
  "@zendev-lab/spark-system",
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
