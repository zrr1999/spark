/** Native Spark CLI compaction helpers aligned with current Pi JSONL sessions. */

import { randomUUID } from "node:crypto";
import {
  SPARK_PROMPT_ITEM_METADATA_KEY,
  parseSparkPromptItemMetadata,
} from "@zendev-lab/spark-turn";

import type {
  SparkBranchSummaryEntry,
  SparkCompactionEntry,
  SparkCustomMessageEntry,
  SparkSessionEntry,
  SparkSessionMessage,
  SparkSessionMessageEntry,
  SparkSessionRecord,
  SparkSessionStore,
} from "./session-store.ts";
import {
  getSparkSessionBranch,
  getSparkSessionLeafId,
  switchSparkSessionLeaf,
} from "./session-navigation.ts";

export type SparkCompactionTokenSource = "reported" | "tokenizer" | "estimated";

export type SparkCompactionFallbackReason =
  | "model_unavailable"
  | "model_error"
  | "invalid_summary"
  | "deterministic_requested";

export type SparkCompactModelSelection = string;

export interface SparkCompactionSettings {
  enabled: boolean;
  /** Context-window ratio that triggers one stateless micro-compaction pass. */
  microThreshold: number;
  /** Context-window ratio that triggers full semantic compaction after micro-compaction. */
  fullThreshold: number;
  /** Fraction of the current compactable context that micro-compaction attempts to remove. */
  targetReduction: number;
  /** Stop a micro-compaction pass when it cannot remove this fraction of its input. */
  minUsefulReduction: number;
  /** `current` selects the active session model; any other value is an explicit model id. */
  compactModel: SparkCompactModelSelection;
  /** Legacy full-compaction trigger retained while V2 runtime scheduling is adopted. */
  reserveTokens: number;
  /** Recent context protected from full compaction. */
  keepRecentTokens: number;
}

export interface SparkCompactionOutcomeMetadata {
  summaryVersion: number;
  tokenSource: SparkCompactionTokenSource;
  measuredReductionRatio: number;
  fallbackReason?: SparkCompactionFallbackReason;
}

export const CURRENT_SPARK_COMPACTION_SUMMARY_VERSION = 2;

export const DEFAULT_SPARK_COMPACTION_SETTINGS: SparkCompactionSettings = {
  enabled: true,
  microThreshold: 0.75,
  fullThreshold: 0.9,
  targetReduction: 0.4,
  minUsefulReduction: 0.05,
  compactModel: "current",
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export function normalizeSparkCompactionOutcomeMetadata(
  input: Partial<SparkCompactionOutcomeMetadata> &
    Pick<SparkCompactionOutcomeMetadata, "tokenSource">,
): SparkCompactionOutcomeMetadata {
  return {
    summaryVersion: positiveInteger(input.summaryVersion, CURRENT_SPARK_COMPACTION_SUMMARY_VERSION),
    tokenSource: input.tokenSource,
    measuredReductionRatio: unitRatio(input.measuredReductionRatio, 0),
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
  };
}

const MAX_DETERMINISTIC_COMPACTION_SUMMARY_CHARS = 48_000;

export interface SparkContextUsageEstimate {
  tokens: number;
  trailingTokens: number;
}

export interface SparkCutPointResult {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

export interface SparkCompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: SparkSessionMessage[];
  turnPrefixMessages: SparkSessionMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  settings: SparkCompactionSettings;
}

export interface SparkCompactionSummaryResult<T = unknown> {
  summary: string;
  details?: T;
}

export type SparkCompactionSummarizer<T = unknown> = (
  preparation: SparkCompactionPreparation,
) => SparkCompactionSummaryResult<T> | Promise<SparkCompactionSummaryResult<T>>;

export interface SparkTranscriptMessageForCompaction {
  role: string;
  text: string;
  display?: boolean;
  customType?: string;
  toolName?: string;
  toolCallId?: string;
  status?: string;
}

export interface SparkVisibleTranscriptCompactionResult {
  record: SparkSessionRecord;
  entry: SparkCompactionEntry<{ mode: "deterministic"; summarizedMessages: number }>;
  keptMessages: SparkSessionMessage[];
}

export interface SparkBranchNavigationSummaryResult {
  activeLeafId: string | null;
  editorText?: string;
  summaryEntry?: SparkBranchSummaryEntry<{ mode: "deterministic"; summarizedEntries: number }>;
}

export function shouldSparkCompact(
  contextTokens: number,
  contextWindow: number,
  settings: SparkCompactionSettings = DEFAULT_SPARK_COMPACTION_SETTINGS,
): boolean {
  if (!settings.enabled) return false;
  const reserveTokens = Math.min(
    settings.reserveTokens,
    Math.max(1, Math.floor(contextWindow * 0.2)),
  );
  return contextTokens > contextWindow - reserveTokens;
}

export function estimateSparkTokens(message: SparkSessionMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user":
    case "custom":
    case "toolResult": {
      chars = estimateContentChars(message.content);
      break;
    }
    case "assistant": {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!block || typeof block !== "object" || typeof block.type !== "string") continue;
          if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
          else if (block.type === "thinking" && typeof block.thinking === "string") {
            chars += block.thinking.length;
          } else if (block.type === "toolCall") {
            chars += String(block.name ?? "").length + JSON.stringify(block.arguments ?? {}).length;
          }
        }
      } else {
        chars = estimateContentChars(message.content);
      }
      break;
    }
    case "bashExecution": {
      chars = estimateScalarChars(message.command) + estimateScalarChars(message.output);
      break;
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = estimateScalarChars(message.summary);
      break;
    }
    default:
      chars = estimateContentChars(message.content);
  }
  return Math.ceil(chars / 4);
}

