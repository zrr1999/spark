import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Type } from "typebox";

import {
  registerPiGraftExtension,
  type PiGraftExtensionApi,
  type PiGraftSessionContext,
  type PiGraftToolContext,
} from "./extension.ts";
import { runGraftJson, type JsonRecord } from "./graft-client.ts";

const SANDBOX_STATE_ENTRY = "pi-graft-sandbox-state";
const DEFAULT_REPO_ID = "sandbox";
const SANDBOX_FILE_PROMPT_GUIDELINES = [
  "Sandbox read/write/edit/grep/find/ls operate on the active Graft scratch/base, never directly on the working tree.",
  "Run graft_sandbox_enter before sandbox file access; use graft_sandbox_checkpoint/materialize/promote for lifecycle transitions.",
  "Do not bypass the sandbox with shell/script file I/O; validation commands without direct file access remain allowed.",
  "Sandbox grep/find/ls v1 cover explicit sandbox paths or known changed paths only; materialize for full-tree inspection.",
];

export interface PiGraftSandboxState {
  active: true;
  repoRoot: string;
  repoId: string;
  workspace: string;
  workspaceId?: string;
  base: string;
  resolvedBase?: string;
  lastScratch?: string;
  changedPaths: string[];
  lastCandidate?: string;
  lastPatch?: string;
  lastMaterializedPath?: string;
  lastPromotion?: {
    branch?: string;
    commit?: string;
    promotion?: string;
  };
  guardrails: {
    blockShellFileIo: boolean;
    allowValidationCommands: boolean;
  };
  createdAt: string;
  updatedAt: string;
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

function optionalBooleanParam(
  params: Record<string, unknown>,
  field: string,
  defaultValue: boolean,
): boolean {
  const value = params[field];
  return typeof value === "boolean" ? value : defaultValue;
}

function stringListParam(params: Record<string, unknown>, field: string): string[] {
  const value = params[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value.filter((item) => item.trim().length > 0);
}

function workspaceIdFromEnvelope(envelope: JsonRecord | undefined): string | undefined {
  const direct = stringField(envelope, "workspace_id");
  if (direct?.startsWith("ws:")) return direct;
  const message = stringField(envelope, "message");
  if (!message) return undefined;
  const match = /\b(ws:[A-Za-z0-9_.:-]+)/.exec(message);
  return match?.[1];
}

function restoreSandboxState(ctx: PiGraftSessionContext): PiGraftSandboxState | undefined {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  let state: PiGraftSandboxState | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SANDBOX_STATE_ENTRY) {
      continue;
    }
    const data = isRecord(entry.data) ? entry.data : undefined;
    const nextState = data?.state;
    if (nextState === null) {
      state = undefined;
      continue;
    }
    if (!isRecord(nextState) || nextState.active !== true) continue;
    const repoRoot = stringField(nextState, "repoRoot");
    const repoId = stringField(nextState, "repoId");
    const workspace = stringField(nextState, "workspace");
    const base = stringField(nextState, "base");
    const createdAt = stringField(nextState, "createdAt");
    const updatedAt = stringField(nextState, "updatedAt");
    if (!repoRoot || !repoId || !workspace || !base || !createdAt || !updatedAt) continue;
    const changedPaths = Array.isArray(nextState.changedPaths)
      ? nextState.changedPaths.filter((item): item is string => typeof item === "string")
      : [];
    const guardrails = isRecord(nextState.guardrails) ? nextState.guardrails : {};
    const promotionBranch = isRecord(nextState.lastPromotion)
      ? stringField(nextState.lastPromotion, "branch")
      : undefined;
    const promotionCommit = isRecord(nextState.lastPromotion)
      ? stringField(nextState.lastPromotion, "commit")
      : undefined;
    const promotionRef = isRecord(nextState.lastPromotion)
      ? stringField(nextState.lastPromotion, "promotion")
      : undefined;
    const lastPromotion =
      promotionBranch || promotionCommit || promotionRef
        ? {
            ...(promotionBranch ? { branch: promotionBranch } : {}),
            ...(promotionCommit ? { commit: promotionCommit } : {}),
            ...(promotionRef ? { promotion: promotionRef } : {}),
          }
        : undefined;
    state = {
      active: true,
      repoRoot,
      repoId,
      workspace,
      workspaceId: stringField(nextState, "workspaceId"),
      base,
      resolvedBase: stringField(nextState, "resolvedBase"),
      lastScratch: stringField(nextState, "lastScratch"),
      changedPaths,
      lastCandidate: stringField(nextState, "lastCandidate"),
      lastPatch: stringField(nextState, "lastPatch"),
      lastMaterializedPath: stringField(nextState, "lastMaterializedPath"),
      lastPromotion,
      guardrails: {
        blockShellFileIo:
          typeof guardrails.blockShellFileIo === "boolean" ? guardrails.blockShellFileIo : true,
        allowValidationCommands:
          typeof guardrails.allowValidationCommands === "boolean"
            ? guardrails.allowValidationCommands
            : true,
      },
      createdAt,
      updatedAt,
    };
  }
  return state;
}

