#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = (
  process.env.SPARK_DOC_TERMINOLOGY_ROOT ??
  process.env.SPARK_BOUNDARY_ROOT ??
  new URL("..", import.meta.url).pathname
).replace(/\/$/u, "");

const violations = [];
const skippedActiveDocumentationPattern = /^docs\/(?:navia\/|spark-daemon-unification\.md$)/u;
const retiredNaviaWebPattern =
  /\b(?:apps\/navia-web|@zendev-lab\/navia-web|navia-web|Navia web)\b/u;
const legacyNaviaPackagePattern = /(?:@zendev-lab\/navia-|packages\/navia-|`navia-)/u;
const intentionalLegacyNaviaLinePattern =
  /\b(?:legacy|legacy-named|historical|migration|transition|retired|archived|former)\b/iu;

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

if (violations.length > 0) {
  console.error("documentation terminology violation");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
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
