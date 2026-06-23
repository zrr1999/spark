/**
 * Spark native session store.
 *
 * Current Pi (0.74.x) persists sessions as append-only JSONL files. The first
 * line is a session header, subsequent lines are tree entries linked by
 * `id`/`parentId`; branch state is represented by that tree and the active leaf
 * is the last entry. Spark keeps the same key names and entry shapes for
 * cross-debugging, but writes under ~/.spark/sessions/<workspaceHash>/ instead
 * of ~/.pi/agent/sessions.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CURRENT_SPARK_SESSION_VERSION = 3;

export interface SparkSessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SparkSessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SparkSessionMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export interface SparkSessionMessageEntry extends SparkSessionEntryBase {
  type: "message";
  message: SparkSessionMessage;
}

export interface SparkThinkingLevelChangeEntry extends SparkSessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface SparkModelChangeEntry extends SparkSessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface SparkCompactionEntry<T = unknown> extends SparkSessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
}

export interface SparkBranchSummaryEntry<T = unknown> extends SparkSessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: T;
  fromHook?: boolean;
}

export interface SparkCustomEntry<T = unknown> extends SparkSessionEntryBase {
  type: "custom";
  customType: string;
  data?: T;
}

export interface SparkCustomMessageEntry<T = unknown> extends SparkSessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  details?: T;
  display: boolean;
}

export interface SparkLabelEntry extends SparkSessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SparkSessionInfoEntry extends SparkSessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SparkSessionEntry =
  | SparkSessionMessageEntry
  | SparkThinkingLevelChangeEntry
  | SparkModelChangeEntry
  | SparkCompactionEntry
  | SparkBranchSummaryEntry
  | SparkCustomEntry
  | SparkCustomMessageEntry
  | SparkLabelEntry
  | SparkSessionInfoEntry;

export type SparkSessionFileEntry = SparkSessionHeader | SparkSessionEntry;

export interface SparkSessionRecord {
  path: string;
  header: SparkSessionHeader;
  entries: SparkSessionEntry[];
}

export interface SparkSessionInfo {
  path: string;
  id: string;
  cwd: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
  name?: string;
}

export interface SparkSessionStoreOptions {
  cwd: string;
  /** Defaults to $SPARK_HOME or ~/.spark. */
  sparkHome?: string;
  /** Overrides sparkHome/sessions, mainly for tests. */
  sessionsRoot?: string;
}

export interface NewSparkSessionOptions {
  id?: string;
  parentSession?: string;
  timestamp?: string;
}

export class SparkSessionStore {
  readonly cwd: string;
  readonly sessionsRoot: string;
  readonly workspaceHash: string;
  readonly sessionDir: string;

  constructor(options: SparkSessionStoreOptions) {
    this.cwd = resolve(options.cwd);
    this.sessionsRoot = options.sessionsRoot ?? defaultSparkSessionsRoot(options.sparkHome);
    this.workspaceHash = workspaceSessionHash(this.cwd);
    this.sessionDir = join(this.sessionsRoot, this.workspaceHash);
  }

  createSession(options: NewSparkSessionOptions = {}): SparkSessionRecord {
    const id = options.id ?? createSessionId();
    const timestamp = options.timestamp ?? new Date().toISOString();
    const header: SparkSessionHeader = {
      type: "session",
      version: CURRENT_SPARK_SESSION_VERSION,
      id,
      timestamp,
      cwd: this.cwd,
      ...(options.parentSession ? { parentSession: options.parentSession } : {}),
    };
    return {
      path: join(this.sessionDir, `${fileTimestamp(timestamp)}_${id}.jsonl`),
      header,
      entries: [],
    };
  }

  async save(record: SparkSessionRecord): Promise<void> {
    await writeJsonLinesAtomically(record.path, [record.header, ...record.entries]);
  }

  async load(path: string): Promise<SparkSessionRecord> {
    const entries = parseSparkSessionEntries(await readFile(path, "utf8"));
    if (entries.length === 0 || entries[0]?.type !== "session") {
      throw new Error(`Invalid Spark session file: ${path}`);
    }
    const header = entries[0] as SparkSessionHeader;
    return {
      path,
      header,
      entries: entries.slice(1) as SparkSessionEntry[],
    };
  }