function registerSandboxState(
  pi: PiGraftExtensionApi,
  state: PiGraftSandboxState | undefined,
): void {
  pi.appendEntry?.(SANDBOX_STATE_ENTRY, { state: state ?? null });
}

function defaultSandboxWorkspace(cwd: string, name?: string): string {
  const safeName = (name ?? cwd)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return resolve(tmpdir(), "pi-graft-sandbox", safeName || "workspace");
}

function sandboxSummary(state: PiGraftSandboxState | undefined): string {
  if (!state) {
    return [
      "GRAFT SANDBOX INACTIVE",
      "Normal pi-graft tools are available, but sandbox file-tool replacement has not been entered.",
      "Run graft_sandbox_enter before using sandbox-backed file tools.",
    ].join("\n");
  }
  return [
    "GRAFT SANDBOX ACTIVE",
    `repo: ${state.repoRoot}`,
    `workspace: ${state.workspace}`,
    `workspaceId: ${state.workspaceId ?? "auto"}`,
    `base: ${state.base}`,
    `resolvedBase: ${state.resolvedBase ?? "unknown"}`,
    `scratch: ${state.lastScratch ?? "none"}`,
    `changedPaths: ${state.changedPaths.length ? state.changedPaths.join(", ") : "none"}`,
    `candidate: ${state.lastCandidate ?? "none"}`,
    `patch: ${state.lastPatch ?? "none"}`,
    `materializedPath: ${state.lastMaterializedPath ?? "none"}`,
    `promotionCommit: ${state.lastPromotion?.commit ?? "none"}`,
    "writes: Graft scratch only; working tree is not modified",
  ].join("\n");
}

function requireSandboxState(state: PiGraftSandboxState | undefined): PiGraftSandboxState {
  if (!state) {
    throw new Error("Graft sandbox is inactive; run graft_sandbox_enter before file operations.");
  }
  return state;
}

function sandboxSourceArgv(state: PiGraftSandboxState): string[] {
  return state.lastScratch ? ["--from", state.lastScratch] : ["--base", state.base];
}

function sandboxSourceLabel(state: PiGraftSandboxState): string {
  return state.lastScratch ? `scratch ${state.lastScratch}` : `base ${state.base}`;
}

