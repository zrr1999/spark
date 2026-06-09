/**
 * pi-cue extension
 *
 * Atomic execution tools organized by the three category objects:
 *
 *   Execution:
 *     cue_exec     — execute a command and create a job
 *     cue_run      — run a `.cue` file-script (sequential, fail-fast)
 *     cue_script   — run an inline `.cue` script body (sequential, fail-fast)
 *     script_run   — run a script file with an explicit language
 *     script_eval  — run an inline script with an explicit language
 *
 *   Jobs:
 *     cue_jobs     — list, inspect, wait for, or stop jobs
 *
 *   Schedules:
 *     cue_schedule — add, list, pause, resume, or remove scheduled jobs
 *
 *   System:
 *     cue_scope    — inspect scopes, env, or config
 *     cue_history  — show job and daemon history
 *
 * See ARCHITECTURE.md for the category-theoretic model.
 */

import type { ExtensionAPI } from "pi-extension-api";
import * as nodePath from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface PiCueExtensionApi {
  registerTool(config: PiCueToolConfig): void;
  on?(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void;
  getAllTools?(): Array<{ name: string }>;
  setActiveTools?(names: string[]): void;
}

export type PiCueNotifyLevel = "info" | "warning" | "error" | "success";

export interface PiCueToolContext {
  cwd?: string;
  ui?: { notify?: (msg: string, level: PiCueNotifyLevel) => void };
}

export interface PiCueToolConfig {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: PiCueToolContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

interface ToolCallRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

interface ToolCallComponent {
  render(width: number): string[];
}

class ToolCallText implements ToolCallComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}

export { CueClient, CueError, defaultSocketPath, resolveCueTransport } from "./cue-client.ts";
export type {
  CueResolvedTransport,
  JobInfo,
  JobResult,
  JobStatus,
  ScriptItemSummary,
  ScriptResult,
  StartJobResult,
} from "./cue-client.ts";
export {
  __resetForTests as __resetVersionCheckForTests,
  checkAndWarn as checkCuedVersionAndWarn,
  classifyDaemonVersion,
  compareSemver,
  fetchLatestRelease,
  renderWarning as renderCuedVersionWarning,
} from "./version-check.ts";
export type { DaemonVersion, VersionCheckOptions, VersionVerdict } from "./version-check.ts";

import {
  CueClient,
  CueError,
  type CueResolvedTransport,
  type JobInfo,
  type JobStatus,
  type ScriptResult,
  resolveCueTransport,
} from "./cue-client.ts";
import { checkAndWarn as checkCuedVersionAndWarn } from "./version-check.ts";

// ── Shared state ───────────────────────────────────────────────────────────

let client: CueClient | null = null;

async function getClient(ctx?: {
  ui?: { notify?: (msg: string, level: PiCueNotifyLevel) => void };
}): Promise<CueClient> {
  if (client && !client.isClosed) return client;
  client = null;
  const transport = await resolveCueTransport();
  const socketPath = socketPathForPiCue(transport);
  try {
    client = await CueClient.connect(socketPath);
  } catch {
    // Daemon not running — auto-start local/unix transports only.
    ctx?.ui?.notify?.("cue-shell: auto-starting daemon…", "info");
    try {
      await autoStartDaemon(socketPath);
    } catch (startErr) {
      const msg = `cue-shell daemon not reachable at ${socketPath}. Auto-start failed: ${(startErr as Error).message}`;
      throw new CueError("DAEMON_UNREACHABLE", msg);
    }
    // Retry connection after starting.
    try {
      client = await CueClient.connect(socketPath);
    } catch (err) {
      const msg = `cue-shell daemon started but still not reachable at ${socketPath}: ${(err as Error).message}`;
      throw new CueError("DAEMON_UNREACHABLE", msg);
    }
  }

  // Best-effort outdated-cued warning, fired at most once per process.
  // Detached on purpose: the warning hits GitHub for the latest release
  // and we never want that to delay the first IPC call.
  void checkCuedVersionAndWarn(client, ctx);
  return client;
}

/** Spawn `cued start` as a detached background process. */
function socketPathForPiCue(transport: CueResolvedTransport): string {
  if (transport.transport === "unix") return transport.socket_path;
  throw new CueError(
    "UNSUPPORTED_TRANSPORT",
    `cue profile \`${transport.profile_name}\` resolves to ssh transport (${transport.destination}), but pi-cue currently supports only unix cue-shell transport profiles. Use cue-client/cue-tui for remote targets or configure a unix profile for pi-cue.`,
  );
}

async function autoStartDaemon(socketPath: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("cued", ["start", "--socket", socketPath], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === null) {
        // Give the daemon a moment to bind its socket.
        setTimeout(resolve, 500);
      } else {
        reject(new Error(`cued start exited with code ${code}`));
      }
    });
    // Don't wait for the child — cued start backgrounds itself.
    child.unref();
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

const SHORT_TIMEOUT_COMMANDS = new Set([
  "mv",
  "cp",
  "rm",
  "mkdir",
  "rmdir",
  "ln",
  "touch",
  "chmod",
  "chown",
  "ls",
  "cat",
  "echo",
  "pwd",
  "which",
  "wc",
  "head",
  "tail",
  "file",
  "find",
  "fd",
  "rg",
  "grep",
  "stat",
  "readlink",
  "dirname",
  "basename",
  "true",
  "false",
  "test",
  "[",
]);
const SHORT_TIMEOUT_S = 10;
const DEFAULT_CUE_TAIL_BYTES = 16 * 1024;
const DEFAULT_LIST_LIMIT = 20;
const CUE_JOB_ACTIONS = ["list", "status", "wait", "stop"] as const;
const CUE_JOB_STATUS_FILTERS = [
  "all",
  "running",
  "pending",
  "done",
  "failed",
  "killed",
  "cancelled",
] as const;
const CUE_SCHEDULE_ACTIONS = ["add", "list", "pause", "resume", "remove"] as const;
const CUE_SCHEDULE_STATUS_FILTERS = [
  "all",
  "scheduled",
  "paused",
  "completed",
  "expired",
  "active",
] as const;
const CUE_SCOPE_ACTIONS = ["list", "env", "config"] as const;
const SCRIPT_LANGUAGES = ["cue-shell", "python"] as const;
type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

function isFileOp(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0];
  if (!firstWord) return false;
  const base = firstWord.split("/").pop() ?? firstWord;
  return SHORT_TIMEOUT_COMMANDS.has(base);
}

function statusLabel(status: JobStatus): string {
  switch (status) {
    case "Running":
      return "🟢 running";
    case "Done":
      return "✅ done";
    case "Failed":
      return "❌ failed";
    case "Killed":
      return "⏹️ killed";
    case "Cancelled":
      return "🚫 cancelled";
    case "Pending":
      return "⏳ pending";
    default:
      return status;
  }
}

