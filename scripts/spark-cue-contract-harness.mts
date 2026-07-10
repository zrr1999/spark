#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { CueClient } from "../packages/spark-cue/src/cue-client.ts";

const execFileAsync = promisify(execFile);
const LOG_LIMIT_BYTES = 128 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

type CheckStatus = "passed" | "failed" | "skipped";

export interface CueContractCheck {
  status: CheckStatus;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface CueContractHarnessReport {
  generatedAt: string;
  backend: "cue-contract";
  status: "passed" | "blocked" | "failed";
  strict: boolean;
  durationMs: number;
  paths: {
    cueShellRoot: string | null;
    cuedBin: string | null;
    tempRoot: string | null;
    socketPath: string | null;
  };
  daemon: {
    pid: number | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  };
  checks: Record<string, CueContractCheck>;
  blockers: string[];
  failures: string[];
  cleanup: string[];
}

export interface CueContractHarnessOptions {
  strict?: boolean;
  outputPath?: string;
  cueShellRoot?: string;
  cuedBin?: string;
  startupTimeoutMs?: number;
  retainTemp?: boolean;
}

interface MutableLog {
  value: string;
  append(chunk: Buffer | string): void;
}

function boundedLog(): MutableLog {
  return {
    value: "",
    append(chunk: Buffer | string) {
      this.value += chunk.toString();
      if (Buffer.byteLength(this.value) > LOG_LIMIT_BYTES) {
        this.value = `[truncated to last ${LOG_LIMIT_BYTES} bytes]\n${Buffer.from(this.value)
          .subarray(-LOG_LIMIT_BYTES)
          .toString()}`;
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function executableOnPath(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [name], {
      timeout: 2_000,
      env: process.env,
    });
    const candidate = stdout.trim();
    return candidate && (await executable(candidate)) ? candidate : null;
  } catch {
    return null;
  }
}

function absoluteFrom(root: string, candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(root, candidate);
}

async function resolveCuedBinary(options: CueContractHarnessOptions): Promise<{
  cueShellRoot: string | null;
  cuedBin: string | null;
  searched: string[];
}> {
  const rootInput = options.cueShellRoot ?? process.env.CUE_SHELL_ROOT;
  const cueShellRoot = rootInput ? resolve(rootInput) : null;
  const explicitBin = options.cuedBin ?? process.env.CUED_BIN;
  const searched: string[] = [];

  if (explicitBin) {
    const candidate = absoluteFrom(cueShellRoot ?? process.cwd(), explicitBin);
    searched.push(candidate);
    return {
      cueShellRoot,
      cuedBin: (await executable(candidate)) ? candidate : null,
      searched,
    };
  }

  if (cueShellRoot) {
    for (const relative of ["target/debug/cued", "target/release/cued"]) {
      const candidate = join(cueShellRoot, relative);
      searched.push(candidate);
      if (await executable(candidate)) return { cueShellRoot, cuedBin: candidate, searched };
    }
    return { cueShellRoot, cuedBin: null, searched };
  }

  const pathCandidate = await executableOnPath("cued");
  searched.push("PATH:cued");
  return { cueShellRoot, cuedBin: pathCandidate, searched };
}

async function waitForSocket(
  socketPath: string,
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  spawnError: () => Error | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = spawnError();
    if (error) throw error;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `cued exited before its socket became ready (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
      );
    }
    try {
      if ((await stat(socketPath)).isSocket()) return;
    } catch {
      // The daemon has not bound the isolated socket yet.
    }
    await delay(25);
  }
  throw new Error(`cued did not create ${socketPath} within ${timeoutMs}ms`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

function signalProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited between the checks.
    }
  }
}

async function stopIsolatedDaemon(
  cuedBin: string,
  socketPath: string,
  env: NodeJS.ProcessEnv,
  child: ReturnType<typeof spawn>,
  cleanup: string[],
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    cleanup.push("isolated cued had already exited");
    return;
  }

  try {
    await execFileAsync(cuedBin, ["stop", "--socket", socketPath], {
      env,
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
    });
    cleanup.push("sent isolated cued a protocol shutdown request");
  } catch (error) {
    cleanup.push(`protocol shutdown failed: ${errorMessage(error)}`);
    signalProcessGroup(child, "SIGTERM");
  }

  if (await waitForExit(child, 3_000)) return;
  signalProcessGroup(child, "SIGTERM");
  if (await waitForExit(child, 2_000)) {
    cleanup.push("stopped isolated cued with SIGTERM");
    return;
  }
  signalProcessGroup(child, "SIGKILL");
  await waitForExit(child, 1_000);
  cleanup.push("force-stopped isolated cued with SIGKILL");
}

async function recordCheck(
  report: CueContractHarnessReport,
  name: string,
  run: () => Promise<Record<string, unknown> | void>,
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const details = await run();
    report.checks[name] = {
      status: "passed",
      durationMs: Date.now() - startedAt,
      ...(details ? { details } : {}),
    };
    return true;
  } catch (error) {
    const message = errorMessage(error);
    report.checks[name] = {
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: message,
    };
    report.failures.push(`${name}: ${message}`);
    return false;
  }
}

function skipCheck(report: CueContractHarnessReport, name: string, reason: string): void {
  report.checks[name] = { status: "skipped", durationMs: 0, error: reason };
}

async function writeReport(path: string, report: CueContractHarnessReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function cueContractHarnessExitCode(
  report: CueContractHarnessReport,
  strict = report.strict,
): number {
  if (report.status === "failed") return 1;
  if (report.status === "blocked" && strict) return 1;
  return 0;
}

export async function runSparkCueContractHarness(
  options: CueContractHarnessOptions = {},
): Promise<CueContractHarnessReport> {
  const harnessStartedAt = Date.now();
  const strict = options.strict ?? false;
  const outputPath = resolve(options.outputPath ?? "/tmp/spark-cue-contract-harness-report.json");
  const binary = await resolveCuedBinary(options);
  const report: CueContractHarnessReport = {
    generatedAt: new Date().toISOString(),
    backend: "cue-contract",
    status: "blocked",
    strict,
    durationMs: 0,
    paths: {
      cueShellRoot: binary.cueShellRoot,
      cuedBin: binary.cuedBin,
      tempRoot: null,
      socketPath: null,
    },
    daemon: {
      pid: null,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
    },
    checks: {},
    blockers: [],
    failures: [],
    cleanup: [],
  };

  if (!binary.cuedBin) {
    report.blockers.push(
      `cued binary is unavailable; set CUED_BIN or CUE_SHELL_ROOT (searched: ${binary.searched.join(", ")})`,
    );
    report.durationMs = Date.now() - harnessStartedAt;
    await writeReport(outputPath, report);
    return report;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "spark-cue-contract-"));
  const runtimeDir = join(tempRoot, "runtime");
  const dataDir = join(tempRoot, "data");
  const stateDir = join(tempRoot, "state");
  const configDir = join(tempRoot, "config");
  const homeDir = join(tempRoot, "home");
  const workspaceA = join(tempRoot, "workspace-a");
  const workspaceB = join(tempRoot, "workspace-b");
  const socketPath = join(runtimeDir, "contract.sock");
  report.paths.tempRoot = tempRoot;
  report.paths.socketPath = socketPath;

  await Promise.all(
    [runtimeDir, dataDir, stateDir, configDir, homeDir, workspaceA, workspaceB].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );

  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_DATA_HOME: dataDir,
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: configDir,
    CUE_SOCKET: socketPath,
  };
  const daemonStdout = boundedLog();
  const daemonStderr = boundedLog();
  const child = spawn(binary.cuedBin, ["start", "--fg", "--socket", socketPath], {
    detached: true,
    env: daemonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  report.daemon.pid = child.pid ?? null;
  child.stdout?.on("data", (chunk: Buffer) => daemonStdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => daemonStderr.append(chunk));
  let childSpawnError: Error | null = null;
  child.once("error", (error) => {
    childSpawnError = error;
  });

  const clients: CueClient[] = [];
  let clientA: CueClient | undefined;
  let clientB: CueClient | undefined;
  try {
    await waitForSocket(
      socketPath,
      child,
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      () => childSpawnError,
    );

    const handshakePassed = await recordCheck(report, "handshakeAndCapabilities", async () => {
      const sessionEnv = {
        PATH: process.env.PATH,
        LC_ALL: "C",
        SPARK_CUE_CONTRACT: "1",
      };
      clientA = await CueClient.connect(socketPath, {
        sessionId: "spark-cue-contract-a",
        cwd: workspaceA,
        env: sessionEnv,
      });
      clients.push(clientA);
      clientB = await CueClient.connect(socketPath, {
        sessionId: "spark-cue-contract-b",
        cwd: workspaceB,
        env: sessionEnv,
      });
      clients.push(clientB);
      const [versionA, versionB] = await Promise.all([
        clientA.pingForVersion(),
        clientB.pingForVersion(),
      ]);
      requireContract(versionA !== null && versionB !== null, "cued Pong omitted its version");
      requireContract(versionA === versionB, "sessions observed different daemon versions");
      return {
        daemonVersion: versionA,
        protocolVersionAtLeast: 2,
        requiredCapabilities: [
          "session-handshake-required",
          "script-item-created",
          "cancel-execution",
        ],
        sessionIds: ["spark-cue-contract-a", "spark-cue-contract-b"],
      };
    });

    if (!handshakePassed || !clientA || !clientB) {
      const reason = "requires two initialized CueClient sessions";
      for (const name of [
        "jobResult",
        "twoSessionConcurrency",
        "runScriptItemAuthority",
        "abortCancellation",
      ]) {
        skipCheck(report, name, reason);
      }
    } else {
      const first = clientA;
      const second = clientB;

      await recordCheck(report, "jobResult", async () => {
        const result = await first.runJob("printf spark-cue-contract-job", {
          timeout: 10,
          pty: false,
        });
        requireContract(result.status === "Done", `expected Done, got ${result.status}`);
        requireContract(
          result.exitCode === 0,
          `expected exitCode=0, got ${String(result.exitCode)}`,
        );
        requireContract(
          result.stdout === "spark-cue-contract-job",
          `unexpected stdout ${JSON.stringify(result.stdout)}`,
        );
        return {
          jobId: result.jobId,
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
        };
      });

      await recordCheck(report, "twoSessionConcurrency", async () => {
        const [resultA, resultB] = await Promise.all([
          first.runJob("printf spark-cue-contract-session-a", { timeout: 10 }),
          second.runJob("printf spark-cue-contract-session-b", { timeout: 10 }),
        ]);
        requireContract(
          resultA.stdout === "spark-cue-contract-session-a",
          `session A received ${JSON.stringify(resultA.stdout)}`,
        );
        requireContract(
          resultB.stdout === "spark-cue-contract-session-b",
          `session B received ${JSON.stringify(resultB.stdout)}`,
        );
        requireContract(!first.isClosed && !second.isClosed, "one session closed the other");
        await Promise.all([first.ping(), second.ping()]);
        return {
          sessionAJobId: resultA.jobId,
          sessionBJobId: resultB.jobId,
          bothConnectionsRemainOpen: true,
        };
      });

      await recordCheck(report, "runScriptItemAuthority", async () => {
        const scriptPromise = first.runScript({
          path: join(workspaceA, "two-items.cue"),
          input: "sleep 0.4\nprintf spark-cue-contract-script-second",
          timeout: 10,
        });
        await delay(75);
        const outsiderPromise = second.runJob("printf spark-cue-contract-outsider", {
          timeout: 10,
        });
        const [script, outsider] = await Promise.all([scriptPromise, outsiderPromise]);
        requireContract(
          script.status === "done",
          `expected script status done, got ${script.status}`,
        );
        requireContract(
          script.exitCode === 0,
          `expected script exitCode=0, got ${script.exitCode}`,
        );
        requireContract(
          script.items.length === 2,
          `expected 2 script items, got ${script.items.length}`,
        );
        requireContract(
          script.items[0]?.source === "sleep 0.4",
          `unexpected first item source ${JSON.stringify(script.items[0]?.source)}`,
        );
        requireContract(
          script.items[1]?.source === "printf spark-cue-contract-script-second",
          `unexpected second item source ${JSON.stringify(script.items[1]?.source)}`,
        );
        const scriptJobIds = script.items.flatMap((item) => item.jobIds);
        requireContract(
          !scriptJobIds.includes(outsider.jobId),
          `outsider job ${outsider.jobId} was attributed to script ${script.scriptId}`,
        );
        requireContract(
          script.items[1]?.stdout === "spark-cue-contract-script-second",
          `unexpected second item stdout ${JSON.stringify(script.items[1]?.stdout)}`,
        );
        return {
          scriptId: script.scriptId,
          scriptJobIds,
          outsiderJobId: outsider.jobId,
          itemSources: script.items.map((item) => item.source),
          itemStdout: script.items.map((item) => item.stdout),
        };
      });

      await recordCheck(report, "abortCancellation", async () => {
        const controller = new AbortController();
        const startedAt = Date.now();
        const running = first.runJob("sleep 29", {
          timeout: 10,
          signal: controller.signal,
        });
        const abortTimer = setTimeout(
          () => controller.abort(new Error("spark cue contract abort")),
          100,
        );
        let abortError: unknown;
        try {
          await running;
        } catch (error) {
          abortError = error;
        } finally {
          clearTimeout(abortTimer);
        }
        const elapsedMs = Date.now() - startedAt;
        requireContract(
          abortError instanceof Error,
          "aborted runJob resolved instead of rejecting",
        );
        requireContract(
          abortError.name === "AbortError",
          `expected AbortError, got ${abortError.name}: ${abortError.message}`,
        );
        requireContract(elapsedMs < 5_000, `abort took ${elapsedMs}ms`);
        const cancelledJob = (await first.listJobs()).find((job) => job.pipeline === "sleep 29");
        requireContract(cancelledJob, "cancelled job was not visible in the durable job list");
        requireContract(
          ["Killed", "Cancelled"].includes(cancelledJob.status),
          `cancelled job remained ${cancelledJob.status}`,
        );
        return {
          jobId: cancelledJob.id,
          status: cancelledJob.status,
          elapsedMs,
          errorName: abortError.name,
        };
      });
    }
  } catch (error) {
    report.failures.push(`harness: ${errorMessage(error)}`);
  } finally {
    for (const client of clients) client.close();
    if (clients.length > 0) report.cleanup.push(`closed ${clients.length} CueClient connections`);
    await stopIsolatedDaemon(binary.cuedBin, socketPath, daemonEnv, child, report.cleanup);
    report.daemon.exitCode = child.exitCode;
    report.daemon.signal = child.signalCode;
    report.daemon.stdout = daemonStdout.value;
    report.daemon.stderr = daemonStderr.value;
    if (options.retainTemp) {
      report.cleanup.push(`retained isolated temp root ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
      report.cleanup.push(`removed isolated temp root ${tempRoot}`);
    }
  }

  report.status = report.failures.length > 0 ? "failed" : "passed";
  report.durationMs = Date.now() - harnessStartedAt;
  await writeReport(outputPath, report);
  return report;
}

const args = new Map<string, string | boolean>();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]!;
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, true);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const strict = args.get("strict") === true || process.env.CUE_CONTRACT_STRICT === "1";
  runSparkCueContractHarness({
    strict,
    outputPath:
      typeof args.get("output") === "string"
        ? String(args.get("output"))
        : "/tmp/spark-cue-contract-harness-report.json",
    cueShellRoot:
      typeof args.get("cue-shell-root") === "string"
        ? String(args.get("cue-shell-root"))
        : undefined,
    cuedBin: typeof args.get("cued-bin") === "string" ? String(args.get("cued-bin")) : undefined,
    startupTimeoutMs:
      typeof args.get("startup-timeout-ms") === "string"
        ? Number(args.get("startup-timeout-ms"))
        : undefined,
    retainTemp: args.get("retain-temp") === true,
  })
    .then((report) => {
      console.log(
        JSON.stringify(
          {
            reportPath:
              typeof args.get("output") === "string"
                ? resolve(String(args.get("output")))
                : "/tmp/spark-cue-contract-harness-report.json",
            status: report.status,
            checks: report.checks,
            blockers: report.blockers,
            failures: report.failures,
          },
          null,
          2,
        ),
      );
      process.exitCode = cueContractHarnessExitCode(report, strict);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}
