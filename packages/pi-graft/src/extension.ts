import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_ENTRY = "pi-graft-state";
const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_START_TIMEOUT_MS = 5_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

export interface PiGraftSessionContext {
  sessionManager?: { getBranch?: () => unknown[]; getEntries?: () => unknown[] };
}

export interface PiGraftCommandContext extends PiGraftSessionContext {
  cwd: string;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
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
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<PiGraftToolResult>;
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
  base: string;
  rootScratch: string;
  scratch: string;
  lease?: string;
  openedAt: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

function stringArrayField(value: unknown, field: string): string[] | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  if (!Array.isArray(fieldValue)) return undefined;
  return fieldValue.every((item) => typeof item === "string") ? fieldValue : undefined;
}

function workspaceSocketPath(cwd: string): string {
  return join(cwd, ".graft", "graftd.sock");
}

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
  await mkdir(join(cwd, ".graft"), { recursive: true });
  await rm(socketPath, { force: true });

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
  const id = `pi-graft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, op, params })}\n`);
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
    const base = stringField(nextState, "base");
    const rootScratch = stringField(nextState, "rootScratch");
    const scratch = stringField(nextState, "scratch");
    const openedAt = stringField(nextState, "openedAt");
    const updatedAt = stringField(nextState, "updatedAt");
    if (!workspace || !base || !rootScratch || !scratch || !openedAt || !updatedAt) continue;
    state = {
      workspace,
      base,
      rootScratch,
      scratch,
      openedAt,
      updatedAt,
      lease: stringField(nextState, "lease"),
      lastCandidate: stringField(nextState, "lastCandidate"),
      lastPatch: stringField(nextState, "lastPatch"),
    };
  }
  return state;
}

function stateSummary(state: ActiveGraftScratchState | undefined): string {
  if (!state) return "No active graft scratch. Run /graft-open <base> first.";
  return [
    `workspace: ${state.workspace}`,
    `base: ${state.base}`,
    `rootScratch: ${state.rootScratch}`,
    `scratch: ${state.scratch}`,
    `lease: ${state.lease ?? "none"}`,
    `lastCandidate: ${state.lastCandidate ?? "none"}`,
    `lastPatch: ${state.lastPatch ?? "none"}`,
  ].join("\n");
}

function registerState(pi: PiGraftExtensionApi, state: ActiveGraftScratchState | undefined): void {
  pi.appendEntry?.(STATE_ENTRY, { state: state ?? null });
}

function requiredActiveState(state: ActiveGraftScratchState | undefined): ActiveGraftScratchState {
  if (!state) {
    throw new Error("E_NO_ACTIVE_SCRATCH: no active graft scratch. Run /graft-open <base> first.");
  }
  return state;
}

