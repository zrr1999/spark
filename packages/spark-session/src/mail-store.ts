import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SparkSessionMailKind = "request" | "inform" | "reply";

export interface SparkSessionMailMessage {
  id: string;
  toSessionId: string;
  fromSessionId: string;
  kind: SparkSessionMailKind;
  intent: string;
  payload: Record<string, unknown>;
  correlationId: string;
  replyToMessageId: string | null;
  idempotencyKey: string | null;
  subject: string | null;
  body: string;
  createdAt: string;
  readAt: string | null;
  ackedAt: string | null;
  source: "cli" | "tui" | "tool";
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
  kind?: SparkSessionMailKind;
  intent?: string;
  payload?: Record<string, unknown>;
  correlationId?: string;
  replyToMessageId?: string | null;
  idempotencyKey?: string;
  subject?: string | null;
  body?: string;
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
    const normalized = normalizeRequiredSessionId(toSessionId, "session");
    return join(this.mailRoot(), mailboxDirectoryName(normalized), "mailbox.json");
  }

  async send(
    input: SparkSessionMailSendInput,
  ): Promise<{ message: SparkSessionMailMessage; path: string; created: boolean }> {
    const toSessionId = normalizeRequiredSessionId(input.toSessionId, "toSessionId");
    const fromSessionId = input.fromSessionId?.trim() || "session:operator";
    const kind = normalizeMailKind(input.kind);
    const intent = input.intent?.trim() || "session.mail";
    const payload = normalizePayload(input.payload);
    const body = input.body?.trim() || renderPayloadText(payload);
    const correlationId = input.correlationId?.trim() || `corr:${randomUUID()}`;
    const replyToMessageId = input.replyToMessageId?.trim() || null;
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    const candidate = {
      toSessionId,
      fromSessionId,
      kind,
      intent,
      payload,
      correlationId: input.correlationId?.trim(),
      replyToMessageId,
      subject: input.subject?.trim() || null,
      body,
    };
    return await this.withSendLock(async () => {
      if (idempotencyKey) {
        const existing = await this.findByIdempotencyKey(idempotencyKey);
        if (existing) {
          assertSameLogicalMessage(existing.message, candidate);
          return { message: existing.message, path: existing.path, created: false };
        }
      }
      return await this.withMailboxLock(toSessionId, async () => {
        const mailbox = await this.load(toSessionId);
        const message: SparkSessionMailMessage = {
          id: `mail:${randomUUID()}`,
          toSessionId,
          fromSessionId,
          kind,
          intent,
          payload,
          correlationId,
          replyToMessageId,
          idempotencyKey,
          subject: input.subject?.trim() || null,
          body,
          createdAt: this.nowIso(),
          readAt: null,
          ackedAt: null,
          source: input.source ?? "cli",
        };
        mailbox.messages.push(message);
        await this.save(toSessionId, mailbox);
        return { message, path: this.mailboxPath(toSessionId), created: true };
      });
    });
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

  async get(toSessionId: string, messageId: string): Promise<SparkSessionMailMessage> {
    const normalized = normalizeRequiredSessionId(toSessionId, "session");
    const id = messageId.trim();
    if (!id) throw new Error("message id is required");
    const message = (await this.load(normalized)).messages.find((item) => item.id === id);
    if (!message) throw new Error(`Spark session mail not found: ${id}`);
    return message;
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
      return assertMailboxOwner(await readMailboxFile(path, normalized), normalized, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const legacyPath = this.legacyMailboxPath(normalized);
    if (legacyPath !== path) {
      try {
        return assertMailboxOwner(
          await readMailboxFile(legacyPath, normalized),
          normalized,
          legacyPath,
        );
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          !(error instanceof SparkSessionMailboxOwnerMismatchError)
        )
          throw error;
      }
    }
    return emptyMailbox(normalized);
  }

  private async updateMessage(
    toSessionId: string,
    messageId: string,
    updater: (message: SparkSessionMailMessage) => SparkSessionMailMessage,
  ): Promise<SparkSessionMailMessage> {
    const normalized = normalizeRequiredSessionId(toSessionId, "session");
    const id = messageId.trim();
    if (!id) throw new Error("message id is required");
    return await this.withMailboxLock(normalized, async () => {
      const mailbox = await this.load(normalized);
      const index = mailbox.messages.findIndex((message) => message.id === id);
      if (index < 0) throw new Error(`Spark session mail not found: ${id}`);
      const updated = updater(mailbox.messages[index]!);
      mailbox.messages[index] = updated;
      await this.save(normalized, mailbox);
      return updated;
    });
  }

  private mailRoot(): string {
    return join(this.sparkHome, "session-mail", "v1");
  }

  private legacyMailboxPath(toSessionId: string): string {
    const normalized = normalizeRequiredSessionId(toSessionId, "session");
    return join(this.mailRoot(), sanitizeSessionMailScope(normalized), "mailbox.json");
  }

  private async withSendLock<T>(operation: () => Promise<T>): Promise<T> {
    return await this.withDirectoryLock(
      join(this.mailRoot(), ".send.lock"),
      "global send",
      operation,
    );
  }

  private async withMailboxLock<T>(toSessionId: string, operation: () => Promise<T>): Promise<T> {
    return await this.withDirectoryLock(
      `${this.mailboxPath(toSessionId)}.lock`,
      `mailbox ${toSessionId}`,
      operation,
    );
  }

  private async withDirectoryLock<T>(
    lockPath: string,
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await mkdir(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockAge = await stat(lockPath)
          .then((entry) => Date.now() - entry.mtimeMs)
          .catch(() => 0);
        if (lockAge > 30_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for Spark session mail ${label} lock`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<{ message: SparkSessionMailMessage; path: string } | undefined> {
    const root = this.mailRoot();
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const matches = new Map<
      string,
      { message: SparkSessionMailMessage; path: string; canonical: boolean }
    >();
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name === ".send.lock") continue;
      try {
        const path = join(root, entry.name, "mailbox.json");
        const raw = JSON.parse(await readFile(path, "utf8")) as Partial<SparkSessionMailboxFile>;
        const fallbackSessionId =
          typeof raw.toSessionId === "string" && raw.toSessionId.trim()
            ? raw.toSessionId
            : entry.name;
        for (const message of normalizeMailbox(raw, fallbackSessionId).messages) {
          if (message.idempotencyKey !== idempotencyKey) continue;
          const canonical = path === this.mailboxPath(message.toSessionId);
          const duplicate = matches.get(message.id);
          if (duplicate) {
            assertSameStoredMessage(duplicate.message, message);
            const duplicateRank = mailStatusRank(duplicate.message);
            const candidateRank = mailStatusRank(message);
            if (candidateRank < duplicateRank || (candidateRank === duplicateRank && !canonical))
              continue;
          }
          matches.set(message.id, { message, path, canonical });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    if (matches.size > 1) {
      throw new Error(
        `Spark session mail idempotency key ${idempotencyKey} exists in multiple mailboxes`,
      );
    }
    const match = matches.values().next().value;
    return match ? { message: match.message, path: match.path } : undefined;
  }

  private async save(toSessionId: string, mailbox: SparkSessionMailboxFile): Promise<void> {
    const path = this.mailboxPath(toSessionId);
    await writeJsonAtomically(path, mailbox);
    const legacyPath = this.legacyMailboxPath(toSessionId);
    if (legacyPath === path) return;
    try {
      assertMailboxOwner(await readMailboxFile(legacyPath, toSessionId), toSessionId, legacyPath);
      await writeJsonAtomically(legacyPath, mailbox);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SparkSessionMailboxOwnerMismatchError)
      )
        throw error;
    }
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

function mailboxDirectoryName(toSessionId: string): string {
  const readable = sanitizeSessionMailScope(toSessionId).slice(0, 80);
  const digest = createHash("sha256").update(toSessionId).digest("hex");
  return `${readable}--${digest}`;
}

export function defaultSparkHome(): string {
  return process.env.SPARK_HOME ?? join(homedir(), ".spark");
}

function normalizeRequiredSessionId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function emptyMailbox(toSessionId: string): SparkSessionMailboxFile {
  return { version: 1, toSessionId, messages: [] };
}

async function readMailboxFile(
  path: string,
  fallbackSessionId: string,
): Promise<SparkSessionMailboxFile> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<SparkSessionMailboxFile>;
  return normalizeMailbox(raw, fallbackSessionId);
}

class SparkSessionMailboxOwnerMismatchError extends Error {}

function assertMailboxOwner(
  mailbox: SparkSessionMailboxFile,
  toSessionId: string,
  path: string,
): SparkSessionMailboxFile {
  if (mailbox.toSessionId !== toSessionId) {
    throw new SparkSessionMailboxOwnerMismatchError(
      `Spark session mailbox owner mismatch at ${path}: expected ${toSessionId}, found ${mailbox.toSessionId}`,
    );
  }
  if (mailbox.messages.some((message) => message.toSessionId !== toSessionId)) {
    throw new Error(`Spark session mailbox at ${path} contains messages for another session`);
  }
  return mailbox;
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
      ? raw.messages
          .map(normalizeMailMessage)
          .filter((message): message is SparkSessionMailMessage => Boolean(message))
          .sort(compareMailMessages)
      : [],
  };
}

function normalizeMailMessage(value: unknown): SparkSessionMailMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<SparkSessionMailMessage>;
  if (
    typeof record.id !== "string" ||
    typeof record.toSessionId !== "string" ||
    typeof record.fromSessionId !== "string" ||
    typeof record.body !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return undefined;
  }
  const subject = typeof record.subject === "string" ? record.subject : null;
  return {
    id: record.id,
    toSessionId: record.toSessionId,
    fromSessionId: record.fromSessionId,
    kind: normalizeMailKind(record.kind),
    intent:
      typeof record.intent === "string" && record.intent.trim() ? record.intent : "session.mail",
    payload: normalizePayload(record.payload),
    correlationId:
      typeof record.correlationId === "string" && record.correlationId.trim()
        ? record.correlationId
        : `legacy:${record.id}`,
    replyToMessageId:
      typeof record.replyToMessageId === "string" && record.replyToMessageId.trim()
        ? record.replyToMessageId
        : null,
    idempotencyKey:
      typeof record.idempotencyKey === "string" && record.idempotencyKey.trim()
        ? record.idempotencyKey
        : null,
    subject,
    body: record.body,
    createdAt: record.createdAt,
    readAt: typeof record.readAt === "string" ? record.readAt : null,
    ackedAt: typeof record.ackedAt === "string" ? record.ackedAt : null,
    source: record.source === "tui" || record.source === "tool" ? record.source : "cli",
  };
}

function normalizeMailKind(value: unknown): SparkSessionMailKind {
  return value === "request" || value === "reply" || value === "inform" ? value : "inform";
}

function normalizePayload(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Spark session mail payload must be a JSON object");
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("payload is not JSON-serializable");
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("payload must serialize to a JSON object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Spark session mail payload must be JSON-serializable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function renderPayloadText(payload: Record<string, unknown>): string {
  for (const key of ["text", "body"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return Object.keys(payload).length > 0 ? JSON.stringify(payload, null, 2) : "";
}

function assertSameStoredMessage(
  left: SparkSessionMailMessage,
  right: SparkSessionMailMessage,
): void {
  const withoutMutableStatus = (message: SparkSessionMailMessage) => ({
    ...message,
    readAt: null,
    ackedAt: null,
  });
  if (JSON.stringify(withoutMutableStatus(left)) !== JSON.stringify(withoutMutableStatus(right))) {
    throw new Error(`Spark session mail ${left.id} differs across mailbox files`);
  }
}

function mailStatusRank(message: SparkSessionMailMessage): number {
  if (message.ackedAt) return 2;
  if (message.readAt) return 1;
  return 0;
}

function assertSameLogicalMessage(
  existing: SparkSessionMailMessage,
  candidate: {
    toSessionId: string;
    fromSessionId: string;
    kind: SparkSessionMailKind;
    intent: string;
    payload: Record<string, unknown>;
    correlationId?: string;
    replyToMessageId: string | null;
    subject: string | null;
    body: string;
  },
): void {
  const comparableExisting = {
    toSessionId: existing.toSessionId,
    fromSessionId: existing.fromSessionId,
    kind: existing.kind,
    intent: existing.intent,
    payload: existing.payload,
    ...(candidate.correlationId ? { correlationId: existing.correlationId } : {}),
    replyToMessageId: existing.replyToMessageId,
    subject: existing.subject,
    body: existing.body,
  };
  const comparableCandidate = {
    toSessionId: candidate.toSessionId,
    fromSessionId: candidate.fromSessionId,
    kind: candidate.kind,
    intent: candidate.intent,
    payload: candidate.payload,
    ...(candidate.correlationId ? { correlationId: candidate.correlationId } : {}),
    replyToMessageId: candidate.replyToMessageId,
    subject: candidate.subject,
    body: candidate.body,
  };
  if (JSON.stringify(comparableExisting) !== JSON.stringify(comparableCandidate)) {
    throw new Error(
      `Spark session mail idempotency key ${existing.idempotencyKey} was reused for a different message`,
    );
  }
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
