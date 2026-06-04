/** Persisted Spark agent session facade shared by TUI/daemon-style callers. */

import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";

import { assistantMessageToText, type SparkCliHostServices } from "./bootstrap.ts";
import type {
  SparkSessionEntry,
  SparkSessionMessage,
  SparkSessionMessageEntry,
  SparkSessionRecord,
} from "./session-store.ts";

export interface SparkAgentSessionRunOptions {
  sessionId: string;
  prompt: string;
  reset?: boolean;
}

export interface SparkAgentSessionRunResult {
  sessionId: string;
  sessionPath: string;
  newMessageCount: number;
  assistantText: string;
  assistant?: AssistantMessage;
}

export class SparkAgentSession {
  private readonly services: SparkCliHostServices;

  constructor(services: SparkCliHostServices) {
    this.services = services;
  }

  async run(options: SparkAgentSessionRunOptions): Promise<SparkAgentSessionRunResult> {
    const record = await this.loadOrCreateRecord(options);
    const priorMessages = sessionRecordToAgentMessages(record);
    this.services.agentLoop.replaceMessages(priorMessages);
    const beforeCount = this.services.agentLoop.getMessages().length;
    const assistant = await this.services.agentLoop.submit(options.prompt);
    if (!assistant) throw new Error("Spark agent produced no assistant response");

    const newMessages = this.services.agentLoop.getMessages().slice(beforeCount);
    for (const message of newMessages) {
      this.services.sessionStore.appendMessage(record, agentMessageToSessionMessage(message));
    }
    await this.services.sessionStore.save(record);

    return {
      sessionId: record.header.id,
      sessionPath: record.path,
      newMessageCount: newMessages.length,
      assistantText: assistantMessageToText(assistant),
      assistant,
    };
  }

  private async loadOrCreateRecord(
    options: SparkAgentSessionRunOptions,
  ): Promise<SparkSessionRecord> {
    if (options.reset) return this.services.sessionStore.createSession({ id: options.sessionId });
    const existing = await this.findExistingRecord(options.sessionId);
    return existing ?? this.services.sessionStore.createSession({ id: options.sessionId });
  }

  private async findExistingRecord(sessionId: string): Promise<SparkSessionRecord | undefined> {
    for (const info of await this.services.sessionStore.list()) {
      if (info.id === sessionId) return await this.services.sessionStore.load(info.path);
    }
    return undefined;
  }
}

export function sessionRecordToAgentMessages(record: SparkSessionRecord): Message[] {
  return record.entries
    .filter((entry): entry is SparkSessionMessageEntry => entry.type === "message")
    .map((entry) => sessionMessageToAgentMessage(entry.message))
    .filter((message): message is Message => Boolean(message));
}

export function sessionMessageToAgentMessage(message: SparkSessionMessage): Message | undefined {
  if (message.role === "user" && isKnownContent(message.content)) {
    return {
      role: "user",
      content: message.content as UserMessage["content"],
      timestamp: normalizeTimestamp(message.timestamp),
    };
  }
  if (message.role === "assistant" && Array.isArray(message.content)) return message as Message;
  if (message.role === "toolResult" && Array.isArray(message.content)) return message as Message;
  return undefined;
}

export function agentMessageToSessionMessage(message: Message): SparkSessionMessage {
  return { ...(message as unknown as Record<string, unknown>), role: message.role };
}

export function sessionEntriesToAgentMessages(entries: SparkSessionEntry[]): Message[] {
  return sessionRecordToAgentMessages({
    path: "",
    header: { type: "session", id: "", timestamp: "", cwd: "" },
    entries,
  });
}

function isKnownContent(content: unknown): boolean {
  return typeof content === "string" || Array.isArray(content);
}

function normalizeTimestamp(timestamp: unknown): number {
  return typeof timestamp === "number" ? timestamp : Date.now();
}
