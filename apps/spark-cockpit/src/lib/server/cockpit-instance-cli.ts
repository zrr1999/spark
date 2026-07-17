import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  cockpitDatabaseLockPath,
  CockpitDatabaseLockedError,
  type CockpitRestoreResult,
  type CockpitSnapshotInspection,
  type CockpitSnapshotManifest,
  CockpitSnapshotValidationError,
  createCockpitSnapshot,
  defaultDatabasePath,
  inspectCockpitSnapshot,
  readCockpitInstanceId,
  restoreCockpitSnapshot,
} from "@zendev-lab/spark-db";

// Cockpit instance persistence is a server-owned Node surface. The public CLI
// path re-exports this module without taking a direct dependency on spark-db.

export type CockpitInstanceOperation = "backup" | "inspect" | "restore" | "status";

export interface CockpitInstanceCliCommand {
  operation: string;
  snapshotPath?: string;
  databasePath?: string;
  rollbackRoot?: string;
  yes?: boolean;
}

export interface CockpitInstanceCliOptions {
  now?: string;
  isInteractive?: boolean;
  confirm?: (question: string) => Promise<boolean>;
}

export interface CockpitInstanceStatusResult {
  plane: "cockpit";
  resource: "instance";
  operation: "status";
  status: "missing" | "ready" | "invalid";
  databasePath: string;
  databaseExists: boolean;
  instanceId: string | null;
  schemaMigrationCount: number;
  latestSchemaMigration: string | null;
  lock: {
    path: string;
    present: boolean;
    pid: number | null;
    acquiredAt: string | null;
  };
  text: string;
}

export interface CockpitInstanceBackupResult {
  plane: "cockpit";
  resource: "instance";
  operation: "backup";
  status: "created";
  snapshotPath: string;
  databasePath: string;
  instanceId: string;
  format: CockpitSnapshotManifest["format"];
  createdAt: string;
  sha256: string;
  sizeBytes: number;
  schemaMigrationCount: number;
  tableCounts: Record<string, number>;
  text: string;
}

export interface CockpitInstanceInspectResult {
  plane: "cockpit";
  resource: "instance";
  operation: "inspect";
  status: "valid";
  snapshotPath: string;
  databasePath: string;
  instanceId: string;
  format: CockpitSnapshotManifest["format"];
  createdAt: string;
  sha256: string;
  sizeBytes: number;
  schemaMigrationCount: number;
  tableCounts: Record<string, number>;
  integrityCheck: "ok";
  foreignKeyViolations: 0;
  includedScopes: string[];
  resetOnRestoreScopes: string[];
  excludedScopes: string[];
  text: string;
}

export interface CockpitInstanceRestoreResult {
  plane: "cockpit";
  resource: "instance";
  operation: "restore";
  status: "restored";
  snapshotPath: string;
  databasePath: string;
  instanceId: string;
  rollbackSnapshotPath: string | null;
  transientReset: CockpitRestoreResult["transientReset"];
  text: string;
}

export type CockpitInstanceCliResult =
  | CockpitInstanceStatusResult
  | CockpitInstanceBackupResult
  | CockpitInstanceInspectResult
  | CockpitInstanceRestoreResult;

export interface CockpitInstanceCliFailure {
  code:
    | "COCKPIT_INSTANCE_USAGE"
    | "COCKPIT_RESTORE_CONFIRMATION_REQUIRED"
    | "COCKPIT_DATABASE_NOT_FOUND"
    | "COCKPIT_INSTANCE_LOCKED"
    | "COCKPIT_SNAPSHOT_NOT_FOUND"
    | "COCKPIT_SNAPSHOT_EXISTS"
    | "COCKPIT_SNAPSHOT_MANIFEST_INVALID"
    | "COCKPIT_SNAPSHOT_DIGEST_MISMATCH"
    | "COCKPIT_SNAPSHOT_SCHEMA_INCOMPATIBLE"
    | "COCKPIT_SNAPSHOT_INVALID"
    | "COCKPIT_INSTANCE_OPERATION_FAILED";
  message: string;
  exitCode: number;
}