export function estimateSparkContextTokens(
  messages: SparkSessionMessage[],
): SparkContextUsageEstimate {
  const tokens = messages.reduce((sum, message) => sum + estimateSparkTokens(message), 0);
  return { tokens, trailingTokens: tokens };
}

export function findSparkCompactionCutPoint(
  entries: SparkSessionEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): SparkCutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]!;
  for (let i = endIndex - 1; i >= startIndex; i -= 1) {
    const entry = entries[i]!;
    if (entry.type !== "message") continue;
    accumulatedTokens += estimateSparkTokens((entry as SparkSessionMessageEntry).message);
    if (accumulatedTokens >= keepRecentTokens) {
      cutIndex = cutPoints.find((point) => point >= i) ?? cutIndex;
      break;
    }
  }

  while (cutIndex > startIndex) {
    const prev = entries[cutIndex - 1]!;
    if (prev.type === "compaction" || prev.type === "message") break;
    cutIndex -= 1;
  }

  const cutEntry = entries[cutIndex]!;
  const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage
    ? -1
    : findSparkTurnStartIndex(entries, cutIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

export function findSparkTurnStartIndex(
  entries: SparkSessionEntry[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i -= 1) {
    const entry = entries[i]!;
    if (entry.type === "branch_summary" || entry.type === "custom_message") return i;
    if (entry.type === "message") {
      const role = (entry as SparkSessionMessageEntry).message.role;
      if (role === "user" || role === "bashExecution") return i;
    }
  }
  return -1;
}

export function prepareSparkCompaction(
  record: SparkSessionRecord,
  leafId: string | null = getSparkSessionLeafId(record),
  settings: SparkCompactionSettings = DEFAULT_SPARK_COMPACTION_SETTINGS,
): SparkCompactionPreparation | undefined {
  const pathEntries = getSparkSessionBranch(record, leafId);
  if (pathEntries.length === 0) return undefined;
  if (pathEntries.at(-1)?.type === "compaction") return undefined;

  const prevCompactionIndex = findLastIndex(pathEntries, (entry) => entry.type === "compaction");
  const previousSummary =
    prevCompactionIndex >= 0
      ? (pathEntries[prevCompactionIndex] as SparkCompactionEntry).summary
      : undefined;
  let boundaryStart = 0;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex] as SparkCompactionEntry;
    const firstKeptIndex = pathEntries.findIndex(
      (entry) => entry.id === prevCompaction.firstKeptEntryId,
    );
    boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : prevCompactionIndex + 1;
  }

  const cutPoint = findSparkCompactionCutPoint(
    pathEntries,
    boundaryStart,
    pathEntries.length,
    settings.keepRecentTokens,
  );
  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) return undefined;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize = entriesToMessages(pathEntries.slice(boundaryStart, historyEnd));
  const turnPrefixMessages = cutPoint.isSplitTurn
    ? entriesToMessages(pathEntries.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex))
    : [];
  const tokensBefore = estimateSparkContextTokens(entriesToMessages(pathEntries)).tokens;

  return {
    firstKeptEntryId: firstKeptEntry.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    settings,
  };
}

