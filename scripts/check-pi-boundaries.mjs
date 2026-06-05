#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const packagesDir = join(root, "packages");
const sourceFilePattern = /\.(?:c|m)?(?:t|j)sx?$/u;
const sparkPackageImportPattern =
  /\bfrom\s+["']spark-[^"']+["']|\bimport\s+["']spark-[^"']+["']|\bimport\s*\(\s*["']spark-[^"']+["']\s*\)/u;

const violations = [];

for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("pi-")) continue;
  const packageDir = join(packagesDir, entry.name);
  await checkPackageManifest(packageDir);
  await checkSourceTree(join(packageDir, "src"));
}

if (violations.length > 0) {
  console.error("pi package boundary violation: pi-* packages must not depend on spark-* packages");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

async function checkPackageManifest(packageDir) {
  const packageJsonPath = join(packageDir, "package.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = parsed[field];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith("spark-")) {
        violations.push(`${formatPath(packageJsonPath)}: ${field}.${name}`);
      }
    }
  }
}

async function checkSourceTree(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await checkSourceTree(fullPath);
      continue;
    }
    if (!entry.isFile() || !sourceFilePattern.test(entry.name)) continue;
    const content = await readFile(fullPath, "utf8");
    const lines = content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (sparkPackageImportPattern.test(line)) {
        violations.push(`${formatPath(fullPath)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

function formatPath(path) {
  return relative(root, path);
}
