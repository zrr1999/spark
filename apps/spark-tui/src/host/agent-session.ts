/** Persisted Spark agent session facade shared by TUI/daemon-style callers. */

import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { sparkTextPhaseFromSignature } from "@zendev-lab/spark-protocol";
import {
  SPARK_PROMPT_ITEM_METADATA_KEY,
  lowerSparkPromptItems,
  parseSparkPromptItemMetadata,
  sparkPromptItemFromProviderMessage,
  sparkPromptItemMetadata,
  sparkRuntimePromptItem,
  type SparkPromptItem,
  type SparkRunOutcome,
} from "@zendev-lab/spark-turn";

import type { SparkCliHostServices } from "./bootstrap.ts";
import type {
  SparkBranchSummaryEntry,
  SparkCompactionEntry,
  SparkCustomMessageEntry,
  SparkSessionEntry,
  SparkSessionMessage,
  SparkSessionRecord,
} from "./session-store.ts";

export interface SparkAgentSessionRunOptions {
  sessionId: string;
  prompt: string;
  reset?: boolean;
  forkFromSession?: string;
  /** Display-safe metadata persisted on this turn's submitted user message only. */
  messageMetadata?: Record<string, unknown>;
}

export interface SparkAgentSessionRunResult {
  sessionId: string;
  sessionPath: string;
  newMessageCount: number;
  assistantText: string;
  assistant?: AssistantMessage;
  outcome?: SparkRunOutcome;
  sessionPersistence?: "persistent" | "anonymous";
}

export class SparkAgentSession {
  private readonly services: SparkCliHostServices;

  constructor(services: SparkCliHostServices) {
    this.services = services;
  }

  async run(options: SparkAgentSessionRunOptions): Promise<SparkAgentSessionRunResult> {
    const record = await this.loadOrCreateRecord(options);
    this.services.runtime.setSessionId(record.header.id);
    this.services.agentLoop.setViewSessionId(record.header.id);
    const priorItems = sessionRecordToPromptItems(record);
    this.services.agentLoop.replacePromptItems(priorItems);
    const beforeCount = this.services.agentLoop.getPromptItems().length;
    const outcome = await this.services.agentLoop.submitWithOutcome(options.prompt);
    const assistant = outcome.assistant;

    const newItems = this.services.agentLoop.getPromptItems().slice(beforeCount);
    let pendingMessageMetadata = options.messageMetadata;
    let persistedCount = 0;
    for (const item of newItems) {
      if (item.persistence !== "session") continue;
      if (item.content.kind === "runtime") {
        const details = {
          ...(item.details ?? {}),
          [SPARK_PROMPT_ITEM_METADATA_KEY]: sparkPromptItemMetadata(item),
        };
        this.services.sessionStore.appendCustomMessage(
          record,
          item.customType ?? "spark-runtime-message",
          item.content.value,
          item.visibility === "visible",
          details,
        );
        persistedCount += 1;
        continue;
      }
      const message = item.content.message as Message;
      const persisted = agentMessageToSessionMessage(message);
      if (item.authority === "user" && pendingMessageMetadata) {
        persisted.metadata = {
          ...recordMetadata(persisted.metadata),
          ...pendingMessageMetadata,
        };
        pendingMessageMetadata = undefined;
      }
      this.services.sessionStore.appendMessage(record, persisted);
      persistedCount += 1;
    }
    await this.services.sessionStore.save(record);

    return {
      sessionId: record.header.id,
      sessionPath: record.path,
      newMessageCount: persistedCount,
      assistantText: assistantMessageToFinalAnswerText(assistant),
      assistant,
      outcome,
      sessionPersistence: "persistent",
    };
  }

