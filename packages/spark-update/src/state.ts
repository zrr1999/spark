import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { resolveSparkUserPaths } from "@zendev-lab/spark-system";

import {
  SPARK_UPDATE_STATE_SCHEMA_VERSION,
  type SparkUpdatePaths,
  type SparkUpdateState,
} from "./types.ts";

export function resolveSparkUpdatePaths(
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    prefix?: string;
  } = {},
): SparkUpdatePaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  // Managed deployment is version-independent and XDG-owned. SPARK_HOME is
  // daemon/workspace state and must not silently relocate an installed binary.
  const user = resolveSparkUserPaths({ env: { ...env, SPARK_HOME: undefined }, cwd });
  const prefix = resolve(
    cwd,
    options.prefix ?? env.SPARK_INSTALL_PREFIX ?? join(env.HOME ?? user.root, ".local"),
  );
  const stateDir = resolve(cwd, env.SPARK_MANAGED_STATE_DIR ?? join(user.stateRoot, "update"));
  const cacheDir = resolve(cwd, env.SPARK_MANAGED_CACHE_DIR ?? join(user.cacheRoot, "update"));
  const versionsDir = resolve(
    cwd,
    env.SPARK_MANAGED_VERSIONS_DIR ?? join(user.dataRoot, "versions"),
  );
  const configFile = resolve(
    cwd,
    env.SPARK_MANAGED_CONFIG_FILE ?? join(user.configRoot, "update.toml"),
  );
  const launcherPath =
    options.prefix !== undefined
      ? join(prefix, "bin", "spark")
      : resolve(cwd, env.SPARK_STABLE_LAUNCHER ?? join(prefix, "bin", "spark"));
  return {
    versionsDir,
    currentLink: join(versionsDir, "current"),
    configFile,
    stateDir,
    stateFile: join(stateDir, "state.json"),
    lockFile: join(stateDir, "update.lock"),
    cacheDir,
    stagingDir: join(cacheDir, "staging"),
    launcherPath,
    updaterLaunchAgentPath: join(
      env.HOME ?? user.root,
      "Library",
      "LaunchAgents",
      "dev.spark.updater.plist",
    ),
  };
}

export function emptySparkUpdateState(): SparkUpdateState {
  return {
    schemaVersion: SPARK_UPDATE_STATE_SCHEMA_VERSION,
    quarantined: [],
  };
}

export async function readSparkUpdateState(
  paths: Pick<SparkUpdatePaths, "stateFile">,
): Promise<SparkUpdateState> {
  try {
    const parsed = JSON.parse(await readFile(paths.stateFile, "utf8")) as unknown;
    if (!isSparkUpdateState(parsed)) throw new Error("Unsupported Spark updater state schema");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySparkUpdateState();
    throw error;
  }
}

export async function writeSparkUpdateState(
  paths: Pick<SparkUpdatePaths, "stateFile">,
  state: SparkUpdateState,
): Promise<void> {
  if (!isSparkUpdateState(state)) throw new Error("Refusing to write invalid Spark updater state");
  await mkdir(dirname(paths.stateFile), { recursive: true });
  const temporary = `${paths.stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, paths.stateFile);
}

export async function withSparkUpdateLock<T>(
  paths: Pick<SparkUpdatePaths, "lockFile">,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(paths.lockFile), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await acquireLockFile(paths.lockFile);
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const owner = await readLockOwner(paths.lockFile);
      if (owner && !processIsAlive(owner)) {
        await rm(paths.lockFile, { force: true });
        handle = await acquireLockFile(paths.lockFile);
        await handle.writeFile(`${process.pid}\n`);
      } else {
        throw new Error(`Another Spark update is already running (${paths.lockFile})`);
      }
    } else {
      throw error;
    }
  }
  try {
    return await operation();
  } finally {
    await handle?.close();
    await rm(paths.lockFile, { force: true });
  }
}

export function nextUpdateRetryAt(count: number, now = new Date()): string {
  const backoffMinutes = [30, 120, 360, 1440][Math.min(Math.max(count - 1, 0), 3)]!;
  return new Date(now.getTime() + backoffMinutes * 60_000).toISOString();
}

function isSparkUpdateState(value: unknown): value is SparkUpdateState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SparkUpdateState>;
  return (
    candidate.schemaVersion === 1 &&
    optionalString(candidate.currentVersion) &&
    optionalString(candidate.currentFingerprint) &&
    optionalString(candidate.availableVersion) &&
    optionalString(candidate.pendingVersion) &&
    optionalString(candidate.pendingFingerprint) &&
    optionalString(candidate.lastGoodVersion) &&
    optionalString(candidate.lastGoodFingerprint) &&
    optionalString(candidate.rollbackVersion) &&
    optionalString(candidate.rollbackFingerprint) &&
    optionalString(candidate.lastCheckAt) &&
    optionalString(candidate.registryEtag) &&
    optionalString(candidate.lastAvailableNotifiedVersion) &&
    optionalString(candidate.lastAvailableNotifiedAt) &&
    Array.isArray(candidate.quarantined) &&
    candidate.quarantined.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.version === "string" &&
        typeof entry.reason === "string" &&
        typeof entry.quarantinedAt === "string",
    ) &&
    (candidate.failure === undefined ||
      (typeof candidate.failure.code === "string" &&
        typeof candidate.failure.message === "string" &&
        Number.isInteger(candidate.failure.count) &&
        candidate.failure.count > 0 &&
        typeof candidate.failure.firstAt === "string" &&
        typeof candidate.failure.lastAt === "string" &&
        typeof candidate.failure.nextRetryAt === "string" &&
        optionalString(candidate.failure.version) &&
        optionalString(candidate.failure.lastLoggedAt) &&
        optionalString(candidate.failure.lastNotifiedAt)))
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

async function acquireLockFile(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  return await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
}

async function readLockOwner(path: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