  async list(): Promise<SparkSessionInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const infos: SparkSessionInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(this.sessionDir, name);
      try {
        const record = await this.load(path);
        const stats = await stat(path);
        infos.push(toSessionInfo(record, stats.mtime));
      } catch {
        // Match Pi list behavior: ignore invalid/corrupt session files.
      }
    }
    return infos.sort(compareSessionInfoByMostRecent);
  }

  async findMostRecent(): Promise<SparkSessionInfo | undefined> {
    return (await this.list())[0];
  }

  async findById(sessionId: string): Promise<SparkSessionRecord | undefined> {
    const normalized = normalizeSessionRef(sessionId);
    for (const info of await this.list()) {
      if (info.id === sessionId || info.id === normalized) return await this.load(info.path);
    }
    return undefined;
  }

  async loadByRef(sessionRef: string): Promise<SparkSessionRecord> {
    const trimmed = sessionRef.trim();
    if (!trimmed) throw new Error("Spark session ref is required");

    if (looksLikeSessionPath(trimmed)) {
      try {
        return await this.load(resolve(trimmed));
      } catch {
        // Fall through to id lookup so callers can pass a basename-like id.
      }
    }

    const byId = await this.findById(trimmed);
    if (byId) return byId;
    throw new Error(`Spark session not found: ${sessionRef}`);
  }

  forkSession(
    parent: SparkSessionRecord,
    options: NewSparkSessionOptions = {},
  ): SparkSessionRecord {
    const fork = this.createSession({
      ...options,
      parentSession: options.parentSession ?? parent.path,
    });
    fork.entries = parent.entries.map(cloneSessionEntry);
    return fork;
  }

  appendMessage(record: SparkSessionRecord, message: SparkSessionMessage): string {
    return appendEntry(record, { type: "message", message });
  }

  appendThinkingLevelChange(record: SparkSessionRecord, thinkingLevel: string): string {
    return appendEntry(record, { type: "thinking_level_change", thinkingLevel });
  }

  appendModelChange(record: SparkSessionRecord, provider: string, modelId: string): string {
    return appendEntry(record, { type: "model_change", provider, modelId });
  }

  appendCustomEntry<T = unknown>(record: SparkSessionRecord, customType: string, data?: T): string {
    return appendEntry(record, { type: "custom", customType, data });
  }

  appendCustomMessage<T = unknown>(
    record: SparkSessionRecord,
    customType: string,
    content: SparkCustomMessageEntry<T>["content"],
    display: boolean,
    details?: T,
  ): string {
    return appendEntry(record, { type: "custom_message", customType, content, display, details });
  }
}

export function defaultSparkSessionsRoot(sparkHome = defaultSparkHome()): string {
  return join(sparkHome, "sessions");
}

export function defaultSparkHome(): string {
  return process.env.SPARK_HOME ?? join(homedir(), ".spark");
}

export function workspaceSessionHash(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

export function parseSparkSessionEntries(content: string): SparkSessionFileEntry[] {
  const entries: SparkSessionFileEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SparkSessionFileEntry);
    } catch {
      // Pi skips malformed lines while reading session files.
    }
  }
  if (entries.length === 0) return entries;
  const header = entries[0];
  if (header.type !== "session" || typeof header.id !== "string") return [];
  return entries;
}

export async function writeJsonLinesAtomically(
  path: string,
  entries: SparkSessionFileEntry[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

function appendEntry(
  record: SparkSessionRecord,
  entryFields: Record<string, unknown> & { type: SparkSessionEntry["type"] },
): string {
  const id = createEntryId(record.entries);
  const parentId = record.entries.at(-1)?.id ?? null;
  const entry = {
    ...entryFields,
    id,
    parentId,
    timestamp: new Date().toISOString(),
  } as unknown as SparkSessionEntry;
  record.entries.push(entry);
  return id;
}

function toSessionInfo(record: SparkSessionRecord, statsMtime: Date): SparkSessionInfo {
  const messages = record.entries.filter(
    (entry): entry is SparkSessionMessageEntry => entry.type === "message",
  );
  const textMessages = messages.map((entry) => extractTextContent(entry.message)).filter(Boolean);
  const latestSessionInfo = [...record.entries]
    .reverse()
    .find((entry): entry is SparkSessionInfoEntry => entry.type === "session_info");
  return {
    path: record.path,
    id: record.header.id,
    cwd: record.header.cwd,
    parentSessionPath: record.header.parentSession,
    created: new Date(record.header.timestamp),
    modified: getSessionModifiedDate(record, statsMtime),
    messageCount: messages.length,
    firstMessage: textMessages[0] ?? "",
    allMessagesText: textMessages.join("\n"),
    name: latestSessionInfo?.name?.trim() || undefined,
  };
}

function compareSessionInfoByMostRecent(left: SparkSessionInfo, right: SparkSessionInfo): number {
  return (
    right.modified.getTime() - left.modified.getTime() ||
    right.created.getTime() - left.created.getTime() ||
    right.path.localeCompare(left.path)
  );
}

function getSessionModifiedDate(record: SparkSessionRecord, statsMtime: Date): Date {
  let lastActivityTime = 0;
  for (const entry of record.entries) {
    if (entry.type !== "message") continue;
    const timestamp = entry.message.timestamp;
    if (typeof timestamp === "number") lastActivityTime = Math.max(lastActivityTime, timestamp);
    const entryTime = new Date(entry.timestamp).getTime();
    if (!Number.isNaN(entryTime)) lastActivityTime = Math.max(lastActivityTime, entryTime);
  }
  if (lastActivityTime > 0) return new Date(lastActivityTime);
  const headerTime = new Date(record.header.timestamp).getTime();
  return Number.isNaN(headerTime) ? statsMtime : new Date(headerTime);
}

function looksLikeSessionPath(sessionRef: string): boolean {
  return sessionRef.endsWith(".jsonl") || sessionRef.includes("/") || sessionRef.includes("\\");
}

function normalizeSessionRef(sessionRef: string): string {
  const trimmed = sessionRef.trim();
  return trimmed.startsWith("session:") ? trimmed.slice("session:".length) : trimmed;
}

function cloneSessionEntry(entry: SparkSessionEntry): SparkSessionEntry {
  return JSON.parse(JSON.stringify(entry)) as SparkSessionEntry;
}

function extractTextContent(message: SparkSessionMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string",
      ),
    )
    .map((block) => block.text)
    .join(" ");
}

function createSessionId(): string {
  return randomUUID();
}

function createEntryId(entries: SparkSessionEntry[]): string {
  const existing = new Set(entries.map((entry) => entry.id));
  for (let i = 0; i < 100; i += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}

function fileTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}
