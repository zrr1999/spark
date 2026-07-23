import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const maxWorkspacePackages = 48;
const maxProductionFileLines = 4_000;
const frozenPiExtensions = new Set([
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
  "./packages/pi-extension/src/extension/index.ts",
]);

const failures = [];
const workspacePackages = ["apps", "packages"].flatMap((workspaceDir) =>
  readdirSync(join(root, workspaceDir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => isFile(join(root, workspaceDir, entry.name, "package.json")))
    .map((entry) => `${workspaceDir}/${entry.name}`),
);
if (workspacePackages.length > maxWorkspacePackages) {
  failures.push(
    `workspace package count grew to ${workspacePackages.length}; the ratchet permits at most ${maxWorkspacePackages}. Consolidate an owner boundary or update this limit with an architecture rationale.`,
  );
}

const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const piExtensions = Array.isArray(rootPackage.pi?.extensions) ? rootPackage.pi.extensions : [];
for (const extension of piExtensions) {
  if (!frozenPiExtensions.has(extension)) {
    failures.push(
      `Pi product extension surface grew: ${extension}. New capabilities must target Spark-native hosts.`,
    );
  }
}

for (const workspacePackage of workspacePackages) {
  visit(join(root, workspacePackage), (path) => {
    if (!isProductionSource(path)) return;
    const lines = readFileSync(path, "utf8").split(/\r?\n/u).length;
    if (lines > maxProductionFileLines) {
      failures.push(
        `${relative(root, path)} has ${lines} lines; the production-file ceiling is ${maxProductionFileLines}. Split it at a domain or adapter boundary.`,
      );
    }
  });
}

if (failures.length > 0) {
  console.error(
    ["Architecture ratchet failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    `Architecture ratchet passed (${workspacePackages.length}/${maxWorkspacePackages} workspaces; production files <= ${maxProductionFileLines} lines; Pi surface frozen).`,
  );
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
