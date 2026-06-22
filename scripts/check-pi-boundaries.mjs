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
const piTuiSpecifier = "@earendil-works/pi-tui";
const skippedActiveDocumentationPattern = /^docs\/(?:navia\/|spark-daemon-unification\.md$)/u;
const retiredNaviaWebPattern =
  /\b(?:apps\/navia-web|@zendev-lab\/navia-web|navia-web|Navia web)\b/u;
const legacyNaviaPackagePattern = /(?:@zendev-lab\/navia-|packages\/navia-|`navia-)/u;
const intentionalLegacyNaviaLinePattern =
  /\b(?:legacy|legacy-named|historical|migration|transition|compatibility|retired|archived|former)\b/iu;
const allowedPiTuiImportFiles = new Set([
  join(root, "apps", "spark", "src", "tui", "pi-tui-adapter.ts"),
]);
const allowedPiTuiPackageDirs = new Set([join(root, "packages", "spark-tui")]);

for (const packageDir of await listWorkspaceDirs()) {
  const manifest = await readPackageManifest(packageDir);
  if (!manifest) continue;
  const boundary = classifyBoundary(packageDir, manifest);
  if (boundary === "other") continue;
  await checkPackageManifest(packageDir, manifest, boundary);
  await checkSourceTree(join(packageDir, "src"), boundary);
  await checkSourceTree(join(packageDir, "server"), boundary);
  await checkSourceTree(join(packageDir, "extensions"), boundary);
}
await checkSourceTree(join(root, "test"), "other");
await checkActiveDocumentation();

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
  const relativePackageDir = formatPath(packageDir);
  const [workspaceDir, pathName = ""] = relativePackageDir.split("/");
  const packageName = typeof manifest.name === "string" ? manifest.name : "";
  if (pathName.startsWith("pi-") || packageName.startsWith("@zendev-lab/pi-")) return "pi";
  if (workspaceDir === "apps") {
    if (pathName === "spark-cockpit" || packageName === "@zendev-lab/spark-cockpit") {
      return "cockpit-app";
    }
    if (pathName === "spark-daemon" || packageName === "@zendev-lab/spark-daemon") {
      return "daemon-app";
    }
    if (
      pathName === "spark" ||
      pathName === "spark-cli" ||
      pathName === "spark-tui" ||
      packageName === "@zendev-lab/spark-cli" ||
      packageName === "@zendev-lab/spark-tui-app"
    ) {
      return "spark-app";
    }
  }
  if (
    pathName === "spark" ||
    pathName === "spark-extension" ||
    packageName === "@zendev-lab/spark" ||
    packageName === "@zendev-lab/spark-extension"
  ) {
    return "spark-extension";
  }
  if (pathName.startsWith("navia-") || packageName.startsWith("@zendev-lab/navia-")) {
    return "cockpit-package";
  }
  if (
    pathName.startsWith("spark-cockpit-") ||
    packageName.startsWith("@zendev-lab/spark-cockpit-")
  ) {
    return "cockpit-package";
  }
  if (pathName.startsWith("spark") || packageName.startsWith("@zendev-lab/spark")) {
    return "spark-core";
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
      if (name === piTuiSpecifier && !isAllowedPiTuiImportPath(packageJsonPath)) {
        violations.push(
          `${formatPath(packageJsonPath)}: ${field}.${name} (direct pi-tui dependency must stay behind @zendev-lab/spark-tui)`,
        );
      }
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
        if (specifier === piTuiSpecifier && !isAllowedPiTuiImportPath(fullPath)) {
          violations.push(
            `${formatPath(fullPath)}:${index + 1}: ${specifier} (direct pi-tui imports must go through @zendev-lab/spark-tui or the Spark TUI adapter)`,
          );
        }
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

function isAllowedPiTuiImportPath(path) {
  if (allowedPiTuiImportFiles.has(path)) return true;
  for (const packageDir of allowedPiTuiPackageDirs) {
    if (path === packageDir || path.startsWith(`${packageDir}/`)) return true;
  }
  return false;
}

function forbiddenSpecifierReason(specifier, boundary) {
  if (boundary === "pi") {
    if (isCockpitSpecifier(specifier)) return "pi-* packages must not depend on cockpit packages";
    if (isSparkSpecifier(specifier)) return "pi-* packages must not depend on Spark packages";
  }
  if (boundary === "spark-core" || boundary === "spark-extension") {
    if (isCockpitSpecifier(specifier)) {
      return "Spark core/runtime packages must not depend on cockpit or daemon adapter packages";
    }
    if (isSparkAppInternalSpecifier(specifier)) {
      return "Spark shared packages must not import Spark app host internals";
    }
  }
  if (boundary === "cockpit-package" || boundary === "cockpit-app") {
    if (isSparkAppInternalSpecifier(specifier)) {
      return "Cockpit packages must not import Spark CLI host internals";
    }
  }
  return null;
}

function isSparkSpecifier(specifier) {
  if (specifier === "@zendev-lab/spark-tui" || specifier.startsWith("@zendev-lab/spark-tui/")) {
    return false;
  }
  return specifier.startsWith("@zendev-lab/spark") || specifier.startsWith("spark-");
}

function isCockpitSpecifier(specifier) {
  return (
    specifier === "@zendev-lab/spark-cockpit" ||
    specifier === "@zendev-lab/spark-daemon" ||
    specifier.startsWith("@zendev-lab/spark-cockpit-") ||
    specifier.startsWith("@zendev-lab/navia-") ||
    specifier.startsWith("spark-cockpit") ||
    specifier.startsWith("spark-daemon") ||
    specifier.startsWith("navia-")
  );
}

function isSparkAppInternalSpecifier(specifier) {
  return (
    specifier === "@zendev-lab/spark-cli" ||
    specifier.startsWith("@zendev-lab/spark-cli/") ||
    specifier === "@zendev-lab/spark-tui-app" ||
    specifier.startsWith("@zendev-lab/spark-tui-app/") ||
    specifier.includes("apps/spark-tui/src/host/") ||
    specifier.includes("apps/spark-cli/") ||
    specifier.includes("apps/spark-tui/") ||
    specifier.includes("../spark-tui/src/host/") ||
    specifier.includes("../../spark-tui/src/host/") ||
    specifier.includes("../spark-cli/") ||
    specifier.includes("../../spark-cli/") ||
    specifier.includes("../spark-tui/") ||
    specifier.includes("../../spark-tui/")
  );
}

async function checkActiveDocumentation() {
  for (const relativePath of await listActiveDocumentationFiles()) {
    const path = join(root, relativePath);
    const content = await readFile(path, "utf8");
    const lines = content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (retiredNaviaWebPattern.test(line)) {
        violations.push(
          `${relativePath}:${index + 1}: retired Navia web package/path name in active documentation`,
        );
      }
      if (legacyNaviaPackagePattern.test(line) && !intentionalLegacyNaviaLinePattern.test(line)) {
        violations.push(
          `${relativePath}:${index + 1}: legacy navia-* package name must be marked as legacy/migration/historical context`,
        );
      }
    });
  }
}

async function listActiveDocumentationFiles() {
  const files = [];
  await appendMarkdownFiles(files, "");
  await appendMarkdownFiles(files, "docs");
  return files.filter((path) => !skippedActiveDocumentationPattern.test(path));
}

async function appendMarkdownFiles(files, relativeDir) {
  let entries;
  try {
    entries = await readdir(join(root, relativeDir), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    files.push(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
  }
}

function formatPath(path) {
  return relative(root, path);
}
