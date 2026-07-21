import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  SPARK_PROTOCOL_VERSION,
  parseSparkSessionView,
  sanitizeSparkDisplayError,
  sparkTextPhaseFromSignature,
  summarizeToolCallArguments,
  summarizeToolResultContent,
  type SparkConversationPart,
  type SparkJsonObject,
  type SparkMessageView,
  type SparkSessionRegistryRecord,
  type SparkSessionUsage,
  type SparkSessionView,
  type SparkToolCallView,
} from "@zendev-lab/spark-protocol";
import { gitCommand } from "@zendev-lab/spark-system";
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

const providerFailureFallback = "The provider request failed without additional details.";

export interface LoadSparkSessionSnapshotInput {
  sessionsRoot: string;
  session: SparkSessionRegistryRecord;
  resolveGitBranch?: (cwd: string) => Promise<string | undefined>;
}

/** Read the daemon-owned native JSONL transcript and project its active branch. */
export async function loadSparkSessionSnapshot(
  input: LoadSparkSessionSnapshotInput,
): Promise<SparkSessionView> {
  const path =
    input.session.sessionPath ??
    (await findNativeSessionPath(input.sessionsRoot, input.session.sessionId));
  if (!path) {
    const gitBranch = input.session.cwd
      ? await (input.resolveGitBranch ?? resolveNativeSessionGitBranch)(input.session.cwd)
      : undefined;
    return emptySessionSnapshot(input.session, gitBranch);
  }
  const record = await loadNativeSessionRecord(path, input.session.sessionId);
  const activeEntries = activeBranchEntries(record.entries);
  const toolOutcomes = collectToolOutcomes(activeEntries);
  const projectedMessages = activeEntries.flatMap((entry) => {
    const message = messageView(entry, toolOutcomes);
    return message ? [message] : [];
  });
  const interrupted = interruptedTurnMessage(activeEntries, input.session);
  const messages = interrupted ? [...projectedMessages, interrupted] : projectedMessages;
  const tools = toolCallViews(activeEntries, toolOutcomes);
  const metadata: SparkJsonObject = {
    sessionScope: input.session.scope,
    ...(input.session.scope.kind === "workspace"
      ? { workspaceId: input.session.scope.workspaceId }
      : {}),
    registryStatus: input.session.status,
  };
  const cwd = record.header.cwd ?? input.session.cwd;
  const gitBranch = cwd
    ? await (input.resolveGitBranch ?? resolveNativeSessionGitBranch)(cwd)
    : undefined;
  const usage = sessionUsage(record.entries, activeEntries);
  return parseSparkSessionView({
    sessionId: input.session.sessionId,
    ...(input.session.title ? { title: input.session.title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(activeEntries.at(-1)?.id ? { activeLeafId: activeEntries.at(-1)!.id } : {}),
    status: input.session.status === "running" ? "running" : "idle",
    ...(input.session.model ? { model: input.session.model } : {}),
    ...(input.session.thinkingLevel ? { thinkingLevel: input.session.thinkingLevel } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(usage ? { usage } : {}),
    messages,
    tools,
    createdAt: record.header.timestamp,
    updatedAt:
      input.session.updatedAt > record.modifiedAt ? input.session.updatedAt : record.modifiedAt,
    metadata,
  });
}

function emptySessionSnapshot(
  session: SparkSessionRegistryRecord,
  gitBranch: string | undefined,
): SparkSessionView {
  return parseSparkSessionView({
    sessionId: session.sessionId,
    ...(session.title ? { title: session.title } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    status: session.status === "running" ? "running" : "idle",
    ...(session.model ? { model: session.model } : {}),
    ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
    ...(gitBranch ? { gitBranch } : {}),
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
    // A failed tool still completed its process message. Keep that failure on
    // the tool-result part instead of promoting it to a terminal turn error.
    status: entry.message.stopReason === "error" ? "error" : "done",
    ...(createdAt ? { createdAt } : {}),
    ...(entry.parentId ? { parentId: entry.parentId } : {}),
    parts,
    metadata:
      role === "user"
        ? displayMessageMetadata(entry.message.metadata)
        : role === "assistant"
          ? assistantDisplayMetadata(entry.message)
          : {},
  };
}

function interruptedTurnMessage(
  activeEntries: readonly NativeSessionEntry[],
  session: SparkSessionRegistryRecord,
): SparkMessageView | undefined {
  if (session.status === "running") return undefined;
  const lastEntry = activeEntries.findLast(
    (entry) => entry.type === "message" && Boolean(entry.message),
  );
  const toolResultWithoutReply = lastEntry?.message?.role === "toolResult";
  const stopReason =
    typeof lastEntry?.message?.stopReason === "string"
      ? lastEntry.message.stopReason.trim().toLocaleLowerCase()
      : "";
  const toolCallWithoutResult =
    lastEntry?.message?.role === "assistant" && ["tooluse", "tool_use"].includes(stopReason);
  if (!lastEntry || (!toolResultWithoutReply && !toolCallWithoutResult)) return undefined;
  const text = "Turn ended before a final response. The last recorded step was a tool result.";
  const createdAt = entryTimestamp(lastEntry);
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: `${lastEntry.id}:missing-final-response`,
    role: "system",
    text,
    status: "error",
    ...(createdAt ? { createdAt } : {}),
    parentId: lastEntry.id,
    parts: [
      {
        id: `${lastEntry.id}:missing-final-response:part:0`,
        type: "text",
        text,
        status: "failed",
        metadata: {},
      },
    ],
    metadata: {
      source: "session.snapshot",
      kind: "missing_final_response",
      errorTitle: "Session interrupted",
      conversationVisible: true,
    },
  };
}

function assistantDisplayMetadata(message: Record<string, unknown>): SparkJsonObject {
  const usage = normalizedAssistantUsage(message.usage);
  const errorMessage = sanitizeSparkDisplayError(message.errorMessage, {
    ...(message.stopReason === "error" ? { fallback: providerFailureFallback } : {}),
  });
  return {
    ...(typeof message.api === "string" && message.api.trim() ? { api: message.api.trim() } : {}),
    ...(typeof message.provider === "string" && message.provider.trim()
      ? { provider: message.provider.trim() }
      : {}),
    ...(typeof message.model === "string" && message.model.trim()
      ? { model: message.model.trim() }
      : {}),
    ...(typeof message.stopReason === "string" && message.stopReason.trim()
      ? { stopReason: message.stopReason.trim() }
      : {}),
    ...(isRoundtripBudgetError(errorMessage) ? { outcomeStatus: "budget_exhausted" } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
  };
}

function isRoundtripBudgetError(message: string | undefined): boolean {
  return Boolean(message && /^agent loop hit maxRoundtrips=\d+; stopping$/u.test(message));
}

function sessionUsage(
  entries: readonly NativeSessionEntry[],
  activeEntries: readonly NativeSessionEntry[],
): SparkSessionUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let latestCacheHitPercent: number | undefined;
  let hasUsage = false;

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const usage = normalizedAssistantUsage(entry.message.usage);
    if (!usage) continue;
    hasUsage = true;
    inputTokens += usage.input;
    outputTokens += usage.output;
    cacheReadTokens += usage.cacheRead;
    cacheWriteTokens += usage.cacheWrite;
    costUsd += usage.cost.total;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    latestCacheHitPercent = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
  }

  if (!hasUsage) return undefined;
  const latestCompactionIndex = findLastIndex(
    activeEntries,
    (entry) => entry.type === "compaction",
  );
  let contextTokens: number | undefined;
  for (let index = activeEntries.length - 1; index > latestCompactionIndex; index -= 1) {
    const entry = activeEntries[index];
    if (
      entry?.type !== "message" ||
      entry.message?.role !== "assistant" ||
      entry.message.stopReason === "aborted" ||
      entry.message.stopReason === "error"
    ) {
      continue;
    }
    const usage = normalizedAssistantUsage(entry.message.usage);
    if (!usage) continue;
    const candidate =
      usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (candidate > 0) {
      contextTokens = candidate;
      break;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    ...(latestCacheHitPercent !== undefined ? { latestCacheHitPercent } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };
}

type NormalizedAssistantUsage = SparkJsonObject & {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: SparkJsonObject & {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

function normalizedAssistantUsage(value: unknown): NormalizedAssistantUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = nonnegativeNumber(value.input ?? value.inputTokens) ?? 0;
  const output = nonnegativeNumber(value.output ?? value.outputTokens) ?? 0;
  const cacheRead = nonnegativeNumber(value.cacheRead ?? value.cacheReadTokens) ?? 0;
  const cacheWrite = nonnegativeNumber(value.cacheWrite ?? value.cacheWriteTokens) ?? 0;
  const totalTokens = nonnegativeNumber(value.totalTokens) ?? 0;
  const costValue = isRecord(value.cost) ? value.cost : {};
  const cost = {
    input: nonnegativeNumber(costValue.input) ?? 0,
    output: nonnegativeNumber(costValue.output) ?? 0,
    cacheRead: nonnegativeNumber(costValue.cacheRead) ?? 0,
    cacheWrite: nonnegativeNumber(costValue.cacheWrite) ?? 0,
    total: nonnegativeNumber(costValue.total) ?? 0,
  };
  if (!cost.total) cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  if (
    input === 0 &&
    output === 0 &&
    cacheRead === 0 &&
    cacheWrite === 0 &&
    totalTokens === 0 &&
    cost.total === 0
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

async function resolveNativeSessionGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return await new Promise((resolve) => {
    let command: string;
    try {
      command = gitCommand();
    } catch {
      resolve(undefined);
      return;
    }
    execFile(
      command,
      ["-C", cwd, "branch", "--show-current"],
      { encoding: "utf8", timeout: 1_000 },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve(undefined);
          return;
        }
        const branch = stdout.trim();
        resolve(branch || undefined);
      },
    );
  });
}

function displayMessageMetadata(value: unknown): SparkJsonObject {
  if (!isRecord(value)) return {};
  const safeMetadata: SparkJsonObject = {};
  if (typeof value.invocationId === "string" && value.invocationId.trim()) {
    safeMetadata.invocationId = value.invocationId.trim();
  }
  if (!isRecord(value.channel)) return safeMetadata;
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
  const messageReference = displayChannelMessageReference(channel.messageReference);
  if (messageReference) safeChannel.messageReference = messageReference;
  if (Object.keys(safeChannel).length > 0) safeMetadata.channel = safeChannel;
  return safeMetadata;
}

function displayChannelMessageReference(value: unknown): SparkJsonObject | undefined {
  if (!isRecord(value)) return undefined;
  const reference: SparkJsonObject = {};
  for (const key of [
    "messageId",
    "secondaryMessageId",
    "preview",
    "senderId",
    "senderName",
    "source",
  ] as const) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) reference[key] = field.trim();
  }
  return Object.keys(reference).length > 0 ? reference : undefined;
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
    const failed = message.isError === true;
    const rawSummary = summarizeToolResultContent(message.content);
    const summary = failed
      ? sanitizeSparkDisplayError(rawSummary, {
          fallback: "The tool failed without additional details.",
        })
      : rawSummary;
    return [
      {
        id: conversationPartId(entry.id, 0),
        type: "tool-result",
        toolCallId,
        toolName,
        status: failed ? "failed" : "complete",
        ...(summary ? { summary } : {}),
        metadata: {},
      },
    ];
  }

  const content = message.content;
  if (typeof content === "string") {
    const parts: SparkConversationPart[] = content
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
    return parts.length > 0 ? parts : providerErrorParts(entry);
  }
  if (!Array.isArray(content)) return providerErrorParts(entry);

  const parts = content.flatMap((value, index): SparkConversationPart[] => {
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
  return parts.length > 0 ? parts : providerErrorParts(entry);
}

/**
 * Provider failures commonly carry an empty assistant content array, so the
 * normal part projection has nothing to render. Preserve the failure as a
 * bounded text part without copying an upstream HTML error page into Cockpit.
 */
function providerErrorParts(entry: NativeSessionEntry): SparkConversationPart[] {
  const message = entry.message;
  if (message?.role !== "assistant" || message.stopReason !== "error") return [];
  const summary = sanitizeSparkDisplayError(message.errorMessage, {
    fallback: providerFailureFallback,
  });
  return [
    {
      id: conversationPartId(entry.id, 0),
      type: "text",
      text: summary,
      status: "failed",
      metadata: {},
    },
  ];
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
