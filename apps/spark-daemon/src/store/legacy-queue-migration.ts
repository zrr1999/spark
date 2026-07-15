import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { validateSparkDaemonTask, type SparkDaemonTask } from "../core/types.ts";
import { SparkInvocationStore, type SparkInvocationStatus } from "./invocations.ts";

const MIGRATION_KEY = "migration.legacy-queue-to-invocations-v1";
const legacyStates = ["inbox", "processed", "failed"] as const;
type LegacyState = (typeof legacyStates)[number];

export interface LegacyQueueMigrationIssue {
  state: LegacyState;
  fileName: string;
  message: string;
}

export interface LegacyQueueMigrationReport {
  migrationKey: typeof MIGRATION_KEY;
  sourceRoot: string;
  archivePath?: string;
  imported: Record<LegacyState, number>;
  malformed: number;
  issues: LegacyQueueMigrationIssue[];
  alreadyComplete: boolean;
  completedAt: string;
}

interface LegacyPayload {
  enqueuedAt: string;
  task: SparkDaemonTask;
  processedAt?: string;
  result?: unknown;
  failedAt?: string;
  error?: string;
}

export async function migrateLegacyQueueHistory(input: {
  db: DatabaseSync;
  queueRoot: string;
  now?: string;
}): Promise<LegacyQueueMigrationReport> {
  const previous = readMigrationReport(input.db);
  if (previous) return { ...previous, alreadyComplete: true };

  const now = input.now ?? new Date().toISOString();
  const source = await resolveLegacyMigrationSource(input.queueRoot);
  const report: LegacyQueueMigrationReport = {
    migrationKey: MIGRATION_KEY,
    sourceRoot: input.queueRoot,
    ...(source.archivePath ? { archivePath: source.archivePath } : {}),
    imported: { inbox: 0, processed: 0, failed: 0 },
    malformed: 0,
    issues: [],
    alreadyComplete: false,
    completedAt: now,
  };
  const store = new SparkInvocationStore(input.db);

  input.db.exec("BEGIN IMMEDIATE");
  try {
    for (const state of legacyStates) {
      const stateDir = join(source.readRoot, state);
      if (!existsSync(stateDir)) continue;
      const files = (await readdir(stateDir)).filter((file) => file.endsWith(".json")).sort();
      for (const fileName of files) {
        try {
          const payload = parseLegacyPayload(await readFile(join(stateDir, fileName), "utf8"));
          const status = invocationStatusForLegacyState(state, payload);
          store.importRecord({
            invocationId: invocationIdForLegacyFile(state, fileName),
            idempotencyKey: `legacy-queue:${state}:${fileName}`,
            status,
            sessionId: payload.task.sessionId,
            workspaceBindingId: payload.task.workspaceBindingId,
            prompt: payload.task.prompt,
            task: payload.task,
            result: payload.result,
            sourceKind: "legacy-queue",
            sourceRef: `${state}/${fileName}`,
            errorCode: state === "failed" ? "LEGACY_QUEUE_FAILURE" : undefined,
            errorMessage: payload.error,
            createdAt: payload.enqueuedAt,
            updatedAt: payload.processedAt ?? payload.failedAt ?? payload.enqueuedAt,
            startedAt: state === "inbox" ? undefined : payload.enqueuedAt,
            finishedAt: payload.processedAt ?? payload.failedAt,
          });
          report.imported[state] += 1;
        } catch (error) {
          report.malformed += 1;
          report.issues.push({
            state,
            fileName,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    input.db.exec("COMMIT");
  } catch (error) {
    input.db.exec("ROLLBACK");
    throw error;
  }

  if (!source.archivePath && (hasLegacyEntries(report) || report.malformed > 0)) {
    const archivePath = uniqueArchivePath(input.queueRoot, now);
    await rename(input.queueRoot, archivePath);
    report.archivePath = archivePath;
  }
  writeMigrationReport(input.db, report, now);
  return report;
}

async function resolveLegacyMigrationSource(
  queueRoot: string,
): Promise<{ readRoot: string; archivePath?: string }> {
  if (existsSync(queueRoot)) return { readRoot: queueRoot };

  const parent = dirname(queueRoot);
  const prefix = `${basename(queueRoot)}.legacy-`;
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return { readRoot: queueRoot };
    throw error;
  }
  const archiveName = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))[0];
  if (!archiveName) return { readRoot: queueRoot };
  const archivePath = join(parent, archiveName);
  return { readRoot: archivePath, archivePath };
}

function parseLegacyPayload(raw: string): LegacyPayload {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.enqueuedAt !== "string") throw new Error("missing enqueuedAt");
  const task = validateSparkDaemonTask(parsed.task);
  return {
    enqueuedAt: parsed.enqueuedAt,
    task,
    ...(typeof parsed.processedAt === "string" ? { processedAt: parsed.processedAt } : {}),
    ...(Object.hasOwn(parsed, "result") ? { result: parsed.result } : {}),
    ...(typeof parsed.failedAt === "string" ? { failedAt: parsed.failedAt } : {}),
    ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
  };
}

function invocationStatusForLegacyState(
  state: LegacyState,
  payload: LegacyPayload,
): SparkInvocationStatus {
  if (state === "inbox") return "queued";
  if (state === "failed") return "failed";
  return payload.error ? "failed" : "succeeded";
}

function invocationIdForLegacyFile(state: LegacyState, fileName: string): string {
  return `inv_${createHash("sha256").update(`${state}:${fileName}`).digest("hex").slice(0, 32)}`;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function hasLegacyEntries(report: LegacyQueueMigrationReport): boolean {
  return Object.values(report.imported).some((count) => count > 0);
}

function uniqueArchivePath(queueRoot: string, now: string): string {
  const suffix = now.replaceAll(/[^0-9]/gu, "");
  return join(dirname(queueRoot), `${basename(queueRoot)}.legacy-${suffix}`);
}

function readMigrationReport(db: DatabaseSync): LegacyQueueMigrationReport | undefined {
  const row = db.prepare("SELECT value FROM daemon_meta WHERE key = ?").get(MIGRATION_KEY) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  return JSON.parse(row.value) as LegacyQueueMigrationReport;
}

function writeMigrationReport(
  db: DatabaseSync,
  report: LegacyQueueMigrationReport,
  now: string,
): void {
  db.prepare(
    `INSERT INTO daemon_meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(MIGRATION_KEY, JSON.stringify(report), now);
}
