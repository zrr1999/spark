import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  SPARK_PROTOCOL_VERSION,
  parseSparkSessionView,
  sparkTextPhaseFromSignature,
  summarizeToolCallArguments,
  summarizeToolResultContent,
  type SparkConversationPart,
  type SparkJsonObject,
  type SparkMessageView,
  type SparkSessionRegistryRecord,
  type SparkSessionView,
  type SparkToolCallView,
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

interface NativeToolOutcome {
  toolCallId: string;
  toolName: string;
  status: "succeeded" | "failed";
  completedAt?: string;
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
  const toolOutcomes = collectToolOutcomes(activeEntries);
  const messages = activeEntries.flatMap((entry) => {
    const message = messageView(entry, toolOutcomes);
    return message ? [message] : [];
  });
  const tools = toolCallViews(activeEntries, toolOutcomes);
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
    tools,
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

function messageView(
  entry: NativeSessionEntry,
  toolOutcomes: ReadonlyMap<string, NativeToolOutcome>,
): SparkMessageView | undefined {
  if (entry.type !== "message" || !entry.message) return undefined;
  const role = displayRole(entry.message.role);
  if (!role) return undefined;
  const parts = conversationParts(entry, toolOutcomes);
  if (parts.length === 0) return undefined;
  const text =
    parts
      .filter((part): part is Extract<SparkConversationPart, { type: "text" }> => {
        return part.type === "text" && part.phase !== "commentary";
      })
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n") ||
    parts
      .flatMap((part) => {
        if (part.type !== "tool-call" && part.type !== "tool-result") return [];
        return part.summary?.trim() ? [part.summary.trim()] : [];
      })
      .join("\n");
  const createdAt = entryTimestamp(entry);
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: entry.id,
    role,
    text,
    status:
      entry.message.stopReason === "error" ||
      (role === "tool" && parts.some((part) => part.status === "failed"))
        ? "error"
        : "done",
    ...(createdAt ? { createdAt } : {}),
    ...(entry.parentId ? { parentId: entry.parentId } : {}),
    parts,
    metadata: role === "user" ? displayMessageMetadata(entry.message.metadata) : {},
  };
}

function displayMessageMetadata(value: unknown): SparkJsonObject {
  if (!isRecord(value) || !isRecord(value.channel)) return {};
  const channel = value.channel;
  const safeChannel: SparkJsonObject = {};
  for (const key of [
    "adapter",
    "externalKey",
    "senderId",
    "senderName",
    "chatId",
    "messageId",
    "eventType",
    "contentType",
  ] as const) {
    const field = channel[key];
    if (typeof field === "string" && field.trim()) safeChannel[key] = field.trim();
  }
  const attachments = displayChannelAttachments(channel.attachments);
  if (attachments.length > 0) safeChannel.attachments = attachments;
  return Object.keys(safeChannel).length > 0 ? { channel: safeChannel } : {};
}

function displayChannelAttachments(value: unknown): SparkJsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((entry): SparkJsonObject[] => {
    if (!isRecord(entry)) return [];
    if (entry.kind !== "image" && entry.kind !== "file" && entry.kind !== "voice") return [];
    const attachment: SparkJsonObject = { kind: entry.kind };
    for (const key of ["name", "mediaType", "reference"] as const) {
      const field = entry[key];
      if (typeof field === "string" && field.trim()) attachment[key] = field.trim();
    }
    if (typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0) {
      attachment.size = entry.size;
    }
    return [attachment];
  });
}

function displayRole(role: unknown): "user" | "assistant" | "tool" | "custom" | undefined {
  if (role === "toolResult") return "tool";
  return role === "user" || role === "assistant" || role === "custom" ? role : undefined;
}

