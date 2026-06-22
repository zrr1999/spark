import { chmodSync, copyFileSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensurePrivateDir, writePrivateFile, type NaviaPaths } from "@zendev-lab/navia-system";

export interface SparkDaemonLegacyStatePaths {
  configFile: string;
  dataDir: string;
  cacheDir: string;
  stateDir: string;
  runtimeDir: string;
  databasePath: string;
  artifactBlobsDir: string;
  piAgentDir: string;
  pidFile: string;
  socketPath: string;
  lockPath: string;
}

export interface SparkDaemonLegacyStateMigrationResult {
  migratedAt: string;
  copied: string[];
  cleaned: string[];
  skipped: string[];
  legacy: SparkDaemonLegacyStatePaths;
  markerFile: string;
}

export function legacySparkDaemonStatePaths(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): SparkDaemonLegacyStatePaths {
  const home = env.HOME || homedir();
  const configHome = absoluteDir(env.XDG_CONFIG_HOME ?? join(home, ".config"), cwd);
  const dataHome = absoluteDir(env.XDG_DATA_HOME ?? join(home, ".local", "share"), cwd);
  const cacheHome = absoluteDir(env.XDG_CACHE_HOME ?? join(home, ".cache"), cwd);
  const stateHome = absoluteDir(env.XDG_STATE_HOME ?? join(home, ".local", "state"), cwd);
  const configFile = absoluteDir(
    env.NAVIA_RUNNER_CONFIG_FILE ?? join(configHome, "navia", "runner.toml"),
    cwd,
  );
  const dataDir = absoluteDir(env.NAVIA_RUNNER_DATA_DIR ?? join(dataHome, "navia", "runner"), cwd);
  const cacheDir = absoluteDir(
    env.NAVIA_RUNNER_CACHE_DIR ?? join(cacheHome, "navia", "runner"),
    cwd,
  );
  const stateDir = absoluteDir(
    env.NAVIA_RUNNER_STATE_DIR ?? join(stateHome, "navia", "runner"),
    cwd,
  );
  const runtimeDir = absoluteDir(
    env.NAVIA_RUNNER_RUNTIME_DIR ??
      (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "navia", "runner") : join(stateDir, "run")),
    cwd,
  );
  return {
    configFile,
    dataDir,
    cacheDir,
    stateDir,
    runtimeDir,
    databasePath: join(dataDir, "runner.sqlite"),
    artifactBlobsDir: join(dataDir, "artifacts", "blobs", "sha256"),
    piAgentDir: join(dataDir, "pi-agent"),
    pidFile: join(runtimeDir, "runner.pid"),
    socketPath: join(runtimeDir, "runner.sock"),
    lockPath: join(runtimeDir, "runner.lock"),
  };
}

export function migrateLegacySparkDaemonState(
  paths: NaviaPaths,
  options: { env?: Record<string, string | undefined>; cwd?: string; now?: Date } = {},
): SparkDaemonLegacyStateMigrationResult {
  const legacy = legacySparkDaemonStatePaths(options.env, options.cwd);
  const result: SparkDaemonLegacyStateMigrationResult = {
    migratedAt: (options.now ?? new Date()).toISOString(),
    copied: [],
    cleaned: [],
    skipped: [],
    legacy,
    markerFile: join(paths.stateDir, "migrations", "legacy-daemon-state.json"),
  };

  copyConfigIfNeeded(paths, legacy, result);
  copyFileIfMissing(legacy.databasePath, paths.databasePath, result, "database");
  if (paths.piAgentDir)
    copyDirectoryIfMissing(legacy.piAgentDir, paths.piAgentDir, result, "pi-agent");
  copyDirectoryIfMissing(legacy.artifactBlobsDir, paths.artifactBlobsDir, result, "artifact blobs");
  copyDirectoryIfMissing(
    join(legacy.cacheDir, "artifacts", "blobs", "sha256"),
    paths.artifactBlobsDir,
    result,
    "artifact cache blobs",
  );
  cleanupLegacyRuntimeFiles(legacy, result);
  writePrivateFile(result.markerFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function copyConfigIfNeeded(
  paths: NaviaPaths,
  legacy: SparkDaemonLegacyStatePaths,
  result: SparkDaemonLegacyStateMigrationResult,
): void {
  if (!existsSync(legacy.configFile)) return;
  if (existsSync(paths.configFile)) {
    result.skipped.push(`config exists: ${paths.configFile}`);
    return;
  }
  writePrivateFile(
    paths.configFile,
    migrateConfigContents(readFileSync(legacy.configFile, "utf8")),
  );
  result.copied.push(`config: ${legacy.configFile} -> ${paths.configFile}`);
}

function migrateConfigContents(contents: string): string {
  return contents
    .replace(/^(\s*installationId\s*=\s*")navia-runner-/mu, "$1spark-daemon-")
    .replace(/^(\s*displayName\s*=\s*")Navia runner("\s*)$/mu, "$1Spark daemon$2");
}

function copyFileIfMissing(
  source: string,
  target: string,
  result: SparkDaemonLegacyStateMigrationResult,
  label: string,
): void {
  if (!existsSync(source)) return;
  if (existsSync(target)) {
    result.skipped.push(`${label} exists: ${target}`);
    return;
  }
  ensurePrivateDir(dirname(target));
  copyFileSync(source, target);
  chmodIfPossible(target, 0o600);
  result.copied.push(`${label}: ${source} -> ${target}`);
}

function copyDirectoryIfMissing(
  source: string,
  target: string,
  result: SparkDaemonLegacyStateMigrationResult,
  label: string,
): void {
  if (!existsSync(source)) return;
  if (existsSync(target)) {
    result.skipped.push(`${label} exists: ${target}`);
    return;
  }
  ensurePrivateDir(dirname(target));
  cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
  result.copied.push(`${label}: ${source} -> ${target}`);
}

function cleanupLegacyRuntimeFiles(
  legacy: SparkDaemonLegacyStatePaths,
  result: SparkDaemonLegacyStateMigrationResult,
): void {
  const pid = readPidFile(legacy.pidFile);
  if (pid && isProcessAlive(pid)) {
    result.skipped.push(`legacy service process still appears alive: ${pid}`);
    return;
  }
  removeRuntimeFile(legacy.socketPath, result);
  removeRuntimeFile(legacy.pidFile, result);
  removeRuntimeFile(legacy.lockPath, result);
}

function removeRuntimeFile(path: string, result: SparkDaemonLegacyStateMigrationResult): void {
  if (!existsSync(path)) return;
  rmSync(path, { force: true, recursive: false });
  result.cleaned.push(path);
}

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function chmodIfPossible(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function absoluteDir(path: string, cwd: string): string {
  return resolve(cwd, path);
}