function sandboxPath(value: unknown, field = "path"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty relative path.`);
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".graft" ||
    normalized.startsWith(".graft/") ||
    normalized === ".worktrees" ||
    normalized.startsWith(".worktrees/")
  ) {
    throw new Error(`${field} must stay inside the sandbox virtual repo tree.`);
  }
  return normalized;
}

function optionalSandboxPath(params: Record<string, unknown>, field = "path"): string | undefined {
  const value = params[field];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  return sandboxPath(value, field);
}

function resultString(result: JsonRecord | undefined, field: string): string {
  const value = stringField(result, field);
  if (!value) throw new Error(`graft sandbox operation did not return result.${field}.`);
  return value;
}

function resultStringArray(result: JsonRecord | undefined, field: string): string[] {
  const value = result?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function updateSandboxState(
  pi: PiGraftExtensionApi,
  state: PiGraftSandboxState,
  updates: Partial<PiGraftSandboxState>,
): PiGraftSandboxState {
  const next: PiGraftSandboxState = {
    ...state,
    ...updates,
    changedPaths: uniqueStrings([...(state.changedPaths ?? []), ...(updates.changedPaths ?? [])]),
    updatedAt: new Date().toISOString(),
  };
  registerSandboxState(pi, next);
  return next;
}

function positiveIntegerParam(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function renderTextSlice(
  content: string,
  offset?: unknown,
  limit?: unknown,
): { text: string; nextOffset?: number } {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const start = positiveIntegerParam(offset, "offset") ?? 1;
  const max = positiveIntegerParam(limit, "limit");
  const selected = lines.slice(start - 1, max ? start - 1 + max : undefined);
  const nextOffset = max && start - 1 + max < lines.length ? start + max : undefined;
  const suffix = nextOffset
    ? `\n\n[Showing lines ${start}-${start + selected.length - 1} of ${lines.length}. Use offset=${nextOffset} to continue.]`
    : "";
  return { text: `${selected.join("\n")}${suffix}`, nextOffset };
}

function lineNumberAtOffset(content: string, offset: number): number {
  return content.slice(0, Math.max(0, offset)).split("\n").length;
}

function splitDisplayLines(content: string): string[] {
  return content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
}

function simpleUnifiedDiff(path: string, before: string, after: string): string {
  const beforeLines = splitDisplayLines(before);
  const afterLines = splitDisplayLines(after);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");
}

interface ExactTextReplacement {
  index: number;
  oldText: string;
  newText: string;
  start: number;
  end: number;
}

function applyExactTextEdits(
  original: string,
  edits: unknown,
): { content: string; replacements: number; firstChangedLine: number } {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("edit requires a non-empty edits array.");
  }
  const replacements: ExactTextReplacement[] = [];
  for (const [index, edit] of edits.entries()) {
    if (!isRecord(edit)) throw new Error(`edits[${index}] must be an object.`);
    const oldText = edit.oldText;
    const newText = edit.newText;
    if (typeof oldText !== "string" || oldText.length === 0) {
      throw new Error(`edits[${index}].oldText must be a non-empty string.`);
    }
    if (typeof newText !== "string") {
      throw new Error(`edits[${index}].newText must be a string.`);
    }
    const first = original.indexOf(oldText);
    if (first < 0) throw new Error(`edits[${index}].oldText was not found.`);
    if (original.indexOf(oldText, first + oldText.length) >= 0) {
      throw new Error(`edits[${index}].oldText must match exactly one location.`);
    }
    replacements.push({ index, oldText, newText, start: first, end: first + oldText.length });
  }

  const sorted = [...replacements].sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.end > current.start) {
      throw new Error(
        `edits[${current.index}] overlaps edits[${previous.index}]; exact text replacements must be non-overlapping regions from the original file.`,
      );
    }
  }

  let content = "";
  let cursor = 0;
  for (const replacement of sorted) {
    content += original.slice(cursor, replacement.start);
    content += replacement.newText;
    cursor = replacement.end;
  }
  content += original.slice(cursor);
  return {
    content,
    replacements: replacements.length,
    firstChangedLine: lineNumberAtOffset(original, sorted[0]?.start ?? 0),
  };
}

async function readSandboxFile(
  state: PiGraftSandboxState,
  path: string,
): Promise<{
  content: string;
  scratch: string;
  result: JsonRecord | undefined;
  execution: unknown;
}> {
  const { result, execution } = await runGraftJson(state.workspace, [
    "scratch",
    "read",
    ...sandboxSourceArgv(state),
    path,
    "--mode",
    "text",
  ]);
  const content = stringField(result, "content");
  if (content === undefined) {
    throw new Error(
      "Graft sandbox read supports UTF-8 text files only; binary, non-text, or oversized content is not supported by the sandbox read/edit replacement tools.",
    );
  }
  return {
    content,
    scratch: resultString(result, "scratch"),
    result,
    execution,
  };
}

function envelopeText(envelope: JsonRecord): string {
  return stringField(envelope, "message") ?? JSON.stringify(envelope, null, 2);
}

function resultOrEnvelopeString(
  envelope: JsonRecord,
  result: JsonRecord | undefined,
  fields: string[],
): string | undefined {
  for (const field of fields) {
    const fromResult = stringField(result, field);
    if (fromResult) return fromResult;
    const fromEnvelope = stringField(envelope, field);
    if (fromEnvelope) return fromEnvelope;
  }
  return undefined;
}

function materializePathFromMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return /(?:would write state into|into)\s+(.+)$/.exec(message)?.[1];
}

function commitFromPromotionMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return /\b(?:at|to)\s+([0-9a-f]{7,64})\b/i.exec(message)?.[1];
}

function promotionSummary(envelope: JsonRecord): {
  promotion: string | undefined;
  target: string | undefined;
  commit: string | undefined;
} {
  const promotions = envelope.promotions;
  const first = Array.isArray(promotions) && isRecord(promotions[0]) ? promotions[0] : undefined;
  const message = stringField(envelope, "message");
  return {
    promotion: stringField(first, "id"),
    target: stringField(first, "target"),
    commit:
      commitFromPromotionMessage(stringField(first, "status")) ??
      commitFromPromotionMessage(message),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardRegExp(pattern: string): RegExp {
  return new RegExp(`^${escapeRegExp(pattern).replaceAll("\\*", ".*")}$`);
}

function changedPathsFor(state: PiGraftSandboxState, path?: string): string[] {
  if (path) {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return state.changedPaths.filter(
      (changedPath) => changedPath === path || changedPath.startsWith(prefix),
    );
  }
  return state.changedPaths;
}

function commandTextFromToolCall(event: unknown): { toolName?: string; text: string } {
  if (!isRecord(event)) return { text: "" };
  const toolName = stringField(event, "toolName");
  const input = isRecord(event.input) ? event.input : isRecord(event.args) ? event.args : {};
  const parts: string[] = [];
  for (const field of ["command", "script", "path", "language"] as const) {
    const value = input[field];
    if (typeof value === "string") parts.push(value);
  }
  const argv = input.argv;
  if (Array.isArray(argv)) parts.push(argv.filter((item) => typeof item === "string").join(" "));
  return { toolName, text: parts.join("\n") };
}

function sandboxBypassReason(
  event: unknown,
  state: PiGraftSandboxState | undefined,
): string | undefined {
  if (!state?.guardrails.blockShellFileIo) return undefined;
  const { toolName, text } = commandTextFromToolCall(event);
  if (!toolName || !text.trim()) return undefined;
  if (
    !["bash", "cue_exec", "cue_run", "cue_script", "script_run", "script_eval"].includes(toolName)
  ) {
    return undefined;
  }
  const patterns: RegExp[] = [
    /(^|\s)(cat|sed|awk|grep|find|ls|head|tail|less|more)\b/,
    /(^|\s)(rm|cp|mv|touch|mkdir|rmdir|chmod|chown|tee)\b/,
    /(^|\s)(python3?|node|ruby|perl)\b[\s\S]*(open\(|writeFile|readFile|fs\.|Path\()/,
    /(^|[^0-9])>>?\s*[^&\s]/,
  ];
  if (!patterns.some((pattern) => pattern.test(text))) return undefined;
  return [
    `Graft sandbox blocked ${toolName}: obvious file I/O bypass detected.`,
    "Use sandbox read/write/edit/grep/find/ls for file access, or checkpoint/materialize/promote for lifecycle operations.",
    "Validation commands without direct file I/O (for example test runners) remain allowed.",
  ].join(" ");
}

export function registerPiGraftSandboxExtension(pi: PiGraftExtensionApi): void {
  registerPiGraftExtension(pi);

  let sandboxState: PiGraftSandboxState | undefined;
  let lastCwd: string | undefined;

  pi.on("session_start", (_event: unknown, ctx: PiGraftSessionContext) => {
    lastCwd = ctx.cwd;
    sandboxState = restoreSandboxState(ctx);
  });

  pi.on("tool_call", (event: unknown) => {
    const reason = sandboxBypassReason(event, sandboxState);
    return reason ? { block: true, reason } : undefined;
  });

  pi.registerTool({
    name: "read",
    label: "Read (Graft Sandbox)",
    description:
      "Read a UTF-8 file from the active Graft sandbox scratch/base. Does not read the working tree.",
    promptSnippet:
      "Read a UTF-8 file from the active Graft sandbox scratch/base; never reads the working tree.",
    promptGuidelines: SANDBOX_FILE_PROMPT_GUIDELINES,
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path inside the sandbox virtual repo tree." }),
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
    ) {
      const state = requireSandboxState(sandboxState);
      const path = sandboxPath(params.path);
      const read = await readSandboxFile(state, path);
      sandboxState = updateSandboxState(pi, state, { lastScratch: read.scratch });
      const rendered = renderTextSlice(read.content, params.offset, params.limit);
      return {
        content: [{ type: "text", text: rendered.text }],
        details: {
          truncation: undefined,
          sandbox: true,
          operation: "read",
          path,
          source: sandboxSourceLabel(state),
          state: sandboxState,
          result: read.result,
          execution: read.execution,
          nextOffset: rendered.nextOffset,
        },
      };
    },
  });

  pi.registerTool({
    name: "write",
    label: "Write (Graft Sandbox)",
    description:
      "Write a complete UTF-8 file into the active Graft sandbox scratch. Does not write the working tree.",
    promptSnippet:
      "Write a complete UTF-8 file into the active Graft sandbox scratch; never writes the working tree.",
    promptGuidelines: SANDBOX_FILE_PROMPT_GUIDELINES,
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path inside the sandbox virtual repo tree." }),
      content: Type.String({ description: "Complete UTF-8 file content." }),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
    ) {
      const state = requireSandboxState(sandboxState);
      const path = sandboxPath(params.path);
      const content = typeof params.content === "string" ? params.content : undefined;
      if (content === undefined) throw new Error("write requires content.");
      const { result, execution } = await runGraftJson(
        state.workspace,
        ["scratch", "write", ...sandboxSourceArgv(state), path, "--content-stdin"],
        { stdin: content },
      );
      const scratch = resultString(result, "scratch");
      sandboxState = updateSandboxState(pi, state, {
        lastScratch: scratch,
        changedPaths: resultStringArray(result, "changed_paths").length
          ? resultStringArray(result, "changed_paths")
          : [path],
      });
      return {
        content: [
          {
            type: "text",
            text: `Wrote ${path} into Graft sandbox scratch ${scratch}. Working tree was not modified.`,
          },
        ],
        details: {
          sandbox: true,
          operation: "write",
          path,
          state: sandboxState,
          result,
          execution,
        },
      };
    },
  });

  pi.registerTool({
    name: "edit",
    label: "Edit (Graft Sandbox)",
    description:
      "Apply exact text replacements to a UTF-8 file in the active Graft sandbox scratch. Does not edit the working tree.",
    promptSnippet:
      "Edit UTF-8 files in the active Graft sandbox scratch with exact replacements; never edits the working tree.",
    promptGuidelines: SANDBOX_FILE_PROMPT_GUIDELINES,
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path inside the sandbox virtual repo tree." }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text to replace; must match once." }),
          newText: Type.String({ description: "Replacement text." }),
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
    ) {
      const state = requireSandboxState(sandboxState);
      const path = sandboxPath(params.path);
      const read = await readSandboxFile(state, path);
      const applied = applyExactTextEdits(read.content, params.edits);
      const { result, execution } = await runGraftJson(
        state.workspace,
        ["scratch", "write", "--from", read.scratch, path, "--content-stdin"],
        { stdin: applied.content },
      );
      const scratch = resultString(result, "scratch");
      sandboxState = updateSandboxState(pi, state, {
        lastScratch: scratch,
        changedPaths: resultStringArray(result, "changed_paths").length
          ? resultStringArray(result, "changed_paths")
          : [path],
      });
      const diff = simpleUnifiedDiff(path, read.content, applied.content);
      return {
        content: [
          {
            type: "text",
            text: `Edited ${path} in Graft sandbox scratch ${scratch} (${applied.replacements} replacement${applied.replacements === 1 ? "" : "s"}). Working tree was not modified.`,
          },
        ],
        details: {
          sandbox: true,
          operation: "edit",
          path,
          diff,
          patch: diff,
          firstChangedLine: applied.firstChangedLine,
          replacements: applied.replacements,
          state: sandboxState,
          read: read.result,
          result,
          execution,
        },
      };
    },
  });

  pi.registerTool({
    name: "grep",
    label: "Grep (Graft Sandbox)",
    description:
      "Search UTF-8 text in active sandbox changed paths or an explicit sandbox path. V1 does not scan untouched base files.",
    promptSnippet:
      "Search UTF-8 text in explicit sandbox paths or known changed sandbox paths; does not scan the working tree.",
    promptGuidelines: SANDBOX_FILE_PROMPT_GUIDELINES,
    parameters: Type.Object({
      pattern: Type.String({ description: "Regex or literal pattern to search for." }),
      path: Type.Optional(Type.String({ description: "Optional explicit sandbox file/path." })),
      glob: Type.Optional(
        Type.String({ description: "Optional wildcard filter for changed paths." }),
      ),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text." })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
      context: Type.Optional(Type.Number({ description: "Context lines around matches." })),
      limit: Type.Optional(Type.Number({ description: "Maximum matching lines." })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const state = requireSandboxState(sandboxState);
      const pattern = optionalStringParam(params, "pattern");
      if (!pattern) throw new Error("grep requires pattern.");
      const basePath = optionalSandboxPath(params, "path");
      const glob = optionalStringParam(params, "glob");
      const globRegex = glob ? wildcardRegExp(glob) : undefined;
      const paths = (basePath ? [basePath] : changedPathsFor(state)).filter(
        (path) =>
          !globRegex || globRegex.test(path) || globRegex.test(path.split("/").at(-1) ?? path),
      );
      if (paths.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Sandbox grep v1 searches known changed paths only; no changed paths are currently tracked. Use read for a known path or checkpoint/materialize for broader inspection.",
            },
          ],
          details: { sandbox: true, searchedPaths: [] },
        };
      }
      const flags = optionalBooleanParam(params, "ignoreCase", false) ? "i" : "";
      const regex = new RegExp(
        optionalBooleanParam(params, "literal", false) ? escapeRegExp(pattern) : pattern,
        flags,
      );
      const max = positiveIntegerParam(params.limit, "limit") ?? 100;
      const matches: string[] = [];
      const searchedPaths: string[] = [];
      for (const path of paths) {
        if (matches.length >= max) break;
        searchedPaths.push(path);
        const read = await readSandboxFile(state, path);
        const lines = read.content.endsWith("\n")
          ? read.content.slice(0, -1).split("\n")
          : read.content.split("\n");
        for (const [index, line] of lines.entries()) {
          if (regex.test(line)) matches.push(`${path}:${index + 1}:${line}`);
          if (matches.length >= max) break;
        }
      }
      return {
        content: [
          {
            type: "text",
            text:
              matches.join("\n") ||
              "No matches in sandbox changed paths. Note: grep v1 does not scan untouched base files.",
          },
        ],
        details: {
          sandbox: true,
          searchedPaths,
          matchCount: matches.length,
          matchLimitReached: matches.length >= max ? max : undefined,
          linesTruncated: false,
        },
      };
    },
  });

  pi.registerTool({
    name: "find",
    label: "Find (Graft Sandbox)",
    description:
      "Find known changed sandbox paths. V1 lists changed paths tracked by sandbox write/edit rather than the entire base tree.",
    promptSnippet:
      "Find known changed sandbox paths by wildcard; does not traverse the working tree or untouched base tree.",
    promptGuidelines: SANDBOX_FILE_PROMPT_GUIDELINES,
    parameters: Type.Object({
      pattern: Type.Optional(Type.String({ description: "Optional wildcard pattern, e.g. *.ts." })),
      path: Type.Optional(Type.String({ description: "Optional sandbox directory/path prefix." })),
      limit: Type.Optional(Type.Number({ description: "Maximum paths to show." })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const state = requireSandboxState(sandboxState);
      const basePath = optionalSandboxPath(params, "path");
      const pattern = optionalStringParam(params, "pattern");
      const regex = pattern ? wildcardRegExp(pattern) : undefined;
      const max = positiveIntegerParam(params.limit, "limit") ?? 200;
      const matchingPaths = changedPathsFor(state, basePath).filter(
        (path) => !regex || regex.test(path) || regex.test(path.split("/").at(-1) ?? path),
      );
      const paths = matchingPaths.slice(0, max);
      return {
        content: [
          {
            type: "text",
            text:
              paths.join("\n") ||
              "No known changed paths. Sandbox find v1 lists changed paths only; use materialize for full-tree inspection.",
          },
        ],
        details: {
          sandbox: true,
          path: basePath,
          pattern,
          count: paths.length,
          resultLimitReached: matchingPaths.length > max ? max : undefined,
        },
      };
    },
  });

  pi.registerTool({
    name: "ls",
    label: "List (Graft Sandbox)",
    description:
      "List known changed entries under a sandbox path. V1 does not list untouched base-tree entries.",
    promptSnippet:
      "List known changed sandbox entries under a path; does not list working-tree or untouched base-tree entries.",
    promptGuidelines: SANDBOX_FILE_PROMPT_GUIDELINES,
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Sandbox directory/path prefix; defaults to root." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum entries to show." })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const state = requireSandboxState(sandboxState);
      const basePath = optionalSandboxPath(params, "path");
      const prefix = basePath ? (basePath.endsWith("/") ? basePath : `${basePath}/`) : "";
      const entries = new Set<string>();
      for (const changedPath of changedPathsFor(state, basePath)) {
        const rest = prefix ? changedPath.slice(prefix.length) : changedPath;
        const [head, ...tail] = rest.split("/");
        if (head) entries.add(tail.length ? `${head}/` : head);
      }
      const max = positiveIntegerParam(params.limit, "limit") ?? 500;
      const allEntries = [...entries].sort();
      const rendered = allEntries.slice(0, max);
      return {
        content: [
          {
            type: "text",
            text:
              rendered.join("\n") ||
              "No known changed entries. Sandbox ls v1 lists changed paths only; use materialize for full-tree inspection.",
          },
        ],
        details: {
          sandbox: true,
          path: basePath,
          count: rendered.length,
          entryLimitReached: allEntries.length > max ? max : undefined,
        },
      };
    },
  });

  pi.registerTool({
    name: "graft_sandbox_enter",
    label: "Graft Sandbox Enter",
    description:
      "Enter explicit Graft sandbox mode: create or reuse a non-Git Graft workspace, attach a repo base, and make future sandbox file operations use Graft scratch state.",
    executionMode: "sequential",
    parameters: Type.Object({
      repo: Type.Optional(
        Type.String({ description: "Repository path; defaults to the current tool cwd." }),
      ),
      base: Type.Optional(Type.String({ description: "Repo base ref; defaults to HEAD." })),
      workspace: Type.Optional(
        Type.String({ description: "Non-Git Graft workspace path; defaults to a temp sandbox." }),
      ),
      name: Type.Optional(
        Type.String({ description: "Human/session label for default workspace." }),
      ),
      blockShellFileIo: Type.Optional(
        Type.Boolean({
          description: "Block obvious shell/cue file I/O bypasses; defaults to true.",
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
      const cwd = ctx?.cwd ?? lastCwd ?? process.cwd();
      const repoRoot = resolve(cwd, optionalStringParam(params, "repo") ?? ".");
      const baseName = optionalStringParam(params, "base") ?? "HEAD";
      const repoId = DEFAULT_REPO_ID;
      const workspace = resolve(
        cwd,
        optionalStringParam(params, "workspace") ??
          defaultSandboxWorkspace(repoRoot, optionalStringParam(params, "name")),
      );
      await mkdir(workspace, { recursive: true });

      const init = await runGraftJson(workspace, ["init"]);
      await runGraftJson(workspace, [
        "repo",
        "add",
        "--default-branch",
        baseName,
        repoId,
        repoRoot,
      ]);
      await runGraftJson(workspace, ["repo", "lock", repoId]);

      const now = new Date().toISOString();
      sandboxState = {
        active: true,
        repoRoot,
        repoId,
        workspace,
        workspaceId: workspaceIdFromEnvelope(init.envelope),
        base: `repo:${repoId}@${baseName}`,
        changedPaths: [],
        guardrails: {
          blockShellFileIo: optionalBooleanParam(params, "blockShellFileIo", true),
          allowValidationCommands: true,
        },
        createdAt: sandboxState?.createdAt ?? now,
        updatedAt: now,
      };
      registerSandboxState(pi, sandboxState);
      lastCwd = cwd;
      return {
        content: [{ type: "text", text: sandboxSummary(sandboxState) }],
        details: {
          sandbox: true,
          state: sandboxState,
          execution: {
            init: init.execution,
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "graft_sandbox_status",
    label: "Graft Sandbox Status",
    description: "Show explicit Graft sandbox mode state and safety boundary status.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: sandboxSummary(sandboxState) }],
        details: { sandbox: Boolean(sandboxState), state: sandboxState },
      };
    },
  });

  pi.registerTool({
    name: "graft_sandbox_exit",
    label: "Graft Sandbox Exit",
    description:
      "Clear explicit Graft sandbox session state and report retained refs. V1 does not restore original built-in tools until the sandbox entrypoint is unloaded/reloaded.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute() {
      const previous = sandboxState;
      sandboxState = undefined;
      registerSandboxState(pi, undefined);
      return {
        content: [
          {
            type: "text",
            text: previous
              ? `Exited Graft sandbox. Retained refs: scratch=${previous.lastScratch ?? "none"}, candidate=${previous.lastCandidate ?? "none"}, patch=${previous.lastPatch ?? "none"}. Restart or reload without the sandbox entrypoint for ordinary built-in file tools.`
              : "Graft sandbox was already inactive.",
          },
        ],
        details: { sandbox: false, previousState: previous },
      };
    },
  });

  pi.registerTool({
    name: "graft_sandbox_checkpoint",
    label: "Graft Sandbox Checkpoint",
    description:
      "Turn the current sandbox scratch into a candidate, run validation, and optionally admit a patch. Does not materialize or promote.",
    executionMode: "sequential",
    parameters: Type.Object({
      expected: Type.Optional(
        Type.Array(Type.String({ description: "Validation expectation to attach/check." })),
      ),
      required: Type.Optional(
        Type.Array(Type.String({ description: "Required passing evidence for admit." })),
      ),
      admit: Type.Optional(
        Type.Boolean({
          description: "Admit the validated candidate as a patch; defaults to false.",
        }),
      ),
      producer: Type.Optional(Type.String({ description: "Candidate provenance producer." })),
      message: Type.Optional(Type.String({ description: "Candidate message." })),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
    ) {
      const state = requireSandboxState(sandboxState);
      const scratch = state.lastScratch;
      if (!scratch) {
        throw new Error(
          "graft_sandbox_checkpoint requires a sandbox scratch from read/write/edit.",
        );
      }
      const expected = stringListParam(params, "expected");
      const required = stringListParam(params, "required");
      const candidateArgv = ["candidate", "from-scratch", scratch];
      for (const item of expected) candidateArgv.push("--expect", item);
      candidateArgv.push(
        "--producer",
        optionalStringParam(params, "producer") ?? "@zendev-lab/pi-graft-sandbox",
      );
      const message = optionalStringParam(params, "message");
      if (message) candidateArgv.push("--message", message);
      const candidateRun = await runGraftJson(state.workspace, candidateArgv);
      const candidate = resultOrEnvelopeString(candidateRun.envelope, candidateRun.result, [
        "candidate",
        "candidate_id",
      ]);
      if (!candidate) throw new Error("graft sandbox checkpoint did not return a candidate id.");

      sandboxState = updateSandboxState(pi, state, {
        lastScratch:
          resultOrEnvelopeString(candidateRun.envelope, candidateRun.result, ["scratch"]) ??
          scratch,
        lastCandidate: candidate,
        changedPaths: resultStringArray(candidateRun.result, "changed_paths"),
      });

      const validateArgv = ["validate", candidate];
      for (const item of expected) validateArgv.push("--expect", item);
      const validateRun = await runGraftJson(state.workspace, validateArgv);

      let admitRun: Awaited<ReturnType<typeof runGraftJson>> | undefined;
      let patch: string | undefined;
      if (optionalBooleanParam(params, "admit", false)) {
        const admitArgv = ["admit", candidate];
        for (const item of required.length ? required : expected) admitArgv.push("--require", item);
        admitRun = await runGraftJson(state.workspace, admitArgv);
        patch = resultOrEnvelopeString(admitRun.envelope, admitRun.result, ["patch", "patch_id"]);
        if (!patch) throw new Error("graft sandbox checkpoint admit did not return a patch id.");
        sandboxState = updateSandboxState(pi, sandboxState, { lastPatch: patch });
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `Checkpointed sandbox scratch ${scratch} as candidate ${candidate}.`,
              `Validation: ${envelopeText(validateRun.envelope)}`,
              patch
                ? `Admitted patch: ${patch}.`
                : "Admit skipped; pass admit:true to create a patch.",
            ].join("\n"),
          },
        ],
        details: {
          sandbox: true,
          state: sandboxState,
          candidate: candidateRun,
          validation: validateRun,
          admit: admitRun,
        },
      };
    },
  });

  pi.registerTool({
    name: "graft_sandbox_materialize",
    label: "Graft Sandbox Materialize",
    description:
      "Plan or materialize the current sandbox patch into an isolated inspection state. Defaults to dry-run and never promotes.",
    executionMode: "sequential",
    parameters: Type.Object({
      patch: Type.Optional(
        Type.String({ description: "Patch id; defaults to sandbox lastPatch." }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "Plan without writing; defaults to true. Use false explicitly to create the inspection directory.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
    ) {
      const state = requireSandboxState(sandboxState);
      const patch = optionalStringParam(params, "patch") ?? state.lastPatch;
      if (!patch)
        throw new Error("graft_sandbox_materialize requires patch or a sandbox lastPatch.");
      const dryRun = optionalBooleanParam(params, "dryRun", true);
      const argv = ["materialize", patch];
      if (dryRun) argv.push("--dry-run");
      const materializeRun = await runGraftJson(state.workspace, argv);
      const message = envelopeText(materializeRun.envelope);
      const path = materializePathFromMessage(message);
      if (!dryRun && path) {
        sandboxState = updateSandboxState(pi, state, { lastMaterializedPath: path });
      }
      return {
        content: [
          {
            type: "text",
            text: dryRun
              ? `${message}\nDRY RUN: no directory was created. Pass dryRun:false to create the isolated inspection directory.`
              : `${message}\nMaterialized inspection directory: ${path ?? "unknown"}.`,
          },
        ],
        details: {
          sandbox: true,
          dryRun,
          patch,
          plannedPath: path,
          state: sandboxState,
          materialize: materializeRun,
        },
      };
    },
  });

  pi.registerTool({
    name: "graft_sandbox_promote",
    label: "Graft Sandbox Promote",
    description:
      "Explicitly promote a sandbox patch to a Git branch/target. Defaults to dry-run; apply:true adds the --yes side-effect gate.",
    executionMode: "sequential",
    parameters: Type.Object({
      patch: Type.Optional(
        Type.String({ description: "Patch id; defaults to sandbox lastPatch." }),
      ),
      to: Type.String({ description: "Target branch or configured promote target." }),
      branch: Type.Optional(
        Type.String({ description: "Branch/ref when --to names a configured promote target." }),
      ),
      apply: Type.Optional(
        Type.Boolean({
          description: "Actually update the target by adding --yes; defaults to false.",
        }),
      ),
      required: Type.Optional(
        Type.Array(Type.String({ description: "Required passing evidence before promotion." })),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
    ) {
      const state = requireSandboxState(sandboxState);
      const patch = optionalStringParam(params, "patch") ?? state.lastPatch;
      if (!patch) throw new Error("graft_sandbox_promote requires patch or a sandbox lastPatch.");
      const to = optionalStringParam(params, "to");
      if (!to) throw new Error("graft_sandbox_promote requires to.");
      const apply = optionalBooleanParam(params, "apply", false);
      const argv = ["patch", "promote", patch, "--to", to];
      const branch = optionalStringParam(params, "branch");
      if (branch) argv.push("--branch", branch);
      for (const item of stringListParam(params, "required")) argv.push("--require", item);
      if (apply) argv.push("--yes");
      const promoteRun = await runGraftJson(state.workspace, argv);
      const promotion = promotionSummary(promoteRun.envelope);
      if (apply) {
        sandboxState = updateSandboxState(pi, state, {
          lastPromotion: {
            ...(promotion.target ? { branch: promotion.target } : { branch: to }),
            ...(promotion.commit ? { commit: promotion.commit } : {}),
            ...(promotion.promotion ? { promotion: promotion.promotion } : {}),
          },
        });
      }
      const message = envelopeText(promoteRun.envelope);
      return {
        content: [
          {
            type: "text",
            text: apply
              ? `${message}\nPromotion applied explicitly with apply:true.`
              : `${message}\nDRY RUN: no Git refs were updated. Pass apply:true to add --yes and update the target explicitly.`,
          },
        ],
        details: { sandbox: true, apply, patch, to, state: sandboxState, promote: promoteRun },
      };
    },
  });
}

export default function piGraftSandboxExtension(pi: PiGraftExtensionApi): void {
  registerPiGraftSandboxExtension(pi);
}
