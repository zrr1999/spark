import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeJsonFileAtomic } from "@zendev-lab/spark-extension-api";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";

export type SparkMemoryScope = "user" | "workspace" | "repo";
export type SparkMemoryCategory =
  | "failure"
  | "correction"
  | "insight"
  | "preference"
  | "convention"
  | "tool-quirk";
export type SparkMemoryStatus = "active" | "forgotten";

export interface SparkMemoryEntry {
  id: string;
  scope: SparkMemoryScope;
  category: SparkMemoryCategory;
  text: string;
  reason: string;
  evidenceRefs: string[];
  tags: string[];
  status: SparkMemoryStatus;
  createdAt: string;
  updatedAt: string;
  forgottenReason?: string;
}

export interface SparkMemorySnapshot {
  version: 1;
  entries: SparkMemoryEntry[];
}

export interface SparkMemoryRememberInput {
  scope: SparkMemoryScope;
  category: SparkMemoryCategory;
  text: string;
  reason: string;
  evidenceRefs?: string[];
  tags?: string[];
}

export interface SparkMemorySearchResult {
  entry: SparkMemoryEntry;
  score: number;
  snippet: string;
}

export interface SparkMemoryStorePaths {
  user?: string;
  workspace?: string;
  repo?: string;
}

export interface SparkMemoryStatusSummary {
  storePath: string;
  total: number;
  active: number;
  forgotten: number;
  byCategory: Record<SparkMemoryCategory, number>;
}

export interface SparkMemoryCheckpointEntry {
  id: string;
  scope: SparkMemoryScope;
  category: SparkMemoryCategory;
  text: string;
  evidenceRefs: string[];
  tags: string[];
  updatedAt: string;
}

export interface SparkMemoryCheckpoint {
  version: 1;
  generatedAt: string;
  policy: string;
  entries: SparkMemoryCheckpointEntry[];
}

export const SPARK_MEMORY_CATEGORIES: readonly SparkMemoryCategory[] = [
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
] as const;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|rk|pk|xox[baprs]|gh[pousr]|github_pat)_[A-Za-z0-9_-]{16,}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_./+-]{12,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/u,
];

