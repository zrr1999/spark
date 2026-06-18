import {
  createExtensionRoleSpec,
  registerExtensionRole,
  type RoleSpec,
} from "@zendev-lab/pi-roles";
import { Type } from "typebox";

import {
  formatDirectOutput,
  runDirectGraft,
  runGraftJson,
  type DirectGraftExecution,
  type JsonRecord,
  type JsonValue,
} from "./graft-client.ts";

const STATE_ENTRY = "pi-graft-state";
export const PI_GRAFT_PATCHER_ROLE_ID = "patcher";
export const PI_GRAFT_PATCHER_ROLE_REF = "role:extension-patcher";
export const PI_GRAFT_PATCHER_ALLOWED_TOOLS = [
  "graft_help",
  "graft_init",
  "graft_status",
  "graft_ps",
  "graft_doctor",
  "graft_scratch_open",
  "graft_read",
  "graft_write",
  "graft_edit",
  "graft_delete",
  "graft_scratch_diff",
  "graft_scratch_drop",
  "graft_scratch_pin",
  "graft_scratch_unpin",
  "graft_candidate_from_scratch",
  "graft_validate",
  "graft_admit",
  "graft_show",
  "graft_evidence",
  "graft_candidates",
  "graft_search",
  "graft_materialize",
  "graft_repo",
  "graft_cli_exec",
] as const;
const GRAFT_REPO_ACTIONS = ["add", "list", "sync", "lock", "update"] as const;

export function createPiGraftPatcherRoleSpec(): RoleSpec {
  return createExtensionRoleSpec({
    id: PI_GRAFT_PATCHER_ROLE_ID,
    description:
      "Graft-owned patcher role for scratch/candidate/validation/materialization workflows.",
    systemPrompt: [
      "You are the pi-graft patcher role.",
      "Use only Graft scratch, candidate, validation, evidence, repository, and materialization tools exposed to you.",
      "Do not edit the working tree directly; create or update Graft scratches, promote candidates, validate, and report candidate or patch refs with evidence.",
      "If the requested patch is ambiguous, underspecified, contradictory, or missing success criteria, stop and report the blocker upward instead of asking interactively or changing files.",
    ].join("\n"),
    allowedTools: [...PI_GRAFT_PATCHER_ALLOWED_TOOLS],
    origin: { kind: "extension", note: "pi-graft" },
  });
}

export interface PiGraftCurrentModel {
  id?: string;
  provider?: string;
}

export interface PiGraftSessionContext {
  cwd?: string;
  model?: PiGraftCurrentModel;
  sessionManager?: {
    getBranch?: () => unknown[];
    getEntries?: () => unknown[];
    getSessionFile?: () => string | undefined;
  };
}

export interface PiGraftToolContext extends PiGraftSessionContext {
  cwd: string;
  ui?: {
    input?: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
    notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
  };
}

export interface PiGraftToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

export interface PiGraftToolDefinition {
  name: string;
  label: string;
  description: string;
  /** One-line tool summary for Pi's Available tools system-prompt section. */
  promptSnippet?: string;
  /** Tool-specific guideline bullets for Pi's default system prompt. */
  promptGuidelines?: string[];
  parameters: unknown;
  /** Per-tool execution mode hint understood by Pi; stateful sandbox tools use sequential. */
  executionMode?: "sequential" | "parallel";
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
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
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

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
  const { envelope, execution } = await runGraftJson(cwd, argv);
  return { envelope, execution };
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
  return argv;
}

function hasHelpFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
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
  if (hasHelpFlag(argv)) {
    const execution = await runDirectGraft(cwd, argv);
    return { text: formatDirectOutput(execution), details: { execution } };
  }
  const { envelope, execution } = await runGraftJson(cwd, argv);
  return { text: formatEnvelope(envelope), details: { envelope, execution } };
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

function scratchSourceArgv(source: ScratchSourceSelection): string[] {
  if (source.base) return ["--base", source.base];
  if (source.from) return ["--from", source.from];
  throw new Error("scratch source is missing base/from.");
}

