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
const retiredInvocationPatterns = [
  { pattern: /\bdaemon\.queue\b/iu, label: "daemon.queue RPC" },
  { pattern: /\bspark daemon queue\b/iu, label: "queue CLI command" },
  { pattern: /\btaskFileName\b/u, label: "taskFileName identity" },
  { pattern: /\bSparkDaemonQueue(?:Entry|State)?\b/u, label: "queue identity type" },
  { pattern: /\bfile[- ]queue\b/iu, label: "file-queue execution" },
  {
    pattern: /\bqueue (?:file|directory|folder|worker|entry|identity|state|lifecycle)\b/iu,
    label: "queue-shaped execution terminology",
  },
  {
    pattern:
      /\b(?:inbox|processed|failed)[ /,]+(?:inbox|processed|failed)[ /,]+(?:inbox|processed|failed)\b/iu,
    label: "directory lifecycle states",
  },
];
const invocationQueueTermPattern = /\bqueue\b|legacy-queue|QueueRoot/iu;
const skippedActiveDocumentationPattern = /^docs\/archive\//u;
const violations = [];
const classifiedQueueTerms = [];

for (const relativePath of await listTerminologyFiles()) {
  const path = join(root, relativePath);
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (retiredProductPattern.test(line)) {
      violations.push(
        `${relativePath}:${index + 1}: retired product terminology in active documentation`,
      );
    }

    const classification = invocationQueueClassification(relativePath, lines, index);
    for (const retired of retiredInvocationPatterns) {
      if (!retired.pattern.test(line)) continue;
      if (classification) {
        classifiedQueueTerms.push(`${relativePath}:${index + 1}: ${classification}`);
      } else {
        violations.push(`${relativePath}:${index + 1}: retired ${retired.label}`);
      }
    }

    if (isInvocationAuditPath(relativePath) && invocationQueueTermPattern.test(line)) {
      if (classification) {
        classifiedQueueTerms.push(`${relativePath}:${index + 1}: ${classification}`);
      } else {
        violations.push(`${relativePath}:${index + 1}: unclassified daemon queue terminology`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("documentation terminology violation");
  for (const violation of [...new Set(violations)]) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("invocation terminology report");
const classified = [...new Set(classifiedQueueTerms)].sort((left, right) =>
  left.localeCompare(right),
);
if (classified.length === 0) console.log("- no remaining daemon queue terms");
else for (const row of classified) console.log(`- ${row}`);

function invocationQueueClassification(relativePath, lines, index) {
  if (relativePath.endsWith(".md")) return undefined;
  const context = lines.slice(Math.max(0, index - 4), index + 2).join("\n");
  if (
    relativePath.includes("legacy-queue-migration") ||
    /legacySparkDaemonQueueRoot|migrateLegacyQueueHistory|legacy-queue|queue\.legacy|legacy archive|migration source/iu.test(
      context,
    )
  ) {
    return "legacy archive/migration source";
  }
  if (/internal scheduler/iu.test(context)) return "internal scheduler";
  return undefined;
}

function isInvocationAuditPath(relativePath) {
  return (
    relativePath === "README.md" ||
    relativePath.startsWith("docs/") ||
    relativePath === "apps/spark-daemon/README.md" ||
    relativePath === "apps/spark-tui/README.md" ||
    (relativePath.startsWith("apps/spark-daemon/src/") && !relativePath.endsWith(".test.ts"))
  );
}

async function listTerminologyFiles() {
  const files = [];
  await appendRootMarkdownFiles(files);
  await appendFiles(files, "docs", (path) => path.endsWith(".md"));
  await appendKnownFile(files, "apps/spark-daemon/README.md");
  await appendKnownFile(files, "apps/spark-tui/README.md");
  await appendKnownFile(files, "packages/spark-protocol/README.md");
  await appendKnownFile(files, "packages/spark-i18n/src/cli.ts");
  await appendFiles(files, "packages/spark-protocol/src/fixtures", (path) =>
    path.endsWith(".json"),
  );
  await appendFiles(
    files,
    "apps/spark-daemon/src",
    (path) => path.endsWith(".ts") && !path.endsWith(".test.ts"),
  );
  return [...new Set(files)].filter((path) => !skippedActiveDocumentationPattern.test(path));
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

async function appendKnownFile(files, relativePath) {
  try {
    await readFile(join(root, relativePath), "utf8");
    files.push(relativePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function appendFiles(files, relativeDir, accept) {
  let entries;
  try {
    entries = await readdir(join(root, relativeDir), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await appendFiles(files, entryPath, accept);
      continue;
    }
    if (!entry.isFile() || !accept(entryPath)) continue;
    files.push(entryPath);
  }
}