export class SparkMemoryStoreFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid spark memory store: ${filePath}: ${message}`);
    this.name = "SparkMemoryStoreFormatError";
    this.filePath = filePath;
  }
}

export class SparkMemorySecretError extends Error {
  constructor() {
    super("memory text appears to contain a secret or token; refusing to store it");
    this.name = "SparkMemorySecretError";
  }
}

export class SparkMemoryStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async list(options: { includeForgotten?: boolean; category?: SparkMemoryCategory } = {}) {
    const snapshot = await this.loadSnapshot();
    return snapshot.entries.filter(
      (entry) =>
        (options.includeForgotten || entry.status === "active") &&
        (options.category === undefined || entry.category === options.category),
    );
  }

  async remember(input: SparkMemoryRememberInput): Promise<SparkMemoryEntry> {
    const text = requiredText(input.text, "text");
    const reason = requiredText(input.reason, "reason");
    const scope = normalizeSparkMemoryScope(input.scope);
    const category = normalizeSparkMemoryCategory(input.category);
    assertNoSecrets(text);
    assertNoSecrets(reason);
    const now = new Date().toISOString();
    const snapshot = await this.loadSnapshot();
    const entry: SparkMemoryEntry = {
      id: `memory:${randomUUID()}`,
      scope,
      category,
      text,
      reason,
      evidenceRefs: normalizeStrings(input.evidenceRefs ?? []),
      tags: normalizeStrings(input.tags ?? []),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    snapshot.entries.push(entry);
    await this.saveSnapshot(snapshot);
    return entry;
  }

  async forget(id: string, reason: string): Promise<SparkMemoryEntry> {
    const snapshot = await this.loadSnapshot();
    const index = snapshot.entries.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error(`memory entry not found: ${id}`);
    const now = new Date().toISOString();
    const forgottenReason = requiredText(reason, "reason");
    assertNoSecrets(forgottenReason);
    const entry: SparkMemoryEntry = {
      ...snapshot.entries[index],
      status: "forgotten",
      forgottenReason,
      updatedAt: now,
    };
    snapshot.entries[index] = entry;
    await this.saveSnapshot(snapshot);
    return entry;
  }

  async search(
    query: string,
    options: { limit?: number; category?: SparkMemoryCategory } = {},
  ): Promise<SparkMemorySearchResult[]> {
    const tokens = tokenize(requiredText(query, "query"));
    const entries = await this.list({ category: options.category });
    return entries
      .map((entry) => ({
        entry,
        score: scoreEntry(entry, tokens),
        snippet: snippetFor(entry, tokens),
      }))
      .filter((result) => result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.entry.createdAt.localeCompare(right.entry.createdAt),
      )
      .slice(0, options.limit ?? 20);
  }

  async checkpoint(
    options: { limit?: number; category?: SparkMemoryCategory } = {},
  ): Promise<SparkMemoryCheckpoint> {
    const entries = await this.list({ category: options.category });
    const selected = [...entries]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, options.limit ?? 50)
      .map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        category: entry.category,
        text: entry.text,
        evidenceRefs: entry.evidenceRefs,
        tags: entry.tags,
        updatedAt: entry.updatedAt,
      }));
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      policy: renderSparkMemoryPolicy(),
      entries: selected,
    };
  }

  async status(): Promise<SparkMemoryStatusSummary> {
    const snapshot = await this.loadSnapshot();
    const byCategory = Object.fromEntries(
      SPARK_MEMORY_CATEGORIES.map((category) => [category, 0]),
    ) as Record<SparkMemoryCategory, number>;
    for (const entry of snapshot.entries)
      if (entry.status === "active") byCategory[entry.category] += 1;
    return {
      storePath: this.filePath,
      total: snapshot.entries.length,
      active: snapshot.entries.filter((entry) => entry.status === "active").length,
      forgotten: snapshot.entries.filter((entry) => entry.status === "forgotten").length,
      byCategory,
    };
  }

  private async loadSnapshot(): Promise<SparkMemorySnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { version: 1, entries: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SparkMemoryStoreFormatError(
        this.filePath,
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    assertSnapshot(parsed, this.filePath);
    return parsed;
  }

  private async saveSnapshot(snapshot: SparkMemorySnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeJsonFileAtomic(this.filePath, snapshot);
  }
}

export function sparkMemoryStorePath(
  cwd: string,
  scope: SparkMemoryScope,
  paths: SparkMemoryStorePaths = {},
): string {
  const explicit = paths[scope];
  if (explicit?.trim()) return explicit;
  if (scope === "user") return resolveSparkUserPaths().memoryFile;
  return join(cwd, ".spark", "memory", "memory.json");
}

export function defaultSparkMemoryStore(
  cwd: string,
  scope: SparkMemoryScope,
  paths?: SparkMemoryStorePaths,
): SparkMemoryStore {
  return new SparkMemoryStore(sparkMemoryStorePath(cwd, scope, paths));
}

export function renderSparkMemoryPolicy(): string {
  return [
    "Spark memory is explicit and policy-only by default.",
    'Use memory({ action: "search" }) or memory({ action: "recall" }) when prior durable context may help.',
    'Use memory({ action: "remember" }) only for user-approved durable facts, corrections, preferences, conventions, failures, insights, or tool quirks.',
    "Never store secrets, API keys, tokens, or private credentials in memory.",
  ].join("\n");
}

export function renderSparkMemoryCheckpoint(checkpoint: SparkMemoryCheckpoint): string {
  if (checkpoint.entries.length === 0) {
    return `${checkpoint.policy}\n\nSpark memory checkpoint: no active entries.`;
  }
  return [
    checkpoint.policy,
    "",
    "Spark memory checkpoint:",
    ...checkpoint.entries.map(
      (entry) =>
        `- ${entry.id} [${entry.scope}/${entry.category}] ${entry.text}${
          entry.tags.length > 0 ? ` (tags: ${entry.tags.join(", ")})` : ""
        }`,
    ),
  ].join("\n");
}

export function assertNoSecrets(text: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) throw new SparkMemorySecretError();
}

export function normalizeSparkMemoryScope(value: unknown): SparkMemoryScope {
  if (value === "user" || value === "workspace" || value === "repo") return value;
  throw new Error("memory.scope must be user, workspace, or repo");
}

export function normalizeSparkMemoryCategory(value: unknown): SparkMemoryCategory {
  if (SPARK_MEMORY_CATEGORIES.includes(value as SparkMemoryCategory)) {
    return value as SparkMemoryCategory;
  }
  throw new Error(`memory.category must be one of: ${SPARK_MEMORY_CATEGORIES.join(", ")}`);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`memory.${field} is required`);
  return value.trim();
}

function normalizeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreEntry(entry: SparkMemoryEntry, tokens: readonly string[]): number {
  const haystack = [entry.category, entry.text, entry.reason, entry.tags.join(" ")]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const token of tokens) {
    const occurrences = haystack.split(token).length - 1;
    if (occurrences > 0) score += occurrences;
  }
  return score;
}

function snippetFor(entry: SparkMemoryEntry, tokens: readonly string[]): string {
  const text = entry.text.replace(/\s+/gu, " ").trim();
  const lower = text.toLowerCase();
  const firstHit =
    tokens
      .map((token) => lower.indexOf(token))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - 80);
  const end = Math.min(text.length, firstHit + 180);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function assertSnapshot(value: unknown, filePath: string): asserts value is SparkMemorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SparkMemoryStoreFormatError(filePath, "JSON root must be an object");
  }
  const snapshot = value as { version?: unknown; entries?: unknown };
  if (snapshot.version !== 1) throw new SparkMemoryStoreFormatError(filePath, "version must be 1");
  if (!Array.isArray(snapshot.entries)) {
    throw new SparkMemoryStoreFormatError(filePath, "entries must be an array");
  }
  for (const [index, entry] of snapshot.entries.entries()) assertEntry(entry, filePath, index);
}

function assertEntry(
  value: unknown,
  filePath: string,
  index: number,
): asserts value is SparkMemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SparkMemoryStoreFormatError(filePath, `entries[${index}] must be an object`);
  }
  const entry = value as Partial<SparkMemoryEntry>;
  if (typeof entry.id !== "string" || !entry.id.startsWith("memory:")) {
    throw new SparkMemoryStoreFormatError(filePath, `entries[${index}].id must be a memory ref`);
  }
  normalizeSparkMemoryScope(entry.scope);
  normalizeSparkMemoryCategory(entry.category);
  if (typeof entry.text !== "string" || !entry.text.trim()) {
    throw new SparkMemoryStoreFormatError(filePath, `entries[${index}].text must be a string`);
  }
  if (typeof entry.reason !== "string" || !entry.reason.trim()) {
    throw new SparkMemoryStoreFormatError(filePath, `entries[${index}].reason must be a string`);
  }
  if (
    !Array.isArray(entry.evidenceRefs) ||
    !entry.evidenceRefs.every((ref) => typeof ref === "string")
  ) {
    throw new SparkMemoryStoreFormatError(
      filePath,
      `entries[${index}].evidenceRefs must be a string array`,
    );
  }
  if (!Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === "string")) {
    throw new SparkMemoryStoreFormatError(
      filePath,
      `entries[${index}].tags must be a string array`,
    );
  }
  if (entry.status !== "active" && entry.status !== "forgotten") {
    throw new SparkMemoryStoreFormatError(
      filePath,
      `entries[${index}].status must be active or forgotten`,
    );
  }
  if (typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") {
    throw new SparkMemoryStoreFormatError(filePath, `entries[${index}] timestamps must be strings`);
  }
}

export {
  RecallStore,
  RecallStoreFormatError,
  defaultRecallStore,
  recallStorePath,
  type RecallCandidate,
  type RecallCandidateStatus,
  type RecallScope,
  type RecallStorePaths,
  type RecallStoreSnapshot,
} from "./recall-store.ts";

export * from "./learning-store.ts";