function scratchSourceSchema(): Record<string, unknown> {
  return {
    base: Type.Optional(
      Type.String({
        description:
          "Base ref for the first scratch operation: graft:empty, tree:<id>, candidate:<id>, or patch:<id>. Mutually exclusive with from; omit from when base is set.",
      }),
    ),
    from: Type.Optional(
      Type.String({
        description:
          "Scratch id to continue editing. Mutually exclusive with base; omit base when continuing a scratch.",
      }),
    ),
  };
}

async function graftJsonResult(
  cwd: string,
  argv: string[],
  context: string,
  options: { stdin?: string } = {},
): Promise<{ result: JsonRecord; envelope: JsonRecord; execution: DirectGraftExecution }> {
  const { envelope, result, execution } = await runGraftJson(cwd, argv, options);
  if (!result)
    throw new Error(`graft ${context} did not return result: ${JSON.stringify(envelope)}`);
  return { result, envelope, execution };
}

function requireResultString(result: unknown, context: string, field: string): string {
  const value = stringField(result, field);
  if (!value)
    throw new Error(`graftd ${context} did not return ${field}: ${JSON.stringify(result)}`);
  return value;
}

function requireResultBoolean(result: unknown, context: string, field: string): boolean {
  if (isRecord(result) && typeof result[field] === "boolean") return result[field];
  throw new Error(`graftd ${context} did not return ${field}: ${JSON.stringify(result)}`);
}

function requireResultNumber(result: unknown, context: string, field: string): number {
  if (isRecord(result) && typeof result[field] === "number") return result[field];
  throw new Error(`graftd ${context} did not return ${field}: ${JSON.stringify(result)}`);
}

function requireResultStringArray(result: unknown, context: string, field: string): string[] {
  const value = stringArrayField(result, field);
  if (!value)
    throw new Error(`graftd ${context} did not return ${field}: ${JSON.stringify(result)}`);
  return value;
}

