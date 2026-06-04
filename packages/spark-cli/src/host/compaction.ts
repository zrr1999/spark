/** Native Spark CLI compaction helpers aligned with current Pi JSONL sessions. */

import { randomUUID } from "node:crypto";

import type {
  SparkCompactionEntry,
  SparkCustomMessageEntry,
  SparkSessionEntry,
  SparkSessionMessage,
  SparkSessionMessageEntry,
  SparkSessionRecord,
} from "./session-store.ts";
import { getSparkSessionBranch, getSparkSessionLeafId } from "./session-navigation.ts";

export interface SparkCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_SPARK_COMPACTION_SETTINGS: SparkCompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

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

export function shouldSparkCompact(
  contextTokens: number,
  contextWindow: number,
  settings: SparkCompactionSettings = DEFAULT_SPARK_COMPACTION_SETTINGS,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
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
      chars = String(message.command ?? "").length + String(message.output ?? "").length;
      break;
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = String(message.summary ?? "").length;
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
    return {
      role: "custom",
      content: custom.content,
      customType: custom.customType,
      display: custom.display,
      details: custom.details,
      timestamp: Date.parse(custom.timestamp),
    };
  }
  if (entry.type === "branch_summary") {
    return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId };
  }
  return undefined;
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

function createEntryId(entries: SparkSessionEntry[]): string {
  const existing = new Set(entries.map((entry) => entry.id));
  for (let i = 0; i < 100; i += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}
