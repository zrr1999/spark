#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = (process.env.SPARK_BOUNDARY_ROOT ?? new URL("..", import.meta.url).pathname).replace(
  /\/$/u,
  "",
);
const sourceFilePattern = /\.(?:c|m)?(?:t|j)sx?$/u;
const importSpecifierPattern =
  /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu;

const violations = [];

for (const packageDir of await listWorkspaceDirs()) {
  const manifest = await readPackageManifest(packageDir);
  if (!manifest) continue;
  const boundary = classifyBoundary(packageDir, manifest);
  if (boundary === "other") continue;
  await checkPackageManifest(packageDir, manifest, boundary);
  await checkSourceTree(join(packageDir, "src"), boundary);
  await checkSourceTree(join(packageDir, "server"), boundary);
}

if (violations.length > 0) {
  console.error("package boundary violation");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

async function listWorkspaceDirs() {
  const dirs = [];
  for (const workspaceDir of ["packages", "apps"]) {
    let entries;
    try {
      entries = await readdir(join(root, workspaceDir), { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(root, workspaceDir, entry.name));
    }
  }
  return dirs;
}

async function readPackageManifest(packageDir) {
  const packageJsonPath = join(packageDir, "package.json");
  try {
    return JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function classifyBoundary(packageDir, manifest) {
  const pathName = packageDir.split(/[/\\]/u).at(-1) ?? "";
  const packageName = typeof manifest.name === "string" ? manifest.name : "";
  if (pathName.startsWith("pi-") || packageName.startsWith("@zendev-lab/pi-")) return "pi";
  if (pathName.startsWith("navia-") || packageName.startsWith("@navia-dev/")) return "navia";
  if (pathName.startsWith("spark") || packageName.startsWith("@zendev-lab/spark")) {
    return "spark";
  }
  return "other";
}

async function checkPackageManifest(packageDir, manifest, boundary) {
  const packageJsonPath = join(packageDir, "package.json");
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = manifest[field];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) {
      const reason = forbiddenSpecifierReason(name, boundary);
      if (reason) violations.push(`${formatPath(packageJsonPath)}: ${field}.${name} (${reason})`);
    }
  }
}

async function checkSourceTree(dir, boundary) {
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
      await checkSourceTree(fullPath, boundary);
      continue;
    }
    if (!entry.isFile() || !sourceFilePattern.test(entry.name)) continue;
    const content = await readFile(fullPath, "utf8");
    const lines = content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      for (const specifier of importSpecifiers(line)) {
        const reason = forbiddenSpecifierReason(specifier, boundary);
        if (reason) {
          violations.push(`${formatPath(fullPath)}:${index + 1}: ${specifier} (${reason})`);
        }
      }
    });
  }
}

function importSpecifiers(line) {
  const specs = [];
  for (const match of line.matchAll(importSpecifierPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier) specs.push(specifier);
  }
  return specs;
}

function forbiddenSpecifierReason(specifier, boundary) {
  if (boundary === "pi") {
    if (isSparkSpecifier(specifier)) return "pi-* packages must not depend on Spark packages";
    if (isNaviaSpecifier(specifier)) return "pi-* packages must not depend on Navia packages";
  }
  if (boundary === "spark") {
    if (isNaviaSpecifier(specifier))
      return "Spark core/runtime packages must not depend on Navia packages";
  }
  if (boundary === "navia") {
    if (isSparkCliHostSpecifier(specifier)) {
      return "Navia packages must not import Spark CLI host internals";
    }
  }
  return null;
}

function isSparkSpecifier(specifier) {
  return specifier.startsWith("@zendev-lab/spark") || specifier.startsWith("spark-");
}

function isNaviaSpecifier(specifier) {
  return specifier.startsWith("@navia-dev/") || specifier.startsWith("navia-");
}

function isSparkCliHostSpecifier(specifier) {
  return (
    specifier === "@zendev-lab/spark-cli" ||
    specifier.startsWith("@zendev-lab/spark-cli/") ||
    specifier.includes("/spark-cli/") ||
    specifier.includes("../spark-cli") ||
    specifier.includes("../../spark-cli")
  );
}

function formatPath(path) {
  return relative(root, path);
}
