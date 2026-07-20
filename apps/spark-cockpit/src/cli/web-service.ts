import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveSparkPaths } from "@zendev-lab/spark-system";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lockFileName = "cockpit-web.lock";
const startupTimeoutMs = 15_000;
const stopTimeoutMs = 10_000;

type CockpitWebSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CockpitWebServiceDependencies {
  processStartToken(pid: number): string | null;
  spawnProcess: CockpitWebSpawn;
  canConnect(host: string, port: number): Promise<boolean>;
  killProcess(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const defaultDependencies: CockpitWebServiceDependencies = {
  processStartToken: defaultProcessStartToken,
  spawnProcess: (command, args, options) => spawn(command, [...args], options),
  canConnect: defaultCanConnect,
  killProcess: (pid, signal) => process.kill(pid, signal),
  sleep: async (ms) => await delay(ms),
  now: Date.now,
};

function dependencies(
  overrides: Partial<CockpitWebServiceDependencies> = {},
): CockpitWebServiceDependencies {
  return { ...defaultDependencies, ...overrides };
}

export interface CockpitWebProcessRecord {
  pid: number;
  processStartToken: string;
  startedAt: string;
  host: string;
  port: number;
  logFile: string;
}

export interface CockpitWebStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
  url?: string;
  logFile: string;
  pidFile: string;
}

interface WebServicePaths {
  runtimeDir: string;
  pidFile: string;
  lockFile: string;
  logFile: string;
}

function servicePaths(env: NodeJS.ProcessEnv = process.env): WebServicePaths {
  const paths = resolveSparkPaths({ app: "cockpit", env });
  return {
    runtimeDir: paths.runtimeDir,
    pidFile: paths.pidFile,
    lockFile: join(paths.runtimeDir, lockFileName),
    logFile: paths.logFile,
  };
}

function defaultProcessStartToken(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const suffix = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      return suffix[19] ?? null;
    } catch {
      return null;
    }
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1_000,
  });
  const token = result.status === 0 ? result.stdout.trim() : "";
  return token || null;
}

function readRecord(path: string): CockpitWebProcessRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CockpitWebProcessRecord>;
    if (
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.processStartToken !== "string" ||
      typeof value.startedAt !== "string" ||
      typeof value.host !== "string" ||
      !Number.isSafeInteger(value.port) ||
      typeof value.logFile !== "string"
    ) {
      return null;
    }
    return value as CockpitWebProcessRecord;
  } catch {
    return null;
  }
}

function isRecordRunning(
  record: CockpitWebProcessRecord,
  deps: CockpitWebServiceDependencies,
): boolean {
  return deps.processStartToken(record.pid) === record.processStartToken;
}

function removeStaleRecord(path: string, deps: CockpitWebServiceDependencies): void {
  const record = readRecord(path);
  if (!record || !isRecordRunning(record, deps)) rmSync(path, { force: true });
}

function recordsMatch(
  left: CockpitWebProcessRecord | null,
  right: CockpitWebProcessRecord,
): boolean {
  return left?.pid === right.pid && left.processStartToken === right.processStartToken;
}

function removeOwnedRecord(path: string, owner: CockpitWebProcessRecord): void {
  if (recordsMatch(readRecord(path), owner)) rmSync(path, { force: true });
}

function writeRecordAtomically(path: string, record: CockpitWebProcessRecord): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function ensureServiceDirectories(paths: WebServicePaths): void {
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.logFile), { recursive: true, mode: 0o700 });
}

export function getCockpitWebStatus(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CockpitWebServiceDependencies> = {},
): CockpitWebStatus {
  const deps = dependencies(overrides);
  const paths = servicePaths(env);
  const pidRecord = readRecord(paths.pidFile);
  const lockRecord = readRecord(paths.lockFile);
  const record = [pidRecord, lockRecord].find(
    (candidate): candidate is CockpitWebProcessRecord =>
      candidate !== null && isRecordRunning(candidate, deps),
  );
  if (!record) {
    removeStaleRecord(paths.pidFile, deps);
    removeStaleRecord(paths.lockFile, deps);
    return { running: false, logFile: paths.logFile, pidFile: paths.pidFile };
  }
  if (!recordsMatch(pidRecord, record)) removeStaleRecord(paths.pidFile, deps);
  if (!recordsMatch(lockRecord, record)) removeStaleRecord(paths.lockFile, deps);
  const displayHost = record.host === "0.0.0.0" || record.host === "::" ? "127.0.0.1" : record.host;
  return {
    running: true,
    pid: record.pid,
    startedAt: record.startedAt,
    url: `http://${displayHost}:${record.port}`,
    logFile: record.logFile,
    pidFile: paths.pidFile,
  };
}