  async runAnonymous(options: SparkAgentSessionRunOptions): Promise<SparkAgentSessionRunResult> {
    this.services.runtime.setSessionId(options.sessionId);
    this.services.agentLoop.setViewSessionId(options.sessionId);
    this.services.agentLoop.replacePromptItems([]);
    const beforeCount = this.services.agentLoop.getPromptItems().length;
    const outcome = await this.services.agentLoop.submitWithOutcome(options.prompt);
    const assistant = outcome.assistant;

    return {
      sessionId: options.sessionId,
      sessionPath: "",
      newMessageCount: this.services.agentLoop
        .getPromptItems()
        .slice(beforeCount)
        .filter((item) => item.persistence === "session").length,
      assistantText: assistantMessageToFinalAnswerText(assistant),
      assistant,
      outcome,
      sessionPersistence: "anonymous",
    };
  }

  private async loadOrCreateRecord(
    options: SparkAgentSessionRunOptions,
  ): Promise<SparkSessionRecord> {
    if (options.forkFromSession) {
      const parent = await this.services.sessionStore.loadByRef(options.forkFromSession);
      return this.services.sessionStore.forkSession(parent, { id: options.sessionId });
    }
    if (options.reset) return this.services.sessionStore.createSession({ id: options.sessionId });
    const existing = await this.services.sessionStore.findById(options.sessionId);
    return existing ?? this.services.sessionStore.createSession({ id: options.sessionId });
  }
}

/**
 * Extract only display-safe answer prose from the terminal assistant message.
 * Thinking, tool arguments, and signed commentary remain available in the
 * structured session record but must never become a channel/static reply.
 */
export function assistantMessageToFinalAnswerText(message: {
  content?: unknown;
  stopReason?: unknown;
}): string {
  if (typeof message.content === "string") {
    return message.stopReason === "toolUse" ? "" : message.content;
  }
  if (!Array.isArray(message.content)) return "";
  let hasToolCall = false;
  const textParts = message.content.flatMap((value): Array<{ text: string; phase?: string }> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const part = value as Record<string, unknown>;
    if (part.type === "toolCall" || part.type === "tool-call") hasToolCall = true;
    if (part.type !== "text" || typeof part.text !== "string") return [];
    const phase = sparkTextPhaseFromSignature(part.textSignature);
    if (phase === "commentary") return [];
    return [{ text: part.text, ...(phase ? { phase } : {}) }];
  });
  const explicitFinal = textParts.filter((part) => part.phase === "final_answer");
  if (explicitFinal.length > 0) {
    return explicitFinal
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n");
  }
  if (message.stopReason === "toolUse" || hasToolCall) return "";
  return textParts
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n");
}

export function sessionRecordToAgentMessages(record: SparkSessionRecord): Message[] {
  return lowerSparkPromptItems(sessionRecordToPromptItems(record)) as Message[];
}

export function sessionRecordToPromptItems(record: SparkSessionRecord): SparkPromptItem[] {
  return sessionEntriesToPromptItems(record.entries);
}

export function sessionMessageToAgentMessage(message: SparkSessionMessage): Message | undefined {
  if (message.role === "user" && isKnownContent(message.content)) {
    return {
      role: "user",
      content: message.content as UserMessage["content"],
      timestamp: normalizeTimestamp(message.timestamp),
    };
  }
  if (message.role === "assistant") {
    if (Array.isArray(message.content)) return message as Message;
    if (typeof message.content === "string") {
      return {
        ...(message as unknown as Record<string, unknown>),
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        timestamp: normalizeTimestamp(message.timestamp),
      } as Message;
    }
  }
  if (message.role === "toolResult" && Array.isArray(message.content)) return message as Message;
  return undefined;
}

export function agentMessageToSessionMessage(message: Message): SparkSessionMessage {
  return { ...(message as unknown as Record<string, unknown>), role: message.role };
}

export function sessionEntriesToAgentMessages(entries: SparkSessionEntry[]): Message[] {
  return lowerSparkPromptItems(sessionEntriesToPromptItems(entries)) as Message[];
}