function conversationParts(
  entry: NativeSessionEntry,
  toolOutcomes: ReadonlyMap<string, NativeToolOutcome>,
): SparkConversationPart[] {
  const message = entry.message;
  if (!message) return [];
  if (message.role === "toolResult") {
    const toolCallId = stringField(message, "toolCallId");
    const toolName = stringField(message, "toolName");
    if (!toolCallId || !toolName) return [];
    const summary = summarizeToolResultContent(message.content);
    return [
      {
        id: conversationPartId(entry.id, 0),
        type: "tool-result",
        toolCallId,
        toolName,
        status: message.isError === true ? "failed" : "complete",
        ...(summary ? { summary } : {}),
        metadata: {},
      },
    ];
  }

  const content = message.content;
  if (typeof content === "string") {
    return content
      ? [
          {
            id: conversationPartId(entry.id, 0),
            type: "text",
            text: content,
            status: "complete",
            metadata: {},
          },
        ]
      : [];
  }
  if (!Array.isArray(content)) return [];

  return content.flatMap((value, index): SparkConversationPart[] => {
    if (!isRecord(value)) return [];
    if (value.type === "text" && typeof value.text === "string" && value.text) {
      const phase = sparkTextPhaseFromSignature(value.textSignature);
      return [
        {
          id: conversationPartId(entry.id, index),
          type: "text",
          text: value.text,
          status: "complete",
          ...(phase ? { phase } : {}),
          metadata: {},
        },
      ];
    }
    if (value.type === "thinking" && typeof value.thinking === "string") {
      if (!value.thinking && value.redacted !== true) return [];
      return [
        {
          id: conversationPartId(entry.id, index),
          type: "thinking",
          text: value.redacted === true ? "" : value.thinking,
          status: "complete",
          ...(value.redacted === true ? { redacted: true } : {}),
          metadata: {},
        },
      ];
    }
    if (value.type !== "toolCall") return [];
    const toolCallId = stringField(value, "id");
    const toolName = stringField(value, "name");
    if (!toolCallId || !toolName) return [];
    const outcome = toolOutcomes.get(toolCallId);
    const summary = summarizeToolCallArguments(value.arguments);
    return [
      {
        id: conversationPartId(entry.id, index),
        type: "tool-call",
        toolCallId,
        toolName,
        status: outcome ? (outcome.status === "failed" ? "failed" : "complete") : "pending",
        ...(summary ? { summary } : {}),
        metadata: {},
      },
    ];
  });
}

function collectToolOutcomes(entries: NativeSessionEntry[]): Map<string, NativeToolOutcome> {
  const outcomes = new Map<string, NativeToolOutcome>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
    const toolCallId = stringField(entry.message, "toolCallId");
    const toolName = stringField(entry.message, "toolName");
    if (!toolCallId || !toolName) continue;
    outcomes.set(toolCallId, {
      toolCallId,
      toolName,
      status: entry.message.isError === true ? "failed" : "succeeded",
      ...(entryTimestamp(entry) ? { completedAt: entryTimestamp(entry) } : {}),
    });
  }
  return outcomes;
}

function toolCallViews(
  entries: NativeSessionEntry[],
  outcomes: ReadonlyMap<string, NativeToolOutcome>,
): SparkToolCallView[] {
  const tools = new Map<string, SparkToolCallView>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const value of content) {
      if (!isRecord(value) || value.type !== "toolCall") continue;
      const toolCallId = stringField(value, "id");
      const toolName = stringField(value, "name");
      if (!toolCallId || !toolName) continue;
      const outcome = outcomes.get(toolCallId);
      tools.set(toolCallId, {
        version: SPARK_PROTOCOL_VERSION,
        id: toolCallId,
        name: toolName,
        status: outcome?.status ?? "pending",
        ...(entryTimestamp(entry) ? { startedAt: entryTimestamp(entry) } : {}),
        ...(outcome?.completedAt ? { completedAt: outcome.completedAt } : {}),
        metadata: { source: "native-transcript" },
      });
    }
  }
  for (const outcome of outcomes.values()) {
    if (tools.has(outcome.toolCallId)) continue;
    tools.set(outcome.toolCallId, {
      version: SPARK_PROTOCOL_VERSION,
      id: outcome.toolCallId,
      name: outcome.toolName,
      status: outcome.status,
      ...(outcome.completedAt ? { completedAt: outcome.completedAt } : {}),
      metadata: { source: "native-transcript" },
    });
  }
  return Array.from(tools.values());
}

function conversationPartId(entryId: string, index: number): string {
  return `${entryId}:part:${index}`;
}

function entryTimestamp(entry: NativeSessionEntry): string | undefined {
  if (entry.timestamp) return entry.timestamp;
  const messageTimestamp = entry.message?.timestamp;
  return typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)
    ? new Date(messageTimestamp).toISOString()
    : undefined;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
