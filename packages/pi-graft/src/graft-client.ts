import { spawn } from "node:child_process";

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
}

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
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      error?: Error;
    }>((resolve) => {
      const child = spawn(graft, actualArgv, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.once("error", (error) => {
        resolve({
          code: null,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
          error,
        });
      });
      child.once("exit", (code) => {
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
      });
      if (options.stdin !== undefined) child.stdin?.end(options.stdin);
      else child.stdin?.end();
    });

    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      lastError = `${graft} not found`;
      continue;
    }
    if (result.error) {
      throw new Error(`could not run graft CLI with ${graft}: ${result.error.message}`);
    }
    if (result.code !== 0) {
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
  throw new Error(`${lastError}; set GRAFT_BIN or put graft on PATH`);
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
