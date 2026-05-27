/**
 * pi-cue extension
 *
 * Atomic execution tools organized by the three category objects:
 *
 *   Execution:
 *     cue_exec     — execute a command and create a job
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface PiCueExtensionApi {
  registerTool(config: PiCueToolConfig): void;
  on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void;
  getAllTools(): Array<{ name: string }>;
  setActiveTools(names: string[]): void;
}

interface PiCueToolConfig {
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
    ctx: { cwd?: string; ui?: { notify?: (msg: string, level: string) => void } },
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

export { CueClient, CueError, defaultSocketPath } from "./cue-client.ts";
export type { JobInfo, JobResult, JobStatus, StartJobResult } from "./cue-client.ts";

import {
  CueClient,
  CueError,
  type JobInfo,
  type JobStatus,
  defaultSocketPath,
} from "./cue-client.ts";

// ── Shared state ───────────────────────────────────────────────────────────

let client: CueClient | null = null;

async function getClient(ctx?: {
  ui?: { notify?: (msg: string, level: string) => void };
}): Promise<CueClient> {
  if (client && !client.isClosed) return client;
  client = null;
  try {
    client = await CueClient.connect();
    return client;
  } catch {
    // Daemon not running — auto-start it.
    ctx?.ui?.notify?.("cue-shell: auto-starting daemon…", "info");
    try {
      await autoStartDaemon();
    } catch (startErr) {
      const msg = `cue-shell daemon not reachable at ${defaultSocketPath()}.  Auto-start failed: ${(startErr as Error).message}`;
      throw new CueError("DAEMON_UNREACHABLE", msg);
    }
    // Retry connection after starting.
    try {
      client = await CueClient.connect();
      return client;
    } catch (err) {
      const msg = `cue-shell daemon started but still not reachable at ${defaultSocketPath()}: ${(err as Error).message}`;
      throw new CueError("DAEMON_UNREACHABLE", msg);
    }
  }
}

/** Spawn `cued start` as a detached background process. */
async function autoStartDaemon(): Promise<void> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("cued", ["start"], {
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
const DEFAULT_OUTPUT_TAIL_BYTES = 16 * 1024;
const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_LOG_TAIL_BYTES = 16 * 1024;
const DEFAULT_ENV_TAIL_BYTES = 16 * 1024;

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

const ANSI_OSC_SEQUENCE_PATTERN = new RegExp(
  String.raw`\u001B\][^\u0007]*(?:\u0007|\u001B\\)`,
  "g",
);
const ANSI_CONTROL_SEQUENCE_PATTERN = new RegExp(
  String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`,
  "g",
);

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
  if (!normalizedStderr.startsWith(PTY_MERGED_STDOUT_STDERR_LINE)) return normalizedStderr;

  const mergedOutput = normalizedStderr
    .slice(PTY_MERGED_STDOUT_STDERR_LINE.length)
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

function normalizeTailBytes(value: unknown, fallback = DEFAULT_OUTPUT_TAIL_BYTES): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeLimit(value: unknown, fallback = DEFAULT_LIST_LIMIT): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
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
      tail: Type.Optional(
        Type.Boolean({
          description:
            "Deprecated. When false, return full stdout/stderr. Prefer tail_bytes=0 for full output.",
          default: true,
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
          args.tail === false ? "tail=false" : undefined,
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: {
        command: string;
        background?: boolean;
        timeout?: number;
        cwd?: string;
        pty?: boolean;
        tail?: boolean;
        tail_bytes?: number;
      },
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { cwd?: string; ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      const { command } = params;
      const cwd = params.cwd?.trim() || ctx.cwd || process.cwd();
      const tailBytes = params.tail === false ? 0 : normalizeTailBytes(params.tail_bytes);

      if (params.background) {
        const result = await cued.startJob(command, { cwd, pty: params.pty ?? false });
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

      const effectiveTimeout = params.timeout ?? (isFileOp(command) ? SHORT_TIMEOUT_S : 300);

      const result = await cued.runJob(command, {
        timeout: effectiveTimeout,
        cwd,
        pty: params.pty ?? false,
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
          formatStringArg(args.action, { fallback: "list" }),
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
      params: {
        action?: string;
        id?: string;
        status?: string;
        limit?: number;
        timeout?: number;
        tail_bytes?: number;
      },
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      const action = (params.action ?? "list").toLowerCase();

      if (action === "list") {
        let jobs = await cued.listJobs();
        const filter = (params.status ?? "all").toLowerCase();
        if (filter !== "all") jobs = jobs.filter((j) => j.status.toLowerCase() === filter);
        const total = jobs.length;
        jobs = jobs.slice(0, normalizeLimit(params.limit));
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

      if (!params.id)
        return {
          content: [{ type: "text" as const, text: `action='${action}' requires id parameter.` }],
          details: { error: "missing_id" },
        };

      if (action === "stop") {
        await cued.stopJob(params.id);
        return {
          content: [{ type: "text" as const, text: `Stopped ${params.id}.` }],
          details: { targetId: params.id },
        };
      }

      if (action === "status") {
        const tailBytes = normalizeTailBytes(params.tail_bytes);

        if (params.id.startsWith("CH")) {
          const jobs = jobsForChain(await cued.listJobs(), params.id);
          if (jobs.length === 0)
            return {
              content: [{ type: "text" as const, text: `${params.id} not found.` }],
              details: { found: false },
            };

          const lines = [`${statusLabel(chainStatus(jobs))} — chain ${params.id}`];
          for (const job of jobs) {
            const leafLabel = `Leaf ${(job.chain_index ?? 0) + 1}/${job.chain_total ?? jobs.length}`;
            lines.push("", `${leafLabel}: ${statusLabel(job.status)} — ${job.pipeline}`);
            if (job.exit_code != null) lines.push(`Exit code: ${job.exit_code}`);
            await appendJobOutput(cued, job, lines, tailBytes);
          }
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: {
              chainId: params.id,
              status: chainStatus(jobs),
              jobs,
            },
          };
        }

        if (params.id.startsWith("C")) {
          const cron = await cued.cronStatus(params.id);
          if (!cron)
            return {
              content: [{ type: "text" as const, text: `${params.id} not found.` }],
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

        const job = await cued.jobStatus(params.id);
        if (!job)
          return {
            content: [{ type: "text" as const, text: `${params.id} not found.` }],
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
        const deadline = Date.now() + (params.timeout ?? 300) * 1000;
        const tailBytes = normalizeTailBytes(params.tail_bytes);

        if (params.id.startsWith("CH")) {
          while (Date.now() < deadline) {
            const jobs = jobsForChain(await cued.listJobs(), params.id);
            if (jobs.length === 0)
              return {
                content: [{ type: "text" as const, text: `Chain ${params.id} not found.` }],
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
              const lines = [`${statusLabel(status)} — chain ${params.id}`];
              for (const job of jobs) {
                const leafLabel = `Leaf ${(job.chain_index ?? 0) + 1}/${job.chain_total ?? jobs.length}`;
                lines.push("", `${leafLabel}: ${statusLabel(job.status)} — ${job.pipeline}`);
                if (job.exit_code != null) lines.push(`Exit code: ${job.exit_code}`);
                await appendJobOutput(cued, job, lines, tailBytes);
              }
              const text = `Chain ${params.id} completed\n\n${lines.join("\n")}`;
              if (status === "Failed") throw new Error(text);
              if (status === "Killed") throw new Error(`Chain ${params.id} was killed`);
              if (status === "Cancelled") throw new Error(`Chain ${params.id} was cancelled`);
              return {
                content: [{ type: "text" as const, text }],
                details: {
                  chainId: params.id,
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
                text: `Timed out after ${params.timeout ?? 300}s waiting for ${params.id}.`,
              },
            ],
            details: { timedOut: true, targetId: params.id },
          };
        }

        while (Date.now() < deadline) {
          const job = await cued.jobStatus(params.id);
          if (!job)
            return {
              content: [{ type: "text" as const, text: `Job ${params.id} not found.` }],
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
            const text = `Job ${params.id} completed\n\n${lines.join("\n")}`;
            if (job.status === "Failed") throw new Error(text);
            if (job.status === "Killed") throw new Error(`Job ${params.id} was killed`);
            if (job.status === "Cancelled") throw new Error(`Job ${params.id} was cancelled`);
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
              text: `Timed out after ${params.timeout ?? 300}s waiting for ${params.id}.`,
            },
          ],
          details: { timedOut: true },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown action: '${action}'. Valid: list, status, wait, stop.`,
          },
        ],
        details: { error: "unknown_action" },
      };
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
          formatStringArg(args.action, { fallback: "list" }),
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
      params: {
        action: string;
        schedule?: string;
        command?: string;
        id?: string;
        status?: string;
        limit?: number;
      },
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      const action = params.action.toLowerCase();

      // add
      if (action === "add") {
        if (!params.schedule || !params.command) {
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
        const cronId = await cued.addCron(params.schedule, params.command);
        return {
          content: [
            {
              type: "text" as const,
              text: `Schedule: ${cronId}\nRemove with cue_schedule action=remove id=${cronId}.`,
            },
          ],
          details: {
            cronId,
            schedule: params.schedule,
            command: params.command,
          },
        };
      }

      // list
      if (action === "list") {
        let crons = await cued.listCrons();
        const filter = (params.status ?? "all").toLowerCase();
        if (filter !== "all") crons = crons.filter((c) => c.status.toLowerCase() === filter);
        const total = crons.length;
        crons = crons.slice(0, normalizeLimit(params.limit));
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
      if (!params.id) {
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
        await cued.pauseCron(params.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Paused ${params.id}. Resume with cue_schedule action=resume id=${params.id}.`,
            },
          ],
          details: { id: params.id, paused: true },
        };
      }
      if (action === "resume") {
        await cued.resumeCron(params.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Resumed ${params.id}.`,
            },
          ],
          details: { id: params.id, resumed: true },
        };
      }
      if (action === "remove") {
        await cued.stopJob(params.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Removed ${params.id}.`,
            },
          ],
          details: { id: params.id, removed: true },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown action: '${action}'. Valid: add, list, pause, resume, remove.`,
          },
        ],
        details: {},
      };
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
      env_tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Deprecated alias for tail_bytes when includeEnv=true. Default: 16384. Pass 0 for full env.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderToolCall(
        "cue_scope",
        [
          formatStringArg(args.action, { fallback: "list" }),
          formatNumberArg(args.limit, { prefix: "limit=" }),
          args.includeEnv === true ? "include-env" : undefined,
          formatNumberArg(args.tail_bytes, { prefix: "tail=" }),
          formatNumberArg(args.env_tail_bytes, { prefix: "env-tail=" }),
        ],
        theme,
      );
    },
    async execute(
      _toolCallId: string,
      params: {
        action?: string;
        limit?: number;
        includeEnv?: boolean;
        tail_bytes?: number;
        env_tail_bytes?: number;
      },
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      const action = (params.action ?? "list").toLowerCase();

      if (action === "env" || action === "config") {
        const raw = action === "env" ? await cued.showEnv() : await cued.showConfig();
        const tailed = tailStr(raw, normalizeTailBytes(params.tail_bytes, DEFAULT_ENV_TAIL_BYTES));
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

      if (action !== "list")
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown action: '${action}'. Valid: list, env, config.`,
            },
          ],
          details: { error: "unknown_action" },
        };

      const all = await cued.listScopes();
      const visible = all.slice(0, normalizeLimit(params.limit));
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
      if (params.includeEnv === true) {
        const tailBytes = normalizeTailBytes(
          params.tail_bytes ?? params.env_tail_bytes,
          DEFAULT_ENV_TAIL_BYTES,
        );
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
      params: { id?: string; limit?: number; tail_bytes?: number },
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      const raw = await cued.showLog(params.id);
      const tailed = tailStr(raw, normalizeTailBytes(params.tail_bytes, DEFAULT_LOG_TAIL_BYTES));
      const limited = limitLines(tailed.text, normalizeLimit(params.limit, 80));
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
          id: params.id ?? null,
          rawChars: raw.length,
          shownChars: limited.text.length,
          truncated: tailed.truncated || limited.truncated,
        },
      };
    },
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  pi.on("session_start", () => {
    const withoutBash = pi
      .getAllTools()
      .map((t) => t.name)
      .filter((name) => name !== "bash");
    pi.setActiveTools(withoutBash);
  });

  pi.on("session_shutdown", async () => {
    if (client && !client.isClosed) {
      client.close();
      client = null;
    }
  });
}

export default function piCueExtension(pi: ExtensionAPI) {
  registerPiCueTools(pi as PiCueExtensionApi);
}