function tailStr(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: s, truncated: false };
  if (s.length <= maxBytes) return { text: s, truncated: false };
  return { text: s.slice(s.length - maxBytes), truncated: true };
}

export function renderCueScriptResult(
  result: ScriptResult,
  options: { pathLabel: string; timeout: number; tailBytes: number },
): string[] {
  const sourceLabel = result.source.kind === "file" ? result.source.path : options.pathLabel;
  const headerParts = [
    `Script ${result.scriptId}: ${result.status === "done" ? "✅ done" : "❌ failed"}`,
  ];
  if (result.exitCode !== null) headerParts.push(`exit=${result.exitCode}`);
  if (result.failedItemIndex !== null) headerParts.push(`failed_item=${result.failedItemIndex}`);
  headerParts.push(`source=${sourceLabel}`);
  if (result.timedOut) headerParts.push("timed_out=true");

  const lines: string[] = [headerParts.join("  |  ")];
  if (result.timedOut) {
    lines.push(
      `Script timed out after ${options.timeout}s. Submitted jobs may still be running; inspect via cue_jobs action=list.`,
    );
  }

  for (const item of result.items) {
    const idLabel = renderCueScriptItemId(item);
    const statusBadge = item.kind === "message" ? "ℹ️ message" : statusLabel(item.status);
    const exitSuffix =
      item.exitCode !== null && item.exitCode !== 0 ? ` (exit ${item.exitCode})` : "";
    lines.push("");
    lines.push(`--- item ${item.index}: ${item.source} [${idLabel}] ${statusBadge}${exitSuffix}`);
    if (item.kind === "message" && item.message) {
      lines.push(item.message.trimEnd());
      continue;
    }
    const stdout = normalizeCueTerminalOutput(item.stdout);
    const stderr = normalizeCueStderrForDisplay(item.stderr, stdout);
    if (stdout.trim()) {
      const t = tailStr(stdout, options.tailBytes);
      lines.push(t.text.trimEnd());
      if (t.truncated) {
        lines.push(
          `[stdout truncated — use cue_jobs action=status id=${item.jobIds[0] ?? "?"} tail_bytes=0 for full output]`,
        );
      }
    }
    if (stderr.trim()) {
      const t = tailStr(stderr, options.tailBytes);
      lines.push("[stderr]");
      lines.push(t.text.trimEnd());
      if (t.truncated) {
        lines.push(
          `[stderr truncated — use cue_jobs action=status id=${item.jobIds[0] ?? "?"} tail_bytes=0 for full output]`,
        );
      }
    }
  }
  return lines;
}

