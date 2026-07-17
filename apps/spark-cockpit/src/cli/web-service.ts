import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
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

function processStartToken(pid: number): string | null {
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

function isRecordRunning(record: CockpitWebProcessRecord): boolean {
  return processStartToken(record.pid) === record.processStartToken;
}

function removeStaleFiles(paths: WebServicePaths): void {
  const pidRecord = readRecord(paths.pidFile);
  const lockRecord = readRecord(paths.lockFile);
  if (pidRecord && isRecordRunning(pidRecord)) return;
  if (lockRecord && isRecordRunning(lockRecord)) return;
  rmSync(paths.pidFile, { force: true });
  rmSync(paths.lockFile, { force: true });
}

function ensureServiceDirectories(paths: WebServicePaths): void {
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.logFile), { recursive: true, mode: 0o700 });
}

export function getCockpitWebStatus(env: NodeJS.ProcessEnv = process.env): CockpitWebStatus {
  const paths = servicePaths(env);
  const record = readRecord(paths.pidFile) ?? readRecord(paths.lockFile);
  if (!record || !isRecordRunning(record)) {
    removeStaleFiles(paths);
    return { running: false, logFile: paths.logFile, pidFile: paths.pidFile };
  }
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

function canConnect(host: string, port: number): Promise<boolean> {
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
): Promise<{ alreadyRunning: boolean; status: CockpitWebStatus }> {
  const current = getCockpitWebStatus(env);
  if (current.running) return { alreadyRunning: true, status: current };

  const paths = servicePaths(env);
  ensureServiceDirectories(paths);
  const logFd = openSync(paths.logFile, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(
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
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const status = getCockpitWebStatus(env);
    if (status.running && (await canConnect(host, port))) {
      return { alreadyRunning: false, status };
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(100);
  }

  const status = getCockpitWebStatus(env);
  if (status.running && status.pid) {
    try {
      killServiceProcess(status.pid, "SIGTERM");
    } catch {
      // The runner may already have exited.
    }
  }
  throw new Error(`Spark Cockpit failed to become ready; see ${paths.logFile}`);
}

export async function stopCockpitWebService(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ alreadyStopped: boolean; status: CockpitWebStatus }> {
  const current = getCockpitWebStatus(env);
  if (!current.running || !current.pid) return { alreadyStopped: true, status: current };

  killServiceProcess(current.pid, "SIGTERM");
  const deadline = Date.now() + stopTimeoutMs;
  while (Date.now() < deadline) {
    const status = getCockpitWebStatus(env);
    if (!status.running) return { alreadyStopped: false, status };
    await delay(100);
  }

  const record = readRecord(servicePaths(env).pidFile);
  if (record && isRecordRunning(record)) killServiceProcess(record.pid, "SIGKILL");
  await delay(100);
  return { alreadyStopped: false, status: getCockpitWebStatus(env) };
}

function acquireRunnerLock(paths: WebServicePaths, record: CockpitWebProcessRecord): number {
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
        if (existing && isRecordRunning(existing)) {
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

function killServiceProcess(pid: number, signal: NodeJS.Signals): void {
  process.kill(process.platform === "win32" ? pid : -pid, signal);
}

export async function runCockpitWebService(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const paths = servicePaths(env);
  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? "5173");
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535)
    throw new Error(`Invalid PORT: ${env.PORT}`);

  const token = processStartToken(process.pid);
  if (!token) throw new Error("Unable to identify the Spark Cockpit service process.");
  const record: CockpitWebProcessRecord = {
    pid: process.pid,
    processStartToken: token,
    startedAt: new Date().toISOString(),
    host,
    port,
    logFile: paths.logFile,
  };
  const lockFd = acquireRunnerLock(paths, record);
  writeFileSync(paths.pidFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });

  const command = serverCommand(env);
  const server = spawn(command.command, command.args, { cwd: appDir, env, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => {
    if (server.exitCode === null && server.signalCode === null) server.kill(signal);
  };
  process.once("SIGTERM", () => forward("SIGTERM"));
  process.once("SIGINT", () => forward("SIGINT"));

  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        server.once("error", reject);
        server.once("exit", (code, signal) => resolveExit({ code, signal }));
      },
    );
    if (exit.code && exit.code !== 0) process.exitCode = exit.code;
  } finally {
    rmSync(paths.pidFile, { force: true });
    rmSync(paths.lockFile, { force: true });
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
