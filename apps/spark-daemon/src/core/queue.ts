/** Local JSON file queue for the Spark daemon core. */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultSparkDaemonRoot, type SparkDaemonPathOptions } from "./paths.ts";
import {
  type SparkDaemonFailedQueuePayload,
  type SparkDaemonQueueEntry,
  type SparkDaemonQueuePayload,
  type SparkDaemonQueueState,
  type SparkDaemonTask,
  validateSparkDaemonTask,
} from "./types.ts";

export interface SparkDaemonQueueOptions extends SparkDaemonPathOptions {}

let queueFileSequence = 0;

export class SparkDaemonQueue {
  readonly rootDir: string;
  readonly inboxDir: string;
  readonly processedDir: string;
  readonly failedDir: string;

  constructor(options: SparkDaemonQueueOptions = {}) {
    this.rootDir = defaultSparkDaemonRoot(options);
    this.inboxDir = join(this.rootDir, "inbox");
    this.processedDir = join(this.rootDir, "processed");
    this.failedDir = join(this.rootDir, "failed");
  }

  async init(): Promise<void> {
    await Promise.all([
      mkdir(this.inboxDir, { recursive: true }),
      mkdir(this.processedDir, { recursive: true }),
      mkdir(this.failedDir, { recursive: true }),
    ]);
  }

  async enqueue(task: SparkDaemonTask): Promise<SparkDaemonQueueEntry> {
    await this.init();
    const payload: SparkDaemonQueuePayload = {
      enqueuedAt: new Date().toISOString(),
      task: validateSparkDaemonTask(task),
    };
    queueFileSequence = (queueFileSequence + 1) % 1_000_000;
    const sequence = queueFileSequence.toString().padStart(6, "0");
    const fileName = `${Date.now()}_${sequence}_${payload.task.type.replace(/\./g, "_")}_${randomUUID().slice(0, 8)}.json`;
    const filePath = join(this.inboxDir, fileName);
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { fileName, filePath, payload };
  }

  async list(state: SparkDaemonQueueState = "inbox"): Promise<string[]> {
    await this.init();
    const dir = this.dirForState(state);
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).filter((entry) => entry.endsWith(".json")).sort(compareStrings);
  }

  async listEntries(state: SparkDaemonQueueState = "inbox"): Promise<SparkDaemonQueueEntry[]> {
    const entries = await this.list(state);
    const out: SparkDaemonQueueEntry[] = [];
    for (const fileName of entries) {
      try {
        out.push(await this.readEntry(fileName, state));
      } catch {
        // Listing should stay best-effort; worker reads surface malformed payloads as failures.
      }
    }
    return out;
  }

  async readEntry(
    fileName: string,
    state: SparkDaemonQueueState = "inbox",
  ): Promise<SparkDaemonQueueEntry> {
    const filePath = join(this.dirForState(state), normalizeQueueFileName(fileName));
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SparkDaemonQueuePayload>;
    if (typeof parsed.enqueuedAt !== "string") throw new Error("queue entry missing enqueuedAt");
    const task = validateSparkDaemonTask(parsed.task);
    const payload: SparkDaemonQueuePayload = { enqueuedAt: parsed.enqueuedAt, task };
    if (typeof parsed.processedAt === "string") payload.processedAt = parsed.processedAt;
    if (Object.hasOwn(parsed, "result")) payload.result = parsed.result;
    if (typeof parsed.failedAt === "string") payload.failedAt = parsed.failedAt;
    if (typeof parsed.error === "string") payload.error = parsed.error;
    return {
      fileName: normalizeQueueFileName(fileName),
      filePath,
      payload,
    };
  }

  async markProcessed(fileName: string, result?: unknown): Promise<string> {
    await this.init();
    const normalized = normalizeQueueFileName(fileName);
    const inboxPath = join(this.inboxDir, normalized);
    const target = join(this.processedDir, normalized);
    const entry = await this.readEntry(normalized, "inbox");
    const payload: SparkDaemonQueuePayload = {
      ...entry.payload,
      processedAt: new Date().toISOString(),
    };
    const serializedResult = serializeQueueResult(result);
    if (serializedResult !== undefined) payload.result = serializedResult;
    await writeFile(inboxPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(inboxPath, target);
    return target;
  }

  async markFailed(fileName: string, error: unknown): Promise<string> {
    await this.init();
    const normalized = normalizeQueueFileName(fileName);
    const inboxPath = join(this.inboxDir, normalized);
    const failedPath = join(this.failedDir, normalized);
    const errorText = error instanceof Error ? error.message : String(error);
    let failedPayload: SparkDaemonFailedQueuePayload | Record<string, unknown>;
    try {
      const entry = await this.readEntry(normalized, "inbox");
      failedPayload = {
        ...entry.payload,
        failedAt: new Date().toISOString(),
        error: errorText,
      };
    } catch {
      failedPayload = {
        enqueuedAt: new Date().toISOString(),
        failedAt: new Date().toISOString(),
        error: errorText,
      };
    }
    await writeFile(inboxPath, `${JSON.stringify(failedPayload, null, 2)}\n`, "utf8");
    await rename(inboxPath, failedPath);
    return failedPath;
  }

  dirForState(state: SparkDaemonQueueState): string {
    switch (state) {
      case "inbox":
        return this.inboxDir;
      case "processed":
        return this.processedDir;
      case "failed":
        return this.failedDir;
    }
  }
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function serializeQueueResult(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    return { unserializable: true, type: typeof value };
  }
}

function normalizeQueueFileName(fileName: string): string {
  const normalized = fileName.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) {
    throw new Error(`invalid daemon queue file name: ${fileName}`);
  }
  return normalized;
}
