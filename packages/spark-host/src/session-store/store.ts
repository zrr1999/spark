/** Filesystem JSONL SparkSessionStore for host-managed sessions. */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveSparkHome } from "@zendev-lab/spark-system";

import {
  CURRENT_SPARK_SESSION_VERSION,
  type NewSparkSessionOptions,
  type SparkCustomMessageEntry,
  type SparkSessionEntry,
  type SparkSessionFileEntry,
  type SparkSessionHeader,
  type SparkSessionInfo,
  type SparkSessionInfoEntry,
  type SparkSessionMessage,
  type SparkSessionMessageEntry,
  type SparkSessionRecord,
  type SparkSessionStoreOptions,
} from "./types.ts";

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
      ...(options.visibility ? { visibility: options.visibility } : {}),
      ...(options.purpose ? { purpose: options.purpose } : {}),
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
    return { path, header, entries: entries.slice(1) as SparkSessionEntry[] };
  }

  async list(): Promise<SparkSessionInfo[]> {
    return await this.listSessionDir(this.sessionDir);
  }

  async listAllPersistentSessions(): Promise<SparkSessionInfo[]> {
    let workspaceDirs: string[];
    try {
      workspaceDirs = await readdir(this.sessionsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const infos = await Promise.all(
      workspaceDirs.map(async (name) => {
        const path = join(this.sessionsRoot, name);
        try {
          const stats = await stat(path);
          if (!stats.isDirectory()) return [];
          return await this.listSessionDir(path);
        } catch {
          return [];
        }
      }),
    );
    return infos.flat().sort(compareSessionInfoByMostRecent);
  }

  private async listSessionDir(sessionDir: string): Promise<SparkSessionInfo[]> {
    let names: string[];
    try {
      names = await readdir(sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const infos: SparkSessionInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(sessionDir, name);
      try {
        const record = await this.load(path);
        if (record.header.visibility === "internal") continue;
        infos.push(toSessionInfo(record, (await stat(path)).mtime));
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
        const record = await this.load(resolve(trimmed));
        if (record.header.visibility !== "internal") return record;
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
  return resolveSparkHome();
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
      /* Pi skips malformed lines. */
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
  await writeFile(tmp, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  await rename(tmp, path);
}

function appendEntry(
  record: SparkSessionRecord,
  entryFields: Record<string, unknown> & { type: SparkSessionEntry["type"] },
): string {
  const id = createEntryId(record.entries);
  record.entries.push({
    ...entryFields,
    id,
    parentId: record.entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
  } as unknown as SparkSessionEntry);
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
    if (typeof entry.message.timestamp === "number")
      lastActivityTime = Math.max(lastActivityTime, entry.message.timestamp);
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
  return structuredClone(entry);
}
function extractTextContent(message: SparkSessionMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
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
