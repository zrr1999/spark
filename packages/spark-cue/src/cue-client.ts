/**
 * cue-shell IPC client for Node.js
 *
 * Speaks the cue-shell length-prefixed JSON framing protocol over either a
 * Unix domain socket or an SSH gateway stdio stream. The default Unix socket
 * path follows cue-shell's own convention: `$XDG_RUNTIME_DIR/cue-shell/cued.sock`
 * with a fallback to the platform temp directory.
 *
 * Protocol: 4-byte big-endian length prefix + UTF-8 JSON body.
 * Max message size: 16 MiB.
 */

import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import {
  validateCueErrorPayload,
  validateCueEventPayload,
  validateCueOkPayload,
} from "./cue-wire-validators.ts";

// ── Default socket path ────────────────────────────────────────────────────

const APP_DIR = "cue-shell";
const SOCK_NAME = "cued.sock";

/** Resolve the default cue-shell daemon socket path. */
export function defaultSocketPath(): string {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim() || tmpdir();
  return join(runtimeDir, APP_DIR, SOCK_NAME);
}

export type CueResolvedTransport =
  | {
      schema_version: number;
      profile_name: string;
      transport: "unix";
      socket_path: string;
    }
  | {
      schema_version: number;
      profile_name: string;
      transport: "ssh";
      destination: string;
      gateway_command: string;
      start_command: string;
    };

interface ResolverAttempt {
  command: string;
  args: string[];
}

export const DEFAULT_CUE_RESOLVER_TIMEOUT_MS = 10_000;
export const DEFAULT_CUE_CONNECT_TIMEOUT_MS = 10_000;

const RESOLVER_ATTEMPTS: ResolverAttempt[] = [
  { command: "cue-client", args: ["target", "resolve", "--json"] },
  { command: "cue", args: ["client", "target", "resolve", "--json"] },
];

export async function resolveCueTransport(): Promise<CueResolvedTransport> {
  const failures: string[] = [];
  for (const attempt of RESOLVER_ATTEMPTS) {
    try {
      const stdout = await runResolverAttempt(attempt);
      return parseResolvedTransport(stdout, `${attempt.command} ${attempt.args.join(" ")}`);
    } catch (error) {
      failures.push(`${attempt.command} ${attempt.args.join(" ")}: ${(error as Error).message}`);
    }
  }
  throw new CueError(
    "TRANSPORT_RESOLVE_FAILED",
    `failed to resolve cue-shell client transport via cue-client. Tried:\n${failures.join("\n")}`,
  );
}

function runResolverAttempt(attempt: ResolverAttempt): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(attempt.command, attempt.args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeoutMs = timeoutMsFromEnv(
      "PI_CUE_RESOLVER_TIMEOUT_MS",
      DEFAULT_CUE_RESOLVER_TIMEOUT_MS,
    );
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (cb: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cb();
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) => {
      settle(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString("utf8"));
          return;
        }
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(detail || `exited with code ${code}`));
      });
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle(() =>
          reject(
            new Error(
              `resolver timed out after ${timeoutMs}ms: ${attempt.command} ${attempt.args.join(" ")}`,
            ),
          ),
        );
      }, timeoutMs);
      timeout.unref?.();
    }
  });
}

function parseResolvedTransport(text: string, source: string): CueResolvedTransport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON from ${source}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid resolver payload from ${source}: expected object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema_version !== 1) {
    throw new Error(
      `unsupported resolver schema_version from ${source}: ${String(record.schema_version)}`,
    );
  }
  if (record.transport === "unix") {
    if (typeof record.profile_name !== "string" || typeof record.socket_path !== "string") {
      throw new Error(`invalid unix resolver payload from ${source}`);
    }
    return {
      schema_version: 1,
      profile_name: record.profile_name,
      transport: "unix",
      socket_path: record.socket_path,
    };
  }
  if (record.transport === "ssh") {
    if (
      typeof record.profile_name !== "string" ||
      typeof record.destination !== "string" ||
      typeof record.gateway_command !== "string" ||
      typeof record.start_command !== "string"
    ) {
      throw new Error(`invalid ssh resolver payload from ${source}`);
    }
    return {
      schema_version: 1,
      profile_name: record.profile_name,
      transport: "ssh",
      destination: record.destination,
      gateway_command: record.gateway_command,
      start_command: record.start_command,
    };
  }
  throw new Error(`unsupported resolver transport from ${source}: ${String(record.transport)}`);
}

async function resolveConnectionTransport(): Promise<CueResolvedTransport> {
  return resolveCueTransport();
}

function quoteModeParamValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

const RESOURCE_NEED_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function resourceNeedModeParams(needs: ResourceNeeds | undefined): string[] {
  if (!needs) return [];
  return Object.entries(needs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rawKey, rawValue]) => {
      const key = rawKey.trim();
      if (!key) throw new CueError("INVALID_NEED", "resource need key must be non-empty");
      if (key.startsWith("need.")) {
        throw new CueError(
          "INVALID_NEED",
          `resource need key \`${key}\` must omit the need. prefix`,
        );
      }
      if (!RESOURCE_NEED_KEY_PATTERN.test(key)) {
        throw new CueError(
          "INVALID_NEED",
          `resource need key \`${key}\` may contain only letters, numbers, _, ., :, and -`,
        );
      }

      if (typeof rawValue === "number") {
        if (!Number.isFinite(rawValue) || !Number.isInteger(rawValue) || rawValue < 0) {
          throw new CueError(
            "INVALID_NEED",
            `resource need \`${key}\` must be a non-negative integer count or string quantity`,
          );
        }
        return `need.${key}=${rawValue}`;
      }

      if (typeof rawValue !== "string") {
        throw new CueError(
          "INVALID_NEED",
          `resource need \`${key}\` must be a string quantity or non-negative integer count`,
        );
      }
      const value = rawValue.trim();
      if (!value) {
        throw new CueError("INVALID_NEED", `resource need \`${key}\` must be non-empty`);
      }
      return `need.${key}=${quoteModeParamValue(value)}`;
    });
}

// ── IPC message types (mirrors cue_core::ipc) ──────────────────────────────

export type Mode = "Job" | "Cron";

export interface RequestEnvelope {
  type: "request";
  id: number;
  /** Stable logical side-effect key; omitted for queries and connection-local requests. */
  operation_id?: string;
  payload: RequestPayload;
}

export type RequestPayload =
  | { Eval: { input: string; mode: Mode } }
  | { RunScript: { path: string; input: string } }
  | {
      Handshake: {
        session_id: string;
        cwd: string;
        env: Record<string, string>;
        refresh?: boolean;
      };
    }
  | { Subscribe: { channels: string[] } }
  | { Unsubscribe: { channels: string[] } }
  | { FgAttach: { id: string } }
  | { FgDetach: Record<string, never> }
  | { FgInput: { data: string } }
  | { FgResize: { cols: number; rows: number } }
  | { Complete: { input: string; cursor: number } }
  | { Highlight: { input: string } }
  | { ListJobs: { limit?: number | null } }
  | { ListCrons: { limit?: number | null } }
  | { ListScopes: { limit?: number | null } }
  | { ScriptInfo: { id: string } }
  | { ShowLog: { id?: string | null; limit?: number | null; tail_bytes?: number | null } }
  | { JobOutput: { id: string; stdout_bytes?: number | null; stderr_bytes?: number | null } }
  | { KillJob: { id: string } }
  | { CancelExecution: { id: string } }
  | { RemoveCron: { id: string } }
  | { ShowEnv: { tail_bytes?: number | null } }
  | { ShowConfig: { tail_bytes?: number | null } }
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
  | { ScriptCreated: ScriptCreatedPayload }
  | { ScriptInfo: ScriptInfoPayload }
  | { JobInfo: JobInfo }
  | { JobList: JobInfo[] }
  | { JobListPage: { jobs: JobInfo[]; page: PageInfo } }
  | { CronAdded: { cron_id: string } }
  | { CronList: CronInfo[] }
  | { CronListPage: { crons: CronInfo[]; page: PageInfo } }
  | { ScopeInfo: ScopeInfo }
  | { ScopeList: ScopeInfo[] }
  | { ScopeListPage: { scopes: ScopeInfo[]; page: PageInfo } }
  | { ScopeCreated: ScopeCreatedPayload }
  | { Pong: PongPayload }
  | { EvalText: { text: string } }
  | {
      TextOutput: {
        text: string;
        truncated: boolean;
        encoding?: OutputEncoding;
        base64?: string;
      };
    }
  | {
      Output: {
        id: string;
        data: string;
        truncated: boolean;
        encoding?: OutputEncoding;
        base64?: string;
      };
    }
  | { JobOutput: JobOutputPayload }
  | { CompletionList: { items: CompletionItem[] } }
  | { HighlightResult: { spans: HighlightSpan[] } }
  | { FgAttached: { id: string } };

/**
 * Daemon Pong payload.
 *
 * All fields are required by IPC v2. Older daemons are rejected during
 * connection initialization rather than being treated as a partial protocol.
 */
export interface PongPayload {
  version: string;
  protocol_version: number;
  capabilities: string[];
  /** Unique to one daemon process lifetime; ledger replay is valid only within it. */
  instance_id: string;
}

export interface ScopeCreatedPayload {
  hash: string;
  summary: string;
}

export interface CueSessionOptions {
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Explicitly refresh an existing cue-shell session from this cwd/env snapshot. */
  refresh?: boolean;
}

export interface JobCreatedPayload {
  job_id: string;
  start_scope?: string;
  open_hint: "stream" | "fg";
  chain_id?: string;
  chain_index?: number;
  chain_total?: number;
  warnings: string[];
}

export interface ChainCreatedPayload {
  chain_id: string;
  job_ids: string[];
  chain: ChainInfo;
  warnings: string[];
}

export type ScriptSource = { kind: "inline" } | { kind: "file"; path: string };

export type ScriptItemResult =
  | {
      kind: "job";
      job_id: string;
      start_scope?: string;
      open_hint: "stream" | "fg";
    }
  | {
      kind: "chain";
      chain_id: string;
      job_ids: string[];
      chain: ChainInfo;
    }
  | { kind: "cron"; cron_id: string }
  | { kind: "message"; text: string };

export interface ScriptItemInfo {
  index: number;
  source: string;
  result: ScriptItemResult;
}

export interface ScriptSubmitError {
  index: number;
  source: string;
  code: string;
  message: string;
}

export interface ScriptCreatedPayload {
  script_id: string;
  source: ScriptSource;
  items: ScriptItemInfo[];
  submit_error: ScriptSubmitError | null;
}

export type ScriptRunStatus = "done" | "failed";

export type ScriptInfoStatus = "running" | ScriptRunStatus;

export interface ScriptInfoPayload {
  script_id: string;
  status: ScriptInfoStatus;
  items: ScriptItemInfo[];
  exit_code: number | null;
  failed_item_index: number | null;
  submit_error: ScriptSubmitError | null;
}

export interface ScriptFinishedEvent {
  script_id: string;
  status: ScriptRunStatus;
  exit_code: number;
  failed_item_index: number | null;
}

interface ScriptTerminalState {
  status: ScriptRunStatus;
  exit_code: number | null;
  failed_item_index: number | null;
}

export interface ScriptItemCreatedEvent {
  script_id: string;
  item: ScriptItemInfo;
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
  /** Structured reason when status is Cancelled. */
  cancelReason?: CancelReason;
}

export type CronStatus = "scheduled" | "paused" | "completed" | "expired" | "failed";

export interface CronInfo {
  id: string;
  schedule: string;
  command: string;
  status: CronStatus;
}

export type JobStatus = "Pending" | "Running" | "Done" | "Failed" | "Killed" | "Cancelled";
export type CancelReason = "User" | "ChainAborted" | "Timeout";

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
  pending_reason?: string | null;
  /** Structured reason when status is Cancelled. */
  cancelReason?: CancelReason;
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
  | { ChainProgress: { chain: ChainInfo } }
  | { ScriptItemCreated: ScriptItemCreatedEvent }
  | { ScriptFinished: ScriptFinishedEvent }
  | { JobRemoved: { job_id: string } }
  | { CronTriggered: { cron_id: string; job_id: string } }
  | { CronRemoved: { cron_id: string } }
  | { OutputChunk: OutputChunkEvent }
  | { OutputChunkBinary: OutputChunkBinaryEvent }
  | { OutputEof: { id: string } }
  | { FgOutput: { data: string } }
  | { FgExited: { id: string; reason: string } }
  | { ShuttingDown: { reason: string } };

