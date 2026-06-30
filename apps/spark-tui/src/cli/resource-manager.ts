import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { sparkTuiResourceStrings } from "@zendev-lab/spark-i18n/cli";

import {
  defaultSparkConfigPath,
  loadSparkConfig,
  saveSparkConfig,
  type SparkConfig,
} from "../host/config.ts";

export type SparkResourceKind = "extension" | "provider" | "skill" | "prompt-template" | "theme";
export type SparkPackageSourceType = "local" | "git" | "npm";

export interface SparkResourceCommandOptions {
  configPath?: string;
  kind?: SparkResourceKind;
  local?: boolean;
  json?: boolean;
  sparkHome?: string;
  packageRoot?: string;
  commandRunner?: SparkPackageCommandRunner;
}

export interface SparkResourceListEntry {
  kind: SparkResourceKind;
  specifier: string;
  enabled: boolean;
  installed?: boolean;
  installedPath?: string;
  source?: string;
  sourceType?: SparkPackageSourceType;
}

export interface SparkInstalledPackageRecord {
  source: string;
  sourceType: SparkPackageSourceType;
  kind: SparkResourceKind;
  path: string;
  configEntry: string;
  installedAt: string;
  updatedAt: string;
}

export interface SparkPackageManifestFile {
  version: 1;
  packages: SparkInstalledPackageRecord[];
}

export interface SparkResourceCommandResult {
  action: "install" | "remove" | "update" | "list" | "config";
  configPath: string;
  packageRoot: string;
  entries: SparkResourceListEntry[];
  changed: boolean;
  message: string;
}

export type SparkPackageCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
) => Promise<void>;

const MANIFEST_FILE_NAME = "manifest.json";
const NETWORK_TIMEOUT_MS = 120_000;
const STRINGS = sparkTuiResourceStrings();

export async function runSparkResourceCommand(
  action: SparkResourceCommandResult["action"],
  source: string | undefined,
  options: SparkResourceCommandOptions = {},
): Promise<SparkResourceCommandResult> {
  const configPath = options.configPath ?? defaultSparkConfigPath();
  const sparkHome = options.sparkHome ?? dirname(configPath);
  const packageRoot = options.packageRoot ?? join(sparkHome, "packages");
  const config = await loadSparkConfig(configPath);
  const manifest = await loadPackageManifest(packageRoot);
  let changed = false;
  let message = "";

  if (action === "install") {
    if (!source) throw new Error(STRINGS.installRequiresSource);
    const kind = options.kind ?? inferResourceKind(source);
    const record = await installPackageSource(source, kind, {
      cwd: dirname(configPath),
      packageRoot,
      commandRunner: options.commandRunner,
      forceLocal: options.local,
    });
    changed = upsertInstalledPackage(manifest, record);
    changed = addResource(config, kind, record.configEntry) || changed;
    await savePackageManifest(packageRoot, manifest);
    await saveSparkConfig(config, configPath);
    message = changed
      ? STRINGS.installedPackage(kind, source)
      : STRINGS.packageAlreadyInstalled(kind, source);
  } else if (action === "remove") {
    if (!source) throw new Error(STRINGS.removeRequiresSource);
    const kind = options.kind ?? inferResourceKind(source);
    const removedRecords = removeInstalledPackages(manifest, source, kind);
    for (const record of removedRecords) await removeManagedPath(record.path, packageRoot);
    const configChanged = removeResource(config, kind, source, removedRecords);
    changed = removedRecords.length > 0 || configChanged;
    if (changed) {
      await savePackageManifest(packageRoot, manifest);
      await saveSparkConfig(config, configPath);
    }
    message = changed
      ? STRINGS.removedResource(kind, source)
      : STRINGS.resourceWasNotInstalled(kind, source);
  } else if (action === "update") {
    const records = source
      ? manifest.packages.filter((record) => packageRecordMatches(record, source))
      : [...manifest.packages];
    if (source && records.length === 0) {
      message = STRINGS.packageNotInstalled(source);
    } else if (records.length === 0) {
      message = STRINGS.noPackagesInstalled(packageRoot);
    } else {
      for (const record of records) {
        const updated = await installPackageSource(record.source, record.kind, {
          cwd: dirname(configPath),
          packageRoot,
          commandRunner: options.commandRunner,
          forceLocal: record.sourceType === "local",
        });
        upsertInstalledPackage(manifest, { ...updated, installedAt: record.installedAt });
        addResource(config, record.kind, updated.configEntry);
      }
      await savePackageManifest(packageRoot, manifest);
      await saveSparkConfig(config, configPath);
      changed = true;
      message = source ? STRINGS.updatedPackage(source) : STRINGS.updatedPackages(records.length);
    }
  } else if (action === "config") {
    message = STRINGS.configMessage(configPath, packageRoot);
  } else {
    message = STRINGS.configuredAndInstalled;
  }

  return {
    action,
    configPath,
    packageRoot,
    entries: listSparkResources(config, manifest),
    changed,
    message,
  };
}

