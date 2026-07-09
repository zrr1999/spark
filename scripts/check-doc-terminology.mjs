#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = (
  process.env.SPARK_DOC_TERMINOLOGY_ROOT ??
  process.env.SPARK_BOUNDARY_ROOT ??
  new URL("..", import.meta.url).pathname
).replace(/\/$/u, "");

const retiredProduct = ["na", "via"].join("");
const retiredProductPattern = new RegExp(
  `\\b(?:${retiredProduct}|${retiredProduct}-[\\w-]*|@zendev-lab/${retiredProduct}-[\\w-]*|packages/${retiredProduct}-[\\w-]*)\\b`,
  "iu",
);
const violations = [];
const skippedActiveDocumentationPattern = /^docs\/archive\//u;

for (const relativePath of await listActiveDocumentationFiles()) {
  const path = join(root, relativePath);
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (retiredProductPattern.test(line)) {
      violations.push(
        `${relativePath}:${index + 1}: retired product terminology in active documentation`,
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
  await appendRootMarkdownFiles(files);
  await appendMarkdownFiles(files, "docs");
  return files.filter((path) => !skippedActiveDocumentationPattern.test(path));
}

async function appendRootMarkdownFiles(files) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    files.push(entry.name);
  }
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
    const entryPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await appendMarkdownFiles(files, entryPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    files.push(entryPath);
  }
}