export interface JobStateChangedEvent {
  job_id: string;
  old_state: JobStatus;
  new_state: JobStatus;
  end_scope?: string;
  chain_id?: string;
  chain_index?: number;
  /** Structured reason for new_state when new_state is Cancelled. */
  cancelReason?: CancelReason;
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

export interface OutputChunkBinaryEvent {
  id: string;
  stream: "stdout" | "stderr";
  base64: string;
}

export interface PageInfo {
  total: number;
  shown: number;
  limit?: number | null;
  truncated: boolean;
}

export interface StreamText {
  data: string;
  truncated: boolean;
  encoding?: OutputEncoding;
  base64?: string;
}

export type OutputEncoding = "utf8" | "base64";

export type CompletionKind = "Command" | "Param" | "Id" | "Path" | "Operator";

export interface CompletionItem {
  label: string;
  insert_text: string;
  kind: CompletionKind;
  detail: string | null;
}

export type HighlightKind =
  | "CommandPrefix"
  | "CommandName"
  | "ModeParam"
  | "Operator"
  | "IdRef"
  | "Word"
  | "String"
  | "Number"
  | "Error";

export interface HighlightSpan {
  start: number;
  end: number;
  kind: HighlightKind;
}

interface JobOutputPayload {
  id: string;
  stdout: StreamText;
  stderr: StreamText;
  stderr_pty_merged: boolean;
}

export type CueMessage = RequestEnvelope | ResponseEnvelope | EventEnvelope;

type InboundCueMessage = ResponseEnvelope | EventEnvelope;
type WireRecord = Record<string, unknown>;

const JOB_STATUS_VARIANTS = new Set<JobStatus>([
  "Pending",
  "Running",
  "Done",
  "Failed",
  "Killed",
  "Cancelled",
]);
const CANCEL_REASONS = new Set(["User", "ChainAborted", "Timeout"]);

function invalidIpc(path: string, message: string): Error {
  return new Error(`invalid cue-shell IPC message at ${path}: ${message}`);
}

function wireRecord(value: unknown, path: string): WireRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidIpc(path, "expected an object");
  }
  return value as WireRecord;
}

function requireString(record: WireRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") throw invalidIpc(`${path}.${key}`, "expected a string");
  return value;
}

function requireInteger(record: WireRecord, key: string, path: string, max?: number): number {
  const value = record[key];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (max !== undefined && (value as number) > max)
  ) {
    throw invalidIpc(`${path}.${key}`, "expected a non-negative integer");
  }
  return value as number;
}

function assertEnvelopeKeys(record: WireRecord, expected: string[], path: string): void {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(record)) {
    if (!expectedKeys.has(key)) throw invalidIpc(path, `unknown field ${key}`);
  }
  for (const key of expected) {
    if (!(key in record)) throw invalidIpc(path, `missing field ${key}`);
  }
}

function singleVariant(
  value: unknown,
  variants: ReadonlySet<string>,
  path: string,
): [string, unknown] {
  const record = wireRecord(value, path);
  const keys = Object.keys(record);
  if (keys.length !== 1) throw invalidIpc(path, "expected exactly one protocol variant");
  const variant = keys[0]!;
  if (!variants.has(variant)) throw invalidIpc(path, `unknown protocol variant ${variant}`);
  return [variant, record[variant]];
}

