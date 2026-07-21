#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = (process.env.SPARK_BOUNDARY_ROOT ?? new URL("..", import.meta.url).pathname).replace(
  /\/$/u,
  "",
);
const sourceFilePattern = /(?:\.(?:c|m)?(?:t|j)sx?|\.svelte)$/u;
const importSpecifierPattern =
  /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu;

const foundationContractPackages = new Set([
  join(root, "packages", "spark-protocol"),
  join(root, "packages", "spark-core"),
]);
const violations = [];
const piTuiSpecifier = "@earendil-works/pi-tui";
const allowedPiTuiPackageDirs = new Set([
  join(root, "packages", "spark-tui"),
  join(root, "packages", "spark-text"),
]);
const piAllowedSparkFoundationSpecifiers = [
  "@zendev-lab/spark-artifacts",
  "@zendev-lab/spark-core",
  "@zendev-lab/spark-host",
  "@zendev-lab/spark-loop",
  "@zendev-lab/spark-modes",
  "@zendev-lab/spark-tasks",
  "@zendev-lab/spark-workflows",
];

const forbiddenImportRulesByBoundary = {
  pi: [
    {
      reason: "pi-* packages must not depend on Spark product adapter packages",
      matches: isProductAdapterSpecifier,
    },
    {
      reason:
        "pi-* packages may depend only on renamed Spark foundation packages, not Spark product packages",
      matches: (specifier) =>
        isSparkSpecifier(specifier) && !isPiAllowedSparkFoundationSpecifier(specifier),
    },
  ],
  "pi-extension": [
    {
      reason: "pi-extension must use @zendev-lab/spark-text instead of @zendev-lab/spark-tui",
      matches: (specifier) =>
        specifier === "@zendev-lab/spark-tui" || specifier.startsWith("@zendev-lab/spark-tui/"),
    },
    {
      reason:
        "Spark core/runtime packages must not depend on product coordination or app adapter packages",
      matches: isProductAdapterSpecifier,
    },
    {
      reason: "Spark shared packages must not import Spark app host internals",
      matches: isSparkAppInternalSpecifier,
    },
  ],
  "daemon-app": [
    {
      reason:
        "spark-daemon must use @zendev-lab/spark-host/headless-loader instead of @zendev-lab/spark-tui-app",
      matches: (specifier) =>
        specifier === "@zendev-lab/spark-tui-app" ||
        specifier.startsWith("@zendev-lab/spark-tui-app/"),
    },
  ],
  "spark-core": [
    {
      reason: "Spark foundation packages must not import pi-extension policy",
      matches: isPiExtensionSpecifier,
    },
    {
      reason:
        "Spark core/runtime packages must not depend on product coordination or app adapter packages",
      matches: isProductAdapterSpecifier,
    },
    {
      reason: "Spark shared packages must not import Spark app host internals",
      matches: isSparkAppInternalSpecifier,
    },
  ],
  "cockpit-package": [
    {
      reason: "Cockpit packages must not import Spark CLI host internals",
      matches: isSparkAppInternalSpecifier,
    },
  ],
  "cockpit-app": [
    {
      reason: "Cockpit packages must not import Spark CLI host internals",
      matches: isSparkAppInternalSpecifier,
    },
  ],
  "spark-app": [
    {
      reason: "Spark apps must consume workspace packages through declared package exports",
      matches: isWorkspacePackageSourceSpecifier,
    },
  ],
};

for (const packageDir of await listWorkspaceDirs()) {
  const manifest = await readPackageManifest(packageDir);
  if (!manifest) continue;
  const boundary = classifyBoundary(packageDir, manifest);
  if (boundary === "other") continue;
  await checkPackageManifest(packageDir, manifest, boundary);
  if (foundationContractPackages.has(packageDir)) {
    await checkFoundationContractPackage(packageDir, manifest);
  }
  await checkSourceTree(join(packageDir, "src"), boundary);
  await checkSourceTree(join(packageDir, "server"), boundary);
  await checkSourceTree(join(packageDir, "extensions"), boundary);
}
await checkSourceTree(join(root, "test"), "other");

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
  if (pathName === "pi-extension" || packageName === "@zendev-lab/pi-extension") {
    return "pi-extension";
  }
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

async function checkFoundationContractPackage(packageDir, manifest) {
  const packageJsonPath = join(packageDir, "package.json");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const deps = manifest[field];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) {
      if (isSparkAppInternalSpecifier(name) || isProductAdapterSpecifier(name)) {
        violations.push(
          `${formatPath(packageJsonPath)}: ${field}.${name} (foundation contract packages must not depend on product coordination or app adapters)`,
        );
      }
    }
  }
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
            `${formatPath(fullPath)}:${index + 1}: ${specifier} (direct pi-tui imports must go through @zendev-lab/spark-tui)`,
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
  for (const packageDir of allowedPiTuiPackageDirs) {
    if (path === packageDir || path.startsWith(`${packageDir}/`)) return true;
  }
  return false;
}

function forbiddenSpecifierReason(specifier, boundary) {
  const rules = forbiddenImportRulesByBoundary[boundary] ?? [];
  return rules.find((rule) => rule.matches(specifier))?.reason ?? null;
}

function isSparkSpecifier(specifier) {
  if (specifier === "@zendev-lab/spark-tui" || specifier.startsWith("@zendev-lab/spark-tui/")) {
    return false;
  }
  return specifier.startsWith("@zendev-lab/spark") || specifier.startsWith("spark-");
}

function isPiAllowedSparkFoundationSpecifier(specifier) {
  return piAllowedSparkFoundationSpecifiers.some(
    (allowed) => specifier === allowed || specifier.startsWith(`${allowed}/`),
  );
}

function isProductAdapterSpecifier(specifier) {
  return (
    specifier === "@zendev-lab/spark-cockpit" ||
    specifier === "@zendev-lab/spark-daemon" ||
    specifier === "@zendev-lab/spark-coordination" ||
    specifier.startsWith("@zendev-lab/spark-coordination/") ||
    specifier.startsWith("@zendev-lab/spark-cockpit-") ||
    specifier.startsWith("spark-cockpit") ||
    specifier.startsWith("spark-daemon")
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

function isPiExtensionSpecifier(specifier) {
  return (
    specifier === "@zendev-lab/pi-extension" ||
    specifier.startsWith("@zendev-lab/pi-extension/") ||
    /(?:^|\/)pi-extension(?:\/|$)/u.test(specifier)
  );
}

function isWorkspacePackageSourceSpecifier(specifier) {
  return /(?:^|\/)packages\/[^/]+\/src(?:\/|$)/u.test(specifier);
}

function formatPath(path) {
  return relative(root, path);
}
