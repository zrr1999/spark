import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

import { registerPiGraftPatchTool } from "./patch-tool.ts";

const STATE_ENTRY = "pi-graft-state";
const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_START_TIMEOUT_MS = 5_000;
const GLOBAL_GRAFTD_OPS = new Set(["status", "shutdown"]);
const GRAFT_REPO_ACTIONS = ["add", "list", "sync", "lock", "update"] as const;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

export interface PiGraftSessionContext {
  cwd?: string;
  sessionManager?: {
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
    getSessionFile?: () => string | undefined;
  };
}

export interface PiGraftCommandContext extends PiGraftSessionContext {
  cwd: string;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

export interface PiGraftToolContext extends PiGraftSessionContext {
  cwd: string;
  ui?: {
    input?: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
    notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
  };
}

export interface PiGraftCommand {
  description: string;
  handler: (args: string, ctx: PiGraftCommandContext) => Promise<void>;
}

export interface PiGraftToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

export interface PiGraftToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: PiGraftToolRenderTheme,
    context: unknown,
  ) => PiGraftToolCallComponent;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: PiGraftToolContext,
  ) => Promise<PiGraftToolResult>;
}

export interface PiGraftToolRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface PiGraftToolCallComponent {
  render(width: number): string[];
}

class PiGraftToolCallText implements PiGraftToolCallComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    const maxWidth = Math.max(1, width);
    return [this.text.length > maxWidth ? `${this.text.slice(0, maxWidth - 1)}…` : this.text];
  }
}

export interface PiGraftExtensionApi {
  on(
    event: "session_start",
    handler: (event: unknown, ctx: PiGraftSessionContext) => unknown,
  ): void;
  registerCommand(name: string, options: PiGraftCommand): void;
  registerTool(definition: PiGraftToolDefinition): void;
  appendEntry?: (customType: string, data?: unknown) => void;
}

export interface ActiveGraftScratchState {
  workspace: string;
  workspaceId?: string;
  base?: string;
  lastScratch?: string;
  updatedAt: string;
  lastCandidate?: string;
  lastPatch?: string;
}

interface WireError {
  code: string;
  message: string;
  retry?: JsonValue;
}

interface WireResponse {
  id: string;
  ok: boolean;
  result?: JsonValue;
  error?: WireError;
}

class GraftdError extends Error {
  readonly code: string;
  readonly retry?: JsonValue;

  constructor(error: WireError) {
    super(`${error.code}: ${error.message}`);
    this.name = "GraftdError";
    this.code = error.code;
    this.retry = error.retry;
  }
}