export async function compactSparkSessionRecord<T = unknown>(
  record: SparkSessionRecord,
  preparation: SparkCompactionPreparation,
  summarizer: SparkCompactionSummarizer<T>,
): Promise<SparkCompactionEntry<T>> {
  const result = await summarizer(preparation);
  const entry: SparkCompactionEntry<T> = {
    type: "compaction",
    id: createEntryId(record.entries),
    parentId: getSparkSessionLeafId(record),
    timestamp: new Date().toISOString(),
    summary: result.summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: result.details,
  };
  record.entries.push(entry);
  return entry;
}

export async function compactSparkVisibleTranscript(
  store: SparkSessionStore,
  messages: readonly SparkTranscriptMessageForCompaction[],
  options: {
    sessionId?: string;
    customInstructions?: string;
    settings?: SparkCompactionSettings;
  } = {},
): Promise<SparkVisibleTranscriptCompactionResult | undefined> {
  const exportable = messages.filter(
    (message) => message.display !== false && message.text.trim().length > 0,
  );
  if (exportable.length < 2) return undefined;

  const record = store.createSession({
    id: options.sessionId ?? `compact-${Date.now().toString(36)}`,
  });
  for (const message of exportable) {
    store.appendMessage(record, transcriptMessageToSessionMessage(message));
  }

  const settings = options.settings ?? manualSparkCompactionSettings(record);
  const preparation = prepareSparkCompaction(record, undefined, settings);
  if (!preparation || preparation.messagesToSummarize.length === 0) return undefined;

  const entry = await compactSparkSessionRecord(record, preparation, (input) =>
    deterministicSparkCompactionSummary(input, options.customInstructions),
  );
  await store.save(record);
  return {
    record,
    entry,
    keptMessages: getCompactionKeptMessages(record, entry),
  };
}

export function deterministicSparkCompactionSummary(
  preparation: SparkCompactionPreparation,
  customInstructions?: string,
): SparkCompactionSummaryResult<{ mode: "deterministic"; summarizedMessages: number }> {
  const sections: string[] = [];
  if (preparation.previousSummary) {
    sections.push(`Previous summary:\n${preparation.previousSummary}`);
  }
  if (customInstructions?.trim()) {
    sections.push(`Custom focus: ${customInstructions.trim()}`);
  }
  const summarized = summarizeSparkMessagesWithinBudget(
    preparation.messagesToSummarize,
    MAX_DETERMINISTIC_COMPACTION_SUMMARY_CHARS,
  );
  sections.push(
    summarized.length > 0
      ? `Conversation summary:\n${summarized}`
      : "Conversation summary:\nNo prior history to summarize.",
  );
  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    sections.push(
      `Turn Context (split turn):\n${summarizeSparkMessages(preparation.turnPrefixMessages, 8)}`,
    );
  }
  return {
    summary: sections.join("\n\n---\n\n"),
    details: { mode: "deterministic", summarizedMessages: preparation.messagesToSummarize.length },
  };
}

export function appendSparkBranchSummary(
  record: SparkSessionRecord,
  targetId: string | null,
  entriesToSummarize: readonly SparkSessionEntry[],
  options: { customInstructions?: string } = {},
): SparkBranchSummaryEntry<{ mode: "deterministic"; summarizedEntries: number }> | undefined {
  if (entriesToSummarize.length === 0) return undefined;
  const existing = new Set(record.entries.map((entry) => entry.id));
  const entry: SparkBranchSummaryEntry<{ mode: "deterministic"; summarizedEntries: number }> = {
    type: "branch_summary",
    id: createEntryId(existing),
    parentId: targetId,
    timestamp: new Date().toISOString(),
    fromId: entriesToSummarize.at(-1)?.id ?? targetId ?? "root",
    summary: deterministicSparkBranchSummary(entriesToSummarize, options.customInstructions),
    details: { mode: "deterministic", summarizedEntries: entriesToSummarize.length },
  };
  record.entries.push(entry);
  return entry;
}

