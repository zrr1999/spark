/**
 * pi-cue extension
 *
 * Atomic execution tools organized by the three category objects:
 *
 *   Jobs (category J):
 *     run     — create and execute a job
 *     jobs    — list jobs
 *     status  — inspect a job/cron (state + stdout + stderr)
 *     kill    — terminate a job or remove a cron
 *     wait    — block until a background job completes
 *
 *   Crons (recurring Job factories):
 *     cron    — unified cron management (add / list / pause / resume / remove)
 *
 *   System (Scope & history):
 *     scopes  — list environment scopes
 *     log     — show job and daemon history
 *
 * See ARCHITECTURE.md for the category-theoretic model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface PiCueExtensionApi {
  registerTool(config: {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: Record<string, unknown>;
    }>;
  }): void;
  on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void;
  getAllTools(): Array<{ name: string }>;
  setActiveTools(names: string[]): void;
}

export { CueClient, CueError, defaultSocketPath } from "./cue-client.ts";
export type { JobInfo, JobResult, JobStatus, StartJobResult } from "./cue-client.ts";

import { CueClient, CueError, type JobStatus, defaultSocketPath } from "./cue-client.ts";

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
  if (s.length <= maxBytes) return { text: s, truncated: false };
  return { text: s.slice(s.length - maxBytes), truncated: true };
}

// ── Extension ──────────────────────────────────────────────────────────────

export function registerPiCueTools(pi: PiCueExtensionApi) {
  // ═══════════════════════════════════════════════════════════════════
  //  run — create and execute a job
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "run",
    label: "Run Command",
    description:
      "Execute a command in cue-shell. " +
      "cue-shell is direct-exec (execvp) with its own composition operators: " +
      "|> pipes stdout, -> runs in serial on success, || runs in parallel, ~> runs in serial ignoring failure. " +
      "Set background=true to start without waiting; track with status/wait, stop with kill. " +
      "File-system commands (mv, cp, rm, ls, cat, find, ...) get a short 10s timeout by default.",
    parameters: Type.Object({
      command: Type.String({
        description:
          "Command to execute. Examples: 'cargo build |> grep error -> cargo test', '(cargo build || cargo audit) -> cargo test'.",
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
          description: "Working directory. Default: current directory.",
        }),
      ),
      tail: Type.Optional(
        Type.Boolean({
          description:
            "Truncate stdout/stderr to the last ~64 KiB each. Default: true. Set to false for full output.",
          default: true,
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        command: string;
        background?: boolean;
        timeout?: number;
        cwd?: string;
        tail?: boolean;
      },
      _signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      const { command, cwd } = params;
      const doTail = params.tail !== false; // default true: tail output
      const TAIL_BYTES = 64 * 1024; // 64 KiB
      const invocation = `run(command="${command}", background=${!!params.background}, timeout=${params.timeout ?? 300}${cwd ? `, cwd="${cwd}"` : ""})`;

      if (params.background) {
        const result = await cued.startJob(command, { cwd });
        const lines = [invocation, ""];
        if (result.kind === "chain" && result.chain) {
          const chain = result.chain;
          lines.push(`Chain: ${chain.id}  |  ${chain.total_jobs} job(s)`);
          for (const j of chain.jobs)
            lines.push(`  ${j.job_id ?? "(pending)"}  [${j.status.toLowerCase()}]  ${j.pipeline}`);
        } else {
          lines.push(`Job:   ${result.jobId}  [running]`);
          lines.push(`Cmd:   ${result.pipeline ?? command}`);
        }
        lines.push("", `Track: status(id="${result.jobId}")  or  wait(id="${result.jobId}")`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            jobId: result.jobId,
            kind: result.kind,
            chain: result.chain ?? null,
          },
        };
      }

      onUpdate({ content: [{ type: "text", text: invocation }] });
      const effectiveTimeout = params.timeout ?? (isFileOp(command) ? SHORT_TIMEOUT_S : 300);

      const result = await cued.runJob(command, {
        timeout: effectiveTimeout,
        cwd,
      });

      if (result.timedOut) {
        const lines = [
          invocation,
          "",
          `Job ${result.jobId}: Timed out after ${effectiveTimeout}s — switched to background.`,
          `Track: status(id="${result.jobId}")  or  wait(id="${result.jobId}")`,
        ];
        if (result.stdout.trim()) {
          const t = doTail
            ? tailStr(result.stdout, TAIL_BYTES)
            : { text: result.stdout, truncated: false };
          lines.push("", "[stdout so far]", t.text.trimEnd());
          if (t.truncated)
            lines.push(`[stdout truncated — use status(id="${result.jobId}") for full output]`);
        }
        if (result.stderr.trim()) {
          const t = doTail
            ? tailStr(result.stderr, TAIL_BYTES)
            : { text: result.stderr, truncated: false };
          lines.push("", "[stderr so far]", t.text.trimEnd());
          if (t.truncated) lines.push("[stderr truncated]");
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            jobId: result.jobId,
            timedOut: true,
            switchedToBackground: true,
          },
        };
      }

      if (
        result.status === "Failed" ||
        result.status === "Killed" ||
        result.status === "Cancelled"
      ) {
        const stderrTail = result.stderr ? result.stderr.slice(-500).trimEnd() : "";
        const parts = [`Job ${result.jobId}: ${result.status}`];
        if (result.exitCode !== null) parts.push(` (exit ${result.exitCode})`);
        if (result.stdout.trim()) {
          const t = doTail
            ? tailStr(result.stdout, TAIL_BYTES)
            : { text: result.stdout, truncated: false };
          parts.push("\n" + t.text.trimEnd());
          if (t.truncated)
            parts.push(`[stdout truncated — use status(id="${result.jobId}") for full output]`);
        }
        if (stderrTail) parts.push("\n[stderr tail]\n" + stderrTail);
        throw new Error(parts.join(""));
      }

      const out = [`${invocation}\n\nJob ${result.jobId}: ${result.status}`];
      if (result.exitCode !== null && result.exitCode !== 0) out.push(` (exit ${result.exitCode})`);
      if (result.stdout.trim()) {
        const t = doTail
          ? tailStr(result.stdout, TAIL_BYTES)
          : { text: result.stdout, truncated: false };
        out.push("\n" + t.text.trimEnd());
        if (t.truncated)
          out.push(`\n[stdout truncated — use status(id="${result.jobId}") for full output]`);
      }
      if (result.stderr.trim()) {
        const t = doTail
          ? tailStr(result.stderr, TAIL_BYTES)
          : { text: result.stderr, truncated: false };
        out.push("\n[stderr]\n" + t.text.trimEnd());
        if (t.truncated)
          out.push(`\n[stderr truncated — use status(id="${result.jobId}") for full output]`);
      }

      return {
        content: [{ type: "text" as const, text: out.join("") }],
        details: {
          jobId: result.jobId,
          status: result.status,
          exitCode: result.exitCode,
        },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  jobs — list jobs
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "jobs",
    label: "List Jobs",
    description: "List cue-shell jobs with status and pipeline.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          description: "Filter: running, pending, done, failed, killed, all. Default: all.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { status?: string },
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      let jobs = await cued.listJobs();
      const filter = (params.status ?? "all").toLowerCase();
      if (filter !== "all") jobs = jobs.filter((j) => j.status.toLowerCase() === filter);
      if (jobs.length === 0)
        return {
          content: [{ type: "text" as const, text: "No matching jobs." }],
          details: { jobs: [] },
        };
      const lines = jobs.map((j) => {
        let s = `${j.id}  ${statusLabel(j.status)}  ${j.pipeline}`;
        if (j.exit_code != null) s += ` (exit ${j.exit_code})`;
        if (j.chain_id) s += ` [${j.chain_id}]`;
        return s;
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `jobs(status="${filter}")\n\n${lines.join("\n")}`,
          },
        ],
        details: { jobs },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  status — inspect job or cron (state + stdout + stderr)
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "status",
    label: "Job/Cron Status",
    description: "Inspect a job or cron by ID. Returns status, exit code, stdout and stderr.",
    parameters: Type.Object({
      id: Type.String({ description: "Job ID (J<n>) or cron ID (C<n>)." }),
      tail_bytes: Type.Optional(
        Type.Number({
          description:
            "Limit output to last N bytes per stream. Default: 65536 (64 KiB). Pass 0 for full output.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string; tail_bytes?: number },
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      const tailBytes = params.tail_bytes !== undefined ? params.tail_bytes : 65536;

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

      try {
        const out = await cued.jobOutput(params.id, tailBytes === 0 ? undefined : tailBytes);
        if (out.stdout.trim()) parts.push("", out.stdout.trimEnd());
        if (out.truncated) parts.push("[stdout truncated]");
      } catch {
        /* output may not be ready */
      }

      try {
        const errOut = await cued.jobError(params.id);
        if (errOut.stderr.trim()) parts.push("", "[stderr]", errOut.stderr.trimEnd());
      } catch {
        /* stderr may not be ready */
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `status(id="${params.id}")\n\n${parts.join("\n")}`,
          },
        ],
        details: {
          jobId: job.id,
          status: job.status,
          exitCode: job.exit_code,
          pipeline: job.pipeline,
        },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  kill — terminate a job or remove a cron
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "kill",
    label: "Kill Job / Remove Cron",
    description: "Kill a running job or remove a cron. Has no effect on already-completed jobs.",
    parameters: Type.Object({
      id: Type.String({ description: "Job ID (J<n>) or cron ID (C<n>)." }),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string },
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      await cued.stopJob(params.id);
      return {
        content: [{ type: "text" as const, text: `kill(id="${params.id}")\n\nDone.` }],
        details: { targetId: params.id },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  wait — block until job reaches terminal state
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "wait",
    label: "Wait for Job",
    description:
      "Block until a background job reaches Done, Failed, or Killed, then return its status and output.",
    parameters: Type.Object({
      id: Type.String({
        description: "Job ID (J<n>) returned by run(background=true).",
      }),
      timeout: Type.Optional(
        Type.Number({
          description: "Max wait time in seconds. Default: 300.",
          default: 300,
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string; timeout?: number },
      _signal: AbortSignal,
      onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      onUpdate({
        content: [
          {
            type: "text",
            text: `wait(id="${params.id}", timeout=${params.timeout ?? 300})`,
          },
        ],
      });

      const deadline = Date.now() + (params.timeout ?? 300) * 1000;

      while (Date.now() < deadline) {
        const job = await cued.jobStatus(params.id);
        if (!job)
          return {
            content: [
              {
                type: "text" as const,
                text: `wait(id="${params.id}") — job not found.`,
              },
            ],
            details: { found: false },
          };

        if (
          job.status === "Done" ||
          job.status === "Failed" ||
          job.status === "Killed" ||
          job.status === "Cancelled"
        ) {
          const out = await cued.jobOutput(params.id);
          const lines = [`${statusLabel(job.status)} — ${job.pipeline}`];
          if (job.exit_code != null) lines.push(`Exit code: ${job.exit_code}`);
          if (out.stdout.trim()) lines.push("", out.stdout.trimEnd());
          if (out.stderr.trim()) lines.push("", "[stderr]", out.stderr.trimEnd());
          const text = `wait(id="${params.id}") — completed\n\n${lines.join("\n")}`;
          if (job.status === "Failed") throw new Error(text);
          if (job.status === "Killed") throw new Error(`wait(id="${params.id}") — job was killed`);
          if (job.status === "Cancelled")
            throw new Error(`wait(id="${params.id}") — job was cancelled`);
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
            text: `wait(id="${params.id}") — timed out after ${params.timeout ?? 300}s.`,
          },
        ],
        details: { timedOut: true },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  cron — unified cron management
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "cron",
    label: "Manage Crons",
    description:
      "Unified cron management. " +
      "action='add': schedule a recurring job (requires schedule + command). " +
      "action='list': list all crons. " +
      "action='pause'/'resume': control a cron by id. " +
      "action='remove': delete a cron by id (also available via kill).",
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
          description: "Cron ID (C<n>), required for pause/resume/remove.",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "Filter for action='list': scheduled, paused, completed, expired, active, all. Default: all.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        action: string;
        schedule?: string;
        command?: string;
        id?: string;
        status?: string;
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
              text: `cron(action="add", schedule="${params.schedule}", command="${params.command}")\n\nCron: ${cronId}\nRemove: kill(id="${cronId}")`,
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
        if (crons.length === 0)
          return {
            content: [{ type: "text" as const, text: "No matching crons." }],
            details: { crons: [] },
          };
        const lines = crons.map((c) => `${c.id}  [${c.status}]  ${c.schedule}  →  ${c.command}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `cron(action="list")\n\n${lines.join("\n")}`,
            },
          ],
          details: { crons },
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
              text: `cron(action="pause", id="${params.id}")\n\nPaused. Resume: cron(action="resume", id="${params.id}")`,
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
              text: `cron(action="resume", id="${params.id}")\n\nResumed.`,
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
              text: `cron(action="remove", id="${params.id}")\n\nRemoved.`,
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
  //  scopes — list environment scopes
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "scopes",
    label: "List Scopes",
    description:
      "List cue-shell environment scopes. Each scope is an immutable, content-addressed env snapshot.",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      const all = await cued.listScopes();
      if (all.length === 0)
        return {
          content: [{ type: "text" as const, text: "No scopes." }],
          details: { scopes: [] },
        };
      // Also show current env and config
      const envText = await cued.showEnv();
      const lines = [
        ...all.map((s) => `${s.hash}  parent=${s.parent ?? "-"}  cwd=${s.cwd}  env=${s.env_count}`),
        "",
        "--- HEAD env ---",
        envText.trimEnd(),
      ];
      return {
        content: [{ type: "text" as const, text: `scopes()\n\n${lines.join("\n")}` }],
        details: { scopes: all },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════
  //  log — show history
  // ═══════════════════════════════════════════════════════════════════

  pi.registerTool({
    name: "log",
    label: "Show Log",
    description:
      "Show cue-shell history. Pass an id to focus on one job/cron, or omit for the full log.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description: "Optional job ID (J<n>) or cron ID (C<n>) to focus on.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { id?: string },
      _signal: AbortSignal,
      _onUpdate: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      ctx: { ui?: { notify?: (msg: string, level: string) => void } },
    ) {
      const cued = await getClient(ctx);
      const text = await cued.showLog(params.id);
      const label = params.id ? `log(id="${params.id}")` : "log()";
      return {
        content: [{ type: "text" as const, text: `${label}\n\n${text}` }],
        details: { id: params.id ?? null },
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
