import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defaultSparkHome } from "./session-store.ts";

export interface SparkSessionMailMessage {
  id: string;
  toSessionId: string;
  fromSessionId: string;
  subject: string | null;
  body: string;
  createdAt: string;
  readAt: string | null;
  ackedAt: string | null;
  source: "cli" | "tui";
}

export interface SparkSessionMailboxFile {
  version: 1;
  toSessionId: string;
  messages: SparkSessionMailMessage[];
}

export interface SparkSessionMailStoreOptions {
  sparkHome?: string;
  now?: () => number;
}

export interface SparkSessionMailSendInput {
  toSessionId: string;
  fromSessionId?: string;
  subject?: string | null;
  body: string;
  source?: SparkSessionMailMessage["source"];
}

export interface SparkSessionMailListOptions {
  includeAcked?: boolean;
}

export class SparkSessionMailStore {
  readonly sparkHome: string;
  private readonly options: SparkSessionMailStoreOptions;

  constructor(options: SparkSessionMailStoreOptions = {}) {
    this.options = options;
    this.sparkHome = options.sparkHome ?? defaultSparkHome();
  }

  mailboxPath(toSessionId: string): string {
    return join(
      this.sparkHome,
      "session-mail",
      "v1",
      sanitizeSessionMailScope(toSessionId),
      "mailbox.json",
    );
  }

  async send(
    input: SparkSessionMailSendInput,
  ): Promise<{ message: SparkSessionMailMessage; path: string }> {
    const toSessionId = normalizeRequiredSessionId(input.toSessionId, "toSessionId");
    const body = input.body.trim();
    if (!body) throw new Error("spark sessions mailto requires --message <text>");
    const message: SparkSessionMailMessage = {
      id: `mail:${randomUUID()}`,
      toSessionId,
      fromSessionId: input.fromSessionId?.trim() || "session:operator",
      subject: input.subject?.trim() || null,
      body,
      createdAt: this.nowIso(),
      readAt: null,
      ackedAt: null,
      source: input.source ?? "cli",
    };
    const mailbox = await this.load(toSessionId);
    mailbox.messages.push(message);
    await this.save(toSessionId, mailbox);
    return { message, path: this.mailboxPath(toSessionId) };
  }

  async list(
    toSessionId: string,
    options: SparkSessionMailListOptions = {},
  ): Promise<SparkSessionMailMessage[]> {
    const mailbox = await this.load(toSessionId);
    return mailbox.messages
      .filter((message) => options.includeAcked || message.ackedAt === null)
      .sort(compareMailMessages);
  }

  async read(toSessionId: string, messageId: string): Promise<SparkSessionMailMessage> {
    return await this.updateMessage(toSessionId, messageId, (message) => ({
      ...message,
      readAt: message.readAt ?? this.nowIso(),
    }));
  }

  async ack(toSessionId: string, messageId: string): Promise<SparkSessionMailMessage> {
    return await this.updateMessage(toSessionId, messageId, (message) => ({
      ...message,
      readAt: message.readAt ?? this.nowIso(),
      ackedAt: message.ackedAt ?? this.nowIso(),
    }));
  }

  async load(toSessionId: string): Promise<SparkSessionMailboxFile> {
    const normalized = normalizeRequiredSessionId(toSessionId, "session");
    const path = this.mailboxPath(normalized);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as Partial<SparkSessionMailboxFile>;
      return normalizeMailbox(raw, normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMailbox(normalized);
      throw error;
    }
  }

  private async updateMessage(
    toSessionId: string,
    messageId: string,
    updater: (message: SparkSessionMailMessage) => SparkSessionMailMessage,
  ): Promise<SparkSessionMailMessage> {
    const normalized = normalizeRequiredSessionId(toSessionId, "session");
    const id = messageId.trim();
    if (!id) throw new Error("message id is required");
    const mailbox = await this.load(normalized);
    const index = mailbox.messages.findIndex((message) => message.id === id);
    if (index < 0) throw new Error(`Spark session mail not found: ${id}`);
    const updated = updater(mailbox.messages[index]!);
    mailbox.messages[index] = updated;
    await this.save(normalized, mailbox);
    return updated;
  }

  private async save(toSessionId: string, mailbox: SparkSessionMailboxFile): Promise<void> {
    const path = this.mailboxPath(toSessionId);
    await writeJsonAtomically(path, mailbox);
  }

  private nowIso(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }
}

export function sessionMailStatus(message: SparkSessionMailMessage): "pending" | "read" | "acked" {
  if (message.ackedAt) return "acked";
  if (message.readAt) return "read";
  return "pending";
}

export function sanitizeSessionMailScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-") || "default";
}

function normalizeRequiredSessionId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function emptyMailbox(toSessionId: string): SparkSessionMailboxFile {
  return { version: 1, toSessionId, messages: [] };
}

function normalizeMailbox(
  raw: Partial<SparkSessionMailboxFile>,
  fallbackSessionId: string,
): SparkSessionMailboxFile {
  return {
    version: 1,
    toSessionId:
      typeof raw.toSessionId === "string" && raw.toSessionId.trim()
        ? raw.toSessionId
        : fallbackSessionId,
    messages: Array.isArray(raw.messages)
      ? raw.messages.filter(isMailMessage).sort(compareMailMessages)
      : [],
  };
}

function isMailMessage(value: unknown): value is SparkSessionMailMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SparkSessionMailMessage>;
  return (
    typeof record.id === "string" &&
    typeof record.toSessionId === "string" &&
    typeof record.fromSessionId === "string" &&
    typeof record.body === "string" &&
    typeof record.createdAt === "string"
  );
}

function compareMailMessages(
  left: SparkSessionMailMessage,
  right: SparkSessionMailMessage,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
