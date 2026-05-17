/**
 * cue-shell IPC client for Node.js
 *
 * Speaks the cue-shell length-prefixed JSON framing protocol over a Unix
 * domain socket.  The default socket path follows cue-shell's own convention:
 * `$XDG_RUNTIME_DIR/cue-shell/cued.sock` with a fallback to the platform
 * temp directory.
 *
 * Protocol: 4-byte big-endian length prefix + UTF-8 JSON body.
 * Max message size: 16 MiB.
 */

import { type Socket, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";

// ── Default socket path ────────────────────────────────────────────────────

const APP_DIR = "cue-shell";
const SOCK_NAME = "cued.sock";

/** Resolve the default cue-shell daemon socket path. */
export function defaultSocketPath(): string {
  const runtimeDir = env.XDG_RUNTIME_DIR ?? tmpdir();
  return join(runtimeDir, APP_DIR, SOCK_NAME);
}

// ── IPC message types (mirrors cue_core::ipc) ──────────────────────────────

export type Mode = "Job" | "Cron";

export interface RequestEnvelope {
  type: "request";
  id: number;
  payload: RequestPayload;
}

export type RequestPayload =
  | { Eval: { input: string; mode: Mode } }
  | { Subscribe: { channels: string[] } }
  | { Unsubscribe: { channels: string[] } }
  | { Ping: Record<string, never> }
  | { Shutdown: Record<string, never> };

export interface ResponseEnvelope {
  type: "response";
  id: number;
  payload: ResponsePayload;
}

export type ResponsePayload = { Ok: OkPayload } | { Err: { code: string; message: string } };

export type OkPayload =
  | { Ack: Record<string, never> }
  | { JobCreated: JobCreatedPayload }
  | { ChainCreated: ChainCreatedPayload }
  | { JobInfo: JobInfo }
  | { JobList: JobInfo[] }
  | { ScopeInfo: ScopeInfo }
  | { ScopeList: ScopeInfo[] }
  | { Pong: Record<string, never> }
  | { EvalText: { text: string } }
  | { Output: { id: string; data: string; truncated: boolean } }
  | Record<string, unknown>;

export interface JobCreatedPayload {
  job_id: string;
  start_scope?: string;
  open_hint: "stream" | "fg";
  chain_id?: string;
  chain_index?: number;
  chain_total?: number;
}

export interface ChainCreatedPayload {
  chain_id: string;
  job_ids: string[];
  chain: ChainInfo;
}

export interface ChainInfo {
  id: string;
  pipeline: string;
  total_jobs: number;
  jobs: ChainJobInfo[];
}

export interface ChainJobInfo {
  index: number;
  pipeline: string;
  status: JobStatus;
  job_id?: string;
  start_scope?: string;
  end_scope?: string;
  open_hint?: "stream" | "fg";
}

export type CronStatus = "active" | "paused" | "completed" | "expired";

export interface CronInfo {
  id: string;
  schedule: string;
  command: string;
  status: CronStatus;
}

export type JobStatus = "Pending" | "Running" | "Done" | "Failed" | "Killed" | "Cancelled";

export interface JobInfo {
  id: string;
  status: JobStatus;
  pipeline: string;
  exit_code?: number | null;
  start_scope?: string;
  end_scope?: string;
  open_hint: "stream" | "fg";
  chain_id?: number | string | null;
  chain_index?: number;
  chain_total?: number;
}

export interface ScopeInfo {
  hash: string;
  parent?: string | null;
  cwd: string;
  env_count: number;
}

export interface EventEnvelope {
  type: "event";
  payload: EventPayload;
}

export type EventPayload =
  | { JobStateChanged: JobStateChangedEvent }
  | { JobCreated: JobCreatedEvent }
  | { ChainStarted: { chain: ChainInfo } }
  | { ChainProgress: { chain: ChainInfo } }
  | { ChainFinished: { chain_id: string; success: boolean } }
  | { JobRemoved: { job_id: string } }
  | { OutputChunk: OutputChunkEvent }
  | { OutputEof: { id: string } }
  | { ShuttingDown: { reason: string } }
  | { DaemonReady: Record<string, never> }
  | Record<string, unknown>;

export interface JobStateChangedEvent {
  job_id: string;
  old_state: JobStatus;
  new_state: JobStatus;
  end_scope?: string;
  chain_id?: string;
  chain_index?: number;
}

export interface JobCreatedEvent {
  job_id: string;
  pipeline: string;
  start_scope?: string;
  open_hint: "stream" | "fg";
  chain_id?: string;
  chain_index?: number;
  chain_total?: number;
}

export interface OutputChunkEvent {
  id: string;
  stream: "stdout" | "stderr";
  data: string;
}

export type CueMessage = RequestEnvelope | ResponseEnvelope | EventEnvelope;

function normalizeJobStatus(status: unknown): JobStatus {
  if (typeof status === "string") {
    return status as JobStatus;
  }
  if (status && typeof status === "object" && "Cancelled" in (status as Record<string, unknown>)) {
    return "Cancelled";
  }
  return "Pending";
}

// ── Framing constants ──────────────────────────────────────────────────────

const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16 MiB
const MAX_OUTPUT_BUFFER = 4 * 1024 * 1024; // 4 MiB per stream, per job

// ── Connection state ───────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: ResponsePayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Active connection to the cued daemon. */
export class CueClient {
  #socket: Socket;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #listeners = new Map<string, Set<(event: EventPayload) => void>>();
  #buffer = Buffer.alloc(0);
  #closed = false;
  #closePromise: Promise<void>;
  #resolveClose!: () => void;

  /** Create a client from an already-connected Unix socket. */
  constructor(socket: Socket) {
    this.#socket = socket;
    this.#closePromise = new Promise((resolve) => {
      this.#resolveClose = resolve;
    });

    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", (err: Error) => this.#onError(err));
    socket.on("close", () => {
      this.#closed = true;
      this.#rejectAll(new Error("connection closed"));
      this.#resolveClose();
    });
  }

  /** Connect to the cued daemon at the given socket path. */
  static connect(socketPath?: string): Promise<CueClient> {
    const path = socketPath ?? defaultSocketPath();
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path }, () => {
        resolve(new CueClient(socket));
      });
      socket.on("error", reject);
    });
  }

  /** Resolved when the connection closes. */
  get closed(): Promise<void> {
    return this.#closePromise;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  // ── Requests ────────────────────────────────────────────────────────

  /** Send an Eval request for literal cue-shell commands (:kill, :jobs, :out). */
  async #rawEval(input: string, mode: Mode = "Job"): Promise<number> {
    return this.#send({ Eval: { input, mode } });
  }

  /** Send a raw Eval request and wait for the response payload. */
  async #rawEvalAndWait(input: string, mode: Mode = "Job"): Promise<ResponsePayload> {
    const requestId = await this.#rawEval(input, mode);
    return this.#waitForResponse(requestId);
  }

  /**
   * Send a `:run` Eval request.  cue-shell has its own grammar (not bash-compatible) — commands
   * are direct-exec (execvp).  For composition use cue-shell's native
   * operators:
   *
   *   Pipeline (job-internal, connect process stdin/stdout):
   *     `|>`   stdout pipe
   *     `|&>`  stdout+stderr pipe
   *     `|!>`  stderr-only pipe
   *
   *   Chain (between jobs, scheduler-managed):
   *     `->`   serial, success-continue
   *     `~>`   serial, ignore-failure
   *     `||`   parallel, all
   *     `||?`  parallel, any-success
   */
  async eval(input: string, mode: Mode = "Job", cwd?: string): Promise<number> {
    const cwdParam = cwd ? `(cwd=${cwd})` : "";
    return this.#send({ Eval: { input: `:run${cwdParam} ${input}`, mode } });
  }

  /** Subscribe to one or more event channels. */
  async subscribe(channels: string[]): Promise<void> {
    const id = await this.#send({ Subscribe: { channels } });
    await this.#waitForResponse(id);
  }

  /** Ping the daemon. */
  async ping(): Promise<void> {
    const id = await this.#send({ Ping: {} });
    await this.#waitForResponse(id);
  }

  /**
   * Run a command and wait for it to complete, collecting all output.
   * Returns job info + stdout/stderr + exit code.
   */
  async runJob(command: string, opts?: RunJobOptions): Promise<JobResult> {
    const timeoutMs = (opts?.timeout ?? 300) * 1000;
    const cwd = opts?.cwd;

    // Subscribe to global jobs channel before issuing the command.
    await this.#ensureSubscribed("jobs");

    // Issue the eval.  The daemon sends job/chain events before the
    // response for successful runs.
    const requestId = await this.eval(command, "Job", cwd);
    const response = await this.#waitForResponse(requestId);

    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    // Extract job ids from the response — may be a single job or a chain.
    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    let allJobIds: string[] = [];
    let firstJobId: string | null = null;

    if (ok && "ChainCreated" in ok) {
      const payload = (ok as { ChainCreated: ChainCreatedPayload }).ChainCreated;
      allJobIds = payload.job_ids;
      firstJobId = payload.job_ids[0] ?? payload.chain_id;
    } else if (ok && "JobCreated" in ok) {
      const id = (ok as { JobCreated: JobCreatedPayload }).JobCreated.job_id;
      allJobIds = [id];
      firstJobId = id;
    }

    if (!firstJobId || allJobIds.length === 0) {
      throw new CueError("UNEXPECTED_RESPONSE", "no job id from response");
    }

    // Subscribe to output channels for all jobs in the chain.
    for (const id of allJobIds) {
      await this.subscribe([`output:${id}`]);
    }

    // Collect output and wait for completion
    return this.#collectJobOutput(firstJobId, allJobIds, timeoutMs);
  }

  /**
   * Start a job in background mode — returns immediately with metadata.
   * Use `jobStatus()` and `jobOutput()` to track progress.
   */
  async startJob(command: string, opts?: StartJobOptions): Promise<StartJobResult> {
    await this.#ensureSubscribed("jobs");

    const requestId = await this.eval(command, "Job", opts?.cwd);
    const response = await this.#waitForResponse(requestId);

    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    const ok = (response as { Ok: Record<string, unknown> }).Ok;

    // Handle ChainCreated (chain syntax like `a -> b`)
    if (ok && "ChainCreated" in ok) {
      const payload = (ok as { ChainCreated: ChainCreatedPayload }).ChainCreated;
      return {
        jobId: payload.job_ids[0] ?? payload.chain_id,
        kind: "chain",
        chain: payload.chain,
      };
    }

    // Handle JobCreated (single job)
    if (ok && "JobCreated" in ok) {
      return {
        jobId: (ok as { JobCreated: JobCreatedPayload }).JobCreated.job_id,
        kind: "job",
        pipeline: command,
      };
    }

    throw new CueError("UNEXPECTED_RESPONSE", "expected JobCreated or ChainCreated response");
  }

  /** Stop (kill) a running job or remove a cron. */
  async stopJob(jobId: string): Promise<void> {
    const requestId = await this.#rawEval(`:kill ${jobId}`);
    const response = await this.#waitForResponse(requestId);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
  }

  /** List all jobs via `:jobs`. */
  async listJobs(): Promise<JobInfo[]> {
    const response = await this.#rawEvalAndWait(":jobs");

    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (ok && "JobList" in ok) {
      return (ok as { JobList: JobInfo[] }).JobList.map((job) => ({
        ...job,
        status: normalizeJobStatus((job as { status: unknown }).status),
      }));
    }
    if (ok && "JobInfo" in ok) {
      const job = (ok as { JobInfo: JobInfo }).JobInfo;
      return [
        {
          ...job,
          status: normalizeJobStatus((job as { status: unknown }).status),
        },
      ];
    }
    return [];
  }

  /** Get job status via `:jobs`. */
  async jobStatus(jobId: string): Promise<JobInfo | null> {
    const list = await this.listJobs();
    return list.find((j) => j.id === jobId) ?? null;
  }

  /** Get cron status via `:crons`. */
  async cronStatus(cronId: string): Promise<CronInfo | null> {
    const list = await this.listCrons();
    return list.find((c) => c.id === cronId) ?? null;
  }

  /** Get buffered stdout from the daemon. */
  async jobOutput(
    jobId: string,
    tailBytes?: number,
  ): Promise<{ stdout: string; stderr: string; truncated?: boolean }> {
    const suffix = tailBytes ? ` ${tailBytes}` : "";
    const response = await this.#rawEvalAndWait(`:out ${jobId}${suffix}`);

    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (ok && "Output" in ok) {
      const out = (ok as { Output: { id: string; data: string; truncated: boolean } }).Output;
      return { stdout: out.data, stderr: "", truncated: out.truncated };
    }

    if (ok && "EvalText" in ok) {
      return {
        stdout: (ok as { EvalText: { text: string } }).EvalText.text,
        stderr: "",
        truncated: false,
      };
    }

    return { stdout: "", stderr: "", truncated: false };
  }

  /** Get buffered stderr from the daemon. */
  async jobError(jobId: string): Promise<{ stderr: string; truncated?: boolean }> {
    const response = await this.#rawEvalAndWait(`:err ${jobId}`);

    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (ok && "Output" in ok) {
      const out = (ok as { Output: { id: string; data: string; truncated: boolean } }).Output;
      return { stderr: out.data, truncated: out.truncated };
    }

    if (ok && "EvalText" in ok) {
      return {
        stderr: (ok as { EvalText: { text: string } }).EvalText.text,
        truncated: false,
      };
    }

    return { stderr: "", truncated: false };
  }

  /** Send stdin to a running job. */
  async sendInput(id: string, data: string): Promise<void> {
    const response = await this.#rawEvalAndWait(`:send ${id} ${data}`);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
  }

  /** Cancel a pending/running job. */
  async cancelJob(id: string): Promise<void> {
    const response = await this.#rawEvalAndWait(`:cancel ${id}`);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
  }

  /** Pause a cron. */
  async pauseCron(id: string): Promise<void> {
    const response = await this.#rawEvalAndWait(`:pause ${id}`);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
  }

  /** Resume a cron. */
  async resumeCron(id: string): Promise<void> {
    const response = await this.#rawEvalAndWait(`:resume ${id}`);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
  }

  /** Retry a terminal job. */
  async retryJob(id: string): Promise<StartJobResult> {
    const response = await this.#rawEvalAndWait(`:retry ${id}`);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (ok && "ChainCreated" in ok) {
      const payload = (ok as { ChainCreated: ChainCreatedPayload }).ChainCreated;
      return {
        jobId: payload.job_ids[0] ?? payload.chain_id,
        kind: "chain",
        chain: payload.chain,
      };
    }
    if (ok && "JobCreated" in ok) {
      return {
        jobId: (ok as { JobCreated: JobCreatedPayload }).JobCreated.job_id,
        kind: "job",
      };
    }

    throw new CueError("UNEXPECTED_RESPONSE", "expected JobCreated or ChainCreated response");
  }

  /** Evaluate a raw daemon command that returns plain text. */
  async evalText(input: string, mode: Mode = "Job"): Promise<string> {
    const response = await this.#rawEvalAndWait(input, mode);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (ok && "EvalText" in ok) {
      return (ok as { EvalText: { text: string } }).EvalText.text;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected EvalText response");
  }

  /** List all scopes. */
  async listScopes(): Promise<ScopeInfo[]> {
    const response = await this.#rawEvalAndWait(":scopes");
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (ok && "ScopeList" in ok) {
      return (ok as { ScopeList: ScopeInfo[] }).ScopeList;
    }
    if (ok && "ScopeInfo" in ok) {
      return [(ok as { ScopeInfo: ScopeInfo }).ScopeInfo];
    }
    return [];
  }

  /** Show current env snapshot. */
  async showEnv(): Promise<string> {
    return this.evalText(":env");
  }

  /** Show current config. */
  async showConfig(): Promise<string> {
    return this.evalText(":config");
  }

  /** Show log output. */
  async showLog(id?: string): Promise<string> {
    return this.evalText(id ? `:log ${id}` : ":log");
  }

  /** Schedule a recurring or one-shot cron job.  Returns the cron id. */
  async addCron(schedule: string, command: string): Promise<string> {
    const input = `:cron ${schedule} ${command}`;
    const requestId = await this.#rawEval(input);
    const response = await this.#waitForResponse(requestId);

    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (ok && "CronAdded" in ok) {
      return (ok as { CronAdded: { cron_id: string } }).CronAdded.cron_id;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected CronAdded response");
  }

  /** List all cron jobs. */
  async listCrons(): Promise<CronInfo[]> {
    const requestId = await this.#rawEval(":crons");
    const response = await this.#waitForResponse(requestId);

    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (ok && "CronList" in ok) {
      return (ok as { CronList: CronInfo[] }).CronList;
    }
    return [];
  }

  /** Remove a cron job. */
  async removeCron(cronId: string): Promise<void> {
    await this.stopJob(cronId);
  }

  // ── Event listeners ─────────────────────────────────────────────────

  /** Listen for events on a channel prefix.  E.g. "output:J1" or "jobs". */
  onEvent(channelPrefix: string, handler: (event: EventPayload) => void): () => void {
    let listeners = this.#listeners.get(channelPrefix);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(channelPrefix, listeners);
    }
    listeners.add(handler);
    return () => {
      listeners?.delete(handler);
      if (listeners?.size === 0) this.#listeners.delete(channelPrefix);
    };
  }

  /** Close the connection. */
  close(): void {
    if (!this.#closed) {
      this.#socket.destroy();
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  #subscribedChannels = new Set<string>();

  async #ensureSubscribed(channel: string): Promise<void> {
    if (this.#subscribedChannels.has(channel)) return;
    await this.subscribe([channel]);
    this.#subscribedChannels.add(channel);
  }

  #send(payload: RequestPayload): Promise<number> {
    if (this.#closed) throw new Error("connection closed");

    const id = this.#nextId++;
    const request: RequestEnvelope = { type: "request", id, payload };
    const frame = this.#encodeFrame(request);
    this.#socket.write(frame);

    return Promise.resolve(id);
  }

  #waitForResponse(id: number, timeoutMs = 30_000): Promise<ResponsePayload> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`request ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    while (this.#buffer.length >= 4) {
      const len = this.#buffer.readUInt32BE(0);
      if (len > MAX_MESSAGE_SIZE) {
        this.#onError(new Error(`message too large: ${len} bytes`));
        return;
      }
      if (this.#buffer.length < 4 + len) break; // need more data

      const body = this.#buffer.subarray(4, 4 + len);
      this.#buffer = this.#buffer.subarray(4 + len);

      try {
        const msg: CueMessage = JSON.parse(body.toString("utf-8"));
        this.#dispatch(msg);
      } catch (err) {
        this.#onError(new Error(`failed to parse message: ${(err as Error).message}`));
        return;
      }
    }
  }

  #dispatch(msg: CueMessage): void {
    if (msg.type === "response") {
      const pending = this.#pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(msg.id);
        pending.resolve(msg.payload);
      }
    } else if (msg.type === "event") {
      this.#dispatchEvent(msg.payload);
    }
    // request messages are not expected on the client side
  }

  #dispatchEvent(payload: EventPayload): void {
    // Route to channel-specific listeners
    let channel: string | null = null;

    if ("JobStateChanged" in payload) {
      channel = `jobs`;
    } else if ("JobCreated" in payload) {
      channel = `jobs`;
    } else if ("ChainStarted" in payload) {
      channel = `jobs`;
    } else if ("ChainProgress" in payload) {
      channel = `jobs`;
    } else if ("ChainFinished" in payload) {
      channel = `jobs`;
    } else if ("JobRemoved" in payload) {
      channel = `jobs`;
    } else if ("OutputChunk" in payload) {
      const jobId = (payload as { OutputChunk: OutputChunkEvent }).OutputChunk.id;
      channel = `output:${jobId}`;
    } else if ("OutputEof" in payload) {
      const jobId = (payload as { OutputEof: { id: string } }).OutputEof.id;
      channel = `output:${jobId}`;
    }

    if (channel) {
      const listeners = this.#listeners.get(channel);
      if (listeners) {
        for (const handler of listeners) {
          try {
            handler(payload);
          } catch {
            // swallow listener errors
          }
        }
      }
    }
  }

  #onError(err: Error): void {
    if (!this.#closed) {
      this.#rejectAll(err);
      this.#socket.destroy();
    }
  }

  #rejectAll(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #encodeFrame(msg: CueMessage): Buffer {
    const json = Buffer.from(JSON.stringify(msg), "utf-8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length, 0);
    return Buffer.concat([len, json]);
  }

  async #collectJobOutput(
    firstJobId: string,
    chainJobIds: string[],
    timeoutMs: number,
  ): Promise<JobResult> {
    // For single-job commands, check if already done (fast-command race).
    if (chainJobIds.length === 1) {
      const jobId = chainJobIds[0];
      const initial = await this.jobStatus(jobId);
      if (initial) {
        if (["Done", "Failed", "Killed", "Cancelled"].includes(initial.status)) {
          const out = await this.jobOutput(jobId);
          const err = await this.jobError(jobId);
          return {
            jobId,
            status: initial.status,
            stdout: out.stdout,
            stderr: err.stderr,
            exitCode: initial.exit_code ?? null,
            timedOut: false,
          };
        }
      }
    } else {
      // For chains, check if ALL leaves are already done (very fast chains).
      let allDone = true;
      const outParts: string[] = [];
      const errParts: string[] = [];
      let finalStatus: JobStatus = "Done";
      let finalExit: number | null = null;
      for (const jid of chainJobIds) {
        const info = await this.jobStatus(jid);
        if (!info || !["Done", "Failed", "Killed", "Cancelled"].includes(info.status)) {
          allDone = false;
          break;
        }
        if (info.status !== "Done") finalStatus = info.status;
        if (info.exit_code != null && info.exit_code !== 0) finalExit = info.exit_code;
        const out = await this.jobOutput(jid);
        if (out.stdout.trim()) outParts.push(out.stdout.trimEnd());
        const err = await this.jobError(jid);
        if (err.stderr.trim()) errParts.push(err.stderr.trimEnd());
      }
      if (allDone) {
        return {
          jobId: firstJobId,
          status: finalStatus,
          stdout: outParts.join("\n"),
          stderr: errParts.join("\n"),
          exitCode: finalExit,
          timedOut: false,
        };
      }
    }

    const isChain = chainJobIds.length > 1;

    return new Promise((resolve) => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let resolved = false;

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({
          jobId: firstJobId,
          status: "Running",
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          exitCode: null,
          timedOut: true,
        });
      }, timeoutMs);

      // For chains, track terminal state per leaf.
      const terminalSet = new Set<string>();
      const doneSet = new Set(chainJobIds);

      const maybeResolve = () => {
        if (resolved) return;
        if (isChain) {
          // Resolve once all chain leaves have reached a terminal state.
          for (const jid of chainJobIds) {
            if (!terminalSet.has(jid)) return;
          }
        }
        // All done (chain) or single job reached terminal state.
        resolved = true;
        clearTimeout(timer);
        cleanup();
        resolve({
          jobId: firstJobId,
          status: doneSet.size === 0 ? "Done" : "Done",
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          exitCode: null,
          timedOut: false,
        });
      };

      const unsubJob = this.onEvent(`jobs`, (event) => {
        if ("JobStateChanged" in event) {
          const change = (event as { JobStateChanged: JobStateChangedEvent }).JobStateChanged;

          // For single jobs, only care about our job.
          // For chains, track state changes for any leaf.
          if (!isChain && change.job_id !== firstJobId) return;
          if (isChain && !chainJobIds.includes(change.job_id)) return;

          const newState = normalizeJobStatus((change as { new_state: unknown }).new_state);
          const terminal: JobStatus[] = ["Done", "Failed", "Killed", "Cancelled"];
          if (terminal.includes(newState)) {
            terminalSet.add(change.job_id);
            maybeResolve();
          }
        }
      });

      // Subscribe to output for all chain jobs.
      const unsubs: Array<() => void> = [];
      for (const jid of chainJobIds) {
        unsubs.push(
          this.onEvent(`output:${jid}`, (event) => {
            if ("OutputChunk" in event) {
              const chunk = (event as { OutputChunk: OutputChunkEvent }).OutputChunk;
              if (chunk.stream === "stdout") {
                if (stdoutLen < MAX_OUTPUT_BUFFER) {
                  stdoutChunks.push(chunk.data);
                  stdoutLen += chunk.data.length;
                }
              } else {
                if (stderrLen < MAX_OUTPUT_BUFFER) {
                  stderrChunks.push(chunk.data);
                  stderrLen += chunk.data.length;
                }
              }
            }
          }),
        );
      }

      function cleanup() {
        unsubJob();
        for (const u of unsubs) u();
      }
    });
  }
}

// ── Public types ───────────────────────────────────────────────────────────

export interface RunJobOptions {
  /** Timeout in seconds (default: 300 = 5 min). */
  timeout?: number;
  /** Working directory override. */
  cwd?: string;
}

export interface StartJobOptions {
  /** Working directory override. */
  cwd?: string;
}

export interface JobResult {
  jobId: string;
  status: JobStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Result from startJob (background mode). */
export interface StartJobResult {
  jobId: string;
  /** "job" for single commands, "chain" for chain syntax. */
  kind: "job" | "chain";
  /** Pipeline text for single jobs. */
  pipeline?: string;
  /** Full chain info for chain commands. */
  chain?: ChainInfo;
}

export class CueError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`cue-shell error [${code}]: ${message}`);
    this.name = "CueError";
    this.code = code;
  }
}
