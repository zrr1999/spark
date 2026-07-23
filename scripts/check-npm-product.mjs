#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = process.cwd();
const productDirectory = resolve(root, "dist/npm-package");
const productManifestPath = resolve(productDirectory, "package.json");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(join(directory, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const failures = [];
if (rootManifest.private !== true) failures.push("source monorepo root must remain private");
for (const workspaceRoot of ["apps", "packages"]) {
  for (const entry of await readdir(resolve(root, workspaceRoot), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, workspaceRoot, entry.name, "package.json");
    const workspace = JSON.parse(await readFile(manifestPath, "utf8"));
    if (workspace.private !== true)
      failures.push(`${workspace.name}: source workspace must be private`);
    if (workspace.publishConfig !== undefined) {
      failures.push(`${workspace.name}: source workspace must not declare publishConfig`);
    }
  }
}
for (const [name, script] of Object.entries({
  "build:npm-product": "node scripts/build-npm-product.mjs",
  "check:npm-product": "node scripts/check-npm-product.mjs",
  "test:npm-product": "node scripts/smoke-npm-product.mjs",
  "publish:npm-product":
    "pnpm publish dist/npm-package --access public --registry=https://registry.npmjs.org/",
  publish: "pnpm run check && pnpm run test:npm-product && pnpm run publish:npm-product",
})) {
  if (rootManifest.scripts?.[name] !== script) failures.push(`${name} must be ${script}`);
}

if (await exists(productManifestPath)) {
  const manifest = JSON.parse(await readFile(productManifestPath, "utf8"));
  if (manifest.name !== "@zendev-lab/spark")
    failures.push("product name must be @zendev-lab/spark");
  if (manifest.private === true) failures.push("generated npm product must be publishable");
  if (manifest.bin?.spark !== "./bin/spark") failures.push("product must expose one spark bin");
  if (
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig?.registry !== "https://registry.npmjs.org/"
  ) {
    failures.push("product publishConfig must target the public npm registry");
  }
  for (const field of ["keywords", "repository", "homepage", "bugs"]) {
    if (rootManifest[field] !== undefined && manifest[field] === undefined) {
      failures.push(`product must retain root ${field} metadata`);
    }
  }
  for (const asset of [
    "bin/spark",
    "dist/spark-cli.js",
    "dist/spark-tui.js",
    "dist/spark-daemon.js",
    "dist/spark-headless-role-executor.js",
    "dist/migrations/0001_initial.sql",
    "build/handler.js",
  ]) {
    if (!(await exists(resolve(productDirectory, asset))))
      failures.push(`missing product asset: ${asset}`);
  }
  const sourceMaps = await (async function countSourceMaps(directory) {
    let count = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) count += await countSourceMaps(path);
      else if (entry.isFile() && entry.name.endsWith(".map")) count += 1;
    }
    return count;
  })(productDirectory);
  if (sourceMaps > 0)
    failures.push(`product must omit runtime-unneeded source maps (found ${sourceMaps})`);
}

if (failures.length) {
  throw new Error(`Invalid npm product:\n- ${failures.join("\n- ")}`);
}
if (await exists(productManifestPath)) {
  const bytes = (await stat(productManifestPath)).size;
  console.log(
    `Npm product policy valid (${await countFiles(productDirectory)} files; manifest ${bytes} bytes).`,
  );
} else {
  console.log("Npm product policy valid.");
}