export function sessionEntriesToPromptItems(entries: SparkSessionEntry[]): SparkPromptItem[] {
  const pathEntries = branchEntriesForLeaf(entries);
  const latestCompactionIndex = findLastIndex(
    pathEntries,
    (entry): entry is SparkCompactionEntry => entry.type === "compaction",
  );
  if (latestCompactionIndex < 0) return entriesToPromptItems(pathEntries);

  const compaction = pathEntries[latestCompactionIndex] as SparkCompactionEntry;
  const items: SparkPromptItem[] = [compactionSummaryToPromptItem(compaction)];
  let foundFirstKept = false;
  for (let index = 0; index < latestCompactionIndex; index += 1) {
    const entry = pathEntries[index]!;
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) appendEntryPromptItem(items, entry);
  }
  for (let index = latestCompactionIndex + 1; index < pathEntries.length; index += 1)
    appendEntryPromptItem(items, pathEntries[index]!);
  return items;
}

function branchEntriesForLeaf(entries: SparkSessionEntry[]): SparkSessionEntry[] {
  const leaf = entries.at(-1);
  if (!leaf) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SparkSessionEntry[] = [];
  let current: SparkSessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function entriesToPromptItems(entries: SparkSessionEntry[]): SparkPromptItem[] {
  const items: SparkPromptItem[] = [];
  for (const entry of entries) appendEntryPromptItem(items, entry);
  return items;
}

function appendEntryPromptItem(items: SparkPromptItem[], entry: SparkSessionEntry): void {
  const item = entryToPromptItem(entry);
  if (item) items.push(item);
}

function entryToPromptItem(entry: SparkSessionEntry): SparkPromptItem | undefined {
  if (entry.type === "message") {
    const message = sessionMessageToAgentMessage(entry.message);
    return message
      ? sparkPromptItemFromProviderMessage(
          message as unknown as Record<string, unknown> & { role: string },
        )
      : undefined;
  }
  if (entry.type === "custom_message") return customMessageToPromptItem(entry);
  if (entry.type === "branch_summary") return branchSummaryToPromptItem(entry);
  return undefined;
}

function customMessageToPromptItem(entry: SparkCustomMessageEntry): SparkPromptItem {
  const details = recordMetadata(entry.details);
  const metadata = parseSparkPromptItemMetadata(details[SPARK_PROMPT_ITEM_METADATA_KEY]);
  const authority =
    metadata?.authority === "system" ||
    metadata?.authority === "developer" ||
    metadata?.authority === "runtime_control" ||
    metadata?.authority === "runtime_data"
      ? metadata.authority
      : "runtime_data";
  return sparkRuntimePromptItem({
    authority,
    // Legacy custom messages did not carry authority. Treat them as data rather
    // than silently promoting old transcript text into trusted control.
    trust: metadata?.trust ?? "untrusted",
    visibility: entry.display === false ? "hidden" : (metadata?.visibility ?? "visible"),
    persistence: "session",
    content: entry.content,
    customType: entry.customType,
    details,
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  });
}

function branchSummaryToPromptItem(entry: SparkBranchSummaryEntry): SparkPromptItem {
  return sparkRuntimePromptItem({
    authority: "runtime_data",
    trust: "untrusted",
    visibility: "hidden",
    persistence: "session",
    content: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${entry.summary}\n</summary>`,
    customType: "spark-branch-summary",
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  });
}

function compactionSummaryToPromptItem(entry: SparkCompactionEntry): SparkPromptItem {
  return sparkRuntimePromptItem({
    authority: "runtime_data",
    trust: "untrusted",
    visibility: "hidden",
    persistence: "session",
    content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${entry.summary}\n</summary>`,
    customType: "spark-compaction-summary",
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  });
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function isKnownContent(content: unknown): boolean {
  return typeof content === "string" || Array.isArray(content);
}

function normalizeTimestamp(timestamp: unknown): number {
  return typeof timestamp === "number" ? timestamp : Date.now();
}

function recordMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