class GraftCliError extends Error {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

function optionalStringParam(params: Record<string, unknown>, field: string): string | undefined {
  const value = params[field];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringArrayField(value: unknown, field: string): string[] | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  if (!Array.isArray(fieldValue)) return undefined;
  return fieldValue.every((item) => typeof item === "string") ? fieldValue : undefined;
}

function graftHome(): string {
  const fromEnv = process.env.GRAFT_HOME?.trim();
  if (fromEnv) return fromEnv;
  const home = process.env.HOME?.trim() || homedir();
  return join(home, ".graft");
}

function workspaceSocketPath(_cwd: string): string {
  return join(graftHome(), "run", "daemon.sock");
}

const workspaceIdsByRoot = new Map<string, string>();

async function workspaceIdForRequest(cwd: string): Promise<string> {
  const fromEnv = process.env.GRAFT_WORKSPACE?.trim();
  if (fromEnv) return fromEnv;

  try {
    const execution = await runDirectGraft(cwd, ["--json", "workspace", "status"]);
    const envelope = tryParseJsonRecord(execution.stdout);
    const workspaceId = workspaceIdFromEnvelope(envelope);
    if (workspaceId) {
      workspaceIdsByRoot.set(cwd, workspaceId);
      return workspaceId;
    }
  } catch {
    /* Fall through to the last known id/default; the daemon will report a precise routing error. */
  }

  return workspaceIdsByRoot.get(cwd) ?? "ws:default";
}

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface DirectGraftExecution {
  mode: "direct";
  program: string;
  cwd: string;
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface DaemonGraftExecution {
  mode: "daemon";
  cwd: string;
  argv: string[];
}

function graftCandidates(): string[] {
  const fromEnv = process.env.GRAFT_BIN?.trim();
  if (fromEnv) return [fromEnv];
  return ["graft"];
}

async function runDirectGraft(cwd: string, argv: string[]): Promise<DirectGraftExecution> {
  let lastError = "no graft candidate tried";
  for (const graft of graftCandidates()) {
    const actualArgv = ["--cwd", cwd, ...argv];
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      error?: Error;
    }>((resolve) => {
      const child = spawn(graft, actualArgv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

function tryParseJsonRecord(text: string): JsonRecord | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? (parsed as JsonRecord) : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonRecord(text: string, context: string): JsonRecord {
  const parsed = tryParseJsonRecord(text);
  if (!parsed) throw new Error(`${context} did not return a JSON object.`);
  return parsed;
}

function workspaceIdFromEnvelope(envelope: JsonRecord | undefined): string | undefined {
  const direct = stringField(envelope, "workspace_id");
  if (direct?.startsWith("ws:")) return direct;
  const message = stringField(envelope, "message");
  if (!message) return undefined;
  const line = message
    .split(/\r?\n/)
    .find((item) => item.startsWith("workspace_id\t") || item.includes("registered ws:"));
  const match = /\b(ws:[A-Za-z0-9_.:-]+)/.exec(line ?? "");
  return match?.[1];
}

async function directCliJson(
  cwd: string,
  argv: string[],
): Promise<{ envelope: JsonRecord; execution: DirectGraftExecution }> {
  const execution = await runDirectGraft(cwd, argv);
  return { envelope: parseJsonRecord(execution.stdout, `graft ${argv.join(" ")}`), execution };
}

function formatDirectOutput(execution: DirectGraftExecution): string {
  return (
    `${execution.stdout}${execution.stderr}`.trim() ||
    `graft ${execution.argv.join(" ")} completed.`
  );
}

async function canConnect(
  socketPath: string,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function graftdCandidates(): string[] {
  const fromEnv = process.env.GRAFT_DAEMON_BIN?.trim();
  if (fromEnv) return [fromEnv];
  return ["graftd"];
}

async function startGraftd(cwd: string, socketPath: string): Promise<void> {
  await mkdir(join(graftHome(), "run"), { recursive: true });

  let lastError = "no graftd candidate tried";
  for (const graftd of graftdCandidates()) {
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      error?: Error;
    }>((resolve) => {
      const child = spawn(graftd, ["start", "--cwd", cwd, "--socket", socketPath], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
    });

    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      lastError = `${graftd} not found`;
      continue;
    }
    if (result.error) {
      throw new Error(`could not start graftd with ${graftd}: ${result.error.message}`);
    }
    if (result.code !== 0) {
      throw new Error(
        `could not start graftd with ${graftd}: ${(result.stdout + result.stderr).trim()}`,
      );
    }

    const deadline = Date.now() + DEFAULT_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await canConnect(socketPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    lastError = `graftd ${graftd} returned success but ${socketPath} did not become reachable`;
  }

  throw new Error(`${lastError}; set GRAFT_DAEMON_BIN or put graftd on PATH`);
}

async function ensureGraftd(cwd: string): Promise<string> {
  const socketPath = workspaceSocketPath(cwd);
  if (await canConnect(socketPath)) return socketPath;
  await startGraftd(cwd, socketPath);
  return socketPath;
}

async function requestGraftd(
  cwd: string,
  op: string,
  params: JsonRecord = {},
  options: { spawnIfMissing?: boolean } = {},
): Promise<JsonValue> {
  const socketPath =
    options.spawnIfMissing === false ? workspaceSocketPath(cwd) : await ensureGraftd(cwd);
  const id = `pi-graft-${Date.now()}-${randomUUID()}`;
  const requestParams = GLOBAL_GRAFTD_OPS.has(op)
    ? params
    : { workspace_id: await workspaceIdForRequest(cwd), workspace_root: cwd, ...params };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, op, params: requestParams })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      socket.end();
      try {
        const response = JSON.parse(line) as WireResponse;
        if (!response.ok) {
          reject(
            new GraftdError(
              response.error ?? { code: "E_DAEMON", message: "graftd returned an error" },
            ),
          );
          return;
        }
        resolve(response.result ?? null);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => reject(error));
    socket.once("end", () => {
      if (buffer.trim().length === 0) reject(new Error("empty response from graftd"));
    });
  });
}

async function cliExec(cwd: string, argv: string[]): Promise<JsonRecord> {
  const result = await requestGraftd(cwd, "cli_exec", {
    argv: ["graft", "--cwd", cwd, ...argv] as JsonValue[],
  });
  if (!isRecord(result)) throw new Error("graftd cli_exec returned a non-object result");
  return result as JsonRecord;
}

function restoreState(ctx: PiGraftSessionContext): ActiveGraftScratchState | undefined {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  let state: ActiveGraftScratchState | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
    const data = isRecord(entry.data) ? entry.data : undefined;
    const nextState = data?.state;
    if (nextState === null) {
      state = undefined;
      continue;
    }
    if (!isRecord(nextState)) continue;
    const workspace = stringField(nextState, "workspace");
    const updatedAt = stringField(nextState, "updatedAt");
    if (!workspace || !updatedAt) continue;
    state = {
      workspace,
      updatedAt,
      workspaceId: stringField(nextState, "workspaceId"),
      base: stringField(nextState, "base"),
      lastScratch: stringField(nextState, "lastScratch"),
      lastCandidate: stringField(nextState, "lastCandidate"),
      lastPatch: stringField(nextState, "lastPatch"),
    };
  }
  return state;
}

function stateSummary(state: ActiveGraftScratchState | undefined): string {
  if (!state) {
    return "No pi-graft convenience state. Start scratch tools with base, or continue a returned scratch with from.";
  }
  return [
    `workspace: ${state.workspace}`,
    `workspaceId: ${state.workspaceId ?? "auto"}`,
    `base: ${state.base ?? "none"}`,
    `lastScratch: ${state.lastScratch ?? "none"}`,
    `lastCandidate: ${state.lastCandidate ?? "none"}`,
    `lastPatch: ${state.lastPatch ?? "none"}`,
    `updatedAt: ${state.updatedAt}`,
  ].join("\n");
}

function registerState(pi: PiGraftExtensionApi, state: ActiveGraftScratchState | undefined): void {
  pi.appendEntry?.(STATE_ENTRY, { state: state ?? null });
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "string") return [];
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}

function optionalBooleanParam(
  params: Record<string, unknown>,
  field: string,
  defaultValue = false,
): boolean {
  const value = params[field];
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function enumParam<const T extends readonly string[]>(
  params: Record<string, unknown>,
  field: string,
  fallback: T[number],
  values: T,
): T[number] {
  const value = params[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be one of: ${values.join(", ")}.`);
  }
  const normalized = value.trim().toLowerCase();
  if (!(values as readonly string[]).includes(normalized)) {
    throw new Error(`${field} must be one of: ${values.join(", ")}.`);
  }
  return normalized as T[number];
}

function stringArrayParam(params: Record<string, unknown>, field: string): string[] | undefined {
  const value = params[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be a string array.`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`${field}[${index}] must be a string.`);
    if (item.trim().length === 0) throw new Error(`${field}[${index}] must not be empty.`);
    return item;
  });
}

function cliArgvParam(params: Record<string, unknown>): string[] {
  const argv = stringArrayParam(params, "argv");
  if (!argv || argv.length === 0) {
    throw new Error("graft_cli_exec argv must be a non-empty string array.");
  }
  for (const [index, item] of argv.entries()) {
    if (item === "--cwd" || item.startsWith("--cwd=")) {
      throw new Error(
        `graft_cli_exec argv[${index}] must not set --cwd; pass the tool cwd parameter instead.`,
      );
    }
  }
  assertCliExecAllowed(argv);
  return argv;
}

function assertCliExecAllowed(argv: string[]): void {
  const primary = primaryCliCommand(argv);
  if (!primary) throw new Error("graft_cli_exec argv must include a graft command.");
  const secondary = secondaryCliCommand(argv, primary);
  if (isAllowedCliExecCommand(primary, secondary)) return;
  const command = secondary ? `${primary} ${secondary}` : primary;
  throw new Error(
    `graft_cli_exec does not allow graft ${command}. Use typed pi-graft tools for scratch/patch lifecycle operations, or graft_help for supported low-frequency CLI workflows.`,
  );
}