function decodeJobStatusDetail(
  value: unknown,
  path: string,
): { status: JobStatus; cancelReason?: CancelReason } {
  if (typeof value === "string") {
    if (JOB_STATUS_VARIANTS.has(value as JobStatus)) return { status: value as JobStatus };
    throw invalidIpc(path, `unknown job status ${value}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidIpc(path, "unknown job status");
  }
  const cancelled = value as WireRecord;
  const keys = Object.keys(cancelled);
  if (
    keys.length === 1 &&
    keys[0] === "Cancelled" &&
    typeof cancelled.Cancelled === "string" &&
    CANCEL_REASONS.has(cancelled.Cancelled)
  ) {
    return { status: "Cancelled", cancelReason: cancelled.Cancelled as CancelReason };
  }
  throw invalidIpc(path, "unknown job status");
}

function decodeJobStatus(value: unknown, path: string): JobStatus {
  return decodeJobStatusDetail(value, path).status;
}

function validateOkPayload(value: unknown): OkPayload {
  const payload = validateCueOkPayload(value) as OkPayload;
  normalizeOkPayloadStatuses(payload);
  return payload;
}

function validateEventPayload(value: unknown): EventPayload {
  const payload = validateCueEventPayload(value) as EventPayload;
  normalizeEventPayloadStatuses(payload);
  return payload;
}

function normalizeOkPayloadStatuses(payload: OkPayload): void {
  if ("JobInfo" in payload) {
    normalizeJobInfoStatus(payload.JobInfo, "response.payload.Ok.JobInfo");
  } else if ("JobList" in payload) {
    payload.JobList.forEach((job, index) =>
      normalizeJobInfoStatus(job, `response.payload.Ok.JobList[${index}]`),
    );
  } else if ("JobListPage" in payload) {
    payload.JobListPage.jobs.forEach((job, index) =>
      normalizeJobInfoStatus(job, `response.payload.Ok.JobListPage.jobs[${index}]`),
    );
  } else if ("ChainCreated" in payload) {
    normalizeChainStatuses(payload.ChainCreated.chain, "response.payload.Ok.ChainCreated.chain");
  } else if ("ScriptCreated" in payload) {
    payload.ScriptCreated.items.forEach((item, index) =>
      normalizeScriptItemStatuses(item, `response.payload.Ok.ScriptCreated.items[${index}]`),
    );
  } else if ("ScriptInfo" in payload) {
    payload.ScriptInfo.items.forEach((item, index) =>
      normalizeScriptItemStatuses(item, `response.payload.Ok.ScriptInfo.items[${index}]`),
    );
  }
}

function normalizeEventPayloadStatuses(payload: EventPayload): void {
  if ("JobStateChanged" in payload) {
    const change = payload.JobStateChanged;
    const oldState = decodeJobStatusDetail(
      (change as { old_state: unknown }).old_state,
      "event.payload.JobStateChanged.old_state",
    );
    const newState = decodeJobStatusDetail(
      (change as { new_state: unknown }).new_state,
      "event.payload.JobStateChanged.new_state",
    );
    change.old_state = oldState.status;
    change.new_state = newState.status;
    if (newState.cancelReason) change.cancelReason = newState.cancelReason;
  } else if ("ChainProgress" in payload) {
    normalizeChainStatuses(payload.ChainProgress.chain, "event.payload.ChainProgress.chain");
  } else if ("ScriptItemCreated" in payload) {
    normalizeScriptItemStatuses(
      payload.ScriptItemCreated.item,
      "event.payload.ScriptItemCreated.item",
    );
  }
}

function normalizeJobInfoStatus(job: JobInfo, path: string): void {
  const decoded = decodeJobStatusDetail((job as { status: unknown }).status, `${path}.status`);
  job.status = decoded.status;
  if (decoded.cancelReason) job.cancelReason = decoded.cancelReason;
}

function normalizeChainStatuses(chain: ChainInfo, path: string): void {
  chain.jobs.forEach((job, index) => {
    const decoded = decodeJobStatusDetail(
      (job as { status: unknown }).status,
      `${path}.jobs[${index}].status`,
    );
    job.status = decoded.status;
    if (decoded.cancelReason) job.cancelReason = decoded.cancelReason;
  });
}

function normalizeScriptItemStatuses(item: ScriptItemInfo, path: string): void {
  if (item.result.kind === "chain") {
    normalizeChainStatuses(item.result.chain, `${path}.result.chain`);
  }
}

function mergeScriptItemInfo(
  existing: ScriptItemInfo | undefined,
  incoming: ScriptItemInfo,
  incomingAuthoritative = false,
): ScriptItemInfo {
  if (!existing) return incoming;
  if (
    existing.result.kind !== "chain" ||
    incoming.result.kind !== "chain" ||
    existing.result.chain_id !== incoming.result.chain_id
  ) {
    // Script item identity/result kind is immutable. A typed snapshot is
    // authoritative; ordinary live-event reconciliation remains monotonic.
    return incomingAuthoritative ? incoming : existing;
  }

  const jobsByIndex = new Map<number, ChainJobInfo>();
  const firstJobs = incomingAuthoritative ? existing.result.chain.jobs : incoming.result.chain.jobs;
  const secondJobs = incomingAuthoritative
    ? incoming.result.chain.jobs
    : existing.result.chain.jobs;
  for (const job of firstJobs) jobsByIndex.set(job.index, job);
  for (const job of secondJobs) {
    const prior = jobsByIndex.get(job.index);
    jobsByIndex.set(job.index, prior ? { ...prior, ...job } : job);
  }
  const jobIds = [...new Set([...existing.result.job_ids, ...incoming.result.job_ids])];
  const baseChain = incomingAuthoritative ? existing.result.chain : incoming.result.chain;
  const overlayChain = incomingAuthoritative ? incoming.result.chain : existing.result.chain;
  const baseResult = incomingAuthoritative ? existing.result : incoming.result;
  const overlayResult = incomingAuthoritative ? incoming.result : existing.result;
  return {
    ...(incomingAuthoritative ? existing : incoming),
    ...(incomingAuthoritative ? incoming : existing),
    result: {
      ...baseResult,
      ...overlayResult,
      job_ids: jobIds,
      chain: {
        ...baseChain,
        ...overlayChain,
        total_jobs: Math.max(
          incoming.result.chain.total_jobs,
          existing.result.chain.total_jobs,
          jobIds.length,
        ),
        jobs: [...jobsByIndex.values()].sort((left, right) => left.index - right.index),
      },
    },
  };
}

function decodeInboundCueMessage(value: unknown): InboundCueMessage {
  const envelope = wireRecord(value, "envelope");
  const type = requireString(envelope, "type", "envelope");
  if (type === "response") {
    assertEnvelopeKeys(envelope, ["type", "id", "payload"], "response envelope");
    const id = requireInteger(envelope, "id", "response envelope", 0xffff_ffff);
    const [variant, body] = singleVariant(
      envelope.payload,
      new Set(["Ok", "Err"]),
      "response.payload",
    );
    const payload: ResponsePayload =
      variant === "Ok"
        ? { Ok: validateOkPayload(body) }
        : (() => {
            const error = wireRecord(validateCueErrorPayload(body), "response.payload.Err");
            return {
              Err: {
                code: requireString(error, "code", "response.payload.Err"),
                message: requireString(error, "message", "response.payload.Err"),
              },
            };
          })();
    return { type, id, payload };
  }
  if (type === "event") {
    assertEnvelopeKeys(envelope, ["type", "payload"], "event envelope");
    return { type, payload: validateEventPayload(envelope.payload) };
  }
  throw invalidIpc("envelope.type", `unexpected inbound message type ${type}`);
}

function normalizeJobStatus(status: unknown): JobStatus {
  return decodeJobStatus(status, "job.status");
}

function normalizeJob(job: JobInfo): JobInfo {
  return {
    ...job,
    status: normalizeJobStatus((job as { status: unknown }).status),
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Aborted",
  );
  error.name = "AbortError";
  if (reason !== undefined) (error as Error & { cause?: unknown }).cause = reason;
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

interface DecodedOutputChunk {
  id: string;
  stream: "stdout" | "stderr";
  bytes: Buffer;
  encoding: OutputEncoding;
}

function outputChunkFromEvent(event: EventPayload): DecodedOutputChunk | null {
  if ("OutputChunk" in event) {
    const chunk = (event as { OutputChunk: OutputChunkEvent }).OutputChunk;
    return { id: chunk.id, stream: chunk.stream, bytes: Buffer.from(chunk.data), encoding: "utf8" };
  }
  if ("OutputChunkBinary" in event) {
    const chunk = (event as { OutputChunkBinary: OutputChunkBinaryEvent }).OutputChunkBinary;
    return {
      id: chunk.id,
      stream: chunk.stream,
      bytes: Buffer.from(chunk.base64, "base64"),
      encoding: "base64",
    };
  }
  return null;
}

function bytesFromStreamText(stream: StreamText): Buffer {
  if (stream.encoding === "base64" && typeof stream.base64 === "string") {
    return Buffer.from(stream.base64, "base64");
  }
  return Buffer.from(stream.data, "utf8");
}

interface OutputView {
  text: string;
  encoding: OutputEncoding;
  base64?: string;
}

function outputView(bytes: Buffer): OutputView {
  if (isUtf8(bytes)) return { text: bytes.toString("utf8"), encoding: "utf8" };
  return {
    text: bytes.toString("utf8"),
    encoding: "base64",
    base64: bytes.toString("base64"),
  };
}

function bytesFromJobOutput(output: JobOutputResult, stream: "stdout" | "stderr"): Buffer {
  const encoding = stream === "stdout" ? output.stdoutEncoding : output.stderrEncoding;
  const base64 = stream === "stdout" ? output.stdoutBase64 : output.stderrBase64;
  const text = stream === "stdout" ? output.stdout : output.stderr;
  return encoding === "base64" && base64 ? Buffer.from(base64, "base64") : Buffer.from(text);
}

function joinOutputParts(parts: Buffer[], separator: string): Buffer {
  if (parts.length === 0) return Buffer.alloc(0);
  if (!separator) return Buffer.concat(parts);
  const joined: Buffer[] = [];
  for (const [index, part] of parts.entries()) {
    if (index > 0) joined.push(Buffer.from(separator));
    joined.push(part);
  }
  return Buffer.concat(joined);
}

function buildJobResult(input: {
  jobId: string;
  status: JobStatus;
  cancelReason?: CancelReason;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  warnings: string[];
}): JobResult {
  const stdout = outputView(input.stdout);
  const stderr = outputView(input.stderr);
  const warnings = [...input.warnings];
  if (stdout.encoding === "base64") {
    warnings.push(
      "stdout contains non-UTF-8 bytes; stdout is a lossy view and stdoutBase64 is exact",
    );
  }
  if (stderr.encoding === "base64") {
    warnings.push(
      "stderr contains non-UTF-8 bytes; stderr is a lossy view and stderrBase64 is exact",
    );
  }
  return {
    jobId: input.jobId,
    status: input.status,
    ...(input.cancelReason ? { cancelReason: input.cancelReason } : {}),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutEncoding: stdout.encoding,
    stderrEncoding: stderr.encoding,
    ...(stdout.base64 ? { stdoutBase64: stdout.base64 } : {}),
    ...(stderr.base64 ? { stderrBase64: stderr.base64 } : {}),
    stdoutTruncated: input.stdoutTruncated,
    stderrTruncated: input.stderrTruncated,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    warnings,
  };
}

function reconcileCollectedStream(input: {
  live: Buffer;
  liveOverflowed: boolean;
  sawEofForEveryJob: boolean;
  buffered: Buffer;
  bufferedTruncated: boolean;
}): { bytes: Buffer; truncated: boolean } {
  if (!input.sawEofForEveryJob || input.live.length === 0) {
    return { bytes: input.buffered, truncated: input.bufferedTruncated };
  }
  if (!input.bufferedTruncated) {
    if (!input.liveOverflowed && input.live.equals(input.buffered)) {
      return { bytes: input.live, truncated: false };
    }
    return { bytes: input.buffered, truncated: false };
  }

  // The daemon's completed-job snapshot is a 1 MiB tail. A longer live
  // capture is more useful, but the pre-subscription prefix cannot be proven
  // complete, so keep truncation explicit instead of silently claiming it.
  return { bytes: input.live, truncated: true };
}

function okRecord(response: ResponsePayload): Record<string, unknown> {
  if ("Err" in response) {
    throw new CueError(response.Err.code, response.Err.message);
  }
  return (response as { Ok: Record<string, unknown> }).Ok;
}

function isNoBufferedOutputError(error: CueError): boolean {
  return error.code === "NOT_FOUND" && /no output found/i.test(error.message);
}

function textOutputFromOk(ok: Record<string, unknown>): string | null {
  if ("TextOutput" in ok) {
    return (ok as { TextOutput: { text: string; truncated: boolean } }).TextOutput.text;
  }
  if ("EvalText" in ok) {
    return (ok as { EvalText: { text: string } }).EvalText.text;
  }
  return null;
}

function scopeCreatedFromOk(ok: Record<string, unknown>): ScopeCreatedPayload | null {
  if (!("ScopeCreated" in ok)) return null;
  const payload = (ok as { ScopeCreated: ScopeCreatedPayload }).ScopeCreated;
  if (typeof payload.hash !== "string" || typeof payload.summary !== "string") return null;
  return payload;
}

// ── Framing constants ──────────────────────────────────────────────────────

const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16 MiB
const MAX_OUTPUT_BUFFER = 4 * 1024 * 1024; // 4 MiB per stream, per job
const MAX_SSH_STDERR_SNAPSHOT = 64 * 1024; // keep recent gateway diagnostics bounded
const REQUIRED_IPC_PROTOCOL_VERSION = 2;
const REQUIRED_IPC_CAPABILITY_SESSION_HANDSHAKE_REQUIRED = "session-handshake-required";
const REQUIRED_IPC_CAPABILITIES = [
  REQUIRED_IPC_CAPABILITY_SESSION_HANDSHAKE_REQUIRED,
  "script-item-created",
  "cancel-execution",
  "operation-idempotency",
  "script-info-recovery",
] as const;
const MAX_PENDING_REQUESTS = 1_024;
const REQUEST_TIMEOUT_MS = 30_000;
const SETTLED_RESPONSE_RETENTION_MS = 100;
const MAX_REQUEST_ID = 0xffff_ffff;
const PROCESS_SESSION_ID = `spark-cue:process:${process.pid}:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`;

// ── Connection state ───────────────────────────────────────────────────────

interface PendingRequest {
  promise: Promise<ResponsePayload>;
  resolve: (value: ResponsePayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
  settled: boolean;
}

interface CueClientStream {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
  write(frame: Buffer): boolean;
  destroy(error?: Error): void;
}

/** Stable inputs used to derive a bounded daemon operation id. */
export interface CueOperationKey {
  /** Logical Spark/cue-shell session identity, not a transport connection id. */
  sessionId: string;
  /** Pi's stable tool-call id. */
  toolCallId: string;
  /** A distinct semantic step within the tool call (for example submit or cancel). */
  kind: string;
}

function requireOperationPart(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CueError("INVALID_OPERATION_KEY", `${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Derive the wire operation id without randomness. The digest keeps arbitrary
 * session/tool ids safely below cue-shell's 128-byte envelope limit.
 */
export function cueOperationId(operation: CueOperationKey): string {
  const canonical = JSON.stringify([
    "spark-cue-operation-v1",
    requireOperationPart(operation.sessionId, "operation sessionId"),
    requireOperationPart(operation.toolCallId, "operation toolCallId"),
    requireOperationPart(operation.kind, "operation kind"),
  ]);
  return `spark-cue:v1:${createHash("sha256").update(canonical).digest("base64url")}`;
}

/** Derive a non-colliding child step while retaining the same logical tool call. */
export function cueOperationStep(
  operation: CueOperationKey | undefined,
  step: string,
): CueOperationKey | undefined {
  if (!operation) return undefined;
  return {
    ...operation,
    kind: `${requireOperationPart(operation.kind, "operation kind")}/${requireOperationPart(step, "operation step")}`,
  };
}

function nextRequestId(id: number): number {
  return id >= MAX_REQUEST_ID ? 1 : id + 1;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function isSensitiveCueEnvKey(key: string): boolean {
  // Keep this classifier in lockstep with cue-shell's daemon-side scope
  // persistence policy. Spark must use at least the same superset because the
  // handshake and cue_scope output cross the model boundary before cue-shell's
  // persistence guard can protect them.
  const words = key
    .split(/[^a-z0-9]+/iu)
    .filter(Boolean)
    .map((word) => word.toUpperCase());
  const compact = words.join("");
  const sensitiveWords = new Set([
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "PASS",
    "CREDENTIAL",
    "CREDENTIALS",
    "AUTH",
    "AUTHORIZATION",
    "OAUTH",
    "COOKIE",
    "DSN",
    "PASSPHRASE",
  ]);
  if (words.some((word) => sensitiveWords.has(word))) return true;
  if (
    compact.endsWith("TOKEN") ||
    compact.endsWith("SECRET") ||
    compact.includes("PASSWORD") ||
    compact.endsWith("CREDENTIAL") ||
    compact.endsWith("CREDENTIALS") ||
    compact.endsWith("COOKIE") ||
    compact.includes("APIKEY") ||
    compact.includes("ACCESSKEY") ||
    compact.includes("PRIVATEKEY")
  ) {
    return true;
  }
  const namesDatabase = ["DATABASE", "REDIS", "MONGO", "MONGODB", "POSTGRES", "POSTGRESQL"].some(
    (backend) => compact.includes(backend),
  );
  const namesConnectionLocator =
    words.some((word) => word === "URL" || word === "URI" || word === "CONNECTIONSTRING") ||
    compact.includes("CONNECTIONSTRING");
  return namesDatabase && namesConnectionLocator;
}

function normalizeSessionEnv(
  input: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const source = input ?? process.env;
  const forwardSensitive = process.env.SPARK_CUE_FORWARD_SENSITIVE_ENV === "1";
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!forwardSensitive && isSensitiveCueEnvKey(key)) continue;
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function normalizeCueSessionOptions(
  options: CueSessionOptions | undefined,
): Required<CueSessionOptions> {
  const cwd = options?.cwd?.trim() || process.cwd();
  const sessionId = options?.sessionId?.trim() || `${PROCESS_SESSION_ID}:${stableHash(cwd)}`;
  return {
    sessionId,
    cwd,
    env: normalizeSessionEnv(options?.env),
    refresh: options?.refresh ?? false,
  };
}

async function connectUnixCueClient(path: string, session?: CueSessionOptions): Promise<CueClient> {
  const socket = await openUnixSocket(path);
  return initializeConnectedClient(new CueClient(socket), session);
}

async function openUnixSocket(path: string): Promise<Socket> {
  try {
    return await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({ path }, () => {
        socket.setTimeout(0);
        resolve(socket);
      });
      const timeoutMs = timeoutMsFromEnv(
        "PI_CUE_CONNECT_TIMEOUT_MS",
        DEFAULT_CUE_CONNECT_TIMEOUT_MS,
      );
      if (timeoutMs > 0) {
        socket.setTimeout(timeoutMs, () => {
          socket.destroy(new Error(`connect timed out after ${timeoutMs}ms`));
        });
      }
      socket.on("error", reject);
    });
  } catch (error) {
    throw new CueError(
      "DAEMON_UNREACHABLE",
      `failed to connect to cue-shell daemon socket ${path}: ${describeError(error)}`,
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : 0;
}

async function connectSshCueClient(
  transport: Extract<CueResolvedTransport, { transport: "ssh" }>,
  session?: CueSessionOptions,
): Promise<CueClient> {
  const stream = SshCueClientStream.spawn(transport);
  const client = new CueClient(stream);
  try {
    return await initializeConnectedClient(client, session);
  } catch (error) {
    client.close();
    throw new CueError(
      "DAEMON_UNREACHABLE",
      sshConnectionErrorMessage(transport, stream.stderrSnapshot(), error),
    );
  }
}

async function initializeConnectedClient(
  client: CueClient,
  session?: CueSessionOptions,
): Promise<CueClient> {
  try {
    await client.handshake(session);
    await client.pingForVersion();
    return client;
  } catch (error) {
    client.close();
    if (error instanceof CueError) throw error;
    throw unsupportedProtocolError(
      "cue-shell daemon accepted the connection but IPC initialization failed; upgrade/restart cued",
      error,
    );
  }
}

function sshConnectionErrorMessage(
  transport: Extract<CueResolvedTransport, { transport: "ssh" }>,
  stderr: string,
  error: unknown,
): string {
  const detail = stderr || (error instanceof Error ? error.message : String(error));
  return [
    `cue profile \`${transport.profile_name}\` failed to connect via SSH to ${transport.destination}.`,
    `Gateway command: ${transport.gateway_command}`,
    `Remote daemon startup is explicit; start it with: ssh ${transport.destination} ${JSON.stringify(transport.start_command)}`,
    `Detail: ${detail}`,
  ].join("\n");
}

class SshCueClientStream extends EventEmitter implements CueClientStream {
  #child: ChildProcessWithoutNullStreams;
  #stderr: Buffer[] = [];
  #stderrBytes = 0;
  #closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    super();
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.emit("data", chunk));
    child.stdout.on("error", (error: Error) => this.emit("error", error));
    child.stdin.on("error", (error: Error) => this.emit("error", error));
    child.stderr.on("data", (chunk: Buffer) => this.#appendStderr(chunk));
    child.stderr.on("error", (error: Error) => {
      this.#appendStderr(Buffer.from(`failed to read ssh stderr: ${error.message}`));
    });
    child.on("error", (error: Error) => this.emit("error", error));
    child.on("close", () => this.#emitCloseOnce());
  }

  static spawn(transport: Extract<CueResolvedTransport, { transport: "ssh" }>): SshCueClientStream {
    return new SshCueClientStream(
      spawn("ssh", [transport.destination, transport.gateway_command], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  }

  write(frame: Buffer): boolean {
    return this.#child.stdin.write(frame);
  }

  destroy(error?: Error): void {
    if (error) this.emit("error", error);
    this.#child.kill();
    this.#emitCloseOnce();
  }

  stderrSnapshot(): string {
    return Buffer.concat(this.#stderr, this.#stderrBytes).toString("utf8").trim();
  }

  #appendStderr(chunk: Buffer): void {
    let data = Buffer.from(chunk);
    if (data.length > MAX_SSH_STDERR_SNAPSHOT) {
      data = data.subarray(data.length - MAX_SSH_STDERR_SNAPSHOT);
      this.#stderr = [data];
      this.#stderrBytes = data.length;
      return;
    }

    this.#stderr.push(data);
    this.#stderrBytes += data.length;
    while (this.#stderrBytes > MAX_SSH_STDERR_SNAPSHOT) {
      const first = this.#stderr[0];
      if (!first) break;
      const extra = this.#stderrBytes - MAX_SSH_STDERR_SNAPSHOT;
      if (first.length <= extra) {
        this.#stderr.shift();
        this.#stderrBytes -= first.length;
      } else {
        this.#stderr[0] = first.subarray(extra);
        this.#stderrBytes -= extra;
      }
    }
  }

  #emitCloseOnce(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }
}

/** Active connection to the cued daemon. */
export class CueClient {
  #socket: CueClientStream;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #listeners = new Map<string, Set<(event: EventPayload) => void>>();
  #recentScriptItems: ScriptItemCreatedEvent[] = [];
  #recentScriptFinished: ScriptFinishedEvent[] = [];
  #buffer = Buffer.alloc(0);
  #closed = false;
  #daemonInstanceId: string | null = null;
  #closePromise: Promise<void>;
  #resolveClose!: () => void;

  /** Create a client from an already-connected cue-shell IPC stream. */
  constructor(socket: CueClientStream) {
    this.#socket = socket;
    this.#closePromise = new Promise((resolve) => {
      this.#resolveClose = resolve;
    });

    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", (err: Error) => this.#onTransportError(err));
    socket.on("close", () => {
      this.#closed = true;
      this.#rejectAll(new CueTransportError("connection closed"));
      this.#resolveClose();
    });
  }

  /** Test-only hook for exercising the u32 request-id wrap boundary. */
  static __setNextRequestIdForTests(client: CueClient, nextId: number): void {
    if (!Number.isInteger(nextId) || nextId < 1 || nextId > MAX_REQUEST_ID) {
      throw new Error("test request id must be an unsigned non-zero 32-bit integer");
    }
    client.#nextId = nextId;
  }

  /** Test-only observable for bounded pending-request lifecycle assertions. */
  static __pendingRequestCountForTests(client: CueClient): number {
    return client.#pending.size;
  }

  /**
   * Connect to the cued daemon.
   *
   * An explicit `socketPath` is always honored as a Unix socket override. Without
   * an override, spark-cue asks `cue-client target resolve --json` (falling back to
   * `cue client target ...`) for the active client transport profile and then
   * connects either to a Unix socket or to an SSH gateway stream.
   */
  static async connect(socketPath?: string, session?: CueSessionOptions): Promise<CueClient> {
    if (socketPath) return connectUnixCueClient(socketPath, session);
    return CueClient.connectResolved(await resolveConnectionTransport(), session);
  }

  /** Connect to an already-resolved cue-shell client transport profile. */
  static async connectResolved(
    transport: CueResolvedTransport,
    session?: CueSessionOptions,
  ): Promise<CueClient> {
    if (transport.transport === "unix") return connectUnixCueClient(transport.socket_path, session);
    return connectSshCueClient(transport, session);
  }

  /** Resolved when the connection closes. */
  get closed(): Promise<void> {
    if (!this.#closed) return this.#closePromise;
    return Promise.resolve();
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** Daemon process-lifetime identity established by the required initialization Ping. */
  get daemonInstanceId(): string | null {
    return this.#daemonInstanceId;
  }

  // ── Requests ────────────────────────────────────────────────────────

  /** Send an Eval request for literal cue-shell commands (:kill, :jobs, :out). */
  async #rawEval(input: string, mode: Mode = "Job", operation?: CueOperationKey): Promise<number> {
    return this.#send({ Eval: { input, mode } }, operation);
  }

  /** Send a raw Eval request and wait for the response payload. */
  async #rawEvalAndWait(
    input: string,
    mode: Mode = "Job",
    operation?: CueOperationKey,
  ): Promise<ResponsePayload> {
    const requestId = await this.#rawEval(input, mode, operation);
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
   *   Job logical (inside one job):
   *     `&&`   logical AND
   *     `||`   logical OR
   *
   *   Chain (between jobs, scheduler-managed):
   *     `->`   serial, success-continue
   *     `~>`   serial, ignore-failure
   *     `|||`  parallel, all
   *     `|?|`  parallel, any-success race
   */
  async eval(input: string, mode: Mode = "Job", opts: RunEvalOptions = {}): Promise<number> {
    const modeParams: string[] = [];
    if (opts.pty !== undefined) modeParams.push(`pty=${opts.pty ? "true" : "false"}`);
    if (opts.cwd) modeParams.push(`cwd=${quoteModeParamValue(opts.cwd)}`);
    modeParams.push(...resourceNeedModeParams(opts.needs));
    const modeParamText = modeParams.length > 0 ? `(${modeParams.join(",")})` : "";
    return this.#send({ Eval: { input: `:run${modeParamText} ${input}`, mode } }, opts.operation);
  }

  /** Subscribe to one or more event channels. */
  async subscribe(channels: string[]): Promise<void> {
    const id = await this.#send({ Subscribe: { channels } });
    await this.#waitForResponse(id);
  }

  /** Remove one or more event-channel subscriptions. */
  async unsubscribe(channels: string[]): Promise<void> {
    if (channels.length === 0) return;
    const id = await this.#send({ Unsubscribe: { channels } });
    await this.#waitForResponse(id);
  }

  /** Attach this client to a live foreground PTY job. */
  async fgAttach(jobId: string): Promise<string> {
    const id = await this.#send({ FgAttach: { id: jobId } });
    const ok = okRecord(await this.#waitForResponse(id));
    if ("FgAttached" in ok) {
      return (ok as { FgAttached: { id: string } }).FgAttached.id;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected FgAttached response");
  }

  /** Detach this client from its foreground PTY job. */
  async fgDetach(): Promise<void> {
    const id = await this.#send({ FgDetach: {} });
    const ok = okRecord(await this.#waitForResponse(id));
    if (!("Ack" in ok)) throw new CueError("UNEXPECTED_RESPONSE", "expected Ack response");
  }

  /** Send raw bytes to the attached foreground PTY. */
  async fgInput(data: string | Uint8Array): Promise<void> {
    const base64 = Buffer.from(data).toString("base64");
    const id = await this.#send({ FgInput: { data: base64 } });
    const ok = okRecord(await this.#waitForResponse(id));
    if (!("Ack" in ok)) throw new CueError("UNEXPECTED_RESPONSE", "expected Ack response");
  }

  /** Resize the attached foreground PTY. */
  async fgResize(cols: number, rows: number): Promise<void> {
    if (
      !Number.isInteger(cols) ||
      cols < 0 ||
      cols > 0xffff ||
      !Number.isInteger(rows) ||
      rows < 0 ||
      rows > 0xffff
    ) {
      throw new CueError("INVALID_REQUEST", "foreground PTY size must use unsigned 16-bit values");
    }
    const id = await this.#send({ FgResize: { cols, rows } });
    const ok = okRecord(await this.#waitForResponse(id));
    if (!("Ack" in ok)) throw new CueError("UNEXPECTED_RESPONSE", "expected Ack response");
  }

  /** Request parser-aware completions from cue-shell. */
  async complete(input: string, cursor: number): Promise<CompletionItem[]> {
    const id = await this.#send({ Complete: { input, cursor } });
    const ok = okRecord(await this.#waitForResponse(id));
    if ("CompletionList" in ok) {
      return (ok as { CompletionList: { items: CompletionItem[] } }).CompletionList.items;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected CompletionList response");
  }

  /** Request syntax-highlight spans from cue-shell. */
  async highlight(input: string): Promise<HighlightSpan[]> {
    const id = await this.#send({ Highlight: { input } });
    const ok = okRecord(await this.#waitForResponse(id));
    if ("HighlightResult" in ok) {
      return (ok as { HighlightResult: { spans: HighlightSpan[] } }).HighlightResult.spans;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected HighlightResult response");
  }

  /** Send and acknowledge the cue-shell session handshake. */
  async handshake(options?: CueSessionOptions): Promise<void> {
    const session = normalizeCueSessionOptions(options);
    let response: ResponsePayload;
    try {
      const id = await this.#send({
        Handshake: {
          session_id: session.sessionId,
          cwd: session.cwd,
          env: normalizeSessionEnv(session.env),
          refresh: session.refresh,
        },
      });
      response = await this.#waitForResponse(id);
    } catch (error) {
      throw unsupportedProtocolError(
        "cue-shell daemon did not complete the required session Handshake; upgrade/restart cued",
        error,
      );
    }

    if ("Err" in response) {
      throw unsupportedProtocolError(
        `cue-shell daemon rejected the required session Handshake: ${response.Err.code}: ${response.Err.message}; upgrade/restart cued`,
      );
    }
    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (!ok || !("Ack" in ok)) {
      throw unsupportedProtocolError(
        "cue-shell daemon returned an unexpected response to the required session Handshake; upgrade/restart cued",
      );
    }
  }

  /** Ping the daemon and return its self-reported version. */
  async pingForVersion(): Promise<string | null> {
    const id = await this.#send({ Ping: {} });
    const response = await this.#waitForResponse(id);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (!ok || !("Pong" in ok)) {
      throw unsupportedProtocolError("cue-shell daemon did not return Pong to Ping");
    }
    const pong = (ok as { Pong: PongPayload }).Pong;
    const version = pong?.version;
    if (typeof version !== "string" || version.length === 0) {
      throw unsupportedProtocolError(
        "cue-shell daemon Pong is missing version; upgrade/restart cued",
      );
    }
    const protocolVersion = pong.protocol_version;
    if (typeof protocolVersion !== "number" || protocolVersion < REQUIRED_IPC_PROTOCOL_VERSION) {
      throw unsupportedProtocolError(
        `cue-shell daemon IPC protocol version ${String(protocolVersion)} is older than required ${REQUIRED_IPC_PROTOCOL_VERSION}; upgrade/restart cued`,
      );
    }
    const capabilities = Array.isArray(pong.capabilities) ? pong.capabilities : [];
    for (const capability of REQUIRED_IPC_CAPABILITIES) {
      if (!capabilities.includes(capability)) {
        throw unsupportedProtocolError(
          `cue-shell daemon is missing required IPC capability ${capability}; upgrade/restart cued`,
        );
      }
    }
    const instanceId = pong.instance_id;
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw unsupportedProtocolError(
        "cue-shell daemon Pong is missing instance_id; upgrade/restart cued",
      );
    }
    if (this.#daemonInstanceId !== null && this.#daemonInstanceId !== instanceId) {
      throw unsupportedProtocolError("cue-shell daemon changed instance_id on one connection");
    }
    this.#daemonInstanceId = instanceId;
    return version;
  }

  /** Ping the daemon. */
  async ping(): Promise<void> {
    await this.pingForVersion();
  }

  /**
   * Run a command and wait for it to complete, collecting all output.
   * Returns job info + stdout/stderr + exit code.
   */
  async runJob(command: string, opts?: RunJobOptions): Promise<JobResult> {
    const timeoutMs = (opts?.timeout ?? 300) * 1000;
    const cwd = opts?.cwd;
    const pty = opts?.pty ?? false;
    const needs = opts?.needs;
    const signal = opts?.signal;
    throwIfAborted(signal);

    // Subscribe to global jobs channel before issuing the command.
    await this.#ensureSubscribed("jobs");

    // Issue the eval.  The daemon sends job/chain events before the
    // response for successful runs.
    const requestId = await this.eval(command, "Job", {
      cwd,
      pty,
      needs,
      operation: cueOperationStep(opts?.operation, "submit"),
    });
    const response = await this.#waitForResponse(requestId);

    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }

    // Extract job ids from the response — may be a single job or a chain.
    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    let allJobIds: string[] = [];
    let firstJobId: string | null = null;
    let warnings: string[] = [];
    let chainId: string | undefined;
    let expectedJobCount: number | undefined;

    if (ok && "ChainCreated" in ok) {
      const payload = (ok as { ChainCreated: ChainCreatedPayload }).ChainCreated;
      allJobIds = payload.job_ids;
      firstJobId = payload.job_ids[0] ?? payload.chain_id;
      chainId = payload.chain_id;
      expectedJobCount = payload.chain.total_jobs;
      warnings = payload.warnings;
    } else if (ok && "JobCreated" in ok) {
      const payload = (ok as { JobCreated: JobCreatedPayload }).JobCreated;
      const id = payload.job_id;
      const chainJobs = await this.#chainJobsForCreatedJob(payload);
      if (chainJobs) {
        allJobIds = chainJobs.map((job) => job.id);
        firstJobId = allJobIds[0] ?? id;
        chainId = String(chainJobs[0]?.chain_id ?? payload.chain_id);
        expectedJobCount = chainJobs.length;
      } else {
        allJobIds = [id];
        firstJobId = id;
      }
      warnings = payload.warnings;
    }

    if (!firstJobId || allJobIds.length === 0) {
      throw new CueError("UNEXPECTED_RESPONSE", "no job id from response");
    }

    const cancelTarget = chainId ?? firstJobId;
    const outputChannels = allJobIds.map((id) => `output:${id}`);
    try {
      if (signal?.aborted) {
        await this.cancelExecution(cancelTarget, cueOperationStep(opts?.operation, "cancel"));
        throw abortError(signal);
      }
      for (const channel of outputChannels) await this.subscribe([channel]);
      return await this.#collectJobOutput(
        firstJobId,
        allJobIds,
        timeoutMs,
        warnings,
        chainId,
        expectedJobCount,
        signal,
        opts?.operation,
      );
    } finally {
      await this.unsubscribe(outputChannels).catch(() => {});
    }
  }

  /**
   * Start a job in background mode — returns immediately with metadata.
   * Use `jobStatus()` and `jobOutput()` to track progress.
   */
  async startJob(command: string, opts?: StartJobOptions): Promise<StartJobResult> {
    await this.#ensureSubscribed("jobs");

    const requestId = await this.eval(command, "Job", {
      cwd: opts?.cwd,
      pty: opts?.pty ?? false,
      needs: opts?.needs,
      operation: cueOperationStep(opts?.operation, "submit"),
    });
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
        warnings: payload.warnings,
      };
    }

    // Handle JobCreated (single job, or a chain whose leaves are discoverable via :jobs).
    if (ok && "JobCreated" in ok) {
      const payload = (ok as { JobCreated: JobCreatedPayload }).JobCreated;
      const jobs = await this.#chainJobsForCreatedJob(payload);
      if (jobs) {
        const chainId = String(jobs[0]?.chain_id ?? payload.chain_id);
        return {
          jobId: jobs[0]?.id ?? payload.job_id,
          kind: "chain",
          chain: this.#chainInfoFromJobs(chainId, command, jobs.length, jobs),
          warnings: payload.warnings,
        };
      }
      return {
        jobId: payload.job_id,
        kind: "job",
        pipeline: command,
        warnings: payload.warnings,
      };
    }

    throw new CueError("UNEXPECTED_RESPONSE", "expected JobCreated or ChainCreated response");
  }

  /**
   * Run a `.cue` file-script and wait for it to complete.
   *
   * Mirrors the foreground semantics of cue-shell’s `cue run <file.cue>` CLI:
   * top-level items execute sequentially, fail-fast, inside a fresh isolated
   * scope forked from HEAD. Returns the aggregated transcript per item plus
   * the script-level terminal status.
   */
  async runScript(opts: RunScriptOptions): Promise<ScriptResult> {
    const { path, input } = opts;
    const timeoutMs = (opts.timeout ?? 300) * 1000;
    const signal = opts.signal;
    throwIfAborted(signal);

    await this.#ensureSubscribed("jobs");

    const requestId = await this.#send(
      { RunScript: { path, input } },
      cueOperationStep(opts.operation, "submit"),
    );
    const response = await this.#waitForResponse(requestId);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
    const ok = (response as { Ok: Record<string, unknown> }).Ok;
    if (!ok || !("ScriptCreated" in ok)) {
      throw new CueError("UNEXPECTED_RESPONSE", "expected ScriptCreated response");
    }
    const created = (ok as { ScriptCreated: ScriptCreatedPayload }).ScriptCreated;

    if (created.submit_error) {
      const err = created.submit_error;
      throw new CueError(
        err.code,
        `script ${created.script_id} submission failed at item ${err.index}: ${err.message}`,
      );
    }

    if (signal?.aborted) {
      await this.cancelExecution(created.script_id, cueOperationStep(opts.operation, "cancel"));
      throw abortError(signal);
    }

    const scriptItems = new Map<number, ScriptItemInfo>(
      created.items.map((item) => [item.index, item]),
    );
    const itemJobIds = new Map<number, string[]>();
    const allKnownJobIds = new Set<string>();
    const stdoutByJob = new Map<string, string[]>();
    const stderrByJob = new Map<string, string[]>();
    const stdoutLenByJob = new Map<string, number>();
    const stderrLenByJob = new Map<string, number>();
    const binaryNoticeByJob = new Set<string>();
    const subscribedOutputChannels = new Set<string>();
    let acceptingOutputSubscriptions = true;

    const ensureJobBuffers = (jobId: string) => {
      if (!stdoutByJob.has(jobId)) {
        stdoutByJob.set(jobId, []);
        stdoutLenByJob.set(jobId, 0);
      }
      if (!stderrByJob.has(jobId)) {
        stderrByJob.set(jobId, []);
        stderrLenByJob.set(jobId, 0);
      }
    };

    const appendCappedOutput = (
      buffers: Map<string, string[]>,
      lengths: Map<string, number>,
      jobId: string,
      data: string,
    ) => {
      ensureJobBuffers(jobId);
      const list = buffers.get(jobId);
      if (!list) return;
      const current = lengths.get(jobId) ?? 0;
      if (current >= MAX_OUTPUT_BUFFER) return;
      const remaining = MAX_OUTPUT_BUFFER - current;
      const chunk = data.length > remaining ? data.slice(0, remaining) : data;
      if (!chunk) return;
      list.push(chunk);
      lengths.set(jobId, current + chunk.length);
    };

    const trackJob = async (itemIndex: number, jobId: string) => {
      const list = itemJobIds.get(itemIndex) ?? [];
      if (!list.includes(jobId)) list.push(jobId);
      itemJobIds.set(itemIndex, list);
      if (!allKnownJobIds.has(jobId)) {
        allKnownJobIds.add(jobId);
        ensureJobBuffers(jobId);
        const channel = `output:${jobId}`;
        if (!acceptingOutputSubscriptions) return;
        await this.subscribe([channel]);
        if (acceptingOutputSubscriptions) {
          subscribedOutputChannels.add(channel);
        } else {
          await this.unsubscribe([channel]).catch(() => {});
        }
      }
    };

    for (const item of scriptItems.values()) {
      if (item.result.kind === "job") {
        await trackJob(item.index, item.result.job_id);
      } else if (item.result.kind === "chain") {
        for (const jid of item.result.job_ids) {
          await trackJob(item.index, jid);
        }
      }
    }

    if (signal?.aborted) {
      await this.cancelExecution(created.script_id, cueOperationStep(opts.operation, "cancel"));
      await this.unsubscribe([...subscribedOutputChannels]).catch(() => {});
      throw abortError(signal);
    }

    return new Promise<ScriptResult>((resolve, reject) => {
      let finished: ScriptTerminalState | null = null;
      let resolved = false;
      let snapshotTerminalReconciled = false;
      let snapshotPoll: ReturnType<typeof setInterval> | undefined;
      let snapshotQueryInFlight = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timerArmed = false;
      const waitDeadline = Date.now() + timeoutMs;
      const unsubs: Array<() => void> = [];
      const pendingItemRegistrations = new Set<Promise<void>>();

      const cleanupListeners = () => {
        acceptingOutputSubscriptions = false;
        if (snapshotPoll) clearInterval(snapshotPoll);
        signal?.removeEventListener("abort", onAbort);
        for (const off of unsubs) off();
      };

      const releaseOutputChannels = async () => {
        await this.unsubscribe([...subscribedOutputChannels]).catch(() => {});
        subscribedOutputChannels.clear();
      };

      const failRecovery = async (error: unknown) => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        cleanupListeners();
        await releaseOutputChannels();
        reject(error);
      };

      const finalize = async () => {
        if (resolved) return;
        if (!finished || !snapshotTerminalReconciled) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        cleanupListeners();

        await new Promise((r) => setTimeout(r, 50));
        await Promise.all([...pendingItemRegistrations]);

        try {
          const itemResults: ScriptItemSummary[] = [];
          const authoritativeItems = [...scriptItems.values()].sort(
            (left, right) => left.index - right.index,
          );
          for (const item of authoritativeItems) {
            const summary = await this.#summarizeScriptItem(
              item,
              itemJobIds.get(item.index) ?? [],
              stdoutByJob,
              stderrByJob,
            );
            itemResults.push(summary);
          }

          await releaseOutputChannels();
          resolve({
            scriptId: created.script_id,
            source: created.source ?? { kind: "inline" },
            status: finished.status,
            exitCode: finished.exit_code,
            failedItemIndex: finished.failed_item_index ?? null,
            items: itemResults,
            timedOut: false,
          });
        } catch (error) {
          await releaseOutputChannels();
          reject(error);
        }
      };

      const stopForeground = async (kind: "abort" | "timeout") => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        cleanupListeners();
        try {
          await this.cancelExecution(created.script_id, cueOperationStep(opts.operation, "cancel"));
          await releaseOutputChannels();
          if (kind === "abort" && signal) {
            reject(abortError(signal));
            return;
          }
          resolve({
            scriptId: created.script_id,
            source: created.source ?? { kind: "inline" },
            status: "failed",
            exitCode: null,
            failedItemIndex: null,
            items: [],
            timedOut: true,
          });
        } catch (error) {
          await releaseOutputChannels();
          reject(error);
        }
      };

      const armTimeout = () => {
        if (resolved || timerArmed) return;
        timerArmed = true;
        timer = setTimeout(
          () => void stopForeground("timeout"),
          Math.max(0, waitDeadline - Date.now()),
        );
      };
      const onAbort = () => void stopForeground("abort");
      signal?.addEventListener("abort", onAbort, { once: true });

      const onOutput = (event: EventPayload) => {
        const chunk = outputChunkFromEvent(event);
        if (!chunk) return;
        if (!allKnownJobIds.has(chunk.id)) return;
        const text = chunk.bytes.toString("utf8");
        if (chunk.stream === "stdout") {
          appendCappedOutput(stdoutByJob, stdoutLenByJob, chunk.id, text);
        } else {
          appendCappedOutput(stderrByJob, stderrLenByJob, chunk.id, text);
        }
        if (chunk.encoding === "base64" && !binaryNoticeByJob.has(chunk.id)) {
          binaryNoticeByJob.add(chunk.id);
          appendCappedOutput(
            stderrByJob,
            stderrLenByJob,
            chunk.id,
            "[non-UTF-8 process output rendered as a lossy UTF-8 view; OutputChunkBinary.base64 preserves the exact bytes]\n",
          );
        }
      };

      const installedForwarders = new Set<string>();
      const ensureForwarder = (jobId: string) => {
        if (installedForwarders.has(jobId)) return;
        installedForwarders.add(jobId);
        unsubs.push(this.onEvent(`output:${jobId}`, onOutput));
      };
      for (const jid of allKnownJobIds) ensureForwarder(jid);

      const registerScriptItem = async (item: ScriptItemInfo, reconcileChain = false) => {
        const merged = mergeScriptItemInfo(scriptItems.get(item.index), item, reconcileChain);
        scriptItems.set(merged.index, merged);
        const jobIds =
          merged.result.kind === "job"
            ? [merged.result.job_id]
            : merged.result.kind === "chain"
              ? merged.result.job_ids
              : [];
        if (reconcileChain && merged.result.kind === "chain") {
          const chainId = merged.result.chain_id;
          const durableIds = (await this.listJobs())
            .filter((job) => job.chain_id != null && String(job.chain_id) === chainId)
            .map((job) => job.id);
          for (const jobId of durableIds) {
            if (!jobIds.includes(jobId)) jobIds.push(jobId);
          }
          merged.result.job_ids = jobIds;
        }
        for (const jobId of jobIds) {
          await trackJob(merged.index, jobId);
          ensureForwarder(jobId);
        }
      };

      const scheduleScriptItem = (item: ScriptItemInfo) => {
        const registration = registerScriptItem(item);
        pendingItemRegistrations.add(registration);
        void registration
          .catch((error) => failRecovery(error))
          .finally(() => pendingItemRegistrations.delete(registration));
      };
      let reconcileSnapshot!: () => Promise<void>;

      const onJobs = (event: EventPayload) => {
        if ("ScriptItemCreated" in event) {
          const createdItem = (event as { ScriptItemCreated: ScriptItemCreatedEvent })
            .ScriptItemCreated;
          if (createdItem.script_id === created.script_id) {
            scheduleScriptItem(createdItem.item);
          }
          return;
        }
        if ("ScriptFinished" in event) {
          const fin = (event as { ScriptFinished: ScriptFinishedEvent }).ScriptFinished;
          if (fin.script_id === created.script_id) {
            finished = {
              status: fin.status,
              exit_code: fin.exit_code,
              failed_item_index: fin.failed_item_index,
            };
            void reconcileSnapshot();
          }
          return;
        }
        if ("ChainProgress" in event) {
          const progress = (event as { ChainProgress: { chain: ChainInfo } }).ChainProgress;
          const item = [...scriptItems.values()].find(
            (it) => it.result.kind === "chain" && it.result.chain_id === progress.chain.id,
          );
          if (!item || item.result.kind !== "chain") return;
          const jobIds = progress.chain.jobs.flatMap((job) => (job.job_id ? [job.job_id] : []));
          item.result.chain = progress.chain;
          item.result.job_ids = [...new Set([...item.result.job_ids, ...jobIds])];
          for (const job of progress.chain.jobs) {
            const jid = job.job_id;
            if (!jid) continue;
            void trackJob(item.index, jid).then(() => ensureForwarder(jid));
          }
        }
      };
      unsubs.push(this.onEvent("jobs", onJobs));

      for (const cached of this.#recentScriptItems) {
        if (cached.script_id === created.script_id) scheduleScriptItem(cached.item);
      }
      const cachedFinished = this.#recentScriptFinished.find(
        (fin) => fin.script_id === created.script_id,
      );
      if (cachedFinished) {
        finished = {
          status: cachedFinished.status,
          exit_code: cachedFinished.exit_code,
          failed_item_index: cachedFinished.failed_item_index,
        };
      }

      reconcileSnapshot = async () => {
        if (resolved || snapshotQueryInFlight) return;
        snapshotQueryInFlight = true;
        try {
          const snapshot = await this.scriptInfo(created.script_id);
          if (resolved) return;
          for (const item of snapshot.items) await registerScriptItem(item, true);
          if (snapshot.submit_error) {
            const error = snapshot.submit_error;
            await failRecovery(
              new CueError(
                error.code,
                `script ${snapshot.script_id} submission failed at item ${error.index}: ${error.message}`,
              ),
            );
            return;
          }
          if (snapshot.status !== "running") {
            snapshotTerminalReconciled = true;
            finished = {
              status: snapshot.status,
              exit_code: snapshot.exit_code,
              failed_item_index: snapshot.failed_item_index,
            };
            await finalize();
          } else {
            armTimeout();
          }
        } catch (error) {
          await failRecovery(error);
        } finally {
          snapshotQueryInFlight = false;
        }
      };

      // Listener-first reconciliation closes all three races: terminal before
      // reconnect, middle items missed while disconnected, and a still-running
      // script that finishes after the new connection is established.
      if (!resolved) {
        snapshotPoll = setInterval(() => void reconcileSnapshot(), 100);
        snapshotPoll.unref?.();
        void reconcileSnapshot();
        void this.closed.then(() =>
          failRecovery(
            new CueTransportError(
              `connection closed while waiting for script ${created.script_id}`,
            ),
          ),
        );
      }
    });
  }

  async #summarizeScriptItem(
    item: ScriptItemInfo,
    jobIds: string[],
    stdoutByJob: Map<string, string[]>,
    stderrByJob: Map<string, string[]>,
  ): Promise<ScriptItemSummary> {
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    let status: JobStatus = "Done";
    let exitCode: number | null = null;
    const jobStatuses: JobInfo[] = [];

    for (const jobId of jobIds) {
      const info = await this.jobStatus(jobId);
      if (info) {
        jobStatuses.push(info);
        if (info.status !== "Done" && status === "Done") status = info.status;
        if (info.exit_code != null && (exitCode === null || info.exit_code !== 0)) {
          exitCode = info.exit_code;
        }
      }

      try {
        const output = await this.jobOutput(jobId);
        stdoutParts.push(output.stdout);
        stderrParts.push(output.stderr);
        if (output.stdoutEncoding === "base64" || output.stderrEncoding === "base64") {
          stderrParts.push(
            "[non-UTF-8 process output rendered as a lossy UTF-8 view; use typed jobOutput base64 fields for exact bytes]\n",
          );
        }
      } catch {
        stdoutParts.push((stdoutByJob.get(jobId) ?? []).join(""));
        stderrParts.push((stderrByJob.get(jobId) ?? []).join(""));
      }
    }

    const messageText = item.result.kind === "message" ? item.result.text : undefined;

    return {
      index: item.index,
      source: item.source,
      kind: item.result.kind,
      jobIds,
      chainId: item.result.kind === "chain" ? item.result.chain_id : null,
      cronId: item.result.kind === "cron" ? item.result.cron_id : null,
      message: messageText,
      stdout: stdoutParts.join(""),
      stderr: stderrParts.join(""),
      status,
      exitCode,
      jobs: jobStatuses,
    };
  }

  /** Query the daemon-lifetime authoritative snapshot for a script run. */
  async scriptInfo(scriptId: string): Promise<ScriptInfoPayload> {
    const requestId = await this.#send({ ScriptInfo: { id: scriptId } });
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("ScriptInfo" in ok) {
      return (ok as { ScriptInfo: ScriptInfoPayload }).ScriptInfo;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected ScriptInfo response");
  }

  /** Stop (kill) a running job or remove a cron. */
  async stopJob(targetId: string, operation?: CueOperationKey): Promise<void> {
    const payload: RequestPayload = /^C\d+$/u.test(targetId)
      ? { RemoveCron: { id: targetId } }
      : /^CH\d+$/u.test(targetId)
        ? { CancelExecution: { id: targetId } }
        : { KillJob: { id: targetId } };
    const requestId = await this.#send(payload, operation);
    okRecord(await this.#waitForResponse(requestId));
  }

  /** Idempotently cancel a job, chain, or script and wait for it to stop. */
  async cancelExecution(targetId: string, operation?: CueOperationKey): Promise<void> {
    const requestId = await this.#send({ CancelExecution: { id: targetId } }, operation);
    okRecord(await this.#waitForResponse(requestId));
  }

  /** List all jobs through the typed IPC query. */
  async listJobs(limit?: number): Promise<JobInfo[]> {
    const requestId = await this.#send({ ListJobs: { limit: limit ?? null } });
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("JobListPage" in ok) {
      return (ok as { JobListPage: { jobs: JobInfo[]; page: PageInfo } }).JobListPage.jobs.map(
        normalizeJob,
      );
    }
    if ("JobList" in ok) {
      return (ok as { JobList: JobInfo[] }).JobList.map(normalizeJob);
    }
    if ("JobInfo" in ok) {
      const job = (ok as { JobInfo: JobInfo }).JobInfo;
      return [normalizeJob(job)];
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected JobListPage, JobList, or JobInfo response");
  }

  /** Get job status via `:jobs`. */
  async jobStatus(jobId: string): Promise<JobInfo | null> {
    const list = await this.listJobs();
    return list.find((j) => j.id === jobId) ?? null;
  }

  async #chainJobsForCreatedJob(payload: JobCreatedPayload): Promise<JobInfo[] | null> {
    let chainId = payload.chain_id;
    let chainTotal = payload.chain_total;

    if (!chainId || !chainTotal || chainTotal <= 1) {
      const job = await this.jobStatus(payload.job_id);
      if (job?.chain_id != null && job.chain_total && job.chain_total > 1) {
        chainId = String(job.chain_id);
        chainTotal = job.chain_total;
      }
    }

    if (!chainId || !chainTotal || chainTotal <= 1) return null;
    return this.#waitForChainJobs(chainId, chainTotal);
  }

  #chainInfoFromJobs(
    chainId: string,
    pipeline: string,
    totalJobs: number,
    jobs: JobInfo[],
  ): ChainInfo {
    return {
      id: chainId,
      pipeline,
      total_jobs: totalJobs,
      jobs: jobs.map((job, index) => ({
        index: job.chain_index ?? index,
        pipeline: job.pipeline,
        status: job.status,
        job_id: job.id,
        start_scope: job.start_scope,
        end_scope: job.end_scope,
        open_hint: job.open_hint,
        ...(job.cancelReason ? { cancelReason: job.cancelReason } : {}),
      })),
    };
  }

  async #waitForChainJobs(chainId: string, totalJobs: number): Promise<JobInfo[]> {
    const deadline = Date.now() + 1_000;
    while (true) {
      const jobs = (await this.listJobs())
        .filter((job) => job.chain_id != null && String(job.chain_id) === chainId)
        .sort((a, b) => (a.chain_index ?? 0) - (b.chain_index ?? 0));
      if (jobs.length >= totalJobs) return jobs.slice(0, totalJobs);
      if (Date.now() >= deadline) {
        throw new CueError(
          "UNEXPECTED_RESPONSE",
          `chain ${chainId} reported ${totalJobs} jobs but only ${jobs.length} were visible`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Get cron status via `:crons`. */
  async cronStatus(cronId: string): Promise<CronInfo | null> {
    const list = await this.listCrons();
    return list.find((c) => c.id === cronId) ?? null;
  }

  /** Get buffered stdout from the daemon. */
  async jobOutput(jobId: string, tailBytes?: number): Promise<JobOutputResult> {
    const output = await this.#queryJobOutput(jobId, tailBytes ?? null, tailBytes ?? null);
    if (!output) {
      return {
        stdout: "",
        stderr: "",
        stdoutEncoding: "utf8",
        stderrEncoding: "utf8",
        truncated: false,
        stderrTruncated: false,
      };
    }
    const stdout = outputView(bytesFromStreamText(output.stdout));
    const stderr = outputView(bytesFromStreamText(output.stderr));
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutEncoding: stdout.encoding,
      stderrEncoding: stderr.encoding,
      ...(stdout.base64 ? { stdoutBase64: stdout.base64 } : {}),
      ...(stderr.base64 ? { stderrBase64: stderr.base64 } : {}),
      truncated: output.stdout.truncated,
      stderrTruncated: output.stderr.truncated,
    };
  }

  /** Get buffered stderr from the daemon. */
  async jobError(
    jobId: string,
    tailBytes?: number,
  ): Promise<{
    stderr: string;
    encoding: OutputEncoding;
    base64?: string;
    truncated?: boolean;
  }> {
    const output = await this.#queryJobOutput(jobId, null, tailBytes ?? null);
    if (!output) return { stderr: "", encoding: "utf8", truncated: false };
    const stderr = outputView(bytesFromStreamText(output.stderr));
    return {
      stderr: stderr.text,
      encoding: stderr.encoding,
      ...(stderr.base64 ? { base64: stderr.base64 } : {}),
      truncated: output.stderr.truncated,
    };
  }

  async #queryJobOutput(
    jobId: string,
    stdoutBytes: number | null,
    stderrBytes: number | null,
  ): Promise<JobOutputPayload | null> {
    try {
      const requestId = await this.#send({
        JobOutput: { id: jobId, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes },
      });
      const ok = okRecord(await this.#waitForResponse(requestId));
      if ("JobOutput" in ok) return (ok as { JobOutput: JobOutputPayload }).JobOutput;
      throw new CueError("UNEXPECTED_RESPONSE", "expected JobOutput response");
    } catch (error) {
      if (error instanceof CueError && isNoBufferedOutputError(error)) return null;
      throw error;
    }
  }

  /** Send stdin to a running job. */
  async sendInput(id: string, data: string, operation?: CueOperationKey): Promise<void> {
    const response = await this.#rawEvalAndWait(`:send ${id} ${data}`, "Job", operation);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
  }

  /** Cancel a pending/running job. */
  async cancelJob(id: string, operation?: CueOperationKey): Promise<void> {
    const response = await this.#rawEvalAndWait(`:cancel ${id}`, "Job", operation);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
  }

  /** Pause a cron. */
  async pauseCron(id: string, operation?: CueOperationKey): Promise<void> {
    const response = await this.#rawEvalAndWait(`:pause ${id}`, "Job", operation);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
  }

  /** Resume a cron. */
  async resumeCron(id: string, operation?: CueOperationKey): Promise<void> {
    const response = await this.#rawEvalAndWait(`:resume ${id}`, "Job", operation);
    if ("Err" in response) {
      throw new CueError(response.Err.code, response.Err.message);
    }
  }

  /** Retry a terminal job. */
  async retryJob(id: string, operation?: CueOperationKey): Promise<StartJobResult> {
    const response = await this.#rawEvalAndWait(`:retry ${id}`, "Job", operation);
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
        warnings: payload.warnings,
      };
    }
    if (ok && "JobCreated" in ok) {
      const payload = (ok as { JobCreated: JobCreatedPayload }).JobCreated;
      const jobs = await this.#chainJobsForCreatedJob(payload);
      if (jobs) {
        const chainId = String(jobs[0]?.chain_id ?? payload.chain_id);
        return {
          jobId: jobs[0]?.id ?? payload.job_id,
          kind: "chain",
          chain: this.#chainInfoFromJobs(chainId, `:retry ${id}`, jobs.length, jobs),
          warnings: payload.warnings,
        };
      }
      return {
        jobId: payload.job_id,
        kind: "job",
        warnings: payload.warnings,
      };
    }

    throw new CueError("UNEXPECTED_RESPONSE", "expected JobCreated or ChainCreated response");
  }

  /** Evaluate a raw daemon command that returns plain text. */
  async evalText(input: string, mode: Mode = "Job"): Promise<string> {
    const response = await this.#rawEvalAndWait(input, mode);
    const ok = okRecord(response);
    const text = textOutputFromOk(ok);
    if (text !== null) return text;
    throw new CueError("UNEXPECTED_RESPONSE", "expected EvalText response");
  }

  /** Mutate the current session environment with `:env set KEY=VALUE ...`. */
  async setEnv(
    assignments: Record<string, string>,
    operation?: CueOperationKey,
  ): Promise<ScopeCreatedPayload> {
    const parts = Object.entries(assignments).map(([key, value]) => `${key}=${value}`);
    const response = await this.#rawEvalAndWait(`:env set ${parts.join(" ")}`, "Job", operation);
    const ok = okRecord(response);
    const scope = scopeCreatedFromOk(ok);
    if (scope) return scope;
    throw new CueError("UNEXPECTED_RESPONSE", "expected ScopeCreated response");
  }

  /** Remove keys from the current session environment with `:env unset KEY ...`. */
  async unsetEnv(keys: string[], operation?: CueOperationKey): Promise<ScopeCreatedPayload> {
    const response = await this.#rawEvalAndWait(`:env unset ${keys.join(" ")}`, "Job", operation);
    const ok = okRecord(response);
    const scope = scopeCreatedFromOk(ok);
    if (scope) return scope;
    throw new CueError("UNEXPECTED_RESPONSE", "expected ScopeCreated response");
  }

  /** Change the current cue session directory. */
  async changeDirectory(path: string, operation?: CueOperationKey): Promise<ScopeCreatedPayload> {
    const response = await this.#rawEvalAndWait(`:cd ${path}`, "Job", operation);
    const ok = okRecord(response);
    const scope = scopeCreatedFromOk(ok);
    if (scope) return scope;
    throw new CueError("UNEXPECTED_RESPONSE", "expected ScopeCreated response");
  }

  /** List all scopes through the typed IPC query. */
  async listScopes(limit?: number): Promise<ScopeInfo[]> {
    const requestId = await this.#send({ ListScopes: { limit: limit ?? null } });
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("ScopeListPage" in ok) {
      return (ok as { ScopeListPage: { scopes: ScopeInfo[]; page: PageInfo } }).ScopeListPage
        .scopes;
    }
    if ("ScopeList" in ok) {
      return (ok as { ScopeList: ScopeInfo[] }).ScopeList;
    }
    if ("ScopeInfo" in ok) {
      return [(ok as { ScopeInfo: ScopeInfo }).ScopeInfo];
    }
    throw new CueError(
      "UNEXPECTED_RESPONSE",
      "expected ScopeListPage, ScopeList, or ScopeInfo response",
    );
  }

  /** Show the current env snapshot through the typed IPC query. */
  async showEnv(): Promise<string> {
    const requestId = await this.#send({ ShowEnv: { tail_bytes: null } });
    const text = textOutputFromOk(okRecord(await this.#waitForResponse(requestId)));
    if (text !== null) return text;
    throw new CueError("UNEXPECTED_RESPONSE", "expected TextOutput or EvalText response");
  }

  /** Show the current config through the typed IPC query. */
  async showConfig(): Promise<string> {
    const requestId = await this.#send({ ShowConfig: { tail_bytes: null } });
    const text = textOutputFromOk(okRecord(await this.#waitForResponse(requestId)));
    if (text !== null) return text;
    throw new CueError("UNEXPECTED_RESPONSE", "expected TextOutput or EvalText response");
  }

  /** Show log output. */
  async showLog(id?: string, limit?: number, tailBytes?: number): Promise<string> {
    const requestId = await this.#send({
      ShowLog: { id: id ?? null, limit: limit ?? null, tail_bytes: tailBytes ?? null },
    });
    const text = textOutputFromOk(okRecord(await this.#waitForResponse(requestId)));
    if (text !== null) return text;
    throw new CueError("UNEXPECTED_RESPONSE", "expected TextOutput or EvalText response");
  }

  /** Schedule a recurring or one-shot cron job.  Returns the cron id. */
  async addCron(schedule: string, command: string, operation?: CueOperationKey): Promise<string> {
    const input = `:cron ${schedule} ${command}`;
    const requestId = await this.#rawEval(input, "Job", operation);
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

  /** List all cron jobs through the typed IPC query. */
  async listCrons(limit?: number): Promise<CronInfo[]> {
    const requestId = await this.#send({ ListCrons: { limit: limit ?? null } });
    const ok = okRecord(await this.#waitForResponse(requestId));
    if ("CronListPage" in ok) {
      return (ok as { CronListPage: { crons: CronInfo[]; page: PageInfo } }).CronListPage.crons;
    }
    if ("CronList" in ok) {
      return (ok as { CronList: CronInfo[] }).CronList;
    }
    throw new CueError("UNEXPECTED_RESPONSE", "expected CronListPage or CronList response");
  }

  /** Remove a cron job. */
  async removeCron(cronId: string, operation?: CueOperationKey): Promise<void> {
    const requestId = await this.#send({ RemoveCron: { id: cronId } }, operation);
    okRecord(await this.#waitForResponse(requestId));
  }

  /** Ask the daemon to shut down. */
  async shutdown(operation?: CueOperationKey): Promise<void> {
    const requestId = await this.#send({ Shutdown: {} }, operation);
    okRecord(await this.#waitForResponse(requestId));
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

  #send(payload: RequestPayload, operation?: CueOperationKey): Promise<number> {
    if (this.#closed) throw new CueTransportError("connection closed");
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      throw new CueError(
        "CLIENT_REQUEST_LIMIT",
        `refusing to exceed ${MAX_PENDING_REQUESTS} pending cue-shell requests`,
      );
    }

    const id = this.#allocateRequestId();
    let resolveResponse!: (value: ResponsePayload) => void;
    let rejectResponse!: (error: Error) => void;
    const promise = new Promise<ResponsePayload>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    // A caller may intentionally use eval() as fire-and-forget. Keep that from
    // becoming an unhandled rejection while preserving the original promise
    // for callers that do claim the response.
    void promise.catch(() => {});
    const pending: PendingRequest = {
      promise,
      resolve: resolveResponse,
      reject: rejectResponse,
      claimed: false,
      settled: false,
      timer: setTimeout(() => {
        if (this.#pending.get(id) !== pending) return;
        if (!pending.settled) {
          pending.settled = true;
          pending.reject(
            new CueTransportError(`request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`),
          );
        }
        this.#retainUnclaimedResponse(id, pending);
      }, REQUEST_TIMEOUT_MS),
    };
    // Register before write(): a test stream, local transport, or very fast
    // daemon is allowed to deliver the response synchronously from write().
    this.#pending.set(id, pending);
    const request: RequestEnvelope = {
      type: "request",
      id,
      ...(operation ? { operation_id: cueOperationId(operation) } : {}),
      payload,
    };
    const frame = this.#encodeFrame(request);
    try {
      this.#socket.write(frame);
    } catch (error) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.settled = true;
      const writeError = asCueTransportError(error, "request write failed");
      pending.reject(writeError);
      throw writeError;
    }

    return Promise.resolve(id);
  }

  #allocateRequestId(): number {
    // At most pending.size occupied ids can be encountered before a free slot,
    // and the pending cap keeps this scan bounded independently of u32 wrap.
    for (let attempts = 0; attempts <= this.#pending.size; attempts += 1) {
      const id = this.#nextId;
      this.#nextId = nextRequestId(id);
      if (!this.#pending.has(id)) return id;
    }
    throw new CueError("CLIENT_REQUEST_LIMIT", "no free cue-shell request id is available");
  }

  #retainUnclaimedResponse(id: number, pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.claimed) {
      this.#pending.delete(id);
      return;
    }
    pending.timer = setTimeout(() => {
      if (this.#pending.get(id) === pending && !pending.claimed) this.#pending.delete(id);
    }, SETTLED_RESPONSE_RETENTION_MS);
    pending.timer.unref?.();
  }

  #waitForResponse(id: number): Promise<ResponsePayload> {
    const pending = this.#pending.get(id);
    if (!pending) return Promise.reject(new Error(`unknown or expired request ${id}`));
    pending.claimed = true;
    return pending.promise.finally(() => {
      if (this.#pending.get(id) === pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
      }
    });
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    while (this.#buffer.length >= 4) {
      const len = this.#buffer.readUInt32BE(0);
      if (len > MAX_MESSAGE_SIZE) {
        this.#onProtocolError(new Error(`message too large: ${len} bytes`));
        return;
      }
      if (this.#buffer.length < 4 + len) break; // need more data

      const body = this.#buffer.subarray(4, 4 + len);
      this.#buffer = this.#buffer.subarray(4 + len);

      try {
        const msg = decodeInboundCueMessage(JSON.parse(body.toString("utf-8")));
        this.#dispatch(msg);
      } catch (err) {
        this.#onProtocolError(new Error(`failed to parse message: ${(err as Error).message}`));
        return;
      }
    }
  }

  #dispatch(msg: InboundCueMessage): void {
    if (msg.type === "response") {
      const pending = this.#pending.get(msg.id);
      if (!pending) {
        this.#onProtocolError(new Error(`response for unknown or expired request ${msg.id}`));
        return;
      }
      if (pending.settled) return;
      pending.settled = true;
      pending.resolve(msg.payload);
      this.#retainUnclaimedResponse(msg.id, pending);
    } else {
      this.#dispatchEvent(msg.payload);
    }
  }

  #dispatchEvent(payload: EventPayload): void {
    // Route to channel-specific listeners
    let channel: string | null = null;

    if ("JobStateChanged" in payload) {
      channel = `jobs`;
    } else if ("JobCreated" in payload) {
      channel = `jobs`;
    } else if ("ChainProgress" in payload) {
      channel = `jobs`;
    } else if ("ScriptItemCreated" in payload) {
      const created = (payload as { ScriptItemCreated: ScriptItemCreatedEvent }).ScriptItemCreated;
      this.#recentScriptItems.push(created);
      if (this.#recentScriptItems.length > 128) this.#recentScriptItems.shift();
      channel = `jobs`;
    } else if ("ScriptFinished" in payload) {
      const fin = (payload as { ScriptFinished: ScriptFinishedEvent }).ScriptFinished;
      this.#recentScriptFinished.push(fin);
      if (this.#recentScriptFinished.length > 32) this.#recentScriptFinished.shift();
      channel = `jobs`;
    } else if ("JobRemoved" in payload) {
      channel = `jobs`;
    } else if ("CronTriggered" in payload || "CronRemoved" in payload) {
      channel = `crons`;
    } else if ("FgOutput" in payload || "FgExited" in payload) {
      channel = `fg`;
    } else if ("ShuttingDown" in payload) {
      channel = `system`;
    } else {
      const chunk = outputChunkFromEvent(payload);
      if (!chunk) {
        if ("OutputEof" in payload) {
          const jobId = (payload as { OutputEof: { id: string } }).OutputEof.id;
          channel = `output:${jobId}`;
        }
      } else {
        channel = `output:${chunk.id}`;
      }
    }

    if (channel) {
      const notify = (listeners: Set<(event: EventPayload) => void> | undefined) => {
        if (!listeners) return;
        for (const handler of listeners) {
          try {
            handler(payload);
          } catch {
            // swallow listener errors
          }
        }
      };
      notify(this.#listeners.get(channel));
      if (channel.startsWith("output:")) notify(this.#listeners.get("output:"));
    }
  }

  #onTransportError(err: Error): void {
    if (!this.#closed) {
      this.#rejectAll(asCueTransportError(err));
      this.#socket.destroy();
    }
  }

  #onProtocolError(err: Error): void {
    if (!this.#closed) {
      // The daemon may already have committed a side effect before a malformed
      // or uncorrelatable response makes its result unknowable. Treat this as
      // transport ambiguity so Pi can replay only with the exact same key.
      this.#rejectAll(new CueTransportError(`protocol failure: ${err.message}`));
      this.#socket.destroy();
    }
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (!pending.settled) {
        pending.settled = true;
        pending.reject(error);
      }
      // Keep an unclaimed promise long enough for the send() caller to enter
      // waitForResponse() after a synchronous response/error/close cycle.
      this.#retainUnclaimedResponse(id, pending);
    }
  }

  #encodeFrame(msg: CueMessage): Buffer {
    const json = Buffer.from(JSON.stringify(msg), "utf-8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length, 0);
    return Buffer.concat([len, json]);
  }

  async #readBufferedJobResult(
    firstJobId: string,
    chainJobIds: string[],
    warnings: string[] = [],
  ): Promise<JobResult> {
    const stdoutParts: Buffer[] = [];
    const stderrParts: Buffer[] = [];
    let finalStatus: JobStatus = "Done";
    let cancelReason: CancelReason | undefined;
    let finalExit: number | null = null;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutTotal = 0;
    let stderrTotal = 0;

    for (const jobId of chainJobIds) {
      const info = await this.jobStatus(jobId);
      if (info) {
        if (info.status !== "Done") finalStatus = info.status;
        if (info.cancelReason) cancelReason = info.cancelReason;
        if (info.exit_code != null && (finalExit === null || info.exit_code !== 0)) {
          finalExit = info.exit_code;
        }
      }

      const output = await this.jobOutput(jobId, MAX_OUTPUT_BUFFER);
      const stdout =
        chainJobIds.length > 1 && output.stdoutEncoding === "utf8"
          ? Buffer.from(output.stdout.trimEnd())
          : bytesFromJobOutput(output, "stdout");
      const stderr =
        chainJobIds.length > 1 && output.stderrEncoding === "utf8"
          ? Buffer.from(output.stderr.trimEnd())
          : bytesFromJobOutput(output, "stderr");
      const stdoutRemaining = MAX_OUTPUT_BUFFER - stdoutTotal;
      const stderrRemaining = MAX_OUTPUT_BUFFER - stderrTotal;
      if (stdout.length > 0 && stdoutRemaining > 0) {
        const kept = stdout.subarray(0, stdoutRemaining);
        stdoutParts.push(kept);
        stdoutTotal += kept.length;
      }
      if (stderr.length > 0 && stderrRemaining > 0) {
        const kept = stderr.subarray(0, stderrRemaining);
        stderrParts.push(kept);
        stderrTotal += kept.length;
      }
      stdoutTruncated ||= output.truncated || stdout.length > stdoutRemaining;
      stderrTruncated ||= output.stderrTruncated || stderr.length > stderrRemaining;
    }

    return buildJobResult({
      jobId: firstJobId,
      status: finalStatus,
      ...(cancelReason ? { cancelReason } : {}),
      stdout: joinOutputParts(stdoutParts, chainJobIds.length === 1 ? "" : "\n"),
      stderr: joinOutputParts(stderrParts, chainJobIds.length === 1 ? "" : "\n"),
      stdoutTruncated,
      stderrTruncated,
      exitCode: finalExit,
      timedOut: false,
      warnings,
    });
  }

  async #collectJobOutput(
    firstJobId: string,
    chainJobIds: string[],
    timeoutMs: number,
    warnings: string[] = [],
    chainId?: string,
    expectedJobCount = chainJobIds.length,
    signal?: AbortSignal,
    operation?: CueOperationKey,
  ): Promise<JobResult> {
    let expectedJobs = expectedJobCount;
    const dynamicChain = expectedJobs > chainJobIds.length;

    // For single-job commands, check if already done (fast-command race).
    if (!dynamicChain && chainJobIds.length === 1) {
      const jobId = chainJobIds[0];
      const initial = await this.jobStatus(jobId);
      if (initial) {
        if (["Done", "Failed", "Killed", "Cancelled"].includes(initial.status)) {
          return this.#readBufferedJobResult(jobId, [jobId], warnings);
        }
      }
    } else if (!dynamicChain) {
      // For chains, check if ALL leaves are already done (very fast chains).
      let allDone = true;
      for (const jid of chainJobIds) {
        const info = await this.jobStatus(jid);
        if (!info || !["Done", "Failed", "Killed", "Cancelled"].includes(info.status)) {
          allDone = false;
          break;
        }
      }
      if (allDone) {
        return this.#readBufferedJobResult(firstJobId, chainJobIds, warnings);
      }
    }

    const isChain = expectedJobs > 1;
    const cancelTarget = chainId ?? firstJobId;

    if (signal?.aborted) {
      await this.cancelExecution(cancelTarget, cueOperationStep(operation, "cancel"));
      throw abortError(signal);
    }

    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let stdoutOverflowed = false;
      let stderrOverflowed = false;
      let resolved = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      const terminal: JobStatus[] = ["Done", "Failed", "Killed", "Cancelled"];

      const stopForeground = async (kind: "abort" | "timeout") => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        cleanup();
        try {
          await this.cancelExecution(cancelTarget, cueOperationStep(operation, "cancel"));
          if (kind === "abort" && signal) {
            reject(abortError(signal));
            return;
          }
          const result = await this.#readBufferedJobResult(firstJobId, chainJobIds, warnings);
          resolve({ ...result, timedOut: true });
        } catch (error) {
          reject(error);
        }
      };

      const timer = setTimeout(() => void stopForeground("timeout"), timeoutMs);
      const onAbort = () => void stopForeground("abort");
      signal?.addEventListener("abort", onAbort, { once: true });

      const unsubs: Array<() => void> = [];
      const onOutput = (event: EventPayload) => {
        if ("OutputEof" in event) {
          const eof = (event as { OutputEof: { id: string } }).OutputEof;
          if (chainJobIds.includes(eof.id)) outputEof.add(eof.id);
          return;
        }
        const chunk = outputChunkFromEvent(event);
        if (!chunk) return;
        if (chunk.stream === "stdout") {
          const remaining = MAX_OUTPUT_BUFFER - stdoutLen;
          if (remaining <= 0) {
            stdoutOverflowed = true;
            return;
          }
          const kept = chunk.bytes.subarray(0, remaining);
          stdoutChunks.push(kept);
          stdoutLen += kept.length;
          stdoutOverflowed ||= kept.length < chunk.bytes.length;
        } else {
          const remaining = MAX_OUTPUT_BUFFER - stderrLen;
          if (remaining <= 0) {
            stderrOverflowed = true;
            return;
          }
          const kept = chunk.bytes.subarray(0, remaining);
          stderrChunks.push(kept);
          stderrLen += kept.length;
          stderrOverflowed ||= kept.length < chunk.bytes.length;
        }
      };
      for (const jid of chainJobIds) unsubs.push(this.onEvent(`output:${jid}`, onOutput));

      const addChainJob = (jobId: string) => {
        if (chainJobIds.includes(jobId)) return;
        chainJobIds.push(jobId);
        unsubs.push(this.onEvent(`output:${jobId}`, onOutput));
      };

      // Track terminal state per job. Polling covers the race where the terminal
      // event arrives before this collector has installed its listener.
      const terminalSet = new Set<string>();
      const outputEof = new Set<string>();

      const maybeResolve = async () => {
        if (resolved) return;
        const trackedJobIds = chainJobIds.slice(0, expectedJobs);
        if (trackedJobIds.length < expectedJobs) return;
        for (const jid of trackedJobIds) {
          if (!terminalSet.has(jid)) return;
        }
        chainJobIds.splice(0, chainJobIds.length, ...trackedJobIds);
        resolved = true;
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        await new Promise((r) => setTimeout(r, 50));
        cleanup();
        try {
          const buffered = await this.#readBufferedJobResult(firstJobId, chainJobIds, warnings);
          const stdout = reconcileCollectedStream({
            live: Buffer.concat(stdoutChunks),
            liveOverflowed: stdoutOverflowed,
            sawEofForEveryJob: trackedJobIds.every((id) => outputEof.has(id)),
            buffered: bytesFromJobOutput(
              {
                stdout: buffered.stdout,
                stderr: buffered.stderr,
                stdoutEncoding: buffered.stdoutEncoding,
                stderrEncoding: buffered.stderrEncoding,
                ...(buffered.stdoutBase64 ? { stdoutBase64: buffered.stdoutBase64 } : {}),
                ...(buffered.stderrBase64 ? { stderrBase64: buffered.stderrBase64 } : {}),
                truncated: buffered.stdoutTruncated,
                stderrTruncated: buffered.stderrTruncated,
              },
              "stdout",
            ),
            bufferedTruncated: buffered.stdoutTruncated,
          });
          const stderr = reconcileCollectedStream({
            live: Buffer.concat(stderrChunks),
            liveOverflowed: stderrOverflowed,
            sawEofForEveryJob: trackedJobIds.every((id) => outputEof.has(id)),
            buffered: bytesFromJobOutput(
              {
                stdout: buffered.stdout,
                stderr: buffered.stderr,
                stdoutEncoding: buffered.stdoutEncoding,
                stderrEncoding: buffered.stderrEncoding,
                ...(buffered.stdoutBase64 ? { stdoutBase64: buffered.stdoutBase64 } : {}),
                ...(buffered.stderrBase64 ? { stderrBase64: buffered.stderrBase64 } : {}),
                truncated: buffered.stdoutTruncated,
                stderrTruncated: buffered.stderrTruncated,
              },
              "stderr",
            ),
            bufferedTruncated: buffered.stderrTruncated,
          });
          resolve(
            buildJobResult({
              jobId: buffered.jobId,
              status: buffered.status,
              ...(buffered.cancelReason ? { cancelReason: buffered.cancelReason } : {}),
              stdout: stdout.bytes,
              stderr: stderr.bytes,
              stdoutTruncated: stdout.truncated,
              stderrTruncated: stderr.truncated,
              exitCode: buffered.exitCode,
              timedOut: false,
              warnings: buffered.warnings,
            }),
          );
        } catch (error) {
          reject(error);
        }
      };

      const unsubJob = this.onEvent(`jobs`, (event) => {
        if ("JobCreated" in event && chainId) {
          const created = (event as { JobCreated: JobCreatedEvent }).JobCreated;
          if (created.chain_id === chainId) addChainJob(created.job_id);
        }
        if ("ChainProgress" in event && chainId) {
          const progress = (event as { ChainProgress: { chain: ChainInfo } }).ChainProgress;
          if (progress.chain.id === chainId) {
            for (const job of progress.chain.jobs) {
              if (job.job_id) addChainJob(job.job_id);
            }
            const terminalJobs = progress.chain.jobs.filter((job) =>
              terminal.includes(normalizeJobStatus(job.status)),
            );
            if (terminalJobs.some((job) => normalizeJobStatus(job.status) !== "Done")) {
              expectedJobs = terminalJobs.filter((job) => job.job_id).length;
              void maybeResolve();
            } else if (terminalJobs.length === progress.chain.jobs.length) {
              expectedJobs = progress.chain.jobs.filter((job) => job.job_id).length;
              void maybeResolve();
            }
          }
        }
        if ("JobStateChanged" in event) {
          const change = (event as { JobStateChanged: JobStateChangedEvent }).JobStateChanged;

          // For single jobs, only care about our job.
          // For chains, track state changes for any known leaf, or any leaf with our chain id.
          if (!isChain && change.job_id !== firstJobId) return;
          if (isChain && change.chain_id !== chainId && !chainJobIds.includes(change.job_id)) {
            return;
          }
          if (isChain && change.chain_id === chainId) addChainJob(change.job_id);

          const newState = normalizeJobStatus((change as { new_state: unknown }).new_state);
          if (terminal.includes(newState)) {
            terminalSet.add(change.job_id);
            void maybeResolve();
          }
        }
      });

      poll = setInterval(() => {
        if (resolved) return;
        void (async () => {
          try {
            const observedJobs = isChain && chainId ? await this.listJobs() : [];
            if (isChain && chainId) {
              for (const job of observedJobs) {
                if (job.chain_id != null && String(job.chain_id) === chainId) addChainJob(job.id);
              }
            }
            for (const jid of chainJobIds) {
              const info =
                observedJobs.find((job) => job.id === jid) ?? (await this.jobStatus(jid));
              if (info && terminal.includes(info.status)) {
                terminalSet.add(jid);
                if (isChain && info.status !== "Done") {
                  const index = typeof info.chain_index === "number" ? info.chain_index : undefined;
                  expectedJobs = Math.min(
                    expectedJobs,
                    index === undefined ? chainJobIds.indexOf(jid) + 1 : index + 1,
                  );
                }
              }
            }
            await maybeResolve();
          } catch (error) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            if (poll) clearInterval(poll);
            cleanup();
            reject(error);
          }
        })();
      }, 100);

      function cleanup() {
        signal?.removeEventListener("abort", onAbort);
        unsubJob();
        for (const u of unsubs) u();
      }
    });
  }
}

// ── Public types ───────────────────────────────────────────────────────────

export type ResourceNeeds = Record<string, string | number>;

export interface RunEvalOptions {
  /** Working directory override. */
  cwd?: string;
  /** Whether to allocate a PTY. Defaults to false for API/tool runs. */
  pty?: boolean;
  /** Resource quantities to reserve before spawning, encoded as `need.<key>=<quantity>`. */
  needs?: ResourceNeeds;
  /** Stable logical key for the daemon-global side effect. */
  operation?: CueOperationKey;
}

export interface RunJobOptions extends RunEvalOptions {
  /** Timeout in seconds (default: 300 = 5 min). */
  timeout?: number;
  /** Cancels the daemon-side foreground execution and waits for it to stop. */
  signal?: AbortSignal;
}

export interface StartJobOptions extends RunEvalOptions {}

export interface RunScriptOptions {
  /** Source path to associate with the script (display label only when input is inline). */
  path: string;
  /** Raw `.cue` script body to execute. */
  input: string;
  /** Foreground wait budget in seconds. Defaults to 300. */
  timeout?: number;
  /** Cancels the daemon-side script and waits for its active item to stop. */
  signal?: AbortSignal;
  /** Stable logical key; submit and cancel use distinct derived child steps. */
  operation?: CueOperationKey;
}

export interface ScriptItemSummary {
  index: number;
  source: string;
  kind: ScriptItemResult["kind"];
  jobIds: string[];
  chainId: string | null;
  cronId: string | null;
  message?: string;
  stdout: string;
  stderr: string;
  status: JobStatus;
  exitCode: number | null;
  jobs: JobInfo[];
}

export interface ScriptResult {
  scriptId: string;
  source: ScriptSource;
  status: ScriptRunStatus;
  /** Aggregated exit code reported by ScriptFinished. */
  exitCode: number | null;
  failedItemIndex: number | null;
  items: ScriptItemSummary[];
  timedOut: boolean;
}

export interface JobOutputResult {
  /** Backward-compatible UTF-8 view. Lossy when the corresponding encoding is base64. */
  stdout: string;
  stderr: string;
  stdoutEncoding: OutputEncoding;
  stderrEncoding: OutputEncoding;
  stdoutBase64?: string;
  stderrBase64?: string;
  truncated: boolean;
  stderrTruncated: boolean;
}

export interface JobResult {
  jobId: string;
  status: JobStatus;
  cancelReason?: CancelReason;
  stdout: string;
  stderr: string;
  stdoutEncoding: OutputEncoding;
  stderrEncoding: OutputEncoding;
  stdoutBase64?: string;
  stderrBase64?: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
  warnings: string[];
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
  warnings: string[];
}

export class CueError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`cue-shell error [${code}]: ${message}`);
    this.name = "CueError";
    this.code = code;
  }
}

/** A transport-ambiguous failure that may be retried only with the same operation id. */
export class CueTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CueTransportError";
  }
}

export function isRetryableCueTransportError(error: unknown): error is CueTransportError {
  return error instanceof CueTransportError;
}

function asCueTransportError(error: unknown, prefix?: string): CueTransportError {
  if (error instanceof CueTransportError && !prefix) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new CueTransportError(prefix ? `${prefix}: ${detail}` : detail);
}

function unsupportedProtocolError(message: string, cause?: unknown): CueError {
  const detail = cause instanceof Error ? ` Detail: ${cause.message}` : "";
  return new CueError("UNSUPPORTED_PROTOCOL", `${message}.${detail}`);
}
