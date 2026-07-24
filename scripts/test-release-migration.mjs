#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const tarballIndex = process.argv.indexOf("--tarball");
const candidateTarball = process.argv[tarballIndex + 1];
if (tarballIndex < 0 || !candidateTarball) {
  throw new Error("Usage: test-release-migration.mjs --tarball <candidate.tgz>");
}
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const currentVersion = manifest.version;
const versionsResult = await runOptional("npm", [
  "view",
  "@zendev-lab/spark",
  "versions",
  "--json",
]);
if (!versionsResult) {
  console.log("No published Spark version exists; N-1 migration gate is not applicable.");
  process.exit(0);
}
const published = JSON.parse(versionsResult.stdout);
const versions = (Array.isArray(published) ? published : [published])
  .filter((value) => typeof value === "string" && !value.includes("-"))
  .filter((value) => compareVersions(value, currentVersion) < 0)
  .sort(compareVersions);
const previousVersion = versions.at(-1);
if (!previousVersion) {
  console.log("No earlier stable Spark version exists; N-1 migration gate is not applicable.");
  process.exit(0);
}

const temporary = await mkdtemp(join(tmpdir(), "spark-migration-gate-"));
await chmod(temporary, 0o700);
try {
  const previousRoot = join(temporary, "previous");
  const candidateRoot = join(temporary, "candidate");
  const sparkHome = join(temporary, "spark-home");
  await Promise.all([mkdir(previousRoot), mkdir(candidateRoot)]);
  await install(previousRoot, `@zendev-lab/spark@${previousVersion}`);
  await install(candidateRoot, resolve(root, candidateTarball));
  const previousSpark = join(previousRoot, "node_modules", ".bin", "spark");
  const candidateSpark = join(candidateRoot, "node_modules", ".bin", "spark");
  const env = { ...process.env, SPARK_HOME: sparkHome };

  await daemonCycle(previousSpark, env, "N-1 baseline");
  await daemonCycle(candidateSpark, env, "candidate migration");
  await daemonCycle(previousSpark, env, "N-1 compatibility");
  console.log(
    `N-1 migration gate passed: ${previousVersion} -> ${currentVersion} -> ${previousVersion}.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function install(prefix, specifier) {
  await run("npm", [
    "install",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--omit=dev",
    "--no-package-lock",
    "--no-save",
    specifier,
  ]);
}

async function daemonCycle(spark, env, label) {
  const started = await run(spark, ["daemon", "start", "--json"], { env });
  const result = JSON.parse(started.stdout);
  if (result.daemon?.running !== true) throw new Error(`${label} daemon did not start`);
  await run(spark, ["daemon", "status", "--json"], { env });
  await run(spark, ["daemon", "stop", "--yes"], { env });
}

async function run(command, args, options = {}) {
  return await execFileAsync(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function runOptional(command, args) {
  try {
    return await run(command, args);
  } catch (error) {
    const text = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    if (/E404|is not in this registry/u.test(text)) return null;
    throw error;
  }
}

function compareVersions(left, right) {
  const a = left.split(/[.-]/u).slice(0, 3).map(Number);
  const b = right.split(/[.-]/u).slice(0, 3).map(Number);
  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
}