function isAllowedCliExecCommand(primary: string, secondary: string | undefined): boolean {
  if (primary === "explain" || primary === "incoming" || primary === "sync") return true;
  if (primary === "get" || primary === "run") return true;
  if (primary === "bundle") return secondary === "export" || secondary === "import";
  if (primary === "repo")
    return ["add", "list", "sync", "lock", "update"].includes(secondary ?? "");
  if (primary === "workspace") {
    return ["init", "status", "attach", "detach", "ps", "doctor", "gc"].includes(secondary ?? "");
  }
  if (primary === "patch") {
    return [
      "list",
      "show",
      "search",
      "diff",
      "compose",
      "migrate",
      "revert",
      "promote",
      "materialize",
    ].includes(secondary ?? "");
  }
  return false;
}

const DIRECT_CLI_COMMANDS = new Set([
  "attach",
  "cache",
  "candidate",
  "candidates",
  "clone",
  "detach",
  "diff",
  "discard",
  "doctor",
  "evidence",
  "explain",
  "incoming",
  "init",
  "ps",
  "scratch",
  "search",
  "show",
  "status",
]);

function primaryCliCommand(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--cwd") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--cwd=")) continue;
    if (arg === "--json") continue;
    if (arg === "--help" || arg === "-h") return arg;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function hasHelpFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

function secondaryCliCommand(argv: string[], primary: string): string | undefined {
  let foundPrimary = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--cwd") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--cwd=") || arg === "--json") continue;
    if (arg.startsWith("-")) continue;
    if (!foundPrimary) {
      foundPrimary = arg === primary;
      continue;
    }
    return arg;
  }
  return undefined;
}

function shouldRunDirectCli(argv: string[]): boolean {
  const primary = primaryCliCommand(argv);
  if (primary === undefined) return false;
  if (hasHelpFlag(argv)) return true;
  if (primary === "repo") {
    const subcommand = secondaryCliCommand(argv, primary);
    return subcommand === "list";
  }
  if (primary === "workspace") {
    const subcommand = secondaryCliCommand(argv, primary);
    if (subcommand === "gc") return !argv.includes("--apply");
    return ["init", "status", "attach", "detach", "ps", "doctor"].includes(subcommand ?? "");
  }
  if (primary === "patch") {
    const subcommand = secondaryCliCommand(argv, primary);
    return subcommand === "show" || subcommand === "search" || subcommand === "list";
  }
  if (primary === "registry") {
    return secondaryCliCommand(argv, primary) !== "import";
  }
  if (primary === "gc") {
    return !argv.includes("--apply");
  }
  return DIRECT_CLI_COMMANDS.has(primary);
}

function formatEnvelope(envelope: JsonRecord): string {
  const message = typeof envelope.message === "string" ? envelope.message : undefined;
  const candidate =
    typeof envelope.candidate_id === "string" ? `candidate: ${envelope.candidate_id}` : undefined;
  const patch = typeof envelope.patch_id === "string" ? `patch: ${envelope.patch_id}` : undefined;
  return (
    [message, candidate, patch].filter(Boolean).join("\n") || JSON.stringify(envelope, null, 2)
  );
}

function envelopeToolResult(
  envelope: JsonRecord,
  details: Record<string, unknown> = {},
): PiGraftToolResult {
  return {
    content: [{ type: "text", text: formatEnvelope(envelope) }],
    details: { envelope, ...details },
  };
}

async function executeCliArgv(
  cwd: string,
  argv: string[],
): Promise<{ text: string; details: Record<string, unknown> }> {
  if (shouldRunDirectCli(argv)) {
    const execution = await runDirectGraft(cwd, argv);
    const envelope = tryParseJsonRecord(execution.stdout);
    return {
      text: envelope ? formatEnvelope(envelope) : formatDirectOutput(execution),
      details: { envelope, execution },
    };
  }
  const envelope = await cliExec(cwd, argv);
  const execution: DaemonGraftExecution = {
    mode: "daemon",
    cwd,
    argv: ["graft", "--cwd", cwd, ...argv],
  };
  return { text: formatEnvelope(envelope), details: { envelope, execution } };
}

async function notifyCliExec(
  ctx: PiGraftCommandContext,
  argv: string[],
  fallbackMessage: string,
): Promise<void> {
  const result = await executeCliArgv(ctx.cwd, argv);
  ctx.ui?.notify?.(result.text || fallbackMessage, "info");
}

interface ParsedAnchor {
  line: number;
  hash: string;
  textHint?: string;
}

function parseAnchorRef(ref: unknown, field: string): ParsedAnchor {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new Error(`${field} must be a LINE#HASH anchor from graft read output.`);
  }
  const parsed = parseLineHashAnchor(ref);
  if (!parsed) throw new Error(`${field} must use LINE#HASH, got ${JSON.stringify(ref)}.`);
  const line = Number.parseInt(parsed.lineText, 10);
  const hash = parsed.hash;
  if (!Number.isInteger(line) || line < 1) throw new Error(`${field} line must be >= 1.`);
  if (hash.length !== 2) throw new Error(`${field} hash must be exactly 2 characters.`);
  return parsed.textHint === undefined ? { line, hash } : { line, hash, textHint: parsed.textHint };
}

function parseLineHashAnchor(
  ref: string,
): { lineText: string; hash: string; textHint?: string } | undefined {
  const value = ref.trimEnd();
  let index = 0;
  while (index < value.length && isWhitespace(value[index]!)) index += 1;
  while (index < value.length && isAnchorPrefix(value[index]!)) index += 1;
  while (index < value.length && isWhitespace(value[index]!)) index += 1;
  const lineStart = index;
  while (index < value.length && isDigit(value[index]!)) index += 1;
  const lineText = value.slice(lineStart, index);
  if (!lineText) return undefined;
  while (index < value.length && isWhitespace(value[index]!)) index += 1;
  if (value[index] !== "#") return undefined;
  index += 1;
  while (index < value.length && isWhitespace(value[index]!)) index += 1;
  const hashStart = index;
  while (index < value.length && !isWhitespace(value[index]!) && value[index] !== ":") index += 1;
  const hash = value.slice(hashStart, index);
  if (!hash) return undefined;
  while (index < value.length && isWhitespace(value[index]!)) index += 1;
  if (index >= value.length) return { lineText, hash };
  if (value[index] !== ":") return undefined;
  return { lineText, hash, textHint: value.slice(index + 1) };
}

