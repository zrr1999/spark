import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  SPARK_PROTOCOL_VERSION,
  parseSparkSessionView,
  type SparkJsonObject,
  type SparkMessageView,
  type SparkSessionRegistryRecord,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";
import { SparkSessionRegistryError } from "./registry.ts";

interface NativeSessionHeader {
  type: "session";
  id: string;
  timestamp: string;
  cwd?: string;
}

interface NativeSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: Record<string, unknown>;
}

interface NativeSessionRecord {
  path: string;
  header: NativeSessionHeader;
  entries: NativeSessionEntry[];
  modifiedAt: string;
}

export interface LoadSparkSessionSnapshotInput {
  sessionsRoot: string;
  session: SparkSessionRegistryRecord;
}

/** Read the daemon-owned native JSONL transcript and project its active branch. */
export async function loadSparkSessionSnapshot(
  input: LoadSparkSessionSnapshotInput,
): Promise<SparkSessionView> {
  const path =
    input.session.sessionPath ??
    (await findNativeSessionPath(input.sessionsRoot, input.session.sessionId));
  if (!path) {
    return emptySessionSnapshot(input.session);
  }
  const record = await loadNativeSessionRecord(path, input.session.sessionId);
  const activeEntries = activeBranchEntries(record.entries);
  const messages = activeEntries.flatMap((entry) => {
    const message = messageView(entry);
    return message ? [message] : [];
  });
  const metadata: SparkJsonObject = {
    sessionScope: input.session.scope,
    ...(input.session.scope.kind === "workspace"
      ? { workspaceId: input.session.scope.workspaceId }
      : {}),
    registryStatus: input.session.status,
  };
  return parseSparkSessionView({
    sessionId: input.session.sessionId,
    ...(input.session.title ? { title: input.session.title } : {}),
    ...(record.header.cwd || input.session.cwd
      ? { cwd: record.header.cwd ?? input.session.cwd }
      : {}),
    ...(activeEntries.at(-1)?.id ? { activeLeafId: activeEntries.at(-1)!.id } : {}),
    status: input.session.status === "running" ? "running" : "idle",
    ...(input.session.model ? { model: input.session.model } : {}),
    messages,
    createdAt: record.header.timestamp,
    updatedAt:
      input.session.updatedAt > record.modifiedAt ? input.session.updatedAt : record.modifiedAt,
    metadata,
  });
}

function emptySessionSnapshot(session: SparkSessionRegistryRecord): SparkSessionView {
  return parseSparkSessionView({
    sessionId: session.sessionId,
    ...(session.title ? { title: session.title } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    status: session.status === "running" ? "running" : "idle",
    ...(session.model ? { model: session.model } : {}),
    messages: [],
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    metadata: {
      sessionScope: session.scope,
      ...(session.scope.kind === "workspace" ? { workspaceId: session.scope.workspaceId } : {}),
      registryStatus: session.status,
    },
  });
}

async function findNativeSessionPath(
  sessionsRoot: string,
  sessionId: string,
): Promise<string | undefined> {
  let workspaceDirs;
  try {
    workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const suffix = `_${sessionId}.jsonl`;
  const candidates: Array<{ path: string; modifiedMs: number }> = [];
  for (const workspaceDir of workspaceDirs) {
    if (!workspaceDir.isDirectory()) continue;
    const dir = join(sessionsRoot, workspaceDir.name);
    const files = await readdir(dir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(suffix)) continue;
      const path = join(dir, file.name);
      candidates.push({ path, modifiedMs: (await stat(path)).mtimeMs });
    }
  }
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs);
  return candidates[0]?.path;
}

async function loadNativeSessionRecord(
  path: string,
  expectedSessionId: string,
): Promise<NativeSessionRecord> {
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  const header = parseHeader(lines[0], path);
  if (header.id !== expectedSessionId) {
    throw new SparkSessionRegistryError(
      "session_snapshot_mismatch",
      `native transcript ${path} belongs to ${header.id}, not ${expectedSessionId}`,
    );
  }
  const entries = lines.slice(1).map((entry) => parseEntry(entry, path));
  return {
    path,
    header,
    entries,
    modifiedAt: (await stat(path)).mtime.toISOString(),
  };
}

function parseHeader(value: unknown, path: string): NativeSessionHeader {
  if (
    !isRecord(value) ||
    value.type !== "session" ||
    typeof value.id !== "string" ||
    typeof value.timestamp !== "string"
  ) {
    throw new SparkSessionRegistryError(
      "invalid_session_snapshot",
      `invalid native session header: ${path}`,
    );
  }
  return {
    type: "session",
    id: value.id,
    timestamp: value.timestamp,
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
  };
}

function parseEntry(value: unknown, path: string): NativeSessionEntry {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    typeof value.id !== "string" ||
    !(typeof value.parentId === "string" || value.parentId === null)
  ) {
    throw new SparkSessionRegistryError(
      "invalid_session_snapshot",
      `invalid native session entry: ${path}`,
    );
  }
  return {
    type: value.type,
    id: value.id,
    parentId: value.parentId,
    ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
    ...(isRecord(value.message) ? { message: value.message } : {}),
  };
}

function activeBranchEntries(entries: NativeSessionEntry[]): NativeSessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: NativeSessionEntry[] = [];
  const seen = new Set<string>();
  let current = entries.at(-1);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch;
}

function messageView(entry: NativeSessionEntry): SparkMessageView | undefined {
  if (entry.type !== "message" || !entry.message) return undefined;
  const role = displayRole(entry.message.role);
  if (!role) return undefined;
  const text = displayText(entry.message.content);
  if (!text) return undefined;
  const messageTimestamp = entry.message.timestamp;
  const createdAt =
    entry.timestamp ??
    (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)
      ? new Date(messageTimestamp).toISOString()
      : undefined);
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: entry.id,
    role,
    text,
    status: "done",
    ...(createdAt ? { createdAt } : {}),
    ...(entry.parentId ? { parentId: entry.parentId } : {}),
    metadata: {},
  };
}

function displayRole(role: unknown): "user" | "assistant" | "custom" | undefined {
  return role === "user" || role === "assistant" || role === "custom" ? role : undefined;
}

function displayText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return "";
      return part.text;
    })
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
