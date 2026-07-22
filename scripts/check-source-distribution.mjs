#!/usr/bin/env node

import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WORKSPACE_ROOTS = ["apps", "packages"];

export async function readSourceWorkspaces(root = process.cwd()) {
  const workspaces = [];
  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const base = resolve(root, workspaceRoot);
    const entries = await readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(base, entry.name);
      const manifestPath = join(directory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      workspaces.push({ directory, manifest, manifestPath });
    }
  }
  return workspaces.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function validateWorkspaceIdentity(workspace, names) {
  const failures = [];
  const { manifest } = workspace;
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    failures.push(`${workspace.manifestPath}: package name is required`);
  } else if (names.has(manifest.name)) {
    failures.push(`${manifest.name}: duplicate workspace package name`);
  } else {
    names.add(manifest.name);
  }
  return failures;
}

function validateWorkspaceMetadata(manifest) {
  const failures = [];
  if (manifest.private !== true) {
    failures.push(`${manifest.name}: source-distributed workspace must be private`);
  }
  if (manifest.publishConfig !== undefined) {
    failures.push(`${manifest.name}: source-distributed workspace must not declare publishConfig`);
  }
  return failures;
}

function binTargets(manifest) {
  return Object.values(
    typeof manifest.bin === "string" ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {}),
  );
}

async function validateBinTarget(workspace, target, requireBuiltBins) {
  const { manifest } = workspace;
  if (typeof target !== "string") return `${manifest.name}: bin targets must be strings`;

  try {
    await access(resolve(dirname(workspace.manifestPath), target));
    return undefined;
  } catch {
    const buildScript = manifest.scripts?.build;
    const canBeBuilt = typeof buildScript === "string" && buildScript.trim().length > 0;
    return requireBuiltBins || !canBeBuilt
      ? `${manifest.name}: bin target does not exist: ${target}`
      : undefined;
  }
}

async function validateWorkspaceBins(workspace, requireBuiltBins) {
  const results = await Promise.all(
    binTargets(workspace.manifest).map((target) =>
      validateBinTarget(workspace, target, requireBuiltBins),
    ),
  );
  return results.filter((failure) => failure !== undefined);
}

function validateRootManifest(rootManifest) {
  const failures = [];

  if (rootManifest.private !== true) failures.push("root workspace must remain private");
  if (rootManifest.publishConfig !== undefined) {
    failures.push("root source distribution must not declare publishConfig");
  }
  if (rootManifest.scripts?.publish !== undefined) {
    failures.push("root publish script must remain absent until compiled registry artifacts exist");
  }
  if (
    rootManifest.scripts?.["test:source-distribution"] !==
    "node scripts/smoke-source-distribution.mjs"
  ) {
    failures.push("root test:source-distribution must run the canonical source smoke");
  }
  return failures;
}

export async function validateSourceDistribution(workspaces, rootManifest, options = {}) {
  const failures = [];
  const names = new Set();
  for (const workspace of workspaces) {
    failures.push(
      ...validateWorkspaceIdentity(workspace, names),
      ...validateWorkspaceMetadata(workspace.manifest),
      ...(await validateWorkspaceBins(workspace, options.requireBuiltBins === true)),
    );
  }
  failures.push(...validateRootManifest(rootManifest));
  return failures;
}

export async function checkSourceDistribution(root = process.cwd(), options = {}) {
  const workspaces = await readSourceWorkspaces(root);
  const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const failures = await validateSourceDistribution(workspaces, rootManifest, options);
  if (failures.length > 0) {
    throw new Error(`Invalid source distribution:\n- ${failures.join("\n- ")}`);
  }
  return { workspaces };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    const { workspaces } = await checkSourceDistribution();
    console.log(`Source distribution valid: ${workspaces.length} private workspaces.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