function isAnchorPrefix(char: string): boolean {
  return char === ">" || char === "+" || char === "-";
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isWhitespace(char: string): boolean {
  return char.trim() === "";
}

function normalizeEditLines(value: unknown, field: string): string[] {
  if (value === null) return [];
  if (typeof value === "string") {
    const withoutOneTrailingNewline = value.endsWith("\n") ? value.slice(0, -1) : value;
    return withoutOneTrailingNewline.replaceAll("\r", "").split("\n");
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new Error(`${field} must be a string, string array, or null.`);
}

function isHashlineDisplayPrefixed(line: string): boolean {
  return (
    /^\s*(?:>>>\s*)?\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2}:/.test(line) ||
    /^\+\s*\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2}:/.test(line)
  );
}

function assertLiteralLines(lines: string[]): void {
  for (const line of lines) {
    if (isHashlineDisplayPrefixed(line)) {
      throw new Error(
        `E_INVALID_PATCH: edit lines must be literal file content, not rendered LINE#HASH output: ${JSON.stringify(line)}`,
      );
    }
  }
}

function convertHashlineEdit(edit: unknown, index: number): JsonRecord {
  if (!isRecord(edit)) throw new Error(`edits[${index}] must be an object.`);
  if ("oldText" in edit || "newText" in edit || "old_text" in edit || "new_text" in edit) {
    throw new Error(
      `edits[${index}] uses exact-text replacement fields; pi-graft edit is strict hashline-only.`,
    );
  }
  const op = edit.op;
  if (op !== "replace" && op !== "append" && op !== "prepend") {
    throw new Error(`edits[${index}].op must be replace, append, or prepend.`);
  }

  const lines = normalizeEditLines(edit.lines, `edits[${index}].lines`);
  assertLiteralLines(lines);

  if (op === "replace") {
    const start = parseAnchorRef(edit.pos, `edits[${index}].pos`);
    if (edit.end !== undefined) {
      const end = parseAnchorRef(edit.end, `edits[${index}].end`);
      return {
        kind: "replace_range",
        start_line: start.line,
        start_hash: start.hash,
        end_line: end.line,
        end_hash: end.hash,
        new_lines: lines,
      };
    }
    const old = typeof edit.old === "string" ? edit.old : start.textHint;
    if (old === undefined) {
      throw new Error(
        `edits[${index}] replace requires old, or pos copied with the ':old line' suffix from read output.`,
      );
    }
    return { kind: "replace_line", line: start.line, hash: start.hash, old, new: lines.join("\n") };
  }

  const anchor = parseAnchorRef(edit.pos, `edits[${index}].pos`);
  return {
    kind: op === "append" ? "insert_after" : "insert_before",
    line: anchor.line,
    hash: anchor.hash,
    new_lines: lines,
  };
}

function convertHashlineEdits(value: unknown): JsonValue[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("edit requires a non-empty edits array.");
  return value.map((edit, index) => convertHashlineEdit(edit, index) as JsonValue);
}

function renderHashlineSlice(
  content: string,
  offset?: unknown,
  limit?: unknown,
): { text: string; nextOffset?: number } {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const start = typeof offset === "number" && Number.isInteger(offset) && offset > 0 ? offset : 1;
  const max = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : undefined;
  const selected = lines.slice(start - 1, max ? start - 1 + max : undefined);
  const nextOffset = max && start - 1 + max < lines.length ? start + max : undefined;
  const suffix = nextOffset
    ? `\n\n[Showing lines ${start}-${start + selected.length - 1} of ${lines.length}. Use offset=${nextOffset} to continue.]`
    : "";
  return { text: `${selected.join("\n")}${suffix}`, nextOffset };
}

interface ScratchSourceSelection {
  params: JsonRecord;
  base?: string;
  from?: string;
  usedLastScratch: boolean;
}

function stateForCwd(
  state: ActiveGraftScratchState | undefined,
  cwd: string,
): ActiveGraftScratchState | undefined {
  return state?.workspace === cwd ? state : undefined;
}

function toolCwd(
  ctx: PiGraftToolContext | undefined,
  state: ActiveGraftScratchState | undefined,
  fallbackCwd: string | undefined,
): string {
  const cwd = ctx?.cwd ?? state?.workspace ?? fallbackCwd;
  if (!cwd) throw new Error("pi-graft tools require a cwd context or restored session state.");
  return cwd;
}

function scratchSourceSelection(
  params: Record<string, unknown>,
  state: ActiveGraftScratchState | undefined,
): ScratchSourceSelection {
  const base = optionalStringParam(params, "base");
  const from = optionalStringParam(params, "from");
  if (base && from) throw new Error("base and from are mutually exclusive.");
  if (base) return { params: { base }, base, usedLastScratch: false };
  if (from) return { params: { from }, from, usedLastScratch: false };
  if (state?.lastScratch) {
    return { params: { from: state.lastScratch }, from: state.lastScratch, usedLastScratch: true };
  }
  throw new Error(
    "scratch operation requires base or from; pass base for the first operation or from to continue a returned scratch.",
  );
}

type StateUpdates = Partial<Omit<ActiveGraftScratchState, "workspace" | "updatedAt" | "base">> & {
  base?: string | null;
};

function mergeState(
  previous: ActiveGraftScratchState | undefined,
  cwd: string,
  updates: StateUpdates,
): ActiveGraftScratchState {
  const sameWorkspace = previous?.workspace === cwd ? previous : undefined;
  const base = updates.base === null ? undefined : (updates.base ?? sameWorkspace?.base);
  return {
    workspace: cwd,
    workspaceId: updates.workspaceId ?? sameWorkspace?.workspaceId,
    base,
    lastScratch: updates.lastScratch ?? sameWorkspace?.lastScratch,
    lastCandidate: updates.lastCandidate ?? sameWorkspace?.lastCandidate,
    lastPatch: updates.lastPatch ?? sameWorkspace?.lastPatch,
    updatedAt: new Date().toISOString(),
  };
}

function sourceBaseUpdate(
  source: ScratchSourceSelection,
  previous: ActiveGraftScratchState | undefined,
): string | null | undefined {
  if (source.base) return source.base;
  if (source.usedLastScratch || source.from === previous?.lastScratch) return undefined;
  return null;
}

function sourceDescription(source: ScratchSourceSelection): string {
  if (source.base) return `base ${source.base}`;
  if (source.usedLastScratch) return `last scratch ${source.from}`;
  return `scratch ${source.from}`;
}

function scratchSourceSchema(): Record<string, unknown> {
  return {
    base: Type.Optional(
      Type.String({
        description:
          "Base ref for the first scratch operation: graft:empty, tree:<id>, candidate:<id>, or patch:<id>.",
      }),
    ),
    from: Type.Optional(Type.String({ description: "Scratch id to continue editing." })),
  };
}

