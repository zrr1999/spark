import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const STATE_ENTRY = "pi-graft-state";
const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_START_TIMEOUT_MS = 5_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

export interface PiGraftSessionContext {
  cwd?: string;
  sessionManager?: { getBranch?: () => unknown[]; getEntries?: () => unknown[] };
}

export interface PiGraftCommandContext extends PiGraftSessionContext {
  cwd: string;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

export interface PiGraftToolContext extends PiGraftSessionContext {
  cwd: string;
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
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: PiGraftToolContext,
  ) => Promise<PiGraftToolResult>;
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

function workspaceIdForRequest(): string {
  return process.env.GRAFT_WORKSPACE?.trim() || "ws:default";
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
  const id = `pi-graft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.once("connect", () => {
      const requestParams = { workspace_id: workspaceIdForRequest(), cwd, ...params };
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

function formatEnvelope(envelope: JsonRecord): string {
  const message = typeof envelope.message === "string" ? envelope.message : undefined;
  const candidate =
    typeof envelope.candidate_id === "string" ? `candidate: ${envelope.candidate_id}` : undefined;
  return [message, candidate].filter(Boolean).join("\n") || JSON.stringify(envelope, null, 2);
}

async function notifyCliExec(
  ctx: PiGraftCommandContext,
  argv: string[],
  fallbackMessage: string,
): Promise<void> {
  const envelope = await cliExec(ctx.cwd, argv);
  ctx.ui?.notify?.(formatEnvelope(envelope) || fallbackMessage, "info");
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
  let activeState: ActiveGraftScratchState | undefined;
  let lastCwd: string | undefined;

  function rememberState(cwd: string, updates: StateUpdates): ActiveGraftScratchState {
    activeState = mergeState(activeState, cwd, updates);
    registerState(pi, activeState);
    return activeState;
  }

  pi.on("session_start", (_event: unknown, ctx: PiGraftSessionContext) => {
    lastCwd = ctx.cwd;
    activeState = restoreState(ctx);
  });

  pi.registerCommand("graft-attach", {
    description: "Attach cwd to a graft workspace route: /graft-attach [workspace-id|--status]",
    handler: async (args: string, ctx: PiGraftCommandContext) => {
      const trimmed = args.trim();
      const argv = trimmed === "--status" ? ["attach", "--status"] : ["attach"];
      if (trimmed && trimmed !== "--status") argv.push("--workspace", trimmed);
      await notifyCliExec(ctx, argv, "Attached graft workspace route.");
    },
  });

  pi.registerCommand("graft-detach", {
    description: "Detach cwd from its graft workspace route: /graft-detach",
    handler: async (_args: string, ctx: PiGraftCommandContext) => {
      await notifyCliExec(ctx, ["detach"], "Detached graft workspace route.");
    },
  });

  pi.registerCommand("graft-ps", {
    description: "Show graft global daemon and registry status: /graft-ps",
    handler: async (_args: string, ctx: PiGraftCommandContext) => {
      await notifyCliExec(ctx, ["ps"], "Graft ps completed.");
    },
  });

  pi.registerCommand("graft-doctor", {
    description: "Diagnose graft registry state: /graft-doctor [--rebuild-registry]",
    handler: async (args: string, ctx: PiGraftCommandContext) => {
      const argv = ["doctor"];
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
    name: "graft_read",
    label: "Graft read (experimental)",
    description:
      "Experimental: read a UTF-8 text file through graftd scratch_read. Pass base for the first operation or from to continue a returned scratch. Output uses LINE#HASH anchors and details.result.scratch returns the scratch id.",
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
    label: "Graft write (experimental)",
    description:
      "Experimental: write UTF-8 text content through graftd scratch_write. Pass base for the first operation or from to continue a returned scratch. Does not modify the worktree or create a candidate.",
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
    label: "Graft edit (experimental)",
    description:
      "Experimental: apply strict hashline edits through graftd scratch_edit. Pass base for the first operation or from to continue a returned scratch. Supported ops: replace, append, prepend. Does not accept oldText/newText exact replacement fields.",
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
    label: "Graft delete (experimental)",
    description:
      "Experimental: delete a file through graftd scratch_delete. Pass base for the first operation or from to continue a returned scratch. Does not modify the worktree or create a candidate.",
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
    name: "graft_candidate_from_scratch",
    label: "Graft candidate from scratch",
    description:
      "Create a candidate from a scratch id through graftd candidate_from_scratch. Pass scratch explicitly, or omit it to use the last scratch returned by a pi-graft scratch tool in this workspace.",
    parameters: Type.Object({
      scratch: Type.Optional(
        Type.String({
          description: "Scratch id to turn into a candidate. Defaults to lastScratch.",
        }),
      ),
      expected: Type.Optional(
        Type.Array(Type.String({ description: "Expected property, e.g. ValidPatch" })),
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
          typeof params.producer === "string" && params.producer ? params.producer : "pi-graft",
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
    description: "Run graft validation for a candidate or patch through graftd cli_exec.",
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
      const argv = ["validate", target];
      for (const expected of normalizeStringList(params.expected)) argv.push("--expect", expected);
      const envelope = await cliExec(cwd, argv);
      return { content: [{ type: "text", text: formatEnvelope(envelope) }], details: { envelope } };
    },
  });

  pi.registerTool({
    name: "graft_admit",
    label: "Graft Admit",
    description: "Admit a validated candidate to the graft patch registry through graftd cli_exec.",
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
      const argv = ["admit", candidate];
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
}

export default function piGraftExtension(pi: PiGraftExtensionApi): void {
  registerPiGraftExtension(pi);
}