export function listSparkResources(
  config: SparkConfig,
  manifest: SparkPackageManifestFile = emptyManifest(),
): SparkResourceListEntry[] {
  const installedByEntry = new Map<string, SparkInstalledPackageRecord>();
  for (const record of manifest.packages)
    installedByEntry.set(resourceKey(record.kind, record.configEntry), record);
  const entries: SparkResourceListEntry[] = [
    ...config.extensions.map((specifier) =>
      resourceEntry("extension", specifier, installedByEntry),
    ),
    ...config.providers.map((specifier) => resourceEntry("provider", specifier, installedByEntry)),
    ...(config.skills ?? []).map((specifier) =>
      resourceEntry("skill", specifier, installedByEntry),
    ),
    ...(config.promptTemplates ?? []).map((specifier) =>
      resourceEntry("prompt-template", specifier, installedByEntry),
    ),
    ...(config.themes ?? []).map((specifier) =>
      resourceEntry("theme", specifier, installedByEntry),
    ),
  ];
  const configured = new Set(entries.map((entry) => resourceKey(entry.kind, entry.specifier)));
  for (const record of manifest.packages) {
    const key = resourceKey(record.kind, record.configEntry);
    if (configured.has(key)) continue;
    entries.push({
      kind: record.kind,
      specifier: record.configEntry,
      enabled: false,
      installed: true,
      installedPath: record.path,
      source: record.source,
      sourceType: record.sourceType,
    });
  }
  return entries;
}

export function formatSparkResourceResult(result: SparkResourceCommandResult): string {
  const lines = [result.message];
  if (result.entries.length === 0) {
    lines.push(STRINGS.noResourcesConfigured);
  } else {
    for (const entry of result.entries) {
      const state = entry.enabled ? "configured" : "installed-only";
      const installed = entry.installedPath ? ` -> ${entry.installedPath}` : "";
      const source = entry.source ? ` (source: ${entry.source})` : "";
      lines.push(`- ${entry.kind}: ${entry.specifier} [${state}]${installed}${source}`);
    }
  }
  lines.push(`config: ${result.configPath}`);
  lines.push(`packages: ${result.packageRoot}`);
  return lines.join("\n");
}

async function installPackageSource(
  source: string,
  kind: SparkResourceKind,
  options: {
    cwd: string;
    packageRoot: string;
    commandRunner?: SparkPackageCommandRunner;
    forceLocal?: boolean;
  },
): Promise<SparkInstalledPackageRecord> {
  const parsed = parsePackageSource(source, options.forceLocal);
  const installedAt = new Date().toISOString();
  const destination = join(options.packageRoot, kind, packageDirectoryName(source, parsed.type));
  await mkdir(dirname(destination), { recursive: true });

  if (parsed.type === "local") {
    await installLocalPackage(parsed.path, destination);
  } else if (parsed.type === "git") {
    await installGitPackage(parsed.url, destination, options.commandRunner ?? defaultCommandRunner);
  } else {
    await installNpmPackage(
      parsed.spec,
      destination,
      options.commandRunner ?? defaultCommandRunner,
    );
  }

  return {
    source,
    sourceType: parsed.type,
    kind,
    path: destination,
    configEntry: destination,
    installedAt,
    updatedAt: installedAt,
  };
}

