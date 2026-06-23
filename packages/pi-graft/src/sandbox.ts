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
import {
  GraftCliError,
  runGraftJson,
  type DirectGraftExecution,
  type JsonRecord,
} from "./graft-client.ts";

const SANDBOX_STATE_ENTRY = "pi-graft-sandbox-state";
const DEFAULT_REPO_ID = "sandbox";
const SANDBOX_FILE_PROMPT_GUIDELINES = [
  "Sandbox read/write/edit/grep/find/ls operate on the active Graft scratch/base, never directly on the working tree.",
  "Run graft_sandbox_enter before sandbox file access; use graft_sandbox_checkpoint/materialize/promote for lifecycle transitions.",
  "Do not bypass the sandbox with shell/script file I/O; validation commands without direct file access remain allowed.",
  "Sandbox grep/find/ls prefer the Graft-native tree backend when available and fall back to temporary materialized base state plus tracked scratch changes; they never read the Git working tree directly.",
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

const SANDBOX_PROFILE_RELOAD_GUIDANCE =
  "Sandbox profile caveat: file-tool names read/write/edit/grep/find/ls remain sandbox overrides until Pi reloads without @zendev-lab/pi-graft/sandbox; graft_sandbox_exit only clears sandbox state.";

function sandboxProfileDetails(): Record<string, unknown> {
  return {
    treeBackendPreference: sandboxTreeBackendPreference(),
    sandboxOverridesRemainRegistered: true,
    restoreBuiltInsBy: "reload_without_sandbox_entrypoint",
    reloadGuidance:
      "Reload or restart Pi without @zendev-lab/pi-graft/sandbox, and do not use --no-builtin-tools if ordinary Pi built-ins should be available.",
  };
}

function sandboxSummary(state: PiGraftSandboxState | undefined): string {
  if (!state) {
    return [
      "GRAFT SANDBOX INACTIVE",
      "Sandbox state is inactive, but this loaded sandbox profile still owns file-tool override names.",
      "Run graft_sandbox_enter before using sandbox-backed file tools in this profile.",
      SANDBOX_PROFILE_RELOAD_GUIDANCE,
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
    `treeBackendPreference: ${sandboxTreeBackendPreference()}`,
    `candidate: ${state.lastCandidate ?? "none"}`,
    `patch: ${state.lastPatch ?? "none"}`,
    `materializedPath: ${state.lastMaterializedPath ?? "none"}`,
    `promotionCommit: ${state.lastPromotion?.commit ?? "none"}`,
    "writes: Graft scratch only; working tree is not modified",
    SANDBOX_PROFILE_RELOAD_GUIDANCE,
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

const NATIVE_TREE_BACKEND = "native_tree";
const MATERIALIZED_TREE_BACKEND = "materialized_run_overlay";

type SandboxTreeBackend = typeof NATIVE_TREE_BACKEND | typeof MATERIALIZED_TREE_BACKEND;
type SandboxTreeBackendPreference = "auto" | "native" | "materialized";

interface SandboxBasePathCache {
  key: string;
  paths: string[];
  execution?: unknown;
}

interface SandboxVisiblePaths {
  paths: string[];
  backend: SandboxTreeBackend;
  attemptedBackend?: SandboxTreeBackend;
  fallbackReason?: string;
  basePathCount?: number;
  changedPathCount?: number;
  cacheHit?: boolean;
  execution?: unknown;
}

let sandboxBasePathCache: SandboxBasePathCache | undefined;

function sandboxTreeBackendPreference(): SandboxTreeBackendPreference {
  const raw = process.env.PI_GRAFT_SANDBOX_TREE_BACKEND?.trim().toLowerCase();
  if (raw === "native" || raw === "materialized" || raw === "auto") return raw;
  return "auto";
}

function sandboxTreeSourceArgv(state: PiGraftSandboxState): string[] {
  return state.lastScratch ? ["--from", state.lastScratch] : ["--base", state.base];
}

function sandboxTreeCacheKey(state: PiGraftSandboxState): string {
  return [
    state.workspace,
    state.workspaceId ?? "",
    state.base,
    state.resolvedBase ?? "",
    state.lastScratch ?? "",
    ...state.changedPaths,
  ].join("\0");
}

function runViewData(envelope: JsonRecord): Record<string, unknown> | undefined {
  const view = envelope.view;
  if (!isRecord(view) || view.type !== "run" || !isRecord(view.data)) return undefined;
  return view.data;
}

function runViewStdout(envelope: JsonRecord, context: string): string {
  const view = runViewData(envelope);
  if (!view) throw new Error(`${context} did not return a run view.`);
  const exitCode = typeof view.exit_code === "number" ? view.exit_code : 0;
  if (exitCode !== 0) {
    const stderr = typeof view.stderr === "string" ? view.stderr.trim() : "";
    throw new Error(`${context} exited ${exitCode}${stderr ? `: ${stderr}` : ""}`);
  }
  return typeof view.stdout === "string" ? view.stdout : "";
}

function parseFindPaths(stdout: string): string[] {
  return uniqueStrings(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^\.\//, ""))
      .filter((line) => line.length > 0)
      .map((line) => sandboxPath(line, "inspection path")),
  ).sort((left, right) => left.localeCompare(right));
}

async function sandboxBasePaths(state: PiGraftSandboxState): Promise<{
  paths: string[];
  cacheHit: boolean;
  execution?: unknown;
}> {
  const key = sandboxTreeCacheKey(state);
  if (sandboxBasePathCache?.key === key) {
    return {
      paths: sandboxBasePathCache.paths,
      cacheHit: true,
      execution: sandboxBasePathCache.execution,
    };
  }
  const run = await runGraftJson(state.workspace, [
    "run",
    "--cwd",
    ".",
    state.base,
    "--",
    "find",
    ".",
    "-type",
    "f",
  ]);
  const paths = parseFindPaths(runViewStdout(run.envelope, "sandbox full-tree find"));
  sandboxBasePathCache = { key, paths, execution: run.execution };
  return { paths, cacheHit: false, execution: run.execution };
}

function pathMatchesSandboxQuery(path: string, basePath?: string, globRegex?: RegExp): boolean {
  if (basePath) {
    const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
    if (path !== basePath && !path.startsWith(prefix)) return false;
  }
  return !globRegex || globRegex.test(path) || globRegex.test(path.split("/").at(-1) ?? path);
}

function nativeTreeUnavailableReason(error: unknown): string | undefined {
  if (!(error instanceof GraftCliError)) return undefined;
  const text = `${error.stdout}\n${error.stderr}\n${error.message}`;
  if (
    /unrecognized subcommand|invalid subcommand|unknown command|no such subcommand/iu.test(text)
  ) {
    return (
      text
        .split("\n")
        .find((line) => /tree|subcommand|command/iu.test(line))
        ?.trim() || "native tree command is unavailable"
    );
  }
  return undefined;
}

function treeEntryPaths(result: JsonRecord | undefined): string[] {
  const entries = result?.entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => stringField(entry, "path"))
    .filter((path): path is string => Boolean(path))
    .map((path) => sandboxPath(path, "tree entry path"));
}

async function sandboxNativeVisiblePaths(
  state: PiGraftSandboxState,
  options: { basePath?: string; globRegex?: RegExp } = {},
): Promise<SandboxVisiblePaths> {
  const argv = ["tree", "list", ...sandboxTreeSourceArgv(state)];
  if (options.basePath) argv.push("--path", options.basePath);
  const run = await runGraftJson(state.workspace, argv);
  return {
    paths: uniqueStrings(treeEntryPaths(run.result))
      .filter((path) => pathMatchesSandboxQuery(path, options.basePath, options.globRegex))
      .sort((left, right) => left.localeCompare(right)),
    backend: NATIVE_TREE_BACKEND,
    execution: run.execution,
  };
}

async function sandboxMaterializedVisiblePaths(
  state: PiGraftSandboxState,
  options: { basePath?: string; globRegex?: RegExp } = {},
  fallback?: { attemptedBackend: SandboxTreeBackend; fallbackReason: string },
): Promise<SandboxVisiblePaths> {
  const base = await sandboxBasePaths(state);
  const changedPaths = state.changedPaths;
  const visible = uniqueStrings([...base.paths, ...changedPaths])
    .filter((path) => pathMatchesSandboxQuery(path, options.basePath, options.globRegex))
    .sort((left, right) => left.localeCompare(right));
  return {
    paths: visible,
    backend: MATERIALIZED_TREE_BACKEND,
    attemptedBackend: fallback?.attemptedBackend,
    fallbackReason: fallback?.fallbackReason,
    basePathCount: base.paths.length,
    changedPathCount: changedPaths.length,
    cacheHit: base.cacheHit,
    execution: base.execution,
  };
}

async function sandboxVisiblePaths(
  state: PiGraftSandboxState,
  options: { basePath?: string; glob?: string; globRegex?: RegExp } = {},
): Promise<SandboxVisiblePaths> {
  const preference = sandboxTreeBackendPreference();
  if (preference === "materialized") return sandboxMaterializedVisiblePaths(state, options);
  try {
    return await sandboxNativeVisiblePaths(state, options);
  } catch (error) {
    const fallbackReason = nativeTreeUnavailableReason(error);
    if (preference === "native" || !fallbackReason) throw error;
    return sandboxMaterializedVisiblePaths(state, options, {
      attemptedBackend: NATIVE_TREE_BACKEND,
      fallbackReason,
    });
  }
}

async function readSandboxBaseTextFile(state: PiGraftSandboxState, path: string): Promise<string> {
  const run = await runGraftJson(state.workspace, [
    "run",
    "--cwd",
    ".",
    state.base,
    "--",
    "cat",
    `./${path}`,
  ]);
  return runViewStdout(run.envelope, `sandbox base read ${path}`);
}

function numberField(value: unknown, field: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? fieldValue : undefined;
}

function booleanField(value: unknown, field: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  return typeof fieldValue === "boolean" ? fieldValue : undefined;
}

interface SandboxNativeGrepResult {
  matches: string[];
  searchedPaths: string[];
  skippedBinaryPaths: string[];
  totalMatches: number;
  truncated: boolean;
  execution: DirectGraftExecution;
}

function nativeGrepMatches(result: JsonRecord | undefined): string[] {
  const matches = result?.matches;
  if (!Array.isArray(matches)) return [];
  return matches
    .map((match) => {
      const path = stringField(match, "path");
      const line = numberField(match, "line");
      const text = stringField(match, "text");
      return path && line
        ? `${sandboxPath(path, "tree match path")}:${line}:${text ?? ""}`
        : undefined;
    })
    .filter((match): match is string => Boolean(match));
}

function nativeGrepSearchedPaths(result: JsonRecord | undefined): string[] {
  const matches = result?.matches;
  if (!Array.isArray(matches)) return [];
  return uniqueStrings(
    matches
      .map((match) => stringField(match, "path"))
      .filter((path): path is string => Boolean(path))
      .map((path) => sandboxPath(path, "tree match path")),
  );
}

function stringArrayField(value: unknown, field: string): string[] {
  if (!isRecord(value)) return [];
  const fieldValue = value[field];
  if (!Array.isArray(fieldValue)) return [];
  return fieldValue.filter((item): item is string => typeof item === "string");
}

function safeTreeMetadata(value: JsonRecord | undefined): JsonRecord {
  const metadata: JsonRecord = {};
  for (const field of ["path", "kind", "hash", "mime", "source_ref"] as const) {
    const item = stringField(value, field);
    if (item !== undefined) metadata[field] = item;
  }
  for (const field of ["size", "line_count", "child_count"] as const) {
    const item = numberField(value, field);
    if (item !== undefined) metadata[field] = item;
  }
  const isUtf8 = booleanField(value, "is_utf8_text");
  if (isUtf8 !== undefined) metadata.is_utf8_text = isUtf8;
  const source = isRecord(value?.source) ? value.source : undefined;
  if (source) {
    const safeSource: JsonRecord = {};
    for (const field of ["kind", "base", "scratch", "resolved_state"] as const) {
      const item = stringField(source, field);
      if (item !== undefined) safeSource[field] = item;
    }
    if (Object.keys(safeSource).length > 0) metadata.source = safeSource;
  }
  return metadata;
}

async function sandboxNativeMetadata(
  state: PiGraftSandboxState,
  path: string,
): Promise<{ metadata: JsonRecord; backend: SandboxTreeBackend; execution: unknown }> {
  const run = await runGraftJson(state.workspace, [
    "tree",
    "metadata",
    ...sandboxTreeSourceArgv(state),
    path,
  ]);
  return {
    metadata: safeTreeMetadata(run.result),
    backend: NATIVE_TREE_BACKEND,
    execution: run.execution,
  };
}

async function sandboxMaterializedMetadata(
  state: PiGraftSandboxState,
  path: string,
  fallback?: { attemptedBackend: SandboxTreeBackend; fallbackReason: string },
): Promise<{
  metadata: JsonRecord;
  backend: SandboxTreeBackend;
  attemptedBackend?: SandboxTreeBackend;
  fallbackReason?: string;
  execution?: unknown;
}> {
  const visible = await sandboxMaterializedVisiblePaths(state, {}, fallback);
  const prefix = `${path}/`;
  const isFile = visible.paths.includes(path);
  const childCount = visible.paths.filter((item) => item.startsWith(prefix)).length;
  if (!isFile && childCount === 0) throw new Error(`sandbox path not found: ${path}`);
  const metadata: JsonRecord = {
    path,
    kind: isFile ? "file" : "directory",
  };
  if (!isFile) metadata.child_count = childCount;
  return {
    metadata,
    backend: MATERIALIZED_TREE_BACKEND,
    attemptedBackend: fallback?.attemptedBackend,
    fallbackReason: fallback?.fallbackReason,
    execution: visible.execution,
  };
}

async function sandboxFileMetadata(
  state: PiGraftSandboxState,
  path: string,
): Promise<{
  metadata: JsonRecord;
  backend: SandboxTreeBackend;
  attemptedBackend?: SandboxTreeBackend;
  fallbackReason?: string;
  execution?: unknown;
}> {
  const preference = sandboxTreeBackendPreference();
  if (preference === "materialized") return sandboxMaterializedMetadata(state, path);
  try {
    return await sandboxNativeMetadata(state, path);
  } catch (error) {
    const fallbackReason = nativeTreeUnavailableReason(error);
    if (preference === "native" || !fallbackReason) throw error;
    return sandboxMaterializedMetadata(state, path, {
      attemptedBackend: NATIVE_TREE_BACKEND,
      fallbackReason,
    });
  }
}

function metadataSummary(metadata: JsonRecord): string {
  const path = stringField(metadata, "path") ?? "unknown";
  const kind = stringField(metadata, "kind") ?? "unknown";
  const size = numberField(metadata, "size");
  const isUtf8 = booleanField(metadata, "is_utf8_text");
  return [
    `path: ${path}`,
    `kind: ${kind}`,
    ...(size === undefined ? [] : [`size: ${size}`]),
    ...(isUtf8 === undefined ? [] : [`isUtf8Text: ${isUtf8}`]),
  ].join("\n");
}

async function sandboxNativeGrep(
  state: PiGraftSandboxState,
  options: { pattern: string; basePath?: string; glob?: string; limit: number },
): Promise<SandboxNativeGrepResult> {
  const argv = ["tree", "grep", ...sandboxTreeSourceArgv(state), options.pattern];
  if (options.basePath) argv.push("--path", options.basePath);
  if (options.glob) argv.push("--glob", options.glob);
  argv.push("--limit", String(options.limit));
  const run = await runGraftJson(state.workspace, argv);
  const matches = nativeGrepMatches(run.result);
  return {
    matches,
    searchedPaths: nativeGrepSearchedPaths(run.result),
    skippedBinaryPaths: stringArrayField(run.result, "skipped_binary_paths"),
    totalMatches: numberField(run.result, "total_matches") ?? matches.length,
    truncated: booleanField(run.result, "truncated") ?? false,
    execution: run.execution,
  };
}

async function sandboxMaterializedGrep(
  state: PiGraftSandboxState,
  options: {
    pattern: string;
    basePath?: string;
    glob?: string;
    literal: boolean;
    ignoreCase: boolean;
    limit: number;
    fallbackReason?: string;
  },
): Promise<{
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}> {
  const globRegex = options.glob ? wildcardRegExp(options.glob) : undefined;
  const visible = await sandboxMaterializedVisiblePaths(
    state,
    { basePath: options.basePath, globRegex },
    options.fallbackReason
      ? { attemptedBackend: NATIVE_TREE_BACKEND, fallbackReason: options.fallbackReason }
      : undefined,
  );
  const flags = options.ignoreCase ? "i" : "";
  const regex = new RegExp(
    options.literal ? escapeRegExp(options.pattern) : options.pattern,
    flags,
  );
  const matches: string[] = [];
  const searchedPaths: string[] = [];
  const unreadablePaths: string[] = [];
  const changedSet = new Set(state.changedPaths);
  for (const path of visible.paths) {
    if (matches.length >= options.limit) break;
    searchedPaths.push(path);
    let content: string;
    try {
      content = changedSet.has(path)
        ? (await readSandboxFile(state, path)).content
        : await readSandboxBaseTextFile(state, path);
    } catch {
      unreadablePaths.push(path);
      continue;
    }
    const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    for (const [index, line] of lines.entries()) {
      if (regex.test(line)) matches.push(`${path}:${index + 1}:${line}`);
      if (matches.length >= options.limit) break;
    }
  }
  return {
    content: [
      {
        type: "text",
        text: matches.join("\n") || "No matches in sandbox base tree or tracked scratch changes.",
      },
    ],
    details: {
      sandbox: true,
      backend: visible.backend,
      attemptedBackend: visible.attemptedBackend,
      fallbackReason: visible.fallbackReason,
      searchedPaths,
      unreadablePaths,
      basePathCount: visible.basePathCount,
      changedPathCount: visible.changedPathCount,
      cacheHit: visible.cacheHit,
      matchCount: matches.length,
      matchLimitReached: matches.length >= options.limit ? options.limit : undefined,
      linesTruncated: false,
    },
  };
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
      try {
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
      } catch (error) {
        const metadata = await sandboxFileMetadata(state, path);
        return {
          content: [
            {
              type: "text",
              text: [
                "Graft sandbox read did not return UTF-8 text; returning safe metadata instead.",
                metadataSummary(metadata.metadata),
                "Use graft_sandbox_materialize with dryRun:false for binary inspection if needed.",
              ].join("\n"),
            },
          ],
          details: {
            truncation: undefined,
            sandbox: true,
            operation: "read_metadata",
            path,
            source: sandboxSourceLabel(state),
            state: sandboxState,
            backend: metadata.backend,
            attemptedBackend: metadata.attemptedBackend,
            fallbackReason: metadata.fallbackReason,
            metadata: metadata.metadata,
            readError: error instanceof Error ? error.message : String(error),
            execution: metadata.execution,
          },
        };
      }
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
      "Search UTF-8 text in the active sandbox base tree plus tracked scratch changes without reading the Git working tree.",
    promptSnippet:
      "Search UTF-8 text with the native Graft tree backend when semantics allow, otherwise with the materialized sandbox fallback; does not scan the working tree.",
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
      const literal = optionalBooleanParam(params, "literal", false);
      const ignoreCase = optionalBooleanParam(params, "ignoreCase", false);
      const max = positiveIntegerParam(params.limit, "limit") ?? 100;
      if (literal && !ignoreCase && sandboxTreeBackendPreference() !== "materialized") {
        try {
          const native = await sandboxNativeGrep(state, { pattern, basePath, glob, limit: max });
          return {
            content: [
              {
                type: "text",
                text:
                  native.matches.join("\n") ||
                  "No matches in sandbox base tree or tracked scratch changes.",
              },
            ],
            details: {
              sandbox: true,
              backend: NATIVE_TREE_BACKEND,
              searchedPaths: native.searchedPaths,
              skippedBinaryPaths: native.skippedBinaryPaths,
              matchCount: native.matches.length,
              totalMatches: native.totalMatches,
              matchLimitReached: native.truncated ? max : undefined,
              linesTruncated: false,
              execution: native.execution,
            },
          };
        } catch (error) {
          const fallbackReason = nativeTreeUnavailableReason(error);
          if (sandboxTreeBackendPreference() === "native" || !fallbackReason) throw error;
          return sandboxMaterializedGrep(state, {
            pattern,
            basePath,
            glob,
            literal,
            ignoreCase,
            limit: max,
            fallbackReason,
          });
        }
      }
      return sandboxMaterializedGrep(state, {
        pattern,
        basePath,
        glob,
        literal,
        ignoreCase,
        limit: max,
      });
    },
  });

  pi.registerTool({
    name: "find",
    label: "Find (Graft Sandbox)",
    description:
      "Find paths in the active sandbox base tree plus tracked scratch changes without traversing the Git working tree.",
    promptSnippet:
      "Find sandbox-visible paths with the native Graft tree backend when available, otherwise with the materialized sandbox fallback; does not traverse the working tree.",
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
      const visible = await sandboxVisiblePaths(state, {
        basePath,
        glob: pattern,
        globRegex: regex,
      });
      const paths = visible.paths.slice(0, max);
      return {
        content: [
          {
            type: "text",
            text: paths.join("\n") || "No sandbox-visible paths matched the query.",
          },
        ],
        details: {
          sandbox: true,
          backend: visible.backend,
          attemptedBackend: visible.attemptedBackend,
          fallbackReason: visible.fallbackReason,
          path: basePath,
          pattern,
          count: paths.length,
          totalMatches: visible.paths.length,
          basePathCount: visible.basePathCount,
          changedPathCount: visible.changedPathCount,
          cacheHit: visible.cacheHit,
          resultLimitReached: visible.paths.length > max ? max : undefined,
        },
      };
    },
  });

  pi.registerTool({
    name: "ls",
    label: "List (Graft Sandbox)",
    description:
      "List entries under a sandbox path from the active base tree plus tracked scratch changes without reading the Git working tree.",
    promptSnippet:
      "List sandbox-visible entries with the native Graft tree backend when available, otherwise with the materialized sandbox fallback; does not read the working tree.",
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
      const visible = await sandboxVisiblePaths(state, { basePath });
      const entries = new Set<string>();
      for (const visiblePath of visible.paths) {
        const rest =
          basePath && visiblePath === basePath
            ? visiblePath.split("/").at(-1)
            : prefix
              ? visiblePath.slice(prefix.length)
              : visiblePath;
        const [head, ...tail] = (rest ?? "").split("/");
        if (head) entries.add(tail.length ? `${head}/` : head);
      }
      const max = positiveIntegerParam(params.limit, "limit") ?? 500;
      const allEntries = [...entries].sort();
      const rendered = allEntries.slice(0, max);
      return {
        content: [
          {
            type: "text",
            text: rendered.join("\n") || "No sandbox-visible entries matched the query.",
          },
        ],
        details: {
          sandbox: true,
          backend: visible.backend,
          attemptedBackend: visible.attemptedBackend,
          fallbackReason: visible.fallbackReason,
          path: basePath,
          count: rendered.length,
          totalEntries: allEntries.length,
          basePathCount: visible.basePathCount,
          changedPathCount: visible.changedPathCount,
          cacheHit: visible.cacheHit,
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
        details: {
          sandbox: Boolean(sandboxState),
          state: sandboxState,
          profile: sandboxProfileDetails(),
        },
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
              ? `Exited Graft sandbox and cleared sandbox state. Retained refs: scratch=${previous.lastScratch ?? "none"}, candidate=${previous.lastCandidate ?? "none"}, patch=${previous.lastPatch ?? "none"}. File-tool names read/write/edit/grep/find/ls remain sandbox overrides in this loaded profile; reload without @zendev-lab/pi-graft/sandbox, and do not use --no-builtin-tools if ordinary Pi built-ins should be available.`
              : `Graft sandbox was already inactive. ${SANDBOX_PROFILE_RELOAD_GUIDANCE}`,
          },
        ],
        details: { sandbox: false, previousState: previous, profile: sandboxProfileDetails() },
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