function runnerExecArgv(): string[] {
  const result: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index]!;
    if (arg === "--eval" || arg === "-e") {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function defaultCanConnect(host: string, port: number): Promise<boolean> {
  const targetHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host: targetHost, port });
    const done = (connected: boolean) => {
      socket.destroy();
      resolveConnection(connected);
    };
    socket.setTimeout(250);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function startCockpitWebService(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CockpitWebServiceDependencies> = {},
): Promise<{ alreadyRunning: boolean; status: CockpitWebStatus }> {
  const deps = dependencies(overrides);
  const current = getCockpitWebStatus(env, deps);
  if (current.running) return { alreadyRunning: true, status: current };

  const paths = servicePaths(env);
  ensureServiceDirectories(paths);
  const logFd = openSync(paths.logFile, "a", 0o600);
  let child: ChildProcess;
  try {
    child = deps.spawnProcess(
      process.execPath,
      [
        ...runnerExecArgv(),
        fileURLToPath(new URL("./web-service-entry.ts", import.meta.url)),
        "run",
      ],
      {
        cwd: appDir,
        detached: true,
        env,
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? "5173");
  const deadline = deps.now() + startupTimeoutMs;
  while (deps.now() < deadline) {
    const status = getCockpitWebStatus(env, deps);
    if (status.running && (await deps.canConnect(host, port))) {
      return { alreadyRunning: false, status };
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await deps.sleep(100);
  }

  const status = getCockpitWebStatus(env, deps);
  if (status.running && status.pid) {
    try {
      killServiceProcess(status.pid, "SIGTERM", deps);
    } catch {
      // The runner may already have exited.
    }
  }
  throw new Error(`Spark Cockpit failed to become ready; see ${paths.logFile}`);
}

export async function stopCockpitWebService(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CockpitWebServiceDependencies> = {},
): Promise<{ alreadyStopped: boolean; status: CockpitWebStatus }> {
  const deps = dependencies(overrides);
  const current = getCockpitWebStatus(env, deps);
  if (!current.running || !current.pid) return { alreadyStopped: true, status: current };

  killServiceProcess(current.pid, "SIGTERM", deps);
  const deadline = deps.now() + stopTimeoutMs;
  while (deps.now() < deadline) {
    const status = getCockpitWebStatus(env, deps);
    if (!status.running) return { alreadyStopped: false, status };
    await deps.sleep(100);
  }

  const record = readRecord(servicePaths(env).pidFile);
  if (record && isRecordRunning(record, deps)) killServiceProcess(record.pid, "SIGKILL", deps);
  await deps.sleep(100);
  return { alreadyStopped: false, status: getCockpitWebStatus(env, deps) };
}

function acquireRunnerLock(
  paths: WebServicePaths,
  record: CockpitWebProcessRecord,
  deps: CockpitWebServiceDependencies,
): number {
  ensureServiceDirectories(paths);
  const temporary = join(paths.runtimeDir, `.cockpit-web.${process.pid}.${randomUUID()}.lock`);
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(temporary, paths.lockFile);
        return openSync(paths.lockFile, "r");
      } catch (error) {
        const existing = readRecord(paths.lockFile);
        if (existing && isRecordRunning(existing, deps)) {
          throw new Error(`Spark Cockpit is already running (pid ${existing.pid}).`);
        }
        rmSync(paths.lockFile, { force: true });
        if (attempt === 1) throw error;
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  throw new Error("Unable to acquire the Spark Cockpit service lock.");
}

function serverCommand(env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const testEntry = env.SPARK_COCKPIT_WEB_TEST_SERVER_ENTRY;
  if (testEntry) return { command: process.execPath, args: [testEntry] };
  return { command: "pnpm", args: ["exec", "tsx", join(appDir, "server", "index.ts")] };
}

function killServiceProcess(
  pid: number,
  signal: NodeJS.Signals,
  deps: CockpitWebServiceDependencies,
): void {
  deps.killProcess(process.platform === "win32" ? pid : -pid, signal);
}

export async function runCockpitWebService(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CockpitWebServiceDependencies> = {},
): Promise<void> {
  const deps = dependencies(overrides);
  const paths = servicePaths(env);
  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? "5173");
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535)
    throw new Error(`Invalid PORT: ${env.PORT}`);

  const token = deps.processStartToken(process.pid);
  if (!token) throw new Error("Unable to identify the Spark Cockpit service process.");
  const record: CockpitWebProcessRecord = {
    pid: process.pid,
    processStartToken: token,
    startedAt: new Date().toISOString(),
    host,
    port,
    logFile: paths.logFile,
  };
  const lockFd = acquireRunnerLock(paths, record, deps);
  let onSigterm: (() => void) | undefined;
  let onSigint: (() => void) | undefined;
  try {
    writeRecordAtomically(paths.pidFile, record);
    const command = serverCommand(env);
    const server = deps.spawnProcess(command.command, command.args, {
      cwd: appDir,
      env,
      stdio: "inherit",
    });
    const forward = (signal: NodeJS.Signals) => {
      if (server.exitCode === null && server.signalCode === null) server.kill(signal);
    };
    onSigterm = () => forward("SIGTERM");
    onSigint = () => forward("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        server.once("error", reject);
        server.once("exit", (code, signal) => resolveExit({ code, signal }));
      },
    );
    if (exit.code && exit.code !== 0) process.exitCode = exit.code;
  } finally {
    if (onSigterm) process.off("SIGTERM", onSigterm);
    if (onSigint) process.off("SIGINT", onSigint);
    removeOwnedRecord(paths.pidFile, record);
    removeOwnedRecord(paths.lockFile, record);
    closeSync(lockFd);
  }
}

export function readCockpitWebLogs(
  env: NodeJS.ProcessEnv = process.env,
  lineCount = 100,
): { logFile: string; text: string } {
  if (!Number.isSafeInteger(lineCount) || lineCount < 0) {
    throw new Error("Invalid --lines value. Pass a non-negative integer.");
  }
  const { logFile } = servicePaths(env);
  let content = "";
  try {
    content = readFileSync(logFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return {
    logFile,
    text: lineCount === 0 || !content ? "" : `${lines.slice(-lineCount).join("\n")}\n`,
  };
}

export function formatCockpitWebStatus(status: CockpitWebStatus, json: boolean): string {
  if (json) return JSON.stringify(status, null, 2);
  if (!status.running) return `Spark Cockpit is stopped.\nLog: ${status.logFile}`;
  return `Spark Cockpit is running (pid ${status.pid}).\nURL: ${status.url}\nLog: ${status.logFile}`;
}
