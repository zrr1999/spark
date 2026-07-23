import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const architecture = readJson(join(root, "architecture/packages.json"));
const maxProductionFileLines = 4_000;
const frozenCompatibilityExtensions = new Set([
  "./packages/spark-ask/src/extension-entry.ts",
  "./packages/spark-artifacts/src/extension-entry.ts",
  "./packages/spark-cue/src/extension/index.ts",
  "./packages/spark-files/src/extension-entry.ts",
  "./packages/spark-ai/src/models-extension.ts",
  "./packages/spark-roles/src/extension-entry.ts",
  "./packages/spark-session/src/extension-entry.ts",
  "./packages/spark-memory/src/extension-entry.ts",
  "./packages/spark-web/src/extension-entry.ts",
  "./packages/spark-workflows/src/extension-entry.ts",
  "./packages/spark-ai/src/baidu-oneapi-provider.ts",
  "./packages/spark-extension/src/extension/index.ts",
]);
const validLayers = new Set([
  "adapter",
  "application",
  "capability",
  "client",
  "compatibility",
  "composition",
  "contract",
  "experiment",
  "foundation",
  "private-adapter",
  "runtime",
]);
const validStabilities = new Set(["experimental", "frozen", "internal", "private", "supported"]);
const validStateWriters = new Set([
  "cockpit",
  "daemon",
  "external",
  "host",
  "none",
  "user",
  "workspace",
]);

const failures = [];
const workspacePackages = ["apps", "packages"].flatMap((workspaceDir) =>
  readdirSync(join(root, workspaceDir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => isFile(join(root, workspaceDir, entry.name, "package.json")))
    .map((entry) => {
      const path = `${workspaceDir}/${entry.name}`;
      return { path, manifest: readJson(join(root, path, "package.json")) };
    }),
);
const workspaceByName = new Map(
  workspacePackages.map((workspacePackage) => [workspacePackage.manifest.name, workspacePackage]),
);
const declaredPackages = architecture.packages ?? {};

if (workspacePackages.length > architecture.maxWorkspacePackages) {
  failures.push(
    `workspace package count grew to ${workspacePackages.length}; the package budget is ${architecture.maxWorkspacePackages}. Consolidate an owner boundary before adding another workspace.`,
  );
}

for (const { path, manifest } of workspacePackages) {
  const declaration = declaredPackages[manifest.name];
  if (!declaration) {
    failures.push(`${path} (${manifest.name}) is missing from architecture/packages.json.`);
    continue;
  }
  if (declaration.path !== path) {
    failures.push(
      `${manifest.name} is declared at ${declaration.path}, but its manifest is at ${path}.`,
    );
  }
  if (!validLayers.has(declaration.layer)) {
    failures.push(`${manifest.name} has invalid architecture layer ${declaration.layer}.`);
  }
  if (!declaration.owner?.trim()) {
    failures.push(`${manifest.name} must declare a non-empty architecture owner.`);
  }
  if (!validStabilities.has(declaration.stability)) {
    failures.push(`${manifest.name} has invalid stability ${declaration.stability}.`);
  }
  if (!validStateWriters.has(declaration.stateWriter)) {
    failures.push(`${manifest.name} has invalid stateWriter ${declaration.stateWriter}.`);
  }
  if (manifest.private !== true) {
    failures.push(
      `${manifest.name} must remain private; @zendev-lab/spark is the only published product.`,
    );
  }

  const declaredRuntimeDependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const workspaceRuntimeDependencies = [...declaredRuntimeDependencies].filter((dependency) =>
    workspaceByName.has(dependency),
  );
  if (declaration.allowedWorkspaceDependencies) {
    const allowed = new Set(declaration.allowedWorkspaceDependencies);
    for (const dependency of workspaceRuntimeDependencies) {
      if (!allowed.has(dependency)) {
        failures.push(
          `${manifest.name} may depend only on [${[...allowed].join(", ")}], but declares ${dependency}.`,
        );
      }
    }
  }

  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target !== "string" || !target.startsWith("./")) continue;
    if (!isFile(join(root, path, target))) {
      failures.push(`${manifest.name} export ${subpath} points to missing file ${target}.`);
    }
  }

  visit(join(root, path), (sourcePath) => {
    if (!isProductionSource(sourcePath)) return;
    const source = readFileSync(sourcePath, "utf8");
    const lines = source.split(/\r?\n/u).length;
    if (lines > maxProductionFileLines) {
      failures.push(
        `${relative(root, sourcePath)} has ${lines} lines; the production-file ceiling is ${maxProductionFileLines}. Split it at a domain or adapter boundary.`,
      );
    }
    for (const importedPackage of workspaceImports(source)) {
      if (importedPackage === manifest.name || !workspaceByName.has(importedPackage)) continue;
      if (!declaredRuntimeDependencies.has(importedPackage)) {
        failures.push(
          `${relative(root, sourcePath)} imports ${importedPackage}, but ${manifest.name} does not declare it as a runtime dependency.`,
        );
      }
    }
  });
}