async function validateActiveState(state: ActiveGraftScratchState): Promise<void> {
  try {
    await requestGraftd(state.workspace, "status", {}, { spawnIfMissing: false });
    await requestGraftd(
      state.workspace,
      "scratch_diff",
      { from: state.rootScratch, to: state.scratch },
      { spawnIfMissing: false },
    );
  } catch (error) {
    throw new Error(
      `E_SCRATCH_LOST: active graft scratch is not reachable; run /graft-open ${state.base} again. Cause: ${compactError(error)}`,
    );
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function formatEnvelope(envelope: JsonRecord): string {
  const message = typeof envelope.message === "string" ? envelope.message : undefined;
  const candidate =
    typeof envelope.candidate_id === "string" ? `candidate: ${envelope.candidate_id}` : undefined;
  return [message, candidate].filter(Boolean).join("\n") || JSON.stringify(envelope, null, 2);
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
  const match = /^\s*[>+-]*\s*(\d+)\s*#\s*([^\s:]+)(?:\s*:(.*))?$/s.exec(ref.trimEnd());
  if (!match) throw new Error(`${field} must use LINE#HASH, got ${JSON.stringify(ref)}.`);
  const line = Number.parseInt(match[1]!, 10);
  const hash = match[2]!;
  if (!Number.isInteger(line) || line < 1) throw new Error(`${field} line must be >= 1.`);
  if (hash.length !== 2) throw new Error(`${field} hash must be exactly 2 characters.`);
  return match[3] === undefined ? { line, hash } : { line, hash, textHint: match[3] };
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

export function registerPiGraftExtension(pi: PiGraftExtensionApi): void {
  let activeState: ActiveGraftScratchState | undefined;

  pi.on("session_start", (_event: unknown, ctx: PiGraftSessionContext) => {
    activeState = restoreState(ctx);
  });

  pi.registerCommand("graft-open", {
    description: "Open a graft scratch from a tree/candidate/patch base: /graft-open <base>",
    handler: async (args: string, ctx: PiGraftCommandContext) => {
      const base = args.trim();
      if (!base) {
        ctx.ui?.notify?.("Usage: /graft-open <tree|candidate|patch base>", "warning");
        return;
      }
      const cwd = ctx.cwd;
      const open = await requestGraftd(cwd, "scratch_open", { base });
      const scratch = stringField(open, "scratch");
      if (!scratch)
        throw new Error(`graftd scratch_open did not return scratch: ${JSON.stringify(open)}`);
      const pin = await requestGraftd(cwd, "scratch_pin", { scratch });
      const lease = stringField(pin, "lease");
      const now = new Date().toISOString();
      activeState = {
        workspace: cwd,
        base,
        rootScratch: scratch,
        scratch,
        lease,
        openedAt: now,
        updatedAt: now,
      };
      registerState(pi, activeState);
      ctx.ui?.notify?.(
        `Opened graft scratch ${scratch}${lease ? ` (lease ${lease})` : ""}`,
        "info",
      );
    },
  });

  pi.registerCommand("graft-close", {
    description: "Release the active graft scratch lease and clear pi-graft state",
    handler: async (_args: string, ctx: PiGraftCommandContext) => {
      const state = activeState;
      if (!state) {
        ctx.ui?.notify?.("No active graft scratch.", "info");
        return;
      }
      const errors: string[] = [];
      if (state.lease) {
        await requestGraftd(state.workspace, "scratch_unpin", { lease: state.lease }).catch(
          (error) => {
            errors.push(`unpin: ${compactError(error)}`);
          },
        );
      }
      await requestGraftd(state.workspace, "scratch_drop", { scratch: state.scratch }).catch(
        (error) => {
          errors.push(`drop: ${compactError(error)}`);
        },
      );
      activeState = undefined;
      registerState(pi, undefined);
      ctx.ui?.notify?.(
        errors.length
          ? `Cleared graft scratch state with warnings: ${errors.join("; ")}`
          : "Closed graft scratch.",
        errors.length ? "warning" : "info",
      );
    },
  });

  pi.registerTool({
    name: "read",
    label: "Read (graft)",
    description:
      "Read a UTF-8 text file from the active graft scratch. Output uses LINE#HASH anchors; run /graft-open <base> first. Supports offset/limit over rendered hashline lines.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to read from the active graft scratch." }),
      offset: Type.Optional(
        Type.Number({ description: "Line number to start reading from (1-indexed)." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return." })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const state = requiredActiveState(activeState);
      await validateActiveState(state);
      const path = typeof params.path === "string" ? params.path : undefined;
      if (!path) throw new Error("read requires path.");
      const result = await requestGraftd(
        state.workspace,
        "scratch_read",
        { scratch: state.scratch, path, mode: "hashlines" },
        { spawnIfMissing: false },
      );
      const content = stringField(result, "content");
      if (content === undefined)
        throw new Error(`graftd scratch_read did not return content: ${JSON.stringify(result)}`);
      const rendered = renderHashlineSlice(content, params.offset, params.limit);
      return {
        content: [{ type: "text", text: rendered.text }],
        details: { result, state, nextOffset: rendered.nextOffset },
      };
    },
  });

  pi.registerTool({
    name: "write",
    label: "Write (graft)",
    description:
      "Write UTF-8 text content into the active graft scratch and advance the active scratch id. Does not modify the worktree and does not promote automatically.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to write in the active graft scratch." }),
      content: Type.String({ description: "Complete UTF-8 text content to write." }),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const state = requiredActiveState(activeState);
      await validateActiveState(state);
      const path = typeof params.path === "string" ? params.path : undefined;
      const content = typeof params.content === "string" ? params.content : undefined;
      if (!path) throw new Error("write requires path.");
      if (content === undefined) throw new Error("write requires content.");
      const result = await requestGraftd(
        state.workspace,
        "scratch_write",
        { scratch: state.scratch, path, content },
        { spawnIfMissing: false },
      );
      const scratch = stringField(result, "scratch");
      if (!scratch)
        throw new Error(`graftd scratch_write did not return scratch: ${JSON.stringify(result)}`);
      activeState = { ...state, scratch, updatedAt: new Date().toISOString() };
      registerState(pi, activeState);
      return {
        content: [{ type: "text", text: `Wrote ${path} in graft scratch ${scratch}.` }],
        details: { result, state: activeState },
      };
    },
  });

  pi.registerTool({
    name: "edit",
    label: "Edit (graft)",
    description:
      "Apply strict hashline edits to a UTF-8 text file in the active graft scratch. Use anchors from graft read output. Supported ops: replace, append, prepend. Does not accept oldText/newText exact replacement fields.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to edit in the active graft scratch." }),
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
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (
        "oldText" in params ||
        "newText" in params ||
        "old_text" in params ||
        "new_text" in params
      ) {
        throw new Error(
          "pi-graft edit is strict hashline-only; call read first and use edits[].op/pos/lines.",
        );
      }
      const state = requiredActiveState(activeState);
      await validateActiveState(state);
      const path = typeof params.path === "string" ? params.path : undefined;
      if (!path) throw new Error("edit requires path.");
      const edits = convertHashlineEdits(params.edits);
      const result = await requestGraftd(
        state.workspace,
        "scratch_edit",
        { scratch: state.scratch, path, edits },
        { spawnIfMissing: false },
      );
      const scratch = stringField(result, "scratch");
      const updatedAnchors = stringField(result, "updated_anchors");
      if (!scratch)
        throw new Error(`graftd scratch_edit did not return scratch: ${JSON.stringify(result)}`);
      activeState = { ...state, scratch, updatedAt: new Date().toISOString() };
      registerState(pi, activeState);
      return {
        content: [
          {
            type: "text",
            text: `Edited ${path} in graft scratch ${scratch}.${updatedAnchors ? `\n\n--- Updated anchors ---\n${updatedAnchors}` : ""}`,
          },
        ],
        details: { result, state: activeState },
      };
    },
  });

  pi.registerTool({
    name: "graft_status",
    label: "Graft Status",
    description: "Inspect the active pi-graft scratch, lease, changed paths, and graftd status.",
    parameters: Type.Object({}),
    async execute() {
      const state = activeState;
      if (!state)
        return {
          content: [{ type: "text", text: stateSummary(undefined) }],
          details: { active: false },
        };
      await validateActiveState(state);
      const daemon = await requestGraftd(state.workspace, "status", {}, { spawnIfMissing: false });
      const diff = await requestGraftd(
        state.workspace,
        "scratch_diff",
        { from: state.rootScratch, to: state.scratch },
        { spawnIfMissing: false },
      );
      const changedPaths = stringArrayField(diff, "changed_paths") ?? [];
      return {
        content: [
          {
            type: "text",
            text: `${stateSummary(state)}\nchangedPaths: ${changedPaths.length ? changedPaths.join(", ") : "none"}`,
          },
        ],
        details: { active: true, state, daemon, changedPaths },
      };
    },
  });

  pi.registerTool({
    name: "graft_promote",
    label: "Graft Promote",
    description:
      "Promote the active graft scratch to a candidate. Does not validate or admit automatically.",
    parameters: Type.Object({
      expected: Type.Optional(
        Type.Array(Type.String({ description: "Expected property, e.g. ValidPatch" })),
      ),
      producer: Type.Optional(
        Type.String({ description: "Candidate provenance producer. Defaults to pi-graft." }),
      ),
      message: Type.Optional(Type.String({ description: "Candidate message." })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const state = requiredActiveState(activeState);
      await validateActiveState(state);
      const result = await requestGraftd(state.workspace, "scratch_promote", {
        scratch: state.scratch,
        expected: normalizeStringList(params.expected) as JsonValue[],
        producer:
          typeof params.producer === "string" && params.producer ? params.producer : "pi-graft",
        message: typeof params.message === "string" ? params.message : null,
      });
      const candidate = stringField(result, "candidate");
      if (candidate) {
        activeState = { ...state, lastCandidate: candidate, updatedAt: new Date().toISOString() };
        registerState(pi, activeState);
      }
      const changedPaths = stringArrayField(result, "changed_paths") ?? [];
      return {
        content: [
          {
            type: "text",
            text: `Promoted ${state.scratch} to ${candidate ?? "candidate"}. Changed paths: ${changedPaths.length ? changedPaths.join(", ") : "none"}`,
          },
        ],
        details: { result, state: activeState ?? state },
      };
    },
  });

  pi.registerTool({
    name: "graft_validate",
    label: "Graft Validate",
    description: "Run graft validation for a candidate or patch through graftd cli_exec.",
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({ description: "Candidate or patch id. Defaults to last promoted candidate." }),
      ),
      expected: Type.Optional(
        Type.Array(Type.String({ description: "Additional expected property." })),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const state = requiredActiveState(activeState);
      const target =
        typeof params.target === "string" && params.target ? params.target : state.lastCandidate;
      if (!target)
        throw new Error("graft_validate requires target or a previous graft_promote candidate.");
      const argv = ["validate", target];
      for (const expected of normalizeStringList(params.expected)) argv.push("--expect", expected);
      const envelope = await cliExec(state.workspace, argv);
      return { content: [{ type: "text", text: formatEnvelope(envelope) }], details: { envelope } };
    },
  });

  pi.registerTool({
    name: "graft_admit",
    label: "Graft Admit",
    description: "Admit a validated candidate to the graft patch registry through graftd cli_exec.",
    parameters: Type.Object({
      candidate: Type.Optional(
        Type.String({ description: "Candidate id. Defaults to last promoted candidate." }),
      ),
      required: Type.Optional(
        Type.Array(Type.String({ description: "Required passed property." })),
      ),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const state = requiredActiveState(activeState);
      const candidate =
        typeof params.candidate === "string" && params.candidate
          ? params.candidate
          : state.lastCandidate;
      if (!candidate)
        throw new Error("graft_admit requires candidate or a previous graft_promote candidate.");
      const argv = ["admit", candidate];
      for (const required of normalizeStringList(params.required)) argv.push("--require", required);
      const envelope = await cliExec(state.workspace, argv);
      const patch =
        typeof envelope.patch_id === "string" ? envelope.patch_id : stringField(envelope, "patch");
      if (patch) {
        activeState = { ...state, lastPatch: patch, updatedAt: new Date().toISOString() };
        registerState(pi, activeState);
      }
      return {
        content: [{ type: "text", text: formatEnvelope(envelope) }],
        details: { envelope, state: activeState ?? state },
      };
    },
  });
}

export default function piGraftExtension(pi: ExtensionAPI): void {
  registerPiGraftExtension(pi as unknown as PiGraftExtensionApi);
}
