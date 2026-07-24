#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = resolve(root, "dist/release");
const artifactOnly = process.argv.includes("--artifact-only");
const rootManifest = await readJson(resolve(root, "package.json"));
const releaseManifest = await readJson(resolve(releaseDirectory, "release-manifest.json"));
const expectedTag = `v${rootManifest.version}`;
const tag = process.env.GITHUB_REF_NAME?.trim() || expectedTag;
const expectedAssetName = `spark-${expectedTag}.tgz`;
const gitSha = process.env.GITHUB_SHA?.trim();

assertEqual(tag, expectedTag, "Git tag");
assertEqual(releaseManifest.packageName, "@zendev-lab/spark", "release package");
assertEqual(releaseManifest.version, rootManifest.version, "release version");
assertEqual(releaseManifest.assetName, expectedAssetName, "release asset name");
assertEqual(
  releaseManifest.npmTag,
  rootManifest.version.includes("-") ? "next" : "latest",
  "npm distribution tag",
);
if (gitSha) assertEqual(releaseManifest.gitSha, gitSha, "release Git SHA");

const artifact = await readFile(resolve(releaseDirectory, releaseManifest.assetName));
const assetSha256 = createHash("sha256").update(artifact).digest("hex");
const npmIntegrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
assertEqual(releaseManifest.assetSha256, assetSha256, "release asset SHA256");
assertEqual(releaseManifest.npmIntegrity, npmIntegrity, "release npm integrity");

if (artifactOnly) {
  console.log(`Verified ${releaseManifest.assetName} for ${expectedTag}.`);
  process.exit(0);
}

const npmPublished = await verifyNpmState(releaseManifest);
const githubRelease = await findGithubRelease(tag);
const githubPublished = githubRelease !== null && githubRelease.draft !== true;

if (githubPublished && !npmPublished) {
  throw new Error(`GitHub Release ${tag} is published, but npm has no matching version.`);
}
if (githubPublished) {
  await verifyGithubAsset(githubRelease, releaseManifest);
  assertEqual(
    githubRelease.prerelease === true,
    rootManifest.version.includes("-"),
    "GitHub prerelease state",
  );
}

await writeOutputs({
  github_published: githubPublished,
  github_release_exists: githubRelease !== null,
  npm_published: npmPublished,
});
console.log(
  JSON.stringify({
    tag,
    npmPublished,
    githubReleaseExists: githubRelease !== null,
    githubPublished,
  }),
);

async function verifyNpmState(manifest) {
  const packagePath = encodeURIComponent(manifest.packageName);
  const versionPath = encodeURIComponent(manifest.version);
  const response = await fetch(`https://registry.npmjs.org/${packagePath}/${versionPath}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${manifest.packageName}.`);
  }
  const metadata = await response.json();
  assertEqual(metadata?.dist?.integrity, manifest.npmIntegrity, "published npm integrity");
  return true;
}

async function findGithubRelease(releaseTag) {
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  if (!repository) throw new Error("GITHUB_REPOSITORY is required to inspect release state.");
  const response = await githubFetch(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
  );
  if (!response.ok) {
    throw new Error(`GitHub Releases API returned ${response.status} for ${repository}.`);
  }
  const releases = await response.json();
  return releases.find((release) => release.tag_name === releaseTag) ?? null;
}

async function verifyGithubAsset(release, manifest) {
  const releaseAsset = release.assets?.find((asset) => asset.name === manifest.assetName);
  if (!releaseAsset?.url) {
    throw new Error(
      `Published GitHub Release ${release.tag_name} has no ${manifest.assetName} asset.`,
    );
  }
  const response = await githubFetch(releaseAsset.url, {
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error(`GitHub release asset download returned ${response.status}.`);
  }
  const publishedArtifact = Buffer.from(await response.arrayBuffer());
  const publishedSha256 = createHash("sha256").update(publishedArtifact).digest("hex");
  assertEqual(publishedSha256, manifest.assetSha256, "published GitHub asset SHA256");
}

async function githubFetch(url, options = {}) {
  const token = process.env.GITHUB_TOKEN?.trim();
  return await fetch(url, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
}

async function writeOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (!outputPath) return;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}\n`);
  await appendFile(outputPath, lines.join(""));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
