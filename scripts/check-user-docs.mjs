#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
  process.env.SPARK_USER_DOCS_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url))),
);
const docsRoot = join(root, "apps/spark-docs/src/content/docs");
const publicRoot = join(root, "apps/spark-docs/public");
const checkDist = process.argv.includes("--dist");
const failures = [];

const pages = (await listContentFiles(docsRoot)).toSorted();
const pageSet = new Set(pages);
const requiredPages = [
  "index.md",
  "getting-started.md",
  "concepts/surfaces.md",
  "guides/runs-and-sessions.md",
  "guides/side-threads.md",
  "guides/cockpit.md",
  "reference/configuration-and-paths.md",
  "reference/cli.md",
  "troubleshooting.md",
];

for (const page of requiredPages) {
  if (!pageSet.has(page)) failures.push(`missing English page: ${page}`);
  if (!pageSet.has(`zh/${page}`)) failures.push(`missing Chinese page: zh/${page}`);
}

for (const page of pages) {
  const counterpart = page.startsWith("zh/") ? page.slice(3) : `zh/${page}`;
  if (!pageSet.has(counterpart)) failures.push(`${page} has no locale counterpart`);

  const source = await readFile(join(docsRoot, page), "utf8");
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---/u)?.[1];
  if (!frontmatter) {
    failures.push(`${page} has no frontmatter`);
  } else {
    if (!/^title:\s+\S+/mu.test(frontmatter)) failures.push(`${page} has no title`);
    if (!/^description:\s+\S+/mu.test(frontmatter)) failures.push(`${page} has no description`);
  }
}

const routes = new Set(pages.map(routeForPage));
const publicFiles = new Set(await listPublicFiles(publicRoot));
for (const page of pages) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const target of internalTargets(source)) {
    const pathname = normalizeTarget(target);
    if (publicFiles.has(pathname.slice(1))) continue;
    if (!routes.has(pathname)) failures.push(`${page} links to missing route ${pathname}`);
  }
}

const help = spawnSync(join(root, "apps/spark-cli/bin/spark"), ["--help"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, FORCE_COLOR: "0" },
});
if (help.status !== 0) {
  const reason = help.stderr.trim() || `exit ${help.status}`;
  failures.push(`spark --help failed: ${reason}`);
} else {
  const requiredHelpLines = [
    "spark run [--json] [--wait] [--resume <session>] <prompt>",
    "spark bg [--session <id>] [--json] <prompt>",
    "spark paths [--json]",
    "spark doctor",
    "spark install --managed [--version <version>] [--prefix <path>]",
    "spark update status|check|apply|rollback|retry|configure",
    "spark version [--json]",
    "spark daemon <command> [args...]",
    "spark cockpit [command] [args...]",
  ];
  for (const line of requiredHelpLines) {
    if (!help.stdout.includes(line)) failures.push(`spark --help no longer exposes: ${line}`);
  }
}

for (const page of ["reference/cli.md", "zh/reference/cli.md"]) {
  const source = await readFile(join(docsRoot, page), "utf8");
  for (const command of [
    "spark run",
    "spark bg",
    "spark paths",
    "spark doctor",
    "spark install --managed",
    "spark update",
    "spark version",
    "spark daemon",
    "spark cockpit",
  ]) {
    if (!source.includes(command)) failures.push(`${page} does not document ${command}`);
  }
}

if (checkDist) {
  const distRoot = join(root, "apps/spark-docs/dist");
  for (const output of [
    "index.html",
    "zh/index.html",
    "getting-started/index.html",
    "zh/getting-started/index.html",
    "404.html",
    "pagefind/pagefind.js",
    "sitemap-index.xml",
  ]) {
    if (!(await isFile(join(distRoot, output)))) failures.push(`missing build output: ${output}`);
  }
}

if (failures.length > 0) {
  console.error(
    ["Spark user docs check failed:", ...failures.map((item) => `- ${item}`)].join("\n"),
  );
  process.exit(1);
}

console.log(
  `Spark user docs check passed (${pages.length / 2} English/Chinese route pairs${
    checkDist ? "; static output verified" : ""
  }).`,
);

async function listContentFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listContentFiles(entryPath)));
      continue;
    }
    if (!entry.isFile() || ![".md", ".mdx"].includes(extname(entry.name))) continue;
    files.push(relative(docsRoot, entryPath).split(sep).join("/"));
  }
  return files;
}

async function listPublicFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listPublicFiles(entryPath)));
      continue;
    }
    if (entry.isFile()) files.push(relative(publicRoot, entryPath).split(sep).join("/"));
  }
  return files;
}

function routeForPage(page) {
  const withoutExtension = page.slice(0, -extname(page).length);
  const withoutIndex =
    withoutExtension === "index" ? "" : withoutExtension.replace(/\/index$/u, "");
  return `/${withoutIndex}${withoutIndex ? "/" : ""}`;
}

function internalTargets(source) {
  const targets = [];
  for (const match of source.matchAll(/\]\((\/[^)\s?#]*)(?:[?#][^)]*)?\)/gu)) {
    targets.push(match[1]);
  }
  for (const match of source.matchAll(
    /\b(?:href|link):?\s*=\s*["'](\/[^"'?#]*)(?:[?#][^"']*)?["']/gu,
  )) {
    targets.push(match[1]);
  }
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("link:")) continue;
    const rawTarget = trimmed.slice("link:".length).trim();
    if (!rawTarget.startsWith("/")) continue;
    const suffixIndex = rawTarget.search(/[\s?#]/u);
    targets.push(suffixIndex === -1 ? rawTarget : rawTarget.slice(0, suffixIndex));
  }
  return targets;
}

function normalizeTarget(target) {
  if (target === "/") return target;
  return target.endsWith("/") ? target : `${target}/`;
}

async function isFile(path) {
  try {
    const handle = await import("node:fs/promises");
    return (await handle.stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
