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

export async function validateSourceDistribution(workspaces, rootManifest, options = {}) {
  const failures = [];
  const names = new Set();
  for (const workspace of workspaces) {
    const { manifest } = workspace;
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      failures.push(`${workspace.manifestPath}: package name is required`);
    } else if (names.has(manifest.name)) {
      failures.push(`${manifest.name}: duplicate workspace package name`);
    } else {
      names.add(manifest.name);
    }
    if (manifest.private !== true) {
      failures.push(`${manifest.name}: source-distributed workspace must be private`);
    }
    if (manifest.publishConfig !== undefined) {
      failures.push(
        `${manifest.name}: source-distributed workspace must not declare publishConfig`,
      );
    }
    const bins =
      typeof manifest.bin === "string" ? { [manifest.name]: manifest.bin } : manifest.bin;
    for (const target of Object.values(bins ?? {})) {
      if (typeof target !== "string") {
        failures.push(`${manifest.name}: bin targets must be strings`);
        continue;
      }
      try {
        await access(resolve(dirname(workspace.manifestPath), target));
      } catch {
        const buildScript = manifest.scripts?.build;
        if (options.requireBuiltBins || typeof buildScript !== "string" || !buildScript.trim()) {
          failures.push(`${manifest.name}: bin target does not exist: ${target}`);
        }
      }
    }
  }

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