for (const [name, declaration] of Object.entries(declaredPackages)) {
  const workspacePackage = workspaceByName.get(name);
  if (!workspacePackage) {
    failures.push(
      `architecture/packages.json declares removed or missing package ${name} at ${declaration.path}.`,
    );
  }
}

const rootPackage = readJson(join(root, "package.json"));
const compatibilityExtensions = Array.isArray(rootPackage.pi?.extensions)
  ? rootPackage.pi.extensions
  : [];
for (const extension of compatibilityExtensions) {
  if (!frozenCompatibilityExtensions.has(extension)) {
    failures.push(
      `Compatibility loader extension surface grew: ${extension}. New capabilities must target Spark-native hosts.`,
    );
  }
}

const tsconfig = readJson(join(root, "tsconfig.base.json"));
for (const [specifier, targets] of Object.entries(tsconfig.compilerOptions?.paths ?? {})) {
  if (
    specifier.includes("pi-extension") ||
    (Array.isArray(targets) && targets.some((target) => target.includes("packages/pi-extension/")))
  ) {
    failures.push(
      `Retired pi-extension facade remains in tsconfig path mapping ${specifier}. Legacy config migration must not recreate a source workspace alias.`,
    );
  }
}

for (const { path, manifest } of workspacePackages) {
  if (path !== "apps/spark-daemon" && manifest.scripts?.check === "vp check --no-fmt --no-lint .") {
    failures.push(
      `${path} duplicates the root typecheck with a boilerplate check script. Keep workspace scripts only when they add package-local validation.`,
    );
  }
  if (manifest.scripts?.["test:mutation"] === "stryker run") {
    failures.push(
      `${path} duplicates the root mutation runner. Invoke the package's Stryker config through scripts/run-leaf-mutation.mjs instead.`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    ["Architecture ratchet failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    `Architecture ratchet passed (${workspacePackages.length}/${architecture.maxWorkspacePackages} workspaces classified; production imports declared; production files <= ${maxProductionFileLines} lines; compatibility surface frozen).`,
  );
}

function workspaceImports(source) {
  const imports = new Set();
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](@zendev-lab\/[^/"']+)(?:\/[^"']*)?["']/gu;
  for (const match of source.matchAll(pattern)) imports.add(match[1]);
  return imports;
}

function visit(directory, inspect) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", ".svelte-kit", "coverage"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path, inspect);
    else if (entry.isFile()) inspect(path);
  }
}

function isProductionSource(path) {
  if (![".js", ".mjs", ".svelte", ".ts", ".tsx"].includes(extname(path))) return false;
  const normalized = path.replaceAll("\\", "/");
  if (/\.(?:test|spec)\.[^.]+$/u.test(normalized)) return false;
  if (normalized.includes("/src/paraglide/")) return false;
  return !normalized.includes("/test/");
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