export function navigateSparkSessionBranchWithSummary(
  record: SparkSessionRecord,
  targetId: string,
  options: { summarize?: boolean; customInstructions?: string } = {},
): SparkBranchNavigationSummaryResult {
  const oldLeafId = getSparkSessionLeafId(record);
  if (targetId === oldLeafId) return { activeLeafId: oldLeafId };
  const target = record.entries.find((entry) => entry.id === targetId);
  if (!target) throw new Error(`Session entry not found: ${targetId}`);
  const entriesToSummarize = collectSparkBranchEntriesToSummarize(record, oldLeafId, targetId);
  const targetLeafId =
    target.type === "message" && target.message.role === "user" ? target.parentId : targetId;
  let summaryEntry: SparkBranchNavigationSummaryResult["summaryEntry"];
  if (options.summarize) {
    summaryEntry = appendSparkBranchSummary(record, targetLeafId, entriesToSummarize, {
      customInstructions: options.customInstructions,
    });
    return { activeLeafId: summaryEntry?.id ?? targetLeafId, summaryEntry };
  }
  return { activeLeafId: switchSparkSessionLeaf(record, targetLeafId) };
}

export function collectSparkBranchEntriesToSummarize(
  record: SparkSessionRecord,
  oldLeafId: string | null,
  targetId: string,
): SparkSessionEntry[] {
  if (!oldLeafId) return [];
  const oldBranch = getSparkSessionBranch(record, oldLeafId);
  const targetBranch = getSparkSessionBranch(record, targetId);
  const targetIds = new Set(targetBranch.map((entry) => entry.id));
  const entries: SparkSessionEntry[] = [];
  for (let index = oldBranch.length - 1; index >= 0; index -= 1) {
    const entry = oldBranch[index]!;
    if (targetIds.has(entry.id)) break;
    entries.unshift(entry);
  }
  return entries;
}

export function entriesToMessages(entries: SparkSessionEntry[]): SparkSessionMessage[] {
  return entries
    .map((entry) => messageFromEntryForCompaction(entry))
    .filter((message): message is SparkSessionMessage => message !== undefined);
}

function messageFromEntryForCompaction(entry: SparkSessionEntry): SparkSessionMessage | undefined {
  if (entry.type === "compaction") return undefined;
  if (entry.type === "message") return (entry as SparkSessionMessageEntry).message;
  if (entry.type === "custom_message") {
    const custom = entry as SparkCustomMessageEntry;
    const details = isRecord(custom.details) ? custom.details : {};
    const metadata = parseSparkPromptItemMetadata(details[SPARK_PROMPT_ITEM_METADATA_KEY]);
    const authority =
      metadata?.authority === "system" ||
      metadata?.authority === "developer" ||
      metadata?.authority === "runtime_control" ||
      metadata?.authority === "runtime_data"
        ? metadata.authority
        : "runtime_data";
    return {
      role: "custom",
      content: custom.content,
      customType: custom.customType,
      display: custom.display,
      details,
      promptAuthority: authority,
      promptTrust: metadata?.trust ?? "untrusted",
      promptVisibility: custom.display === false ? "hidden" : (metadata?.visibility ?? "visible"),
      promptPersistence: "session",
      timestamp: Date.parse(custom.timestamp),
    };
  }
  if (entry.type === "branch_summary") {
    return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId };
  }
  return undefined;
}

function manualSparkCompactionSettings(record: SparkSessionRecord): SparkCompactionSettings {
  const messageCount = record.entries.filter((entry) => entry.type === "message").length;
  return {
    ...DEFAULT_SPARK_COMPACTION_SETTINGS,
    keepRecentTokens: Math.max(1, Math.floor(messageCount / 2)),
  };
}

function transcriptMessageToSessionMessage(
  message: SparkTranscriptMessageForCompaction,
): SparkSessionMessage {
  const label = message.toolName
    ? `${message.toolName}${message.status ? ` [${message.status}]` : ""}`
    : message.customType;
  return {
    role: normalizeTranscriptRole(message.role),
    content: label ? `${label}: ${message.text}` : message.text,
    timestamp: Date.now(),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  };
}

function normalizeTranscriptRole(role: string): string {
  if (role === "tool") return "toolResult";
  if (role === "thinking") return "custom";
  if (role === "custom") return "custom";
  return role;
}

function getCompactionKeptMessages(
  record: SparkSessionRecord,
  compaction: SparkCompactionEntry,
): SparkSessionMessage[] {
  const branch = getSparkSessionBranch(record, compaction.id);
  const kept: SparkSessionEntry[] = [];
  let foundFirstKept = false;
  for (const entry of branch) {
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept && entry.type === "message") kept.push(entry);
  }
  return entriesToMessages(kept);
}