export function registerPiGraftExtension(pi: PiGraftExtensionApi): void {
  registerExtensionRole(createPiGraftPatcherRoleSpec());

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
      const argv = ["--json", "init"];
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
        const status = await graftJsonResult(cwd, ["scratch", "status"], "scratch status");
        daemon = status.result;
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
      const { envelope, execution } = await directCliJson(cwd, ["--json", "ps"]);
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
      const argv = ["--json", "doctor"];
      if (optionalBooleanParam(params, "rebuildRegistry")) argv.push("--rebuild-registry");
      const { envelope, execution } = await directCliJson(cwd, argv);
      return envelopeToolResult(envelope, { execution });
    },
  });

  pi.registerTool({
    name: "graft_scratch_open",
    label: "Graft Scratch Open",
    description: "Open a base ref as a daemon scratch and remember it as lastScratch.",
    parameters: Type.Object({
      base: Type.String({
        description: "Base ref to open: graft:empty, tree:<id>, candidate:<id>, or patch:<id>.",
      }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const base = optionalStringParam(params, "base");
      if (!base) throw new Error("graft_scratch_open requires base.");
      const { result } = await graftJsonResult(
        cwd,
        ["scratch", "open", "--base", base],
        "scratch open",
      );
      const scratch = requireResultString(result, "scratch_open", "scratch");
      const nextState = rememberState(cwd, { base, lastScratch: scratch });
      return {
        content: [{ type: "text", text: `Opened ${base} as graft scratch ${scratch}.` }],
        details: { result, state: nextState },
      };
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
      const { result } = await graftJsonResult(
        cwd,
        ["scratch", "read", ...scratchSourceArgv(source), path, "--mode", "hashlines"],
        "scratch read",
      );
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
      const { result } = await graftJsonResult(
        cwd,
        ["scratch", "write", ...scratchSourceArgv(source), path, "--content-stdin"],
        "scratch write",
        { stdin: content },
      );
      const scratch = requireResultString(result, "scratch_write", "scratch");
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
      const { result } = await graftJsonResult(
        cwd,
        ["scratch", "edit", ...scratchSourceArgv(source), path, "--edits-stdin"],
        "scratch edit",
        { stdin: JSON.stringify(edits) },
      );
      const scratch = requireResultString(result, "scratch_edit", "scratch");
      const updatedAnchors = stringField(result, "updated_anchors");
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
      const { result } = await graftJsonResult(
        cwd,
        ["scratch", "delete", ...scratchSourceArgv(source), path],
        "scratch delete",
      );
      const scratch = requireResultString(result, "scratch_delete", "scratch");
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
    name: "graft_scratch_diff",
    label: "Graft Scratch Diff",
    description: "Show changed paths between two daemon scratch ids.",
    parameters: Type.Object({
      from: Type.String({ description: "Source scratch id." }),
      to: Type.Optional(
        Type.String({ description: "Target scratch id. Defaults to lastScratch." }),
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
      const from = optionalStringParam(params, "from");
      const to = optionalStringParam(params, "to") ?? state?.lastScratch;
      if (!from) throw new Error("graft_scratch_diff requires from.");
      if (!to) throw new Error("graft_scratch_diff requires to or a previous scratch tool result.");
      const { result } = await graftJsonResult(cwd, ["scratch", "diff", from, to], "scratch diff");
      const changedPaths = requireResultStringArray(result, "scratch_diff", "changed_paths");
      return {
        content: [
          {
            type: "text",
            text: `Scratch diff ${from} -> ${to}. Changed paths: ${changedPaths.length ? changedPaths.join(", ") : "none"}`,
          },
        ],
        details: { result, state },
      };
    },
  });

  pi.registerTool({
    name: "graft_scratch_drop",
    label: "Graft Scratch Drop",
    description: "Drop an unpinned daemon scratch.",
    parameters: Type.Object({
      scratch: Type.Optional(Type.String({ description: "Scratch id. Defaults to lastScratch." })),
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
      const scratch = optionalStringParam(params, "scratch") ?? state?.lastScratch;
      if (!scratch)
        throw new Error("graft_scratch_drop requires scratch or a previous scratch tool result.");
      const { result } = await graftJsonResult(cwd, ["scratch", "drop", scratch], "scratch drop");
      const dropped = requireResultBoolean(result, "scratch_drop", "dropped");
      return {
        content: [
          { type: "text", text: `${dropped ? "Dropped" : "Kept"} graft scratch ${scratch}.` },
        ],
        details: { result, state },
      };
    },
  });

  pi.registerTool({
    name: "graft_scratch_pin",
    label: "Graft Scratch Pin",
    description: "Pin a daemon scratch and return a lease.",
    parameters: Type.Object({
      scratch: Type.Optional(Type.String({ description: "Scratch id. Defaults to lastScratch." })),
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
      const scratch = optionalStringParam(params, "scratch") ?? state?.lastScratch;
      if (!scratch)
        throw new Error("graft_scratch_pin requires scratch or a previous scratch tool result.");
      const { result } = await graftJsonResult(cwd, ["scratch", "pin", scratch], "scratch pin");
      const lease = requireResultString(result, "scratch_pin", "lease");
      const pinned = requireResultNumber(result, "scratch_pin", "pinned");
      return {
        content: [
          {
            type: "text",
            text: `Pinned graft scratch ${scratch} with lease ${lease}. Active pins: ${pinned}.`,
          },
        ],
        details: { result, state },
      };
    },
  });

  pi.registerTool({
    name: "graft_scratch_unpin",
    label: "Graft Scratch Unpin",
    description: "Release a daemon scratch lease.",
    parameters: Type.Object({
      lease: Type.String({ description: "Scratch lease returned by graft_scratch_pin." }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiGraftToolContext,
    ) {
      const cwd = toolCwd(ctx, activeState, lastCwd);
      const lease = optionalStringParam(params, "lease");
      if (!lease) throw new Error("graft_scratch_unpin requires lease.");
      const { result } = await graftJsonResult(cwd, ["scratch", "unpin", lease], "scratch unpin");
      const scratch = requireResultString(result, "scratch_unpin", "scratch");
      const pinned = requireResultNumber(result, "scratch_unpin", "pinned");
      return {
        content: [
          {
            type: "text",
            text: `Released lease ${lease} for graft scratch ${scratch}. Active pins: ${pinned}.`,
          },
        ],
        details: { result, state: stateForCwd(activeState, cwd) },
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
          Type.String({
            description:
              "Whole-state constraint primitive to validate immediately and add to the candidate constraint, e.g. tests_pass.",
          }),
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
      const argv = ["candidate", "from-scratch", scratch];
      for (const expected of normalizeStringList(params.expected)) argv.push("--expect", expected);
      argv.push(
        "--producer",
        typeof params.producer === "string" && params.producer
          ? params.producer
          : "@zendev-lab/pi-graft",
      );
      if (typeof params.message === "string") argv.push("--message", params.message);
      const { result } = await graftJsonResult(cwd, argv, "candidate from-scratch");
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
      const argv = ["validate", target];
      for (const expected of normalizeStringList(params.expected)) argv.push("--expect", expected);
      const { envelope, execution } = await runGraftJson(cwd, argv);
      return {
        content: [{ type: "text", text: formatEnvelope(envelope) }],
        details: { envelope, execution },
      };
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
      const argv = ["admit", candidate];
      for (const required of normalizeStringList(params.required)) argv.push("--require", required);
      const { envelope, execution } = await runGraftJson(cwd, argv);
      const patch =
        typeof envelope.patch_id === "string" ? envelope.patch_id : stringField(envelope, "patch");
      let nextState = state;
      if (patch) {
        nextState = rememberState(cwd, { lastPatch: patch });
      }
      return {
        content: [{ type: "text", text: formatEnvelope(envelope) }],
        details: { envelope, execution, state: nextState },
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
      const argv = ["--json", "show", target];
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
      property: Type.Optional(Type.String({ description: "Filter by expected property." })),
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
      const argv = ["--json", "candidates"];
      const property = optionalStringParam(params, "property");
      const producer = optionalStringParam(params, "producer");
      if (property) argv.push("--property", property);
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
      property: Type.Optional(Type.String({ description: "Filter by property." })),
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
      const argv = ["--json", "search"];
      const property = optionalStringParam(params, "property");
      const base = optionalStringParam(params, "base");
      const producer = optionalStringParam(params, "producer");
      const hasEvidence = optionalStringParam(params, "hasEvidence");
      if (property) argv.push("--property", property);
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
    description: "Plan or materialize an admitted patch target into an isolated inspection state.",
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
      // graft routes `materialize` as a Local command (not a daemon cli_exec write),
      // so run it through the direct CLI path instead of the daemon write path.
      const argv = ["--json", "materialize", patch];
      if (optionalBooleanParam(params, "dryRun", true)) argv.push("--dry-run");
      const { text, details } = await executeCliArgv(cwd, argv);
      return { content: [{ type: "text", text }], details: { state, ...details } };
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
          formatGraftStringArg(args.url, {
            prefix: "url=",
            maxLength: GRAFT_TOOL_CALL_PATH_MAX_LENGTH,
          }),
          formatGraftStringArg(args.cwd, {
            prefix: "cwd=",
            maxLength: GRAFT_TOOL_CALL_PATH_MAX_LENGTH,
          }),
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
    description: "Run allowlisted low-frequency read-only or diagnostic graft CLI argv safely.",
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

const GRAFT_TOOL_CALL_DEFAULT_ARG_MAX_LENGTH = 80;
const GRAFT_TOOL_CALL_PATH_MAX_LENGTH = 60;

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
  const maxLength = options.maxLength ?? GRAFT_TOOL_CALL_DEFAULT_ARG_MAX_LENGTH;
  const normalized = raw.length <= maxLength ? raw : `${raw.slice(0, Math.max(0, maxLength - 1))}…`;
  const rendered = /\s/u.test(normalized) ? JSON.stringify(normalized) : normalized;
  return `${options.prefix ?? ""}${rendered}`;
}

export default function piGraftExtension(pi: PiGraftExtensionApi): void {
  registerPiGraftExtension(pi);
}