async function installLocalPackage(sourcePath: string, destination: string): Promise<void> {
  const stats = await stat(sourcePath);
  await rm(destination, { recursive: true, force: true });
  if (stats.isDirectory()) {
    await cp(sourcePath, destination, {
      recursive: true,
      force: true,
      filter: (path) => !path.split(/[/\\]/u).includes("node_modules"),
    });
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(sourcePath, destination);
}

async function installGitPackage(
  url: string,
  destination: string,
  commandRunner: SparkPackageCommandRunner,
): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await commandRunner("git", ["clone", "--depth", "1", url, destination], {
    cwd: dirname(destination),
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
}

async function installNpmPackage(
  spec: string,
  destination: string,
  commandRunner: SparkPackageCommandRunner,
): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await writeFile(
    join(destination, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { [npmPackageName(spec)]: spec } }, null, 2)}\n`,
    "utf8",
  );
  await commandRunner("npm", ["install", "--ignore-scripts", "--omit=dev"], {
    cwd: destination,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
}

function parsePackageSource(
  source: string,
  forceLocal = false,
): { type: "local"; path: string } | { type: "git"; url: string } | { type: "npm"; spec: string } {
  if (forceLocal || isLocalSource(source))
    return { type: "local", path: resolveLocalSource(source) };
  if (isGitSource(source)) return { type: "git", url: source.replace(/^git\+/u, "") };
  return { type: "npm", spec: source.startsWith("npm:") ? source.slice(4) : source };
}

function isLocalSource(source: string): boolean {
  return (
    source === "." ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("/") ||
    source.startsWith("~/") ||
    source.startsWith("file://")
  );
}

function isGitSource(source: string): boolean {
  return (
    source.startsWith("git+") ||
    source.endsWith(".git") ||
    /^https?:\/\/[^\s]+\/[^\s]+(?:\.git)?$/u.test(source)
  );
}

function resolveLocalSource(source: string): string {
  if (source.startsWith("file://")) return resolve(new URL(source).pathname);
  if (source === "~") return homedir();
  if (source.startsWith("~/")) return join(homedir(), source.slice(2));
  return isAbsolute(source) ? source : resolve(source);
}

function npmPackageName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("@").slice(0, 2).join("@");
  return spec.split("@")[0] || spec;
}

function packageDirectoryName(source: string, type: SparkPackageSourceType): string {
  const label =
    type === "npm"
      ? npmPackageName(source.replace(/^npm:/u, ""))
      : basename(source.replace(/\.git$/u, ""));
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 8);
  return `${sanitizeName(label || type)}-${hash}`;
}

function sanitizeName(value: string): string {
  return (
    value
      .replace(/^@/u, "")
      .replace(/[^a-z0-9._-]+/giu, "-")
      .replace(/^-+|-+$/gu, "") || "package"
  );
}

function addResource(config: SparkConfig, kind: SparkResourceKind, source: string): boolean {
  const list = resourceList(config, kind);
  if (list.includes(source)) return false;
  list.push(source);
  return true;
}

function removeResource(
  config: SparkConfig,
  kind: SparkResourceKind,
  source: string,
  removedRecords: readonly SparkInstalledPackageRecord[] = [],
): boolean {
  const list = resourceList(config, kind);
  const before = list.length;
  const basenameSource = basename(source);
  const removedEntries = new Set(removedRecords.map((record) => record.configEntry));
  const kept = list.filter(
    (entry) =>
      entry !== source &&
      basename(entry) !== basenameSource &&
      entry !== basenameSource &&
      !removedEntries.has(entry),
  );
  list.splice(0, list.length, ...kept);
  return list.length !== before;
}

function resourceList(config: SparkConfig, kind: SparkResourceKind): string[] {
  switch (kind) {
    case "extension":
      return config.extensions;
    case "provider":
      return config.providers;
    case "skill":
      return (config.skills ??= []);
    case "prompt-template":
      return (config.promptTemplates ??= []);
    case "theme":
      return (config.themes ??= []);
  }
}

function resourceEntry(
  kind: SparkResourceKind,
  specifier: string,
  installedByEntry: ReadonlyMap<string, SparkInstalledPackageRecord>,
): SparkResourceListEntry {
  const installed = installedByEntry.get(resourceKey(kind, specifier));
  return {
    kind,
    specifier,
    enabled: true,
    ...(installed
      ? {
          installed: true,
          installedPath: installed.path,
          source: installed.source,
          sourceType: installed.sourceType,
        }
      : {}),
  };
}

function resourceKey(kind: SparkResourceKind, specifier: string): string {
  return `${kind}\0${specifier}`;
}

async function loadPackageManifest(packageRoot: string): Promise<SparkPackageManifestFile> {
  try {
    const parsed = JSON.parse(
      await readFile(manifestPath(packageRoot), "utf8"),
    ) as SparkPackageManifestFile;
    if (parsed.version === 1 && Array.isArray(parsed.packages)) return parsed;
  } catch {
    // Fresh installs start with an empty package manifest.
  }
  return emptyManifest();
}

async function savePackageManifest(
  packageRoot: string,
  manifest: SparkPackageManifestFile,
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(manifestPath(packageRoot), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function emptyManifest(): SparkPackageManifestFile {
  return { version: 1, packages: [] };
}

function manifestPath(packageRoot: string): string {
  return join(packageRoot, MANIFEST_FILE_NAME);
}

function upsertInstalledPackage(
  manifest: SparkPackageManifestFile,
  record: SparkInstalledPackageRecord,
): boolean {
  const index = manifest.packages.findIndex(
    (entry) => entry.source === record.source || entry.configEntry === record.configEntry,
  );
  if (index >= 0) {
    const previous = manifest.packages[index]!;
    manifest.packages[index] = { ...record, installedAt: previous.installedAt };
    return JSON.stringify(previous) !== JSON.stringify(manifest.packages[index]);
  }
  manifest.packages.push(record);
  return true;
}

function removeInstalledPackages(
  manifest: SparkPackageManifestFile,
  source: string,
  kind: SparkResourceKind,
): SparkInstalledPackageRecord[] {
  const removed: SparkInstalledPackageRecord[] = [];
  const kept: SparkInstalledPackageRecord[] = [];
  for (const record of manifest.packages) {
    if (record.kind === kind && packageRecordMatches(record, source)) removed.push(record);
    else kept.push(record);
  }
  manifest.packages.splice(0, manifest.packages.length, ...kept);
  return removed;
}

function packageRecordMatches(record: SparkInstalledPackageRecord, source: string): boolean {
  const basenameSource = basename(source);
  return (
    record.source === source ||
    record.configEntry === source ||
    record.path === source ||
    basename(record.source) === basenameSource ||
    basename(record.configEntry) === basenameSource ||
    basename(record.path) === basenameSource
  );
}

async function removeManagedPath(path: string, packageRoot: string): Promise<void> {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(packageRoot);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}/`)) return;
  await rm(resolvedPath, { recursive: true, force: true });
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: "ignore" });
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

export function inferResourceKind(source: string): SparkResourceKind {
  const lower = source.toLowerCase();
  const extension = extname(lower);
  if (lower.includes("provider")) return "provider";
  if (lower.includes("skill") || lower.endsWith("skill.md")) return "skill";
  if (lower.includes("prompt") || lower.includes("template")) return "prompt-template";
  if (lower.includes("theme") || extension === ".json") return "theme";
  return "extension";
}