export class CockpitInstanceCliError extends Error {
  constructor(readonly failure: CockpitInstanceCliFailure) {
    super(failure.message);
    this.name = "CockpitInstanceCliError";
  }
}

export async function handleCockpitInstanceCliCommand(
  command: CockpitInstanceCliCommand,
  options: CockpitInstanceCliOptions = {},
): Promise<CockpitInstanceCliResult> {
  const operation = parseOperation(command.operation);
  try {
    switch (operation) {
      case "status":
        return cockpitInstanceStatus(command);
      case "backup":
        return await cockpitInstanceBackup(command, options);
      case "inspect":
        return cockpitInstanceInspect(command);
      case "restore":
        return await cockpitInstanceRestore(command, options);
    }
  } catch (error) {
    throw toCockpitInstanceCliError(error, operation);
  }
}

export function toCockpitInstanceCliError(
  error: unknown,
  operation: CockpitInstanceOperation,
): CockpitInstanceCliError {
  if (error instanceof CockpitInstanceCliError) return error;
  if (error instanceof CockpitDatabaseLockedError) {
    return cliError(
      "COCKPIT_INSTANCE_LOCKED",
      "The Cockpit database is in use. Stop the Cockpit Web host before restoring this instance.",
      5,
    );
  }
  if (error instanceof CockpitSnapshotValidationError) {
    const message = error.message;
    if (/SHA-256|size mismatch/u.test(message)) {
      return cliError("COCKPIT_SNAPSHOT_DIGEST_MISMATCH", message, 6);
    }
    if (/migration|schema is newer|schema migrations/u.test(message)) {
      return cliError("COCKPIT_SNAPSHOT_SCHEMA_INCOMPATIBLE", message, 6);
    }
    if (/manifest/u.test(message)) {
      return cliError("COCKPIT_SNAPSHOT_MANIFEST_INVALID", message, 6);
    }
    return cliError("COCKPIT_SNAPSHOT_INVALID", message, 6);
  }
  if (isNodeError(error) && error.code === "ENOENT") {
    return cliError(
      operation === "backup" || operation === "status"
        ? "COCKPIT_DATABASE_NOT_FOUND"
        : "COCKPIT_SNAPSHOT_NOT_FOUND",
      operation === "backup" || operation === "status"
        ? "The Cockpit database does not exist."
        : "The Cockpit snapshot does not exist.",
      3,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/snapshot destination already exists/u.test(message)) {
    return cliError("COCKPIT_SNAPSHOT_EXISTS", message, 6);
  }
  return cliError("COCKPIT_INSTANCE_OPERATION_FAILED", message, 1);
}

async function cockpitInstanceBackup(
  command: CockpitInstanceCliCommand,
  options: CockpitInstanceCliOptions,
): Promise<CockpitInstanceBackupResult> {
  const databasePath = resolvedDatabasePath(command);
  if (!existsSync(databasePath)) {
    throw cliError(
      "COCKPIT_DATABASE_NOT_FOUND",
      `Cockpit database does not exist: ${databasePath}`,
      3,
    );
  }
  const now = options.now ?? new Date().toISOString();
  const snapshotPath = resolve(
    command.snapshotPath ?? defaultSnapshotPath(databasePath, compactTimestamp(now)),
  );
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let manifest: CockpitSnapshotManifest;
  try {
    manifest = await createCockpitSnapshot({ sourceDb: db, destination: snapshotPath, now });
  } finally {
    db.close();
  }

  return {
    plane: "cockpit",
    resource: "instance",
    operation: "backup",
    status: "created",
    snapshotPath,
    databasePath,
    instanceId: manifest.instanceId,
    format: manifest.format,
    createdAt: manifest.createdAt,
    sha256: manifest.database.sha256,
    sizeBytes: manifest.database.sizeBytes,
    schemaMigrationCount: manifest.schemaMigrations.length,
    tableCounts: manifest.tableCounts,
    text:
      `Created Cockpit snapshot: ${snapshotPath}\n` +
      `Inspect: spark cockpit instance inspect ${shellArg(snapshotPath)}\n` +
      `Restore: spark cockpit instance restore ${shellArg(snapshotPath)} --yes\n`,
  };
}

function cockpitInstanceInspect(command: CockpitInstanceCliCommand): CockpitInstanceInspectResult {
  const snapshotPath = requiredSnapshotPath(command, "inspect");
  const inspection = inspectCockpitSnapshot(snapshotPath);
  return inspectionResult(inspection);
}

async function cockpitInstanceRestore(
  command: CockpitInstanceCliCommand,
  options: CockpitInstanceCliOptions,
): Promise<CockpitInstanceRestoreResult> {
  const snapshotPath = requiredSnapshotPath(command, "restore");
  const databasePath = resolvedDatabasePath(command);
  await requireRestoreConfirmation(command, options, snapshotPath, databasePath);
  const restored = await restoreCockpitSnapshot({
    snapshotPath,
    databasePath,
    ...(command.rollbackRoot ? { rollbackRoot: resolve(command.rollbackRoot) } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const rollback = restored.rollbackSnapshotPath
    ? `Rollback: spark cockpit instance restore ${shellArg(restored.rollbackSnapshotPath)} --yes\n`
    : "";
  return {
    plane: "cockpit",
    resource: "instance",
    operation: "restore",
    status: "restored",
    snapshotPath,
    databasePath: restored.databasePath,
    instanceId: restored.instanceId,
    rollbackSnapshotPath: restored.rollbackSnapshotPath,
    transientReset: restored.transientReset,
    text:
      `Restored Cockpit instance ${restored.instanceId} to ${restored.databasePath}.\n` +
      rollback +
      "Start the Cockpit Web host and verify daemon reconnects before deleting the rollback snapshot.\n",
  };
}

function cockpitInstanceStatus(command: CockpitInstanceCliCommand): CockpitInstanceStatusResult {
  const databasePath = resolvedDatabasePath(command);
  const lock = readPublicLockStatus(databasePath);
  if (!existsSync(databasePath)) {
    return {
      plane: "cockpit",
      resource: "instance",
      operation: "status",
      status: "missing",
      databasePath,
      databaseExists: false,
      instanceId: null,
      schemaMigrationCount: 0,
      latestSchemaMigration: null,
      lock,
      text: `Cockpit database not found: ${databasePath}\n`,
    };
  }

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const migrations = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: string }>;
    const instanceId = readCockpitInstanceId(db);
    return {
      plane: "cockpit",
      resource: "instance",
      operation: "status",
      status: instanceId ? "ready" : "invalid",
      databasePath,
      databaseExists: true,
      instanceId,
      schemaMigrationCount: migrations.length,
      latestSchemaMigration: migrations.at(-1)?.version ?? null,
      lock,
      text:
        `Cockpit instance: ${instanceId ?? "invalid"}\n` +
        `Database: ${databasePath}\n` +
        `Schema: ${migrations.at(-1)?.version ?? "none"}\n` +
        `Lock: ${lock.present ? "held" : "free"}\n`,
    };
  } finally {
    db.close();
  }
}

function inspectionResult(inspection: CockpitSnapshotInspection): CockpitInstanceInspectResult {
  const { manifest } = inspection;
  return {
    plane: "cockpit",
    resource: "instance",
    operation: "inspect",
    status: "valid",
    snapshotPath: inspection.snapshotPath,
    databasePath: inspection.databasePath,
    instanceId: manifest.instanceId,
    format: manifest.format,
    createdAt: manifest.createdAt,
    sha256: manifest.database.sha256,
    sizeBytes: manifest.database.sizeBytes,
    schemaMigrationCount: manifest.schemaMigrations.length,
    tableCounts: manifest.tableCounts,
    integrityCheck: inspection.integrityCheck,
    foreignKeyViolations: inspection.foreignKeyViolations,
    includedScopes: manifest.includedScopes,
    resetOnRestoreScopes: manifest.resetOnRestoreScopes,
    excludedScopes: manifest.excludedScopes,
    text:
      `Valid Cockpit snapshot: ${inspection.snapshotPath}\n` +
      `Instance: ${manifest.instanceId}\n` +
      `Created: ${manifest.createdAt}\n` +
      `Restore: spark cockpit instance restore ${shellArg(inspection.snapshotPath)} --yes\n`,
  };
}

async function requireRestoreConfirmation(
  command: CockpitInstanceCliCommand,
  options: CockpitInstanceCliOptions,
  snapshotPath: string,
  databasePath: string,
): Promise<void> {
  if (command.yes) return;
  const question =
    `Replace the entire Cockpit database at ${databasePath} with ${snapshotPath}? ` +
    "The current database will first be backed up.";
  if (options.confirm) {
    if (await options.confirm(question)) return;
    throw cliError("COCKPIT_RESTORE_CONFIRMATION_REQUIRED", "Cockpit restore cancelled.", 4);
  }
  const interactive = options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw cliError(
      "COCKPIT_RESTORE_CONFIRMATION_REQUIRED",
      "Cockpit restore requires --yes in non-interactive environments.",
      4,
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${question} Type 'yes' to continue: `);
    if (answer.trim().toLowerCase() === "yes") return;
  } finally {
    prompt.close();
  }
  throw cliError("COCKPIT_RESTORE_CONFIRMATION_REQUIRED", "Cockpit restore cancelled.", 4);
}

function parseOperation(operation: string): CockpitInstanceOperation {
  if (
    operation === "backup" ||
    operation === "inspect" ||
    operation === "restore" ||
    operation === "status"
  ) {
    return operation;
  }
  throw cliError(
    "COCKPIT_INSTANCE_USAGE",
    `Unknown Cockpit instance operation: ${operation}. Use backup, inspect, restore, or status.`,
    2,
  );
}

function requiredSnapshotPath(
  command: CockpitInstanceCliCommand,
  operation: "inspect" | "restore",
): string {
  if (!command.snapshotPath?.trim()) {
    throw cliError(
      "COCKPIT_INSTANCE_USAGE",
      `spark cockpit instance ${operation} requires <snapshot-path>.`,
      2,
    );
  }
  return resolve(command.snapshotPath);
}

function resolvedDatabasePath(command: CockpitInstanceCliCommand): string {
  return resolve(command.databasePath ?? defaultDatabasePath());
}

function defaultSnapshotPath(databasePath: string, timestamp: string): string {
  return join(dirname(databasePath), "backups", `cockpit-snapshot-${timestamp}`);
}

function compactTimestamp(value: string): string {
  return value.replace(/[^0-9]/gu, "").slice(0, 17) || "unknown-time";
}

function shellArg(value: string): string {
  return JSON.stringify(value);
}

function readPublicLockStatus(databasePath: string): CockpitInstanceStatusResult["lock"] {
  const path = cockpitDatabaseLockPath(databasePath);
  if (!existsSync(path)) return { path, present: false, pid: null, acquiredAt: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRecord(parsed)) {
      return {
        path,
        present: true,
        pid: typeof parsed.pid === "number" ? parsed.pid : null,
        acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : null,
      };
    }
  } catch {
    // A fresh lock can be observed before its owner finishes writing the record.
  }
  return { path, present: true, pid: null, acquiredAt: null };
}

function cliError(
  code: CockpitInstanceCliFailure["code"],
  message: string,
  exitCode: number,
): CockpitInstanceCliError {
  return new CockpitInstanceCliError({ code, message, exitCode });
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