export function registerPiGraftExtension(pi: PiGraftExtensionApi): void {
  registerPiGraftPatchTool(pi);

  let activeState: ActiveGraftScratchState | undefined;
  let lastCwd: string | undefined;

  function rememberState(cwd: string, updates: StateUpdates): ActiveGraftScratchState {
    activeState = mergeState(activeState, cwd, updates);
    if (activeState.workspaceId) workspaceIdsByRoot.set(cwd, activeState.workspaceId);
    registerState(pi, activeState);
    return activeState;
  }

  pi.on("session_start", (_event: unknown, ctx: PiGraftSessionContext) => {
    lastCwd = ctx.cwd;
    activeState = restoreState(ctx);
    if (activeState?.workspaceId)
      workspaceIdsByRoot.set(activeState.workspace, activeState.workspaceId);
  });

  pi.registerCommand("graft-attach", {
    description: "Attach cwd to a graft workspace route: /graft-attach [workspace-id|--status]",
    handler: async (args: string, ctx: PiGraftCommandContext) => {
      const trimmed = args.trim();
      const argv =
        trimmed === "--status" ? ["workspace", "attach", "--status"] : ["workspace", "attach"];
      if (trimmed && trimmed !== "--status") argv.push("--workspace", trimmed);
      await notifyCliExec(ctx, argv, "Attached graft workspace route.");
    },
  });

  pi.registerCommand("graft-detach", {
    description: "Detach cwd from its graft workspace route: /graft-detach",
    handler: async (_args: string, ctx: PiGraftCommandContext) => {
      await notifyCliExec(ctx, ["workspace", "detach"], "Detached graft workspace route.");
    },
  });

  pi.registerCommand("graft-ps", {
    description: "Show graft global daemon and registry status: /graft-ps",
    handler: async (_args: string, ctx: PiGraftCommandContext) => {
      await notifyCliExec(ctx, ["workspace", "ps"], "Graft ps completed.");
    },
  });

  pi.registerCommand("graft-doctor", {
    description: "Diagnose graft registry state: /graft-doctor [--rebuild-registry]",
    handler: async (args: string, ctx: PiGraftCommandContext) => {
      const argv = ["workspace", "doctor"];
      const flags = args.trim() ? args.trim().split(/\s+/) : [];
      for (const flag of flags) {
        if (flag !== "--rebuild-registry") {
          throw new Error(`unknown graft-doctor argument: ${flag}`);
        }
      }
      if (flags.includes("--rebuild-registry")) argv.push("--rebuild-registry");
      await notifyCliExec(ctx, argv, "Graft doctor completed.");
    },
  });

  pi.registerCommand("graft-close", {
    description: "Clear pi-graft convenience state for the current session: /graft-close",
    handler: async (_args: string, ctx: PiGraftCommandContext) => {
      const hadState = activeState !== undefined;
      activeState = undefined;
      registerState(pi, undefined);
      ctx.ui?.notify?.(
        hadState
          ? "Cleared pi-graft convenience state. Returned scratch ids can still be passed explicitly as from while graftd keeps them."
          : "No pi-graft convenience state.",
        "info",
      );
    },
  });

  pi.registerTool({
    name: "graft_help",
    label: "Graft Help",
    description: "Show maintained Graft workflow or command help.",
    parameters: Type.Object({
      topic: Type.Optional(
        Type.String({ description: "Explain topic; defaults to agent-workflow." }),
      ),
      command: Type.Optional(Type.Array(Type.String({ description: "Command token for --help." }))),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const topic = optionalStringParam(params, "topic");
      const command = stringArrayParam(params, "command");
      if (topic && command)
        throw new Error("graft_help accepts either topic or command, not both.");
      if (command && command.length === 0) throw new Error("graft_help command must not be empty.");
      const argv = command ? [...command, "--help"] : ["explain", topic ?? "agent-workflow"];
      const execution = await runDirectGraft(cwd, argv);
      return {
        content: [{ type: "text", text: formatDirectOutput(execution) }],
        details: {
          mode: command ? "command-help" : "explain",
          topic: command ? undefined : (topic ?? "agent-workflow"),
          command,
          execution,
        },
      };
    },
  });

  pi.registerTool({
    name: "graft_init",
    label: "Graft Init",
    description: "Initialize or register a Graft workspace.",
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "Workspace directory; defaults to ctx.cwd." })),
      registerOnly: Type.Optional(
        Type.Boolean({ description: "Only register an existing workspace." }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = optionalStringParam(params, "cwd") ?? toolCwd(ctx, activeState, lastCwd);
      const argv = ["--json", "workspace", "init"];
      if (optionalBooleanParam(params, "registerOnly")) argv.push("--register-only");
      const { envelope, execution } = await directCliJson(cwd, argv);
      const workspaceId = workspaceIdFromEnvelope(envelope);
      const state = workspaceId ? rememberState(cwd, { workspaceId }) : undefined;
      lastCwd = cwd;
      return envelopeToolResult(envelope, { execution, state });
    },
  });

  pi.registerTool({
    name: "graft_status",
    label: "Graft Status",
    description: "Inspect pi-graft convenience state and graftd status.",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const state = stateForCwd(activeState, cwd);
      let daemon: JsonValue | undefined;
      let daemonText = "graftd: unavailable";
      try {
        daemon = await requestGraftd(cwd, "status");
        daemonText = `graftd: ${stringField(daemon, "status") ?? "ok"}`;
      } catch (error) {
        daemonText = `graftd: unavailable (${compactError(error)})`;
      }
      return {
        content: [{ type: "text", text: `${stateSummary(state)}\n${daemonText}` }],
        details: { active: Boolean(state), state, daemon },
      };
    },
  });

  pi.registerTool({
    name: "graft_ps",
    label: "Graft Ps",
    description: "Show global daemon and registry status.",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const { envelope, execution } = await directCliJson(cwd, ["--json", "workspace", "ps"]);
      return envelopeToolResult(envelope, { execution });
    },
  });

  pi.registerTool({
    name: "graft_doctor",
    label: "Graft Doctor",
    description: "Diagnose or repair the Graft registry.",
    parameters: Type.Object({
      rebuildRegistry: Type.Optional(
        Type.Boolean({ description: "Rebuild missing registry entries." }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const argv = ["--json", "workspace", "doctor"];
      if (optionalBooleanParam(params, "rebuildRegistry")) argv.push("--rebuild-registry");
      const { envelope, execution } = await directCliJson(cwd, argv);
      return envelopeToolResult(envelope, { execution });
    },
  });

  pi.registerTool({
    name: "graft_read",
    label: "Graft Read",
    description: "Read a UTF-8 file from a graft scratch as LINE#HASH text.",
    parameters: Type.Object({
      ...scratchSourceSchema(),
      path: Type.String({ description: "Path to read from the graft scratch source." }),
      offset: Type.Optional(
        Type.Number({ description: "Line number to start reading from (1-indexed)." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return." })),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const previousState = stateForCwd(activeState, cwd);
      const source = scratchSourceSelection(params, previousState);
      const path = typeof params.path === "string" ? params.path : undefined;
      if (!path) throw new Error("graft_read requires path.");
      const result = await requestGraftd(cwd, "scratch_read", {
        ...source.params,
        path,
        mode: "hashlines",
      });
      const content = stringField(result, "content");
      const scratch = stringField(result, "scratch");
      if (content === undefined || !scratch)
        throw new Error(
          `graftd scratch_read did not return content and scratch: ${JSON.stringify(result)}`,
        );
      const nextState = rememberState(cwd, {
        base: sourceBaseUpdate(source, previousState),
        lastScratch: scratch,
      });
      const rendered = renderHashlineSlice(content, params.offset, params.limit);
      return {
        content: [{ type: "text", text: rendered.text }],
        details: { result, state: nextState, source, nextOffset: rendered.nextOffset },
      };
    },
  });

  pi.registerTool({
    name: "graft_write",
    label: "Graft Write",
    description: "Write a UTF-8 file into a graft scratch.",
    parameters: Type.Object({
      ...scratchSourceSchema(),
      path: Type.String({ description: "Path to write in the graft scratch source." }),
      content: Type.String({ description: "Complete UTF-8 text content to write." }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const previousState = stateForCwd(activeState, cwd);
      const source = scratchSourceSelection(params, previousState);
      const path = typeof params.path === "string" ? params.path : undefined;
      const content = typeof params.content === "string" ? params.content : undefined;
      if (!path) throw new Error("graft_write requires path.");
      if (content === undefined) throw new Error("graft_write requires content.");
      const result = await requestGraftd(cwd, "scratch_write", { ...source.params, path, content });
      const scratch = stringField(result, "scratch");
      if (!scratch)
        throw new Error(`graftd scratch_write did not return scratch: ${JSON.stringify(result)}`);
      const nextState = rememberState(cwd, {
        base: sourceBaseUpdate(source, previousState),
        lastScratch: scratch,
      });
      return {
        content: [
          {
            type: "text",
            text: `Wrote ${path} from ${sourceDescription(source)} into graft scratch ${scratch}.`,
          },
        ],
        details: { result, state: nextState, source },
      };
    },
  });

  pi.registerTool({
    name: "graft_edit",
    label: "Graft Edit",
    description: "Apply strict LINE#HASH edits into a graft scratch.",
    parameters: Type.Object({
      ...scratchSourceSchema(),
      path: Type.String({ description: "Path to edit in the graft scratch source." }),
      edits: Type.Array(
        Type.Object({
          op: Type.String({ description: "replace, append, or prepend" }),
          pos: Type.Optional(
            Type.String({ description: "LINE#HASH anchor, optionally with :line text suffix." }),
          ),
          end: Type.Optional(
            Type.String({
              description: "Optional inclusive range end LINE#HASH anchor for replace.",
            }),
          ),
          old: Type.Optional(
            Type.String({
              description: "Original line text for single-line replace when pos lacks :text.",
            }),
          ),
          lines: Type.Optional(
            Type.Any({
              description: "Replacement/insertion literal content: string, string[], or null.",
            }),
          ),
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      if (
        "oldText" in params ||
        "newText" in params ||
        "old_text" in params ||
        "new_text" in params
      ) {
        throw new Error(
          "pi-graft graft_edit is strict hashline-only; call graft_read first and use edits[].op/pos/lines.",
        );
      }
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const previousState = stateForCwd(activeState, cwd);
      const source = scratchSourceSelection(params, previousState);
      const path = typeof params.path === "string" ? params.path : undefined;
      if (!path) throw new Error("graft_edit requires path.");
      const edits = convertHashlineEdits(params.edits);
      const result = await requestGraftd(cwd, "scratch_edit", { ...source.params, path, edits });
      const scratch = stringField(result, "scratch");
      const updatedAnchors = stringField(result, "updated_anchors");
      if (!scratch)
        throw new Error(`graftd scratch_edit did not return scratch: ${JSON.stringify(result)}`);
      const nextState = rememberState(cwd, {
        base: sourceBaseUpdate(source, previousState),
        lastScratch: scratch,
      });
      return {
        content: [
          {
            type: "text",
            text: `Edited ${path} from ${sourceDescription(source)} into graft scratch ${scratch}.${updatedAnchors ? `\n\n--- Updated anchors ---\n${updatedAnchors}` : ""}`,
          },
        ],
        details: { result, state: nextState, source },
      };
    },
  });

  pi.registerTool({
    name: "graft_delete",
    label: "Graft Delete",
    description: "Delete a file from a graft scratch.",
    parameters: Type.Object({
      ...scratchSourceSchema(),
      path: Type.String({ description: "Path to delete in the graft scratch source." }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const previousState = stateForCwd(activeState, cwd);
      const source = scratchSourceSelection(params, previousState);
      const path = typeof params.path === "string" ? params.path : undefined;
      if (!path) throw new Error("graft_delete requires path.");
      const result = await requestGraftd(cwd, "scratch_delete", { ...source.params, path });
      const scratch = stringField(result, "scratch");
      if (!scratch)
        throw new Error(`graftd scratch_delete did not return scratch: ${JSON.stringify(result)}`);
      const changedPaths = stringArrayField(result, "changed_paths") ?? [];
      const nextState = rememberState(cwd, {
        base: sourceBaseUpdate(source, previousState),
        lastScratch: scratch,
      });
      return {
        content: [
          {
            type: "text",
            text: `Deleted ${path} from ${sourceDescription(source)} into graft scratch ${scratch}. Changed paths: ${changedPaths.length ? changedPaths.join(", ") : "none"}`,
          },
        ],
        details: { result, state: nextState, source },
      };
    },
  });

  pi.registerTool({
    name: "graft_candidate_from_scratch",
    label: "Graft Candidate From Scratch",
    description: "Create a candidate from a scratch id.",
    parameters: Type.Object({
      scratch: Type.Optional(
        Type.String({
          description: "Scratch id to turn into a candidate. Defaults to lastScratch.",
        }),
      ),
      expected: Type.Optional(
        Type.Array(
          Type.String({ description: "Expected workspace property, e.g. CargoTestsPass" }),
        ),
      ),
      producer: Type.Optional(
        Type.String({ description: "Candidate provenance producer. Defaults to pi-graft." }),
      ),
      message: Type.Optional(Type.String({ description: "Candidate message." })),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const previousState = stateForCwd(activeState, cwd);
      const scratch = optionalStringParam(params, "scratch") ?? previousState?.lastScratch;
      if (!scratch)
        throw new Error(
          "graft_candidate_from_scratch requires scratch or a previous scratch tool result in this workspace.",
        );
      const result = await requestGraftd(cwd, "candidate_from_scratch", {
        scratch,
        expected: normalizeStringList(params.expected) as JsonValue[],
        producer:
          typeof params.producer === "string" && params.producer
            ? params.producer
            : "@zendev-lab/pi-graft",
        message: typeof params.message === "string" ? params.message : null,
      });
      const candidate = stringField(result, "candidate");
      if (!candidate)
        throw new Error(
          `graftd candidate_from_scratch did not return candidate: ${JSON.stringify(result)}`,
        );
      const changedPaths = stringArrayField(result, "changed_paths") ?? [];
      const nextState = rememberState(cwd, {
        lastScratch: stringField(result, "scratch") ?? scratch,
        lastCandidate: candidate,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created candidate ${candidate} from scratch ${scratch}. Changed paths: ${changedPaths.length ? changedPaths.join(", ") : "none"}`,
          },
        ],
        details: { result, state: nextState },
      };
    },
  });

  pi.registerTool({
    name: "graft_validate",
    label: "Graft Validate",
    description: "Validate a candidate or patch.",
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({
          description:
            "Candidate or patch id. Defaults to the last graft_candidate_from_scratch candidate.",
        }),
      ),
      expected: Type.Optional(
        Type.Array(Type.String({ description: "Additional expected property." })),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const state = stateForCwd(activeState, cwd);
      const target = optionalStringParam(params, "target") ?? state?.lastCandidate;
      if (!target)
        throw new Error(
          "graft_validate requires target or a previous graft_candidate_from_scratch candidate.",
        );
      const argv = ["patch", "validate", target];
      for (const expected of normalizeStringList(params.expected)) argv.push("--expect", expected);
      const envelope = await cliExec(cwd, argv);
      return { content: [{ type: "text", text: formatEnvelope(envelope) }], details: { envelope } };
    },
  });

  pi.registerTool({
    name: "graft_admit",
    label: "Graft Admit",
    description: "Admit a validated candidate as a patch.",
    parameters: Type.Object({
      candidate: Type.Optional(
        Type.String({
          description: "Candidate id. Defaults to the last graft_candidate_from_scratch candidate.",
        }),
      ),
      required: Type.Optional(
        Type.Array(Type.String({ description: "Required passed property." })),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const state = stateForCwd(activeState, cwd);
      const candidate = optionalStringParam(params, "candidate") ?? state?.lastCandidate;
      if (!candidate)
        throw new Error(
          "graft_admit requires candidate or a previous graft_candidate_from_scratch candidate.",
        );
      const argv = ["patch", "admit", candidate];
      for (const required of normalizeStringList(params.required)) argv.push("--require", required);
      const envelope = await cliExec(cwd, argv);
      const patch =
        typeof envelope.patch_id === "string" ? envelope.patch_id : stringField(envelope, "patch");
      let nextState = state;
      if (patch) {
        nextState = rememberState(cwd, { lastPatch: patch });
      }
      return {
        content: [{ type: "text", text: formatEnvelope(envelope) }],
        details: { envelope, state: nextState },
      };
    },
  });

  pi.registerTool({
    name: "graft_show",
    label: "Graft Show",
    description: "Show a candidate or patch summary.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Candidate or patch id." })),
      evidence: Type.Optional(Type.Boolean({ description: "Include evidence details." })),
      change: Type.Optional(Type.Boolean({ description: "Include file change details." })),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const state = stateForCwd(activeState, cwd);
      const target =
        optionalStringParam(params, "target") ?? state?.lastPatch ?? state?.lastCandidate;
      if (!target) throw new Error("graft_show requires target or a previous candidate/patch.");
      const argv = ["--json", "patch", "show", target];
      if (optionalBooleanParam(params, "evidence")) argv.push("--evidence");
      if (optionalBooleanParam(params, "change")) argv.push("--change");
      const { text, details } = await executeCliArgv(cwd, argv);
      return { content: [{ type: "text", text }], details: { state, ...details } };
    },
  });

  pi.registerTool({
    name: "graft_evidence",
    label: "Graft Evidence",
    description: "List evidence for a candidate or patch.",
    parameters: Type.Object({
      subject: Type.Optional(Type.String({ description: "Candidate or patch id." })),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const state = stateForCwd(activeState, cwd);
      const subject =
        optionalStringParam(params, "subject") ?? state?.lastPatch ?? state?.lastCandidate;
      if (!subject)
        throw new Error("graft_evidence requires subject or a previous candidate/patch.");
      const { text, details } = await executeCliArgv(cwd, ["--json", "evidence", subject]);
      return { content: [{ type: "text", text }], details: { state, ...details } };
    },
  });

  pi.registerTool({
    name: "graft_candidates",
    label: "Graft Candidates",
    description: "List unadmitted candidates.",
    parameters: Type.Object({
      constraint: Type.Optional(
        Type.String({ description: "Filter by expected constraint primitive." }),
      ),
      failed: Type.Optional(Type.Boolean({ description: "Show only failed candidates." })),
      producer: Type.Optional(Type.String({ description: "Filter by producer." })),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      if ("property" in params)
        throw new Error("graft_candidates property was renamed to constraint.");
      const argv = ["--json", "candidates"];
      const constraint = optionalStringParam(params, "constraint");
      const producer = optionalStringParam(params, "producer");
      if (constraint) argv.push("--constraint", constraint);
      if (optionalBooleanParam(params, "failed")) argv.push("--failed");
      if (producer) argv.push("--producer", producer);
      const { text, details } = await executeCliArgv(cwd, argv);
      return { content: [{ type: "text", text }], details };
    },
  });

  pi.registerTool({
    name: "graft_search",
    label: "Graft Search",
    description: "Search admitted patches.",
    parameters: Type.Object({
      constraint: Type.Optional(Type.String({ description: "Filter by constraint primitive." })),
      base: Type.Optional(Type.String({ description: "Filter by base state." })),
      producer: Type.Optional(Type.String({ description: "Filter by producer." })),
      hasEvidence: Type.Optional(
        Type.String({ description: "Filter by passing evidence property." }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      if ("property" in params) throw new Error("graft_search property was renamed to constraint.");
      const argv = ["--json", "patch", "search"];
      const constraint = optionalStringParam(params, "constraint");
      const base = optionalStringParam(params, "base");
      const producer = optionalStringParam(params, "producer");
      const hasEvidence = optionalStringParam(params, "hasEvidence");
      if (constraint) argv.push("--constraint", constraint);
      if (base) argv.push("--base", base);
      if (producer) argv.push("--producer", producer);
      if (hasEvidence) argv.push("--has-evidence", hasEvidence);
      const { text, details } = await executeCliArgv(cwd, argv);
      return { content: [{ type: "text", text }], details };
    },
  });

  pi.registerTool({
    name: "graft_materialize",
    label: "Graft Materialize",
    description: "Plan or materialize an admitted patch target.",
    parameters: Type.Object({
      patch: Type.Optional(
        Type.String({ description: "Patch id; defaults to last admitted patch." }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({ description: "Plan without writing; defaults to true." }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const state = stateForCwd(activeState, cwd);
      const patch = optionalStringParam(params, "patch") ?? state?.lastPatch;
      if (!patch) throw new Error("graft_materialize requires patch or a previous admitted patch.");
      const argv = ["patch", "materialize", patch];
      if (optionalBooleanParam(params, "dryRun", true)) argv.push("--dry-run");
      const envelope = await cliExec(cwd, argv);
      return envelopeToolResult(envelope, { state });
    },
  });

  pi.registerTool({
    name: "graft_repo",
    label: "Graft Repo",
    description:
      "Manage Graft configured repositories through the current repo add/list/sync/lock/update workflow.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({ description: "Action: add, list, sync, lock, or update. Default: list." }),
      ),
      repoId: Type.Optional(
        Type.String({
          description:
            "Repository id. Required for action=add; optional filter for sync/lock/update.",
        }),
      ),
      url: Type.Optional(Type.String({ description: "Repository URL or local path for add." })),
      defaultBranch: Type.Optional(
        Type.String({ description: "Default branch label to record for add." }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to ctx.cwd." })),
    }),
    renderCall(args, theme) {
      return renderGraftToolCall(
        "graft_repo",
        [
          formatGraftStringArg(args.action, { prefix: "action=", fallback: "list" }),
          formatGraftStringArg(args.repoId, { prefix: "repo=" }),
          formatGraftStringArg(args.url, { prefix: "url=", maxLength: 60 }),
          formatGraftStringArg(args.cwd, { prefix: "cwd=", maxLength: 60 }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const action = enumParam(params, "action", "list", GRAFT_REPO_ACTIONS);
      if ("cwd" in params && typeof params.cwd !== "string")
        throw new Error("cwd must be a string.");
      const cwd = optionalStringParam(params, "cwd") ?? toolCwd(ctx, activeState, lastCwd);
      const repoId = optionalStringParam(params, "repoId");
      const url = optionalStringParam(params, "url");
      const defaultBranch = optionalStringParam(params, "defaultBranch");
      const argv = ["repo", action];

      if (action === "add") {
        if (!repoId) throw new Error("graft_repo action=add requires repoId.");
        if (!url) throw new Error("graft_repo action=add requires url.");
        argv.push(repoId, url);
        if (defaultBranch) argv.push("--default-branch", defaultBranch);
      } else {
        if (url) throw new Error(`graft_repo action=${action} does not accept url.`);
        if (defaultBranch)
          throw new Error(`graft_repo action=${action} does not accept defaultBranch.`);
        if (repoId && action !== "list") argv.push(repoId);
      }

      const { text, details } = await executeCliArgv(cwd, argv);
      return { content: [{ type: "text", text }], details: { action, repoId, ...details } };
    },
  });

  pi.registerTool({
    name: "graft_cli_exec",
    label: "Graft CLI Exec",
    description:
      "Run allowlisted low-frequency Graft CLI argv: explain/incoming/sync/get/run, bundle export/import, repo add/list/sync/lock/update, workspace init/status/attach/detach/ps/doctor/gc, and patch list/show/search/diff/compose/migrate/revert/promote/materialize.",
    parameters: Type.Object({
      argv: Type.Array(
        Type.String({ description: "Graft CLI arguments, excluding the graft binary." }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to ctx.cwd." })),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const argv = cliArgvParam(params);
      if ("cwd" in params && typeof params.cwd !== "string")
        throw new Error("cwd must be a string.");
      const cwd = optionalStringParam(params, "cwd") ?? toolCwd(ctx, activeState, lastCwd);
      const { text, details } = await executeCliArgv(cwd, argv);
      return { content: [{ type: "text", text }], details };
    },
  });
}

function renderGraftToolCall(
  toolName: string,
  parts: Array<string | undefined>,
  theme: PiGraftToolRenderTheme,
): PiGraftToolCallComponent {
  const title =
    theme.fg?.("toolTitle", theme.bold?.(`${toolName} `) ?? `${toolName} `) ?? `${toolName} `;
  const renderedParts = parts.filter((part): part is string => Boolean(part));
  const renderedArgs = theme.fg?.("muted", renderedParts.join(" ")) ?? renderedParts.join(" ");
  return new PiGraftToolCallText(`${title}${renderedArgs}`.trimEnd());
}

function formatGraftStringArg(
  value: unknown,
  options: { prefix?: string; fallback?: string; maxLength?: number } = {},
): string | undefined {
  const raw = typeof value === "string" && value.trim() ? value.trim() : options.fallback;
  if (!raw) return undefined;
  const maxLength = options.maxLength ?? 80;
  const normalized = raw.length <= maxLength ? raw : `${raw.slice(0, Math.max(0, maxLength - 1))}…`;
  const rendered = /\s/u.test(normalized) ? JSON.stringify(normalized) : normalized;
  return `${options.prefix ?? ""}${rendered}`;
}

export default function piGraftExtension(pi: PiGraftExtensionApi): void {
  registerPiGraftExtension(pi);
}