function deterministicSparkBranchSummary(
  entries: readonly SparkSessionEntry[],
  customInstructions?: string,
): string {
  const messages = entriesToMessages([...entries]);
  const lines = ["The following is a summary of a branch that this conversation came back from:"];
  if (customInstructions?.trim()) lines.push(`Custom focus: ${customInstructions.trim()}`);
  lines.push(summarizeSparkMessages(messages, 16) || "No content to summarize.");
  return lines.join("\n\n");
}

function summarizeSparkMessages(messages: readonly SparkSessionMessage[], limit: number): string {
  return messages
    .slice(0, limit)
    .map((message, index) => {
      const text = extractMessageText(message).replace(/\s+/gu, " ").trim();
      const truncated = text.length > 220 ? `${text.slice(0, 217)}...` : text;
      const authority = typeof message.promptAuthority === "string" ? message.promptAuthority : "";
      const trust = typeof message.promptTrust === "string" ? message.promptTrust : "";
      const promptLabel = authority
        ? ` [authority=${authority}${trust ? `, trust=${trust}` : ""}]`
        : "";
      return `${index + 1}. ${message.role}${promptLabel}: ${truncated || "[non-text content]"}`;
    })
    .join("\n");
}

function summarizeSparkMessagesWithinBudget(
  messages: readonly SparkSessionMessage[],
  maxChars: number,
): string {
  if (messages.length === 0 || maxChars <= 0) return "";
  const weights = messages.map(messageSummaryWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const prefixBudget = messages.reduce(
    (sum, message, index) => sum + `${index + 1}. ${message.role}: `.length + 1,
    0,
  );
  const contentBudget = Math.max(messages.length * 24, maxChars - prefixBudget);

  const lines = messages.map((message, index) => {
    const text = extractMessageText(message).replace(/\s+/gu, " ").trim();
    const authority = typeof message.promptAuthority === "string" ? message.promptAuthority : "";
    const trust = typeof message.promptTrust === "string" ? message.promptTrust : "";
    const promptLabel = authority
      ? ` [authority=${authority}${trust ? `, trust=${trust}` : ""}]`
      : "";
    const allowance = Math.max(
      24,
      Math.floor((contentBudget * (weights[index] ?? 1)) / Math.max(1, totalWeight)),
    );
    const summary = text || "[non-text content]";
    const truncated =
      summary.length > allowance ? `${summary.slice(0, Math.max(1, allowance - 1))}…` : summary;
    return `${index + 1}. ${message.role}${promptLabel}: ${truncated}`;
  });
  const summary = lines.join("\n");
  return summary.length <= maxChars ? summary : `${summary.slice(0, maxChars - 1)}…`;
}

function messageSummaryWeight(message: SparkSessionMessage): number {
  if (message.role === "user") return 4;
  if (message.role === "assistant" || message.role === "custom") return 3;
  if (message.role === "toolResult") return 1;
  return 2;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function unitRatio(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractMessageText(message: SparkSessionMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking;
      if (record.type === "toolCall")
        return `tool call ${typeof record.name === "string" ? record.name : ""}`;
      if (record.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function findValidCutPoints(
  entries: SparkSessionEntry[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    const entry = entries[i]!;
    if (entry.type === "branch_summary" || entry.type === "custom_message") cutPoints.push(i);
    if (entry.type !== "message") continue;
    const role = (entry as SparkSessionMessageEntry).message.role;
    if (
      role === "bashExecution" ||
      role === "custom" ||
      role === "branchSummary" ||
      role === "compactionSummary" ||
      role === "user" ||
      role === "assistant"
    ) {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}

function estimateScalarChars(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).length;
  }
  if (typeof value === "symbol") return value.description?.length ?? 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function estimateContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object" || typeof block.type !== "string") continue;
    if (block.type === "text" && typeof block.text === "string") chars += block.text.length;
    if (block.type === "image") chars += 4_800;
  }
  return chars;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i]!)) return i;
  }
  return -1;
}

function createEntryId(entries: SparkSessionEntry[] | Set<string>): string {
  const existing = entries instanceof Set ? entries : new Set(entries.map((entry) => entry.id));
  for (let i = 0; i < 100; i += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}
