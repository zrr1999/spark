/** Persisted Spark agent session facade shared by TUI/daemon-style callers. */

import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";

import { assistantMessageToText, type SparkCliHostServices } from "./bootstrap.ts";
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
  sessionPersistence?: "persistent" | "anonymous";
}

export class SparkAgentSession {
  private readonly services: SparkCliHostServices;

  constructor(services: SparkCliHostServices) {
    this.services = services;
  }

  async run(options: SparkAgentSessionRunOptions): Promise<SparkAgentSessionRunResult> {
    const record = await this.loadOrCreateRecord(options);
    this.services.agentLoop.setViewSessionId(record.header.id);
    const priorMessages = sessionRecordToAgentMessages(record);
    this.services.agentLoop.replaceMessages(priorMessages);
    const beforeCount = this.services.agentLoop.getMessages().length;
    const assistant = await this.services.agentLoop.submit(options.prompt);
    if (!assistant) throw new Error("Spark agent produced no assistant response");

    const newMessages = this.services.agentLoop.getMessages().slice(beforeCount);
    let pendingMessageMetadata = options.messageMetadata;
    for (const message of newMessages) {
      const persisted = agentMessageToSessionMessage(message);
      if (message.role === "user" && pendingMessageMetadata) {
        persisted.metadata = {
          ...recordMetadata(persisted.metadata),
          ...pendingMessageMetadata,
        };
        pendingMessageMetadata = undefined;
      }
      this.services.sessionStore.appendMessage(record, persisted);
    }
    await this.services.sessionStore.save(record);

    return {
      sessionId: record.header.id,
      sessionPath: record.path,
      newMessageCount: newMessages.length,
      assistantText: assistantMessageToText(assistant),
      assistant,
      sessionPersistence: "persistent",
    };
  }

  async runAnonymous(options: SparkAgentSessionRunOptions): Promise<SparkAgentSessionRunResult> {
    this.services.agentLoop.setViewSessionId(options.sessionId);
    this.services.agentLoop.replaceMessages([]);
    const beforeCount = this.services.agentLoop.getMessages().length;
    const assistant = await this.services.agentLoop.submit(options.prompt);
    if (!assistant) throw new Error("Spark agent produced no assistant response");

    return {
      sessionId: options.sessionId,
      sessionPath: "",
      newMessageCount: this.services.agentLoop.getMessages().slice(beforeCount).length,
      assistantText: assistantMessageToText(assistant),
      assistant,
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

export function sessionRecordToAgentMessages(record: SparkSessionRecord): Message[] {
  return sessionEntriesToAgentMessages(record.entries);
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
  const pathEntries = branchEntriesForLeaf(entries);
  const latestCompactionIndex = findLastIndex(
    pathEntries,
    (entry): entry is SparkCompactionEntry => entry.type === "compaction",
  );
  if (latestCompactionIndex < 0) return entriesToAgentMessages(pathEntries);

  const compaction = pathEntries[latestCompactionIndex] as SparkCompactionEntry;
  const messages: Message[] = [compactionSummaryToUserMessage(compaction)];
  let foundFirstKept = false;
  for (let index = 0; index < latestCompactionIndex; index += 1) {
    const entry = pathEntries[index]!;
    if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) appendEntryAgentMessage(messages, entry);
  }
  for (let index = latestCompactionIndex + 1; index < pathEntries.length; index += 1)
    appendEntryAgentMessage(messages, pathEntries[index]!);
  return messages;
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

function entriesToAgentMessages(entries: SparkSessionEntry[]): Message[] {
  const messages: Message[] = [];
  for (const entry of entries) appendEntryAgentMessage(messages, entry);
  return messages;
}

function appendEntryAgentMessage(messages: Message[], entry: SparkSessionEntry): void {
  const message = entryToAgentMessage(entry);
  if (message) messages.push(message);
}

function entryToAgentMessage(entry: SparkSessionEntry): Message | undefined {
  if (entry.type === "message") return sessionMessageToAgentMessage(entry.message);
  if (entry.type === "custom_message") return customMessageToUserMessage(entry);
  if (entry.type === "branch_summary") return branchSummaryToUserMessage(entry);
  return undefined;
}

function customMessageToUserMessage(entry: SparkCustomMessageEntry): UserMessage | undefined {
  if (entry.display === false || !isKnownContent(entry.content)) return undefined;
  return {
    role: "user",
    content: entry.content as UserMessage["content"],
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  };
}

function branchSummaryToUserMessage(entry: SparkBranchSummaryEntry): UserMessage {
  return {
    role: "user",
    content: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${entry.summary}\n</summary>`,
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  };
}

function compactionSummaryToUserMessage(entry: SparkCompactionEntry): UserMessage {
  return {
    role: "user",
    content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${entry.summary}\n</summary>`,
    timestamp: normalizeTimestamp(Date.parse(entry.timestamp)),
  };
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