function renderCueScriptItemId(item: ScriptResult["items"][number]): string {
  switch (item.kind) {
    case "chain":
      return `chain ${item.chainId ?? "?"} (${item.jobIds.join(",")})`;
    case "job":
      return `job ${item.jobIds[0] ?? "?"}`;
    case "cron":
      return `cron ${item.cronId ?? "?"}`;
    case "message":
      return "message";
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_OSC_SEQUENCE_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_CONTROL_SEQUENCE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsiSequences(value: string): string {
  return value
    .replaceAll(ANSI_OSC_SEQUENCE_PATTERN, "")
    .replaceAll(ANSI_CONTROL_SEQUENCE_PATTERN, "");
}

function applyCarriageReturnOverwrites(value: string): string {
  const normalizedNewlines = value.replaceAll("\r\n", "\n");
  const lines: string[] = [];
  let current = "";
  for (let index = 0; index < normalizedNewlines.length; index += 1) {
    const char = normalizedNewlines[index];
    if (char === "\r") {
      current = "";
      continue;
    }
    if (char === "\n") {
      lines.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  lines.push(current);
  return lines.join("\n");
}

function progressLineKey(line: string): string | undefined {
  const key = line.replace(/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◒◐◓◑⣾⣽⣻⢿⡿⣟⣯⣷|/\\-]\s+/, "");
  if (key === line) return undefined;
  return key.trim() || undefined;
}

function collapseRepeatedProgressLines(value: string): string {
  const lines = value.split("\n");
  const collapsed: string[] = [];
  let previousProgressKey: string | undefined;
  for (const line of lines) {
    const key = progressLineKey(line);
    if (key && key === previousProgressKey) {
      collapsed[collapsed.length - 1] = line;
      continue;
    }
    collapsed.push(line);
    previousProgressKey = key;
  }
  return collapsed.join("\n");
}

export function normalizeCueTerminalOutput(value: string): string {
  if (!value) return value;
  return collapseRepeatedProgressLines(applyCarriageReturnOverwrites(stripAnsiSequences(value)));
}

const PTY_MERGED_STDOUT_STDERR_LINE = "[PTY: stdout and stderr are merged]";

export function normalizeCueStderrForDisplay(stderr: string, stdout = ""): string {
  const normalizedStderr = normalizeCueTerminalOutput(stderr);
  if (!normalizedStderr.includes(PTY_MERGED_STDOUT_STDERR_LINE)) return normalizedStderr;

  const mergedOutput = normalizedStderr
    .split(/\r?\n/)
    .filter((line) => line.trim() !== PTY_MERGED_STDOUT_STDERR_LINE)
    .join("\n")
    .replace(/^\r?\n/, "");
  const normalizedStdout = normalizeCueTerminalOutput(stdout);
  if (!mergedOutput.trim()) return "";
  if (mergedOutput.trimEnd() === normalizedStdout.trimEnd()) return "";
  return mergedOutput;
}

function warningLines(warnings: string[]): string[] {
  if (warnings.length === 0) return [];
  return ["", "[warnings]", ...warnings];
}

function warningBlock(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return `\n\n[warnings]\n${warnings.join("\n")}`;
}

function isTerminalJob(status: JobStatus): boolean {
  return status === "Done" || status === "Failed" || status === "Killed" || status === "Cancelled";
}

function jobsForChain(jobs: JobInfo[], chainId: string): JobInfo[] {
  return jobs
    .filter((job) => job.chain_id != null && String(job.chain_id) === chainId)
    .sort((a, b) => (a.chain_index ?? 0) - (b.chain_index ?? 0));
}

function chainStatus(jobs: JobInfo[]): JobStatus {
  const failed = jobs.find((job) => job.status !== "Done" && isTerminalJob(job.status));
  if (failed) return failed.status;
  if (jobs.every((job) => job.status === "Done")) return "Done";
  if (jobs.some((job) => job.status === "Running")) return "Running";
  return "Pending";
}

async function appendJobOutput(
  cued: CueClient,
  job: JobInfo,
  lines: string[],
  tailBytes: number,
): Promise<void> {
  let stdout = "";
  try {
    const out = await cued.jobOutput(job.id);
    stdout = normalizeCueTerminalOutput(out.stdout);
    const display = tailStr(stdout, tailBytes);
    if (display.text.trim()) lines.push("", display.text.trimEnd());
    if (display.truncated || out.truncated) lines.push("[stdout truncated]");
  } catch {
    /* output may not be ready */
  }

  try {
    const errOut = await cued.jobError(job.id);
    const err = tailStr(normalizeCueStderrForDisplay(errOut.stderr, stdout), tailBytes);
    if (err.text.trim()) lines.push("", "[stderr]", err.text.trimEnd());
    if (err.truncated || errOut.truncated) lines.push("[stderr truncated]");
  } catch {
    /* stderr may not be ready */
  }
}

function formatValidValues(values: readonly string[]): string {
  if (values.length === 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

function normalizeCueEnum<const T extends readonly string[]>(
  value: unknown,
  fallback: T[number] | undefined,
  values: T,
  field: string,
): T[number] {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${field} is required`);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be ${formatValidValues(values)}`);
  }
  const normalized = value.trim().toLowerCase();
  if (!(values as readonly string[]).includes(normalized)) {
    throw new Error(`${field} must be ${formatValidValues(values)}`);
  }
  return normalized as T[number];
}

export function normalizeCueTailBytes(
  value: unknown,
  fallback = DEFAULT_CUE_TAIL_BYTES,
  field = "tail_bytes",
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

export function normalizeCueLimit(
  value: unknown,
  fallback = DEFAULT_LIST_LIMIT,
  field = "limit",
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

export function normalizeCueTimeoutSeconds(
  value: unknown,
  fallback: number,
  field = "timeout",
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

export function normalizeCueBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function resolveCueWorkingDirectory(
  requestedCwd: string | undefined,
  ctxCwd: string | undefined,
  fallbackCwd = process.cwd(),
): string {
  const baseCwd = ctxCwd?.trim() ? ctxCwd.trim() : fallbackCwd;
  if (!requestedCwd) return nodePath.resolve(baseCwd);
  return nodePath.isAbsolute(requestedCwd) ? requestedCwd : nodePath.resolve(baseCwd, requestedCwd);
}

function normalizeRequiredCueString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function normalizeOptionalCueString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function quoteCueWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

async function writeInlineScriptTemp(language: ScriptLanguage, body: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const ext = language === "python" ? "py" : "cue";
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "pi-cue-script-runner");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "inline-" + hash + "." + ext);
  await writeFile(file, body, "utf-8");
  return file;
}

async function runPythonScriptJob(
  cued: CueClient,
  options: { path: string; timeout: number; tailBytes: number; cwd: string },
) {
  const result = await cued.runJob(`python3 ${quoteCueWord(options.path)}`, {
    timeout: options.timeout,
    cwd: options.cwd,
  });
  const stdout = normalizeCueTerminalOutput(result.stdout);
  const stderr = normalizeCueStderrForDisplay(result.stderr, stdout);
  const lines = [`Script job ${result.jobId}: ${result.status}`];
  if (result.exitCode !== null) lines[0] += ` (exit ${result.exitCode})`;
  if (result.timedOut) lines[0] += ` — timed out after ${options.timeout}s`;
  if (stdout.trim()) {
    const out = tailStr(stdout, options.tailBytes);
    lines.push("", out.text.trimEnd());
    if (out.truncated) lines.push(truncationLine("stdout", result.jobId));
  }
  if (stderr.trim()) {
    const err = tailStr(stderr, options.tailBytes);
    lines.push("", "[stderr]", err.text.trimEnd());
    if (err.truncated) lines.push(truncationLine("stderr", result.jobId));
  }
  const details = {
    language: "python",
    path: options.path,
    jobId: result.jobId,
    status: result.status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    warnings: result.warnings,
  };
  if (result.status === "Failed" && !result.timedOut) {
    const err = new Error(lines.join("\n"));
    (err as unknown as { details?: unknown }).details = details;
    throw err;
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
}

function rejectDeprecatedCueParam(
  params: Record<string, unknown>,
  param: string,
  replacement: string,
  toolName: string,
): void {
  if (param in params && params[param] !== undefined && params[param] !== null) {
    throw new Error(`${toolName} ${param} is no longer supported; use ${replacement}`);
  }
}

function truncationLine(stream: string, jobId: string): string {
  return `[${stream} truncated — use cue_jobs action=status id=${jobId} tail_bytes=0 for full output]`;
}

function limitLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (maxLines <= 0) return { text, truncated: false };
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(Math.max(0, lines.length - maxLines)).join("\n"), truncated: true };
}

function renderToolCall(
  toolName: string,
  parts: Array<string | undefined>,
  theme: ToolCallRenderTheme,
): ToolCallComponent {
  const title =
    theme.fg?.("toolTitle", theme.bold?.(`${toolName} `) ?? `${toolName} `) ?? `${toolName} `;
  const renderedParts = parts.filter((part): part is string => Boolean(part));
  const args = theme.fg?.("muted", renderedParts.join(" ")) ?? renderedParts.join(" ");
  return new ToolCallText(`${title}${args}`.trimEnd());
}

function formatStringArg(
  value: unknown,
  options: { prefix?: string; fallback?: string; maxLength?: number } = {},
): string | undefined {
  const text = typeof value === "string" && value.trim() ? value.trim() : options.fallback;
  if (!text) return undefined;
  const rendered = needsQuoting(text) ? JSON.stringify(text) : text;
  return `${options.prefix ?? ""}${truncateInline(rendered, options.maxLength ?? 80)}`;
}

function formatNumberArg(
  value: unknown,
  options: { prefix?: string; suffix?: string } = {},
): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${options.prefix ?? ""}${value}${options.suffix ?? ""}`;
}

function needsQuoting(value: string): boolean {
  return /\s|["'`]/.test(value);
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

// ── Extension ──────────────────────────────────────────────────────────────

export function registerPiCueTools(pi: PiCueExtensionApi) {
  // ═══════════════════════════════════════════════════════════════════
  //  cue_exec — execute a command and create a job
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "cue_exec",
    label: "Run Command",
    description:
      "Execute a command in cue-shell. " +
      "cue-shell is direct-exec (execvp), not bash: do not use shell-only syntax such as &&, semicolon command lists, redirection, subshell tests, or bash-style ||. " +
      "Its composition operators are: |> pipes stdout, -> runs in serial on success, || runs in parallel (not OR), ~> runs in serial ignoring failure. " +
      "Prefer direct-exec commands and Pi file tools; use separate tool calls or explicit /bin/sh -lc '...' only when shell semantics are genuinely required. " +
      "Set background=true to start without waiting; track with cue_jobs action=status/wait, stop with cue_jobs action=stop. " +
      "Runs without a PTY by default; set pty=true only for commands that genuinely need terminal semantics. " +
      "File-system commands (mv, cp, rm, ls, cat, find, ...) get a short 10s timeout by default.",
    parameters: Type.Object({
      command: Type.String({
        description:
          "Command to execute in cue-shell, not bash. Use cue operators: '|>' pipe, '->' serial on success, '~>' serial ignoring failure, '||' parallel. Do not use bash-style && or || for logical control; prefer separate tool calls/Pi file tools and use /bin/sh -lc '...' only if shell syntax is required. Examples: 'cargo build |> grep error -> cargo test', '(cargo build || cargo audit) -> cargo test'.",
      }),
      background: Type.Optional(
        Type.Boolean({
          description: "If true, start and return immediately with job ID. Default: false.",
          default: false,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Timeout in seconds. Default: 300 (or 10 for file ops). Ignored when background=true.",
          default: 300,
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory. Defaults to the current Pi session working directory.",
        }),
      ),
      pty: Type.Optional(
        Type.Boolean({
          description:
            "Whether to allocate a PTY. Default: false for non-interactive tool runs; use true only when a command genuinely needs terminal semantics.",
          default: false,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit stdout/stderr to the last N bytes per stream. Default: 16384. Pass 0 for full output.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_exec",
        [
          formatStringArg(args.command, { maxLength: 120 }),
          args.background === true ? "background" : undefined,
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatStringArg(args.cwd, { prefix: "cwd=" }),
          args.pty === true ? "pty=true" : undefined,
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      rejectDeprecatedCueParam(params, "tail", "tail_bytes=0", "cue_exec");
      const command = normalizeRequiredCueString(params.command, "cue_exec command");
      const background = normalizeCueBoolean(params.background, false, "cue_exec background");
      const pty = normalizeCueBoolean(params.pty, false, "cue_exec pty");
      const cwd = resolveCueWorkingDirectory(
        normalizeOptionalCueString(params.cwd, "cue_exec cwd"),
        ctx.cwd,
      );
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_exec tail_bytes",
      );
      const effectiveTimeout = normalizeCueTimeoutSeconds(
        params.timeout,
        isFileOp(command) ? SHORT_TIMEOUT_S : 300,
        "cue_exec timeout",
      );
      const cued = await getClient(ctx);

      if (background) {
        const result = await cued.startJob(command, { cwd, pty });
        const lines: string[] = [];
        if (result.kind === "chain" && result.chain) {
          const chain = result.chain;
          lines.push(`Chain: ${chain.id}  |  ${chain.total_jobs} job(s)`);
          for (const j of chain.jobs)
            lines.push(`  ${j.job_id ?? "(pending)"}  [${j.status.toLowerCase()}]  ${j.pipeline}`);
        } else {
          lines.push(`Job:   ${result.jobId}  [running]`);
          lines.push(`Cmd:   ${result.pipeline ?? command}`);
        }
        lines.push(...warningLines(result.warnings));
        const trackId = result.kind === "chain" && result.chain ? result.chain.id : result.jobId;
        lines.push("", `Track with cue_jobs action=status/wait using id ${trackId}.`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            jobId: result.jobId,
            kind: result.kind,
            chainId: result.chain?.id ?? null,
            chain: result.chain ?? null,
            warnings: result.warnings,
          },
        };
      }

      const result = await cued.runJob(command, {
        timeout: effectiveTimeout,
        cwd,
        pty,
      });

      if (result.timedOut) {
        const stdout = normalizeCueTerminalOutput(result.stdout);
        const stderr = normalizeCueStderrForDisplay(result.stderr, stdout);
        const lines = [
          `Job ${result.jobId}: Timed out after ${effectiveTimeout}s — switched to background.`,
          `Track with cue_jobs action=status/wait using id ${result.jobId}.`,
          ...warningLines(result.warnings),
        ];
        if (stdout.trim()) {
          const t = tailStr(stdout, tailBytes);
          lines.push("", "[stdout so far]", t.text.trimEnd());
          if (t.truncated) lines.push(truncationLine("stdout", result.jobId));
        }
        if (stderr.trim()) {
          const t = tailStr(stderr, tailBytes);
          lines.push("", "[stderr so far]", t.text.trimEnd());
          if (t.truncated) lines.push(truncationLine("stderr", result.jobId));
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            jobId: result.jobId,
            timedOut: true,
            switchedToBackground: true,
            warnings: result.warnings,
          },
        };
      }

      const stdout = normalizeCueTerminalOutput(result.stdout);
      const stderr = normalizeCueStderrForDisplay(result.stderr, stdout);

      if (
        result.status === "Failed" ||
        result.status === "Killed" ||
        result.status === "Cancelled"
      ) {
        const parts = [`Job ${result.jobId}: ${result.status}`];
        if (result.exitCode !== null) parts.push(` (exit ${result.exitCode})`);
        parts.push(warningBlock(result.warnings));
        if (stdout.trim()) {
          const t = tailStr(stdout, tailBytes);
          parts.push("\n" + t.text.trimEnd());
          if (t.truncated) parts.push(`\n${truncationLine("stdout", result.jobId)}`);
        }
        if (stderr.trim()) {
          const t = tailStr(stderr, tailBytes === 0 ? 0 : Math.min(tailBytes, 2_000));
          parts.push("\n[stderr tail]\n" + t.text.trimEnd());
          if (t.truncated) parts.push(`\n${truncationLine("stderr", result.jobId)}`);
        }
        throw new Error(parts.join(""));
      }

      const out = [`Job ${result.jobId}: ${result.status}`];
      if (result.exitCode !== null && result.exitCode !== 0) out.push(` (exit ${result.exitCode})`);
      out.push(warningBlock(result.warnings));
      if (stdout.trim()) {
        const t = tailStr(stdout, tailBytes);
        out.push("\n" + t.text.trimEnd());
        if (t.truncated) out.push(`\n${truncationLine("stdout", result.jobId)}`);
      }
      if (stderr.trim()) {
        const t = tailStr(stderr, tailBytes);
        out.push("\n[stderr]\n" + t.text.trimEnd());
        if (t.truncated) out.push(`\n${truncationLine("stderr", result.jobId)}`);
      }

      return {
        content: [{ type: "text" as const, text: out.join("") }],
        details: {
          jobId: result.jobId,
          status: result.status,
          exitCode: result.exitCode,
          warnings: result.warnings,
        },
      };
    },
  });

  // ══════════════════════════════════════════════════════════════════
  //  cue_run / cue_script — run a .cue script (path or inline body)
  // ══════════════════════════════════════════════════════════════════

  async function runCueScript(
    options: {
      resolvedPath: string;
      body: string;
      pathLabel: string;
      timeout: number;
      tailBytes: number;
      toolName: "cue_run" | "cue_script" | "script_run" | "script_eval";
    },
    ctx: PiCueToolContext,
  ) {
    const { resolvedPath, body, pathLabel, timeout, tailBytes, toolName } = options;
    if (!body.trim()) {
      throw new Error(`${toolName} body is empty (cue-shell rejects empty scripts)`);
    }
    const cued = await getClient(ctx);
    const result = await cued.runScript({
      path: resolvedPath,
      input: body,
      timeout,
    });
    const lines = renderCueScriptResult(result, { pathLabel, timeout, tailBytes });
    const summary = result.items.map((item) => ({
      index: item.index,
      source: item.source,
      kind: item.kind,
      jobIds: item.jobIds,
      chainId: item.chainId,
      cronId: item.cronId,
      status: item.status,
      exitCode: item.exitCode,
    }));
    const output = { content: [{ type: "text" as const, text: lines.join("\n") }] };
    const details = {
      scriptId: result.scriptId,
      source: result.source,
      status: result.status,
      exitCode: result.exitCode,
      failedItemIndex: result.failedItemIndex,
      timedOut: result.timedOut,
      items: summary,
    };
    if (result.status === "failed" && !result.timedOut) {
      const err = new Error(lines.join("\n"));
      (err as unknown as { details?: unknown }).details = details;
      throw err;
    }
    return { ...output, details };
  }

  pi.registerTool({
    name: "cue_run",
    label: "Run Cue File",
    description:
      "Run a .cue file in cue-shell, mirroring `cue run <file.cue>`. " +
      "Top-level items execute sequentially with fail-fast semantics inside a fresh isolated scope forked from HEAD. " +
      "Each item may use cue-shell composition operators (`|>`, `->`, `~>`, `||`, `||?`) but must not use bash-shell syntax (`&&`, `;`, redirection). " +
      "For inline bodies (no file on disk) use cue_script instead. " +
      "Foreground only: blocks until ScriptFinished or `timeout` seconds elapse, in which case the script is reported as timed out (its jobs may continue running and can be inspected via cue_jobs).",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Path to a .cue file to run. Required. Resolved against the current Pi session working directory when relative.",
      }),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Foreground wait budget in seconds. Default: 300. On timeout the tool returns with timedOut=true; submitted jobs may keep running.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit per-item stdout/stderr to the last N bytes when rendering the aggregated transcript. Default: 16384. Pass 0 for full output.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_run",
        [
          formatStringArg(args.path, { prefix: "path=", maxLength: 60 }),
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const pathParam = normalizeRequiredCueString(params.path, "cue_run path");
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "cue_run timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_run tail_bytes",
      );
      const baseCwd = resolveCueWorkingDirectory(undefined, ctx.cwd);
      const { isAbsolute, resolve } = await import("node:path");
      const resolvedPath = isAbsolute(pathParam) ? pathParam : resolve(baseCwd, pathParam);
      if (!resolvedPath.endsWith(".cue")) {
        throw new Error(`cue_run path must end in .cue (got ${resolvedPath})`);
      }
      const { readFile } = await import("node:fs/promises");
      let body: string;
      try {
        body = await readFile(resolvedPath, "utf-8");
      } catch (err) {
        throw new Error(`cue_run failed to read ${resolvedPath}: ${(err as Error).message}`);
      }
      return runCueScript(
        { resolvedPath, body, pathLabel: resolvedPath, timeout, tailBytes, toolName: "cue_run" },
        ctx,
      );
    },
  });

  pi.registerTool({
    name: "cue_script",
    label: "Run Cue Script",
    description:
      "Run an inline .cue script body in cue-shell. " +
      "Top-level items execute sequentially with fail-fast semantics inside a fresh isolated scope forked from HEAD. " +
      "Each item may use cue-shell composition operators (`|>`, `->`, `~>`, `||`, `||?`) but must not use bash-shell syntax (`&&`, `;`, redirection). " +
      "If you have a real .cue file on disk, prefer cue_run. " +
      "Optionally provide `pathLabel` to label the inline script in TUI history. " +
      "Foreground only: blocks until ScriptFinished or `timeout` seconds elapse, in which case the script is reported as timed out (its jobs may continue running and can be inspected via cue_jobs).",
    parameters: Type.Object({
      script: Type.String({
        description:
          "Inline .cue script body. Required. The script is sent to the daemon as if it were a file at `pathLabel` (defaults to `<inline>`).",
      }),
      pathLabel: Type.Optional(
        Type.String({
          description: "Display label for inline scripts. Default: `<inline>`.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Foreground wait budget in seconds. Default: 300. On timeout the tool returns with timedOut=true; submitted jobs may keep running.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit per-item stdout/stderr to the last N bytes when rendering the aggregated transcript. Default: 16384. Pass 0 for full output.",
        }),
      ),
    }),
    renderCall(args, theme) {
      const scriptArg =
        typeof args.script === "string" && args.script.trim()
          ? `inline=${(args.script as string).split(/\r?\n/).filter((l) => l.trim()).length}line(s)`
          : undefined;
      return renderToolCall(
        "cue_script",
        [
          scriptArg,
          formatStringArg(args.pathLabel, { prefix: "label=", maxLength: 40 }),
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const scriptParam = normalizeRequiredCueString(params.script, "cue_script script");
      const pathLabel =
        normalizeOptionalCueString(params.pathLabel, "cue_script pathLabel") ?? "<inline>";
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "cue_script timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_script tail_bytes",
      );
      return runCueScript(
        {
          resolvedPath: pathLabel,
          body: scriptParam,
          pathLabel,
          timeout,
          tailBytes,
          toolName: "cue_script",
        },
        ctx,
      );
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  script_run / script_eval — generic script runners
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "script_run",
    label: "Run Script File",
    description:
      "Run a script file with an explicit language runner. " +
      "Supported languages in this version: cue-shell and python. " +
      "For cue-shell this delegates to RunScript and mirrors cue_run; for python it runs python3 through cue-shell job execution.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the script file to run." }),
      language: Type.String({ description: "Script language. Required: cue-shell or python." }),
      timeout: Type.Optional(
        Type.Number({
          description: "Foreground wait budget in seconds. Default: 300.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit stdout/stderr to the last N bytes. Default: 16384. Pass 0 for full output.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "script_run",
        [
          formatStringArg(args.language, { prefix: "lang=" }),
          formatStringArg(args.path, { prefix: "path=", maxLength: 60 }),
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const language = normalizeCueEnum(
        params.language,
        undefined,
        SCRIPT_LANGUAGES,
        "script_run language",
      );
      const pathParam = normalizeRequiredCueString(params.path, "script_run path");
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "script_run timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "script_run tail_bytes",
      );
      const baseCwd = resolveCueWorkingDirectory(undefined, ctx.cwd);
      const { isAbsolute, resolve } = await import("node:path");
      const resolvedPath = isAbsolute(pathParam) ? pathParam : resolve(baseCwd, pathParam);
      const cued = await getClient(ctx);

      if (language === "cue-shell") {
        if (!resolvedPath.endsWith(".cue")) {
          throw new Error(
            `script_run language=cue-shell path must end in .cue (got ${resolvedPath})`,
          );
        }
        const { readFile } = await import("node:fs/promises");
        let body: string;
        try {
          body = await readFile(resolvedPath, "utf-8");
        } catch (err) {
          throw new Error(`script_run failed to read ${resolvedPath}: ${(err as Error).message}`);
        }
        return runCueScript(
          {
            resolvedPath,
            body,
            pathLabel: resolvedPath,
            timeout,
            tailBytes,
            toolName: "script_run",
          },
          ctx,
        );
      }

      return runPythonScriptJob(cued, { path: resolvedPath, timeout, tailBytes, cwd: baseCwd });
    },
  });

  pi.registerTool({
    name: "script_eval",
    label: "Evaluate Script",
    description:
      "Run an inline script body with an explicit language runner. " +
      "Supported languages in this version: cue-shell and python. " +
      "Inline python is written to a temporary file and executed with python3 through cue-shell.",
    parameters: Type.Object({
      script: Type.String({ description: "Inline script body to run." }),
      language: Type.String({ description: "Script language. Required: cue-shell or python." }),
      pathLabel: Type.Optional(
        Type.String({ description: "Display label for inline scripts. Default: <inline>." }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Foreground wait budget in seconds. Default: 300.",
          default: 300,
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit stdout/stderr to the last N bytes. Default: 16384. Pass 0 for full output.",
        }),
      ),
    }),
    renderCall(args, theme) {
      const scriptArg =
        typeof args.script === "string" && args.script.trim()
          ? `inline=${(args.script as string).split(/\r?\n/).filter((line) => line.trim()).length}line(s)`
          : undefined;
      return renderToolCall(
        "script_eval",
        [
          formatStringArg(args.language, { prefix: "lang=" }),
          scriptArg,
          formatStringArg(args.pathLabel, { prefix: "label=", maxLength: 40 }),
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const language = normalizeCueEnum(
        params.language,
        undefined,
        SCRIPT_LANGUAGES,
        "script_eval language",
      );
      const script = normalizeRequiredCueString(params.script, "script_eval script");
      const pathLabel =
        normalizeOptionalCueString(params.pathLabel, "script_eval pathLabel") ?? "<inline>";
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "script_eval timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "script_eval tail_bytes",
      );
      const cued = await getClient(ctx);

      if (language === "cue-shell") {
        return runCueScript(
          {
            resolvedPath: pathLabel,
            body: script,
            pathLabel,
            timeout,
            tailBytes,
            toolName: "script_eval",
          },
          ctx,
        );
      }

      const tempPath = await writeInlineScriptTemp(language, script);
      return runPythonScriptJob(cued, {
        path: tempPath,
        timeout,
        tailBytes,
        cwd: resolveCueWorkingDirectory(undefined, ctx.cwd),
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_jobs — manage and inspect jobs
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "cue_jobs",
    label: "Cue Jobs",
    description:
      "Manage cue-shell jobs. action='list' lists jobs, action='status' inspects one job or cron ID, action='wait' waits for a job, and action='stop' stops a job or removes a cron.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "Action: list, status, wait, stop. Default: list.",
        }),
      ),
      id: Type.Optional(Type.String({ description: "Job ID (J<n>) or cron ID (C<n>)." })),
      status: Type.Optional(
        Type.String({
          description:
            "Filter for action='list': running, pending, done, failed, killed, all. Default: all.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum jobs to show for action='list'. Default: 20." }),
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Max wait time in seconds for action='wait'. Default: 300." }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit stdout/stderr to the last N bytes for action='status' or action='wait'. Default: 16384. Pass 0 for full output.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_jobs",
        [
          formatStringArg(args.action, { prefix: "action=", fallback: "list" }),
          formatStringArg(args.id, { prefix: "id=" }),
          formatStringArg(args.status, { prefix: "status=" }),
          formatNumberArg(args.limit, { prefix: "limit=" }),
          formatNumberArg(args.timeout, { prefix: "timeout=", suffix: "s" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const action = normalizeCueEnum(params.action, "list", CUE_JOB_ACTIONS, "cue_jobs action");
      const id = normalizeOptionalCueString(params.id, "cue_jobs id");
      const statusFilter = normalizeCueEnum(
        params.status,
        "all",
        CUE_JOB_STATUS_FILTERS,
        "cue_jobs status",
      );
      const limit = normalizeCueLimit(params.limit, DEFAULT_LIST_LIMIT, "cue_jobs limit");
      const timeout = normalizeCueTimeoutSeconds(params.timeout, 300, "cue_jobs timeout");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_jobs tail_bytes",
      );
      const cued = await getClient(ctx);

      if (action === "list") {
        let jobs = await cued.listJobs();
        if (statusFilter !== "all")
          jobs = jobs.filter((j) => j.status.toLowerCase() === statusFilter);
        const total = jobs.length;
        jobs = jobs.slice(0, limit);
        if (total === 0)
          return {
            content: [{ type: "text" as const, text: "No matching jobs." }],
            details: { count: 0, shown: 0, jobs: [] },
          };
        const lines = jobs.map((j) => {
          let s = `${j.id}  ${statusLabel(j.status)}  ${j.pipeline}`;
          if (j.exit_code != null) s += ` (exit ${j.exit_code})`;
          if (j.chain_id) s += ` [${j.chain_id}]`;
          return s;
        });
        if (total > jobs.length) lines.push(`… ${total - jobs.length} more job(s)`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { count: total, shown: jobs.length, jobs },
        };
      }

      if (!id)
        return {
          content: [{ type: "text" as const, text: `action='${action}' requires id parameter.` }],
          details: { error: "missing_id" },
        };

      if (action === "stop") {
        await cued.stopJob(id);
        return {
          content: [{ type: "text" as const, text: `Stopped ${id}.` }],
          details: { targetId: id },
        };
      }

      if (action === "status") {
        if (id.startsWith("CH")) {
          const jobs = jobsForChain(await cued.listJobs(), id);
          if (jobs.length === 0)
            return {
              content: [{ type: "text" as const, text: `${id} not found.` }],
              details: { found: false },
            };

          const lines = [`${statusLabel(chainStatus(jobs))} — chain ${id}`];
          for (const job of jobs) {
            const leafLabel = `Leaf ${(job.chain_index ?? 0) + 1}/${job.chain_total ?? jobs.length}`;
            lines.push("", `${leafLabel}: ${statusLabel(job.status)} — ${job.pipeline}`);
            if (job.exit_code != null) lines.push(`Exit code: ${job.exit_code}`);
            await appendJobOutput(cued, job, lines, tailBytes);
          }
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: {
              chainId: id,
              status: chainStatus(jobs),
              jobs,
            },
          };
        }

        if (id.startsWith("C")) {
          const cron = await cued.cronStatus(id);
          if (!cron)
            return {
              content: [{ type: "text" as const, text: `${id} not found.` }],
              details: { found: false },
            };
          return {
            content: [
              {
                type: "text" as const,
                text: `⏰ ${cron.id}  [${cron.status}]  ${cron.schedule} → ${cron.command}`,
              },
            ],
            details: {
              cronId: cron.id,
              status: cron.status,
              schedule: cron.schedule,
              command: cron.command,
            },
          };
        }

        const job = await cued.jobStatus(id);
        if (!job)
          return {
            content: [{ type: "text" as const, text: `${id} not found.` }],
            details: { found: false },
          };

        const parts = [`${statusLabel(job.status)} — ${job.pipeline}`];
        if (job.exit_code != null) parts.push(`Exit code: ${job.exit_code}`);
        if (job.chain_id)
          parts.push(
            `Chain: ${job.chain_id} (leaf ${(job.chain_index ?? 0) + 1}/${job.chain_total ?? "?"})`,
          );

        await appendJobOutput(cued, job, parts, tailBytes);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {
            jobId: job.id,
            status: job.status,
            exitCode: job.exit_code,
            pipeline: job.pipeline,
          },
        };
      }

      if (action === "wait") {
        const deadline = Date.now() + timeout * 1000;

        if (id.startsWith("CH")) {
          while (Date.now() < deadline) {
            const jobs = jobsForChain(await cued.listJobs(), id);
            if (jobs.length === 0)
              return {
                content: [{ type: "text" as const, text: `Chain ${id} not found.` }],
                details: { found: false },
              };
            const expectedCount = Math.max(...jobs.map((job) => job.chain_total ?? jobs.length));
            const hasTerminalFailure = jobs.some(
              (job) => job.status !== "Done" && isTerminalJob(job.status),
            );
            if (
              (jobs.length >= expectedCount || hasTerminalFailure) &&
              jobs.every((job) => isTerminalJob(job.status))
            ) {
              const status = chainStatus(jobs);
              const lines = [`${statusLabel(status)} — chain ${id}`];
              for (const job of jobs) {
                const leafLabel = `Leaf ${(job.chain_index ?? 0) + 1}/${job.chain_total ?? jobs.length}`;
                lines.push("", `${leafLabel}: ${statusLabel(job.status)} — ${job.pipeline}`);
                if (job.exit_code != null) lines.push(`Exit code: ${job.exit_code}`);
                await appendJobOutput(cued, job, lines, tailBytes);
              }
              const text = `Chain ${id} completed\n\n${lines.join("\n")}`;
              if (status === "Failed") throw new Error(text);
              if (status === "Killed") throw new Error(`Chain ${id} was killed`);
              if (status === "Cancelled") throw new Error(`Chain ${id} was cancelled`);
              return {
                content: [{ type: "text" as const, text }],
                details: {
                  chainId: id,
                  status,
                  jobs,
                },
              };
            }
            await new Promise((r) => setTimeout(r, 500));
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Timed out after ${timeout}s waiting for ${id}.`,
              },
            ],
            details: { timedOut: true, targetId: id },
          };
        }

        while (Date.now() < deadline) {
          const job = await cued.jobStatus(id);
          if (!job)
            return {
              content: [{ type: "text" as const, text: `Job ${id} not found.` }],
              details: { found: false },
            };

          if (
            job.status === "Done" ||
            job.status === "Failed" ||
            job.status === "Killed" ||
            job.status === "Cancelled"
          ) {
            const lines = [`${statusLabel(job.status)} — ${job.pipeline}`];
            if (job.exit_code != null) lines.push(`Exit code: ${job.exit_code}`);
            await appendJobOutput(cued, job, lines, tailBytes);
            const text = `Job ${id} completed\n\n${lines.join("\n")}`;
            if (job.status === "Failed") throw new Error(text);
            if (job.status === "Killed") throw new Error(`Job ${id} was killed`);
            if (job.status === "Cancelled") throw new Error(`Job ${id} was cancelled`);
            return {
              content: [{ type: "text" as const, text }],
              details: {
                jobId: job.id,
                status: job.status,
                exitCode: job.exit_code,
              },
            };
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Timed out after ${timeout}s waiting for ${id}.`,
            },
          ],
          details: { timedOut: true },
        };
      }
      throw new Error("Unhandled cue_jobs action");
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_schedule — unified schedule management
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "cue_schedule",
    label: "Cue Schedule",
    description:
      "Manage scheduled cue-shell jobs. " +
      "action='add': schedule a recurring or one-shot job (requires schedule + command). " +
      "action='list': list schedules. " +
      "action='pause'/'resume': control a schedule by id. " +
      "action='remove': delete a schedule by id (also available via cue_jobs action=stop).",
    parameters: Type.Object({
      action: Type.String({
        description: "Action: add, list, pause, resume, remove.",
      }),
      schedule: Type.Optional(
        Type.String({
          description:
            "Schedule (required for action='add'). Examples: 'every 5m', 'at 14:30', 'in 30s', 'daily', 'hourly', or raw cron '*/5 * * * *'.",
        }),
      ),
      command: Type.Optional(
        Type.String({
          description: "Command to run on schedule (required for action='add').",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description: "Schedule/cron ID (C<n>), required for pause/resume/remove.",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "Filter for action='list': scheduled, paused, completed, expired, active, all. Default: all.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum schedules to show for action=list. Default: 20." }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_schedule",
        [
          formatStringArg(args.action, { prefix: "action=", fallback: "list" }),
          formatStringArg(args.id, { prefix: "id=" }),
          formatStringArg(args.schedule, { prefix: "schedule=", maxLength: 40 }),
          formatStringArg(args.command, { prefix: "command=", maxLength: 80 }),
          formatStringArg(args.status, { prefix: "status=" }),
          formatNumberArg(args.limit, { prefix: "limit=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const action = normalizeCueEnum(
        params.action,
        undefined,
        CUE_SCHEDULE_ACTIONS,
        "cue_schedule action",
      );
      const schedule = normalizeOptionalCueString(params.schedule, "cue_schedule schedule");
      const command = normalizeOptionalCueString(params.command, "cue_schedule command");
      const id = normalizeOptionalCueString(params.id, "cue_schedule id");
      const statusFilter = normalizeCueEnum(
        params.status,
        "all",
        CUE_SCHEDULE_STATUS_FILTERS,
        "cue_schedule status",
      );
      const limit = normalizeCueLimit(params.limit, DEFAULT_LIST_LIMIT, "cue_schedule limit");
      const cued = await getClient(ctx);

      // add
      if (action === "add") {
        if (!schedule || !command) {
          return {
            content: [
              {
                type: "text" as const,
                text: "action='add' requires schedule and command.",
              },
            ],
            details: {},
          };
        }
        const cronId = await cued.addCron(schedule, command);
        return {
          content: [
            {
              type: "text" as const,
              text: `Schedule: ${cronId}\nRemove with cue_schedule action=remove id=${cronId}.`,
            },
          ],
          details: {
            cronId,
            schedule,
            command,
          },
        };
      }

      // list
      if (action === "list") {
        let crons = await cued.listCrons();
        if (statusFilter !== "all")
          crons = crons.filter((c) => c.status.toLowerCase() === statusFilter);
        const total = crons.length;
        crons = crons.slice(0, limit);
        if (total === 0)
          return {
            content: [{ type: "text" as const, text: "No matching schedules." }],
            details: { count: 0, shown: 0, crons: [] },
          };
        const lines = crons.map((c) => `${c.id}  [${c.status}]  ${c.schedule}  →  ${c.command}`);
        if (total > crons.length) lines.push(`… ${total - crons.length} more schedule(s)`);
        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n"),
            },
          ],
          details: { count: total, shown: crons.length, crons },
        };
      }

      // pause / resume / remove
      if (!id) {
        return {
          content: [
            {
              type: "text" as const,
              text: `action='${action}' requires id parameter.`,
            },
          ],
          details: {},
        };
      }

      if (action === "pause") {
        await cued.pauseCron(id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Paused ${id}. Resume with cue_schedule action=resume id=${id}.`,
            },
          ],
          details: { id, paused: true },
        };
      }
      if (action === "resume") {
        await cued.resumeCron(id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Resumed ${id}.`,
            },
          ],
          details: { id, resumed: true },
        };
      }
      if (action === "remove") {
        await cued.stopJob(id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Removed ${id}.`,
            },
          ],
          details: { id, removed: true },
        };
      }
      throw new Error("Unhandled cue_schedule action");
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_scope — inspect scopes, env, or config
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "cue_scope",
    label: "Cue Scope",
    description:
      "Inspect cue-shell scopes and environment state. action='list' lists scopes, action='env' shows HEAD env, and action='config' shows cue-shell config.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({ description: "Action: list, env, config. Default: list." }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum scopes to show for action='list'. Default: 20." }),
      ),
      includeEnv: Type.Optional(
        Type.Boolean({
          description: "For action='list', also include HEAD env output. Default: false.",
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "For action='env' or action='config', limit output to the last N bytes. Default: 16384. Pass 0 for full output.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_scope",
        [
          formatStringArg(args.action, { prefix: "action=", fallback: "list" }),
          formatNumberArg(args.limit, { prefix: "limit=" }),
          args.includeEnv === true ? "include-env" : undefined,
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      rejectDeprecatedCueParam(params, "env_tail_bytes", "tail_bytes", "cue_scope");
      const action = normalizeCueEnum(params.action, "list", CUE_SCOPE_ACTIONS, "cue_scope action");
      const limit = normalizeCueLimit(params.limit, DEFAULT_LIST_LIMIT, "cue_scope limit");
      const includeEnv = normalizeCueBoolean(params.includeEnv, false, "cue_scope includeEnv");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_scope tail_bytes",
      );
      const cued = await getClient(ctx);

      if (action === "env" || action === "config") {
        const raw = action === "env" ? await cued.showEnv() : await cued.showConfig();
        const tailed = tailStr(raw, tailBytes);
        const lines = [tailed.text.trimEnd()];
        if (tailed.truncated)
          lines.push(`[${action} truncated — use tail_bytes=0 for full output]`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            action,
            rawChars: raw.length,
            shownChars: tailed.text.length,
            truncated: tailed.truncated,
          },
        };
      }

      const all = await cued.listScopes();
      const visible = all.slice(0, limit);
      if (all.length === 0)
        return {
          content: [{ type: "text" as const, text: "No scopes." }],
          details: { count: 0, shown: 0, scopes: [] },
        };
      const lines = visible.map(
        (scope) =>
          `${scope.hash}  parent=${scope.parent ?? "-"}  cwd=${scope.cwd}  env=${scope.env_count}`,
      );
      if (all.length > visible.length) lines.push(`… ${all.length - visible.length} more scope(s)`);
      if (includeEnv) {
        const env = tailStr(await cued.showEnv(), tailBytes);
        lines.push("", "--- HEAD env ---", env.text.trimEnd());
        if (env.truncated) lines.push("[HEAD env truncated — use tail_bytes=0 for full env]");
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { count: all.length, shown: visible.length, scopes: visible },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cue_history — show history
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "cue_history",
    label: "Cue History",
    description:
      "Show recent cue-shell history. Pass an id to focus on one job/cron. Output is bounded by default; pass tail_bytes=0 and limit=0 for full history.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description: "Optional job ID (J<n>) or cron ID (C<n>) to focus on.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "Maximum recent history lines to show. Default: 80. Pass 0 for no line limit.",
        }),
      ),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit history text to the last N bytes. Default: 16384. Pass 0 for full text.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_history",
        [
          formatStringArg(args.id),
          formatNumberArg(args.limit, { prefix: "limit=" }),
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: PiCueToolContext,
    ) {
      const id = normalizeOptionalCueString(params.id, "cue_history id");
      const limit = normalizeCueLimit(params.limit, 80, "cue_history limit");
      const tailBytes = normalizeCueTailBytes(
        params.tail_bytes,
        DEFAULT_CUE_TAIL_BYTES,
        "cue_history tail_bytes",
      );
      const cued = await getClient(ctx);
      const raw = await cued.showLog(id);
      const tailed = tailStr(raw, tailBytes);
      const limited = limitLines(tailed.text, limit);
      const messages: string[] = [];
      if (tailed.truncated)
        messages.push("[history truncated by bytes — use tail_bytes=0 for full text]");
      if (limited.truncated)
        messages.push("[history truncated by lines — use limit=0 for full text]");
      return {
        content: [
          { type: "text" as const, text: [limited.text, ...messages].filter(Boolean).join("\n") },
        ],
        details: {
          id: id ?? null,
          rawChars: raw.length,
          shownChars: limited.text.length,
          truncated: tailed.truncated || limited.truncated,
        },
      };
    },
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  pi.on?.("session_start", () => {
    if (!pi.getAllTools || !pi.setActiveTools) return;
    const withoutBash = pi
      .getAllTools()
      .map((t) => t.name)
      .filter((name) => name !== "bash");
    pi.setActiveTools(withoutBash);
  });

  pi.on?.("session_shutdown", async () => {
    if (client && !client.isClosed) {
      client.close();
      client = null;
    }
  });
}

export default function piCueExtension(pi: ExtensionAPI) {
  if (!pi.registerTool) throw new Error("pi-cue extension requires registerTool support");
  registerPiCueTools({
    registerTool: (config) => pi.registerTool?.(config),
    on: pi.on
      ? (event, handler) => {
          pi.on?.(event, (payload, ctx) => handler(payload, ctx));
        }
      : undefined,
    getAllTools: pi.getAllTools ? () => pi.getAllTools!() : undefined,
    setActiveTools: pi.setActiveTools ? (names) => pi.setActiveTools!(names) : undefined,
  });
}
