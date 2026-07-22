import { spawn } from "node:child_process";
import { delay } from "es-toolkit";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonRecord;
export interface JsonRecord {
  [key: string]: JsonValue;
}

export class GraftCliError extends Error {
  readonly program: string;
  readonly argv: string[];
  readonly cwd: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor({
    program,
    argv,
    cwd,
    stdout,
    stderr,
    exitCode,
  }: {
    program: string;
    argv: string[];
    cwd: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }) {
    const output = `${stdout}${stderr}`.trim();
    super(
      `graft CLI failed (${program} ${argv.join(" ")}): ${output || `exit ${exitCode ?? "unknown"}`}`,
    );
    this.name = "GraftCliError";
    this.program = program;
    this.argv = argv;
    this.cwd = cwd;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface DirectGraftExecution {
  mode: "direct";
  program: string;
  cwd: string;
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunDirectGraftOptions {
  stdin?: string;
  /** Wall-clock timeout for one graft CLI process. Defaults to 120s; <=0 disables. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_GRAFT_CLI_TIMEOUT_MS = 120_000;
const GRAFT_WRITER_LOCK_RETRY_ATTEMPTS = 6;
const GRAFT_WRITER_LOCK_RETRY_BASE_MS = 50;

export interface GraftJsonExecution {
  envelope: JsonRecord;
  result?: JsonRecord;
  execution: DirectGraftExecution;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graftCandidates(): string[] {
  const fromEnv = process.env.GRAFT_BIN?.trim();
  if (fromEnv) return [fromEnv];
  return ["graft"];
}

export async function runDirectGraft(
  cwd: string,
  argv: string[],
  options: RunDirectGraftOptions = {},
): Promise<DirectGraftExecution> {
  let lastError = "no graft candidate tried";
  for (const graft of graftCandidates()) {
    const actualArgv = ["--cwd", cwd, ...argv];
    for (let attempt = 1; attempt <= GRAFT_WRITER_LOCK_RETRY_ATTEMPTS; attempt += 1) {
      const result = await spawnGraft(graft, actualArgv, cwd, options);

      if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
        lastError = `${graft} not found`;
        break;
      }
      if (result.error) {
        if (result.error instanceof GraftCliTimeoutError) throw result.error;
        if (result.error instanceof GraftCliAbortError) throw result.error;
        throw new Error(`could not run graft CLI with ${graft}: ${result.error.message}`);
      }
      if (result.code !== 0) {
        if (isGraftWriterLockFailure(result.stderr) && attempt < GRAFT_WRITER_LOCK_RETRY_ATTEMPTS) {
          await delay(GRAFT_WRITER_LOCK_RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new GraftCliError({
          program: graft,
          argv: actualArgv,
          cwd,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code,
        });
      }
      return {
        mode: "direct",
        program: graft,
        cwd,
        argv: actualArgv,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      };
    }
  }
  throw new Error(`${lastError}; set GRAFT_BIN or put graft on PATH`);
}

async function spawnGraft(
  graft: string,
  actualArgv: string[],
  cwd: string,
  options: RunDirectGraftOptions,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}> {
  return new Promise((resolve) => {
    const child = spawn(graft, actualArgv, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeoutMs = normalizeGraftTimeoutMs(options.timeoutMs);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: {
      code: number | null;
      stdout: string;
      stderr: string;
      error?: Error;
    }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const snapshot = (error?: Error) => ({
      code: null,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
      ...(error ? { error } : {}),
    });
    const abandonChild = () => {
      child.kill("SIGTERM");
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };
    const abort = () => {
      abandonChild();
      finish(snapshot(new GraftCliAbortError(abortSignalReason(options.signal))));
    };

    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      finish(snapshot(error));
    });
    child.once("exit", (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        abandonChild();
        finish(snapshot(new GraftCliTimeoutError(graft, actualArgv, timeoutMs)));
      }, timeoutMs);
      timeout.unref?.();
    }
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    else child.stdin?.end();
  });
}

export class GraftCliTimeoutError extends Error {
  readonly program: string;
  readonly argv: string[];
  readonly timeoutMs: number;

  constructor(program: string, argv: string[], timeoutMs: number) {
    super(`graft CLI timed out after ${timeoutMs}ms (${program} ${argv.join(" ")})`);
    this.name = "GraftCliTimeoutError";
    this.program = program;
    this.argv = argv;
    this.timeoutMs = timeoutMs;
  }
}

export class GraftCliAbortError extends Error {
  constructor(reason: string) {
    super(`graft CLI aborted: ${reason}`);
    this.name = "GraftCliAbortError";
  }
}

function normalizeGraftTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_GRAFT_CLI_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs)) return DEFAULT_GRAFT_CLI_TIMEOUT_MS;
  const normalized = Math.floor(timeoutMs);
  return normalized > 0 ? normalized : 0;
}

function abortSignalReason(signal: AbortSignal | undefined): string {
  const reason = (signal as { reason?: unknown } | undefined)?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  return "abort";
}

function isGraftWriterLockFailure(stderr: string): boolean {
  return /another graft writer holds the lock|\.registry\.lock/u.test(stderr);
}

export function formatDirectOutput(execution: DirectGraftExecution): string {
  return (
    `${execution.stdout}${execution.stderr}`.trim() ||
    `graft ${execution.argv.join(" ")} completed.`
  );
}

function parseJsonRecord(text: string, context: string): JsonRecord {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${context} did not return JSON output.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${context} did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isJsonRecord(parsed)) throw new Error(`${context} did not return a JSON object.`);
  return parsed;
}

export async function runGraftJson(
  cwd: string,
  argv: string[],
  options: RunDirectGraftOptions = {},
): Promise<GraftJsonExecution> {
  const jsonArgv = argv.includes("--json") ? argv : ["--json", ...argv];
  const execution = await runDirectGraft(cwd, jsonArgv, options);
  const envelope = parseJsonRecord(execution.stdout, `graft ${jsonArgv.join(" ")}`);
  const result = envelopeResult(envelope);
  return result ? { envelope, result, execution } : { envelope, execution };
}

export function envelopeResult(envelope: JsonRecord): JsonRecord | undefined {
  const result = envelope.result;
  return isJsonRecord(result) ? result : undefined;
}
