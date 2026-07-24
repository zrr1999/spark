#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productDirectory = resolve(root, "dist/npm-package");
const releaseDirectory = resolve(root, "dist/release");
const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });
await execFileAsync("node", ["scripts/build-npm-product.mjs"], {
  cwd: root,
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
});
const packedResult = await execFileAsync(
  "npm",
  ["pack", "--json", "--pack-destination", releaseDirectory],
  {
    cwd: productDirectory,
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    maxBuffer: 64 * 1024 * 1024,
  },
);
const packedMetadata = JSON.parse(packedResult.stdout)[0];
if (
  packedMetadata?.name !== "@zendev-lab/spark" ||
  packedMetadata?.version !== rootManifest.version
) {
  throw new Error(
    `Packed the wrong manifest: ${packedMetadata?.name ?? "unknown"}@${packedMetadata?.version ?? "unknown"}`,
  );
}

const tarballs = (await readdir(releaseDirectory)).filter((name) => name.endsWith(".tgz"));
if (tarballs.length !== 1) {
  throw new Error(`Expected one release tarball, found ${tarballs.length}`);
}
const packedAssetName = tarballs[0];
if (packedMetadata.filename !== packedAssetName) {
  throw new Error(
    `npm reported ${packedMetadata.filename}, but release contains ${packedAssetName}`,
  );
}
const assetName = `spark-v${rootManifest.version}.tgz`;
await rename(resolve(releaseDirectory, packedAssetName), resolve(releaseDirectory, assetName));
const tarball = await readFile(resolve(releaseDirectory, assetName));
const buildInfo = JSON.parse(
  await readFile(resolve(productDirectory, "dist/build-info.json"), "utf8"),
);
const assetSha256 = createHash("sha256").update(tarball).digest("hex");
const npmIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
if (packedMetadata.integrity !== npmIntegrity) {
  throw new Error(
    `npm pack integrity ${packedMetadata.integrity ?? "missing"} does not match ${npmIntegrity}`,
  );
}
const prerelease = rootManifest.version.includes("-");
const manifest = {
  schemaVersion: 1,
  packageName: "@zendev-lab/spark",
  version: rootManifest.version,
  npmTag: prerelease ? "next" : "latest",
  npmIntegrity,
  assetName,
  assetSha256,
  gitSha: buildInfo.gitSha,
  buildFingerprint: buildInfo.fingerprint,
  minimumUpdaterVersion: rootManifest.sparkRelease.minimumUpdaterVersion,
  rollbackCompatibility: rootManifest.sparkRelease.rollbackCompatibility,
  migrationMode: rootManifest.sparkRelease.migrationMode,
};
await writeFile(
  resolve(releaseDirectory, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(resolve(releaseDirectory, "SHA256SUMS"), `${assetSha256}  ${assetName}\n`);
console.log(JSON.stringify(manifest));
