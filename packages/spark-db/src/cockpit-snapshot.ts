import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadMigrations, migrate } from "./migrate.js";

export const cockpitInstanceIdSettingKey = "spark_cockpit:instance_id";
export const cockpitWebPushSubscriptionSettingKey = "spark_cockpit:web_push_subscription";
export const cockpitSnapshotFormat = "spark.cockpit.snapshot.v1" as const;

const snapshotDatabaseFile = "cockpit.sqlite";
const snapshotManifestFile = "manifest.json";

export interface CockpitSnapshotMigration {
  version: string;
  name: string;
}

export interface CockpitSnapshotManifest {
  format: typeof cockpitSnapshotFormat;
  createdAt: string;
  instanceId: string;
  schemaMigrations: CockpitSnapshotMigration[];
  database: {
    file: typeof snapshotDatabaseFile;
    sha256: string;
    sizeBytes: number;
  };
  tableCounts: Record<string, number>;
  includedScopes: string[];
  resetOnRestoreScopes: string[];
  excludedScopes: string[];
}

export interface CockpitSnapshotInspection {
  snapshotPath: string;
  databasePath: string;
  manifest: CockpitSnapshotManifest;
  integrityCheck: "ok";
  foreignKeyViolations: 0;
}

export interface CockpitDatabaseLockRecord {
  pid: number;
  acquiredAt: string;
  databasePath: string;
  ownerToken: string;
}

export interface CockpitDatabaseLockHandle {
  path: string;
  record: CockpitDatabaseLockRecord;
  release(): void;
}

export interface CockpitRestoreResult {
  databasePath: string;
  instanceId: string;
  rollbackSnapshotPath: string | null;
  transientReset: {
    browserSessionsDeleted: number;
    workspaceAccessTokensDeleted: number;
    cockpitAccessTokensDeleted: number;
    runtimeSessionsClosed: number;
    runtimesMarkedOffline: number;
    deviceAuthorizationsDeleted: number;
    artifactCacheRowsDeleted: number;
    webPushSubscriptionsDeleted: number;
  };
}

export class CockpitDatabaseLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly record: Partial<CockpitDatabaseLockRecord> | null,
  ) {
    const owner = record?.pid ? ` by process ${record.pid}` : "";
    super(`Spark Cockpit database is locked${owner}: ${lockPath}`);
    this.name = "CockpitDatabaseLockedError";
  }
}

export class CockpitSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CockpitSnapshotValidationError";
  }
}

interface RestoreTestHooks {
  afterTargetMoved?: () => void;
}

export function cockpitDatabaseLockPath(databasePath: string): string {
  return `${resolve(databasePath)}.lock`;
}

export function acquireCockpitDatabaseLock(databasePath: string): CockpitDatabaseLockHandle {
  const resolvedDatabasePath = resolve(databasePath);
  const lockPath = cockpitDatabaseLockPath(resolvedDatabasePath);
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record: CockpitDatabaseLockRecord = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      databasePath: resolvedDatabasePath,
      ownerToken: randomUUID(),
    };

    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return {
        path: lockPath,
        record,
        release() {
          const current = readLockRecord(lockPath);
          if (current?.ownerToken === record.ownerToken) {
            rmSync(lockPath, { force: true });
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const current = readLockRecord(lockPath);
      if (current?.pid && processIsRunning(current.pid)) {
        throw new CockpitDatabaseLockedError(lockPath, current);
      }
      if (!current && lockFileIsFresh(lockPath)) {
        throw new CockpitDatabaseLockedError(lockPath, null);
      }
      rmSync(lockPath, { force: true });
    }
  }

  throw new CockpitDatabaseLockedError(lockPath, readLockRecord(lockPath));
}

export function ensureCockpitInstanceId(
  db: DatabaseSync,
  options: { now?: string; instanceId?: string } = {},
): string {
  const existing = readCockpitInstanceId(db);
  if (existing) return existing;

  const instanceId = options.instanceId ?? `cockpit_${randomUUID().replaceAll("-", "")}`;
  if (!/^cockpit_[a-f0-9]{32}$/u.test(instanceId)) {
    throw new Error("Cockpit instance id must match cockpit_<32 lowercase hex characters>.");
  }
  db.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  ).run(
    cockpitInstanceIdSettingKey,
    JSON.stringify(instanceId),
    options.now ?? new Date().toISOString(),
  );
  return readCockpitInstanceId(db) ?? instanceId;
}

export function readCockpitInstanceId(db: DatabaseSync): string | null {
  const row = db
    .prepare("SELECT value_json AS valueJson FROM app_settings WHERE key = ?")
    .get(cockpitInstanceIdSettingKey) as { valueJson: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.valueJson) as unknown;
    return typeof value === "string" && /^cockpit_[a-f0-9]{32}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

export async function createCockpitSnapshot(input: {
  sourceDb: DatabaseSync;
  destination: string;
  now?: string;
}): Promise<CockpitSnapshotManifest> {
  const destination = resolve(input.destination);
  if (existsSync(destination)) {
    throw new Error(`Cockpit snapshot destination already exists: ${destination}`);
  }

  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${basename(destination)}.tmp-${randomUUID()}`);
  mkdirSync(temporary, { recursive: false, mode: 0o700 });

  try {
    const databasePath = join(temporary, snapshotDatabaseFile);
    // VACUUM INTO creates a transactionally consistent copy of a live database.
    // Keep this operation on DatabaseSync instead of node:sqlite backup(), whose
    // thread-pool scheduling can add multi-second stalls on loaded Linux hosts.
    input.sourceDb.prepare("VACUUM INTO ?").run(databasePath);
    chmodSync(databasePath, 0o600);
    const summary = inspectDatabaseFile(databasePath);
    const manifest: CockpitSnapshotManifest = {
      format: cockpitSnapshotFormat,
      createdAt: input.now ?? new Date().toISOString(),
      instanceId: requireInstanceId(summary.instanceId),
      schemaMigrations: summary.schemaMigrations,
      database: {
        file: snapshotDatabaseFile,
        sha256: sha256File(databasePath),
        sizeBytes: statSync(databasePath).size,
      },
      tableCounts: summary.tableCounts,
      includedScopes: [
        "cockpit.instance",
        "users",
        "workspaces",
        "projects",
        "runtime.identities_and_token_hashes",
        "runtime.workspace_bindings",
        "commands_and_deliveries",
        "human_interactions",
        "projection_history",
        "artifact_metadata",
      ],
      resetOnRestoreScopes: [
        "browser_sessions",
        "workspace_access_tokens",
        "cockpit_access_tokens",
        "runtime_websocket_sessions",
        "pending_device_authorizations",
        "web_push_subscription",
        "artifact_cache_rows",
      ],
      excludedScopes: [
        "deployment_environment_and_secrets",
        "artifact_cache_files",
        "daemon_database_and_workspace_runtime_state",
      ],
    };
    writeFileSync(join(temporary, snapshotManifestFile), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, destination);
    return manifest;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function inspectCockpitSnapshot(snapshotPath: string): CockpitSnapshotInspection {
  const resolvedSnapshotPath = resolve(snapshotPath);
  const manifestPath = join(resolvedSnapshotPath, snapshotManifestFile);
  const manifest = parseSnapshotManifest(readFileSync(manifestPath, "utf8"));
  const databasePath = join(resolvedSnapshotPath, manifest.database.file);
  if (!existsSync(databasePath)) {
    throw new CockpitSnapshotValidationError(`Snapshot database is missing: ${databasePath}`);
  }

  const sizeBytes = statSync(databasePath).size;
  if (sizeBytes !== manifest.database.sizeBytes) {
    throw new CockpitSnapshotValidationError(
      `Snapshot database size mismatch: expected ${manifest.database.sizeBytes}, received ${sizeBytes}.`,
    );
  }
  const sha256 = sha256File(databasePath);
  if (sha256 !== manifest.database.sha256) {
    throw new CockpitSnapshotValidationError("Snapshot database SHA-256 does not match manifest.");
  }

  const summary = inspectDatabaseFile(databasePath);
  assertCompatibleMigrations(summary.schemaMigrations);
  if (summary.instanceId !== manifest.instanceId) {
    throw new CockpitSnapshotValidationError("Snapshot instance id does not match manifest.");
  }
  if (JSON.stringify(summary.schemaMigrations) !== JSON.stringify(manifest.schemaMigrations)) {
    throw new CockpitSnapshotValidationError("Snapshot migration list does not match manifest.");
  }
  if (JSON.stringify(summary.tableCounts) !== JSON.stringify(manifest.tableCounts)) {
    throw new CockpitSnapshotValidationError("Snapshot table counts do not match manifest.");
  }

  return {
    snapshotPath: resolvedSnapshotPath,
    databasePath,
    manifest,
    integrityCheck: "ok",
    foreignKeyViolations: 0,
  };
}

export async function restoreCockpitSnapshot(input: {
  snapshotPath: string;
  databasePath: string;
  rollbackRoot?: string;
  now?: string;
  /** @internal Fault injection for atomic rollback tests. */
  testHooks?: RestoreTestHooks;
}): Promise<CockpitRestoreResult> {
  const inspection = inspectCockpitSnapshot(input.snapshotPath);
  const databasePath = resolve(input.databasePath);
  const lock = acquireCockpitDatabaseLock(databasePath);
  const now = input.now ?? new Date().toISOString();
  const parent = dirname(databasePath);
  mkdirSync(parent, { recursive: true });

  let rollbackSnapshotPath: string | null = null;
  const stagePath = join(parent, `.${basename(databasePath)}.restore-${randomUUID()}`);
  const previousPath = join(parent, `.${basename(databasePath)}.previous-${randomUUID()}`);
  const targetExisted = existsSync(databasePath);
  const movedSidecars: Array<{ original: string; moved: string }> = [];
  let targetMoved = false;

  try {
    if (targetExisted) {
      const targetDb = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const rollbackRoot = resolve(input.rollbackRoot ?? join(parent, "backups"));
        mkdirSync(rollbackRoot, { recursive: true });
        rollbackSnapshotPath = uniqueSnapshotPath(
          rollbackRoot,
          `cockpit-before-restore-${compactTimestamp(now)}`,
        );
        await createCockpitSnapshot({ sourceDb: targetDb, destination: rollbackSnapshotPath, now });
      } finally {
        targetDb.close();
      }
    }

    copyFileSync(inspection.databasePath, stagePath);
    chmodSync(stagePath, 0o600);
    const transientReset = prepareRestoredDatabase(stagePath, now);
    removeSqliteSidecars(stagePath);
    inspectPreparedDatabase(stagePath, inspection.manifest.instanceId);

    if (targetExisted) {
      renameSync(databasePath, previousPath);
      targetMoved = true;
      for (const suffix of ["-wal", "-shm"]) {
        const original = `${databasePath}${suffix}`;
        if (!existsSync(original)) continue;
        const moved = `${previousPath}${suffix}`;
        renameSync(original, moved);
        movedSidecars.push({ original, moved });
      }
    }

    input.testHooks?.afterTargetMoved?.();
    renameSync(stagePath, databasePath);
    rmSync(previousPath, { force: true });
    for (const sidecar of movedSidecars) removeFileBestEffort(sidecar.moved);

    return {
      databasePath,
      instanceId: inspection.manifest.instanceId,
      rollbackSnapshotPath,
      transientReset,
    };
  } catch (error) {
    rmSync(stagePath, { force: true });
    removeSqliteSidecars(stagePath);
    if (targetMoved && existsSync(previousPath)) {
      if (existsSync(databasePath)) rmSync(databasePath, { force: true });
      renameSync(previousPath, databasePath);
      for (const sidecar of movedSidecars.reverse()) {
        if (existsSync(sidecar.moved)) renameSync(sidecar.moved, sidecar.original);
      }
    }
    throw error;
  } finally {
    lock.release();
  }
}

function prepareRestoredDatabase(
  databasePath: string,
  now: string,
): CockpitRestoreResult["transientReset"] {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  try {
    db.exec("BEGIN IMMEDIATE");
    const browserSessionsDeleted = changes(db.prepare("DELETE FROM sessions").run());
    const workspaceAccessTokensDeleted = changes(
      db.prepare("DELETE FROM workspace_access_tokens WHERE used_at IS NULL").run(),
    );
    const cockpitAccessTokensDeleted = changes(
      db.prepare("DELETE FROM cockpit_access_tokens WHERE used_at IS NULL").run(),
    );
    const runtimeSessionsClosed = changes(
      db
        .prepare(
          `UPDATE runtime_sessions
           SET status = 'closed', closed_at = COALESCE(closed_at, ?), close_reason = 'cockpit_relocated'
           WHERE status != 'closed'`,
        )
        .run(now),
    );
    const runtimesMarkedOffline = changes(
      db
        .prepare(
          `UPDATE runtime_connections
           SET status = 'offline', updated_at = ?
           WHERE status IN ('online', 'draining')`,
        )
        .run(now),
    );
    const deviceAuthorizationsDeleted = changes(
      db.prepare("DELETE FROM runtime_device_authorizations WHERE consumed_at IS NULL").run(),
    );
    const artifactCacheRowsDeleted = changes(db.prepare("DELETE FROM artifact_cache_blobs").run());
    const webPushSubscriptionsDeleted = changes(
      db
        .prepare("DELETE FROM app_settings WHERE key = ?")
        .run(cockpitWebPushSubscriptionSettingKey),
    );
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return {
      browserSessionsDeleted,
      workspaceAccessTokensDeleted,
      cockpitAccessTokensDeleted,
      runtimeSessionsClosed,
      runtimesMarkedOffline,
      deviceAuthorizationsDeleted,
      artifactCacheRowsDeleted,
      webPushSubscriptionsDeleted,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original restore error.
    }
    throw error;
  } finally {
    db.close();
  }
}

function inspectPreparedDatabase(databasePath: string, expectedInstanceId: string): void {
  const summary = inspectDatabaseFile(databasePath);
  assertCompatibleMigrations(summary.schemaMigrations);
  if (summary.instanceId !== expectedInstanceId) {
    throw new CockpitSnapshotValidationError("Prepared database changed Cockpit instance id.");
  }
}

function inspectDatabaseFile(databasePath: string): {
  instanceId: string | null;
  schemaMigrations: CockpitSnapshotMigration[];
  tableCounts: Record<string, number>;
} {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    throw new CockpitSnapshotValidationError(
      `Snapshot database cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new CockpitSnapshotValidationError("Snapshot database failed SQLite integrity_check.");
    }
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) {
      throw new CockpitSnapshotValidationError(
        `Snapshot database has ${foreignKeys.length} foreign key violation(s).`,
      );
    }

    const schemaMigrations = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as unknown as CockpitSnapshotMigration[];
    const tables = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const tableCounts: Record<string, number> = {};
    for (const { name } of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get() as {
        count: number;
      };
      tableCounts[name] = row.count;
    }

    return { instanceId: readCockpitInstanceId(db), schemaMigrations, tableCounts };
  } catch (error) {
    if (error instanceof CockpitSnapshotValidationError) throw error;
    throw new CockpitSnapshotValidationError(
      `Snapshot database schema cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db.close();
  }
}

function assertCompatibleMigrations(snapshotMigrations: CockpitSnapshotMigration[]): void {
  const current = loadMigrations().map(({ version, name }) => ({ version, name }));
  if (snapshotMigrations.length === 0) {
    throw new CockpitSnapshotValidationError("Snapshot has no recorded schema migrations.");
  }
  const sharedLength = Math.min(snapshotMigrations.length, current.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const snapshot = snapshotMigrations[index];
    const expected = current[index];
    if (
      !snapshot ||
      !expected ||
      snapshot.version !== expected.version ||
      snapshot.name !== expected.name
    ) {
      throw new CockpitSnapshotValidationError(
        `Snapshot migration history diverges at index ${index}.`,
      );
    }
  }
  if (snapshotMigrations.length > current.length) {
    throw new CockpitSnapshotValidationError("Snapshot schema is newer than this Spark build.");
  }
}

function parseSnapshotManifest(raw: string): CockpitSnapshotManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new CockpitSnapshotValidationError("Snapshot manifest is not valid JSON.");
  }
  if (!isRecord(value) || value.format !== cockpitSnapshotFormat) {
    throw new CockpitSnapshotValidationError("Snapshot manifest format is unsupported.");
  }
  if (
    typeof value.createdAt !== "string" ||
    typeof value.instanceId !== "string" ||
    !isRecord(value.database) ||
    value.database.file !== snapshotDatabaseFile ||
    typeof value.database.sha256 !== "string" ||
    typeof value.database.sizeBytes !== "number" ||
    !Array.isArray(value.schemaMigrations) ||
    !isRecord(value.tableCounts) ||
    !Array.isArray(value.includedScopes) ||
    !Array.isArray(value.resetOnRestoreScopes) ||
    !Array.isArray(value.excludedScopes)
  ) {
    throw new CockpitSnapshotValidationError("Snapshot manifest shape is invalid.");
  }

  const schemaMigrations = value.schemaMigrations.map((entry) => {
    if (!isRecord(entry) || typeof entry.version !== "string" || typeof entry.name !== "string") {
      throw new CockpitSnapshotValidationError("Snapshot manifest migration entry is invalid.");
    }
    return { version: entry.version, name: entry.name };
  });
  const tableCounts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value.tableCounts)) {
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new CockpitSnapshotValidationError(`Snapshot table count is invalid for ${key}.`);
    }
    tableCounts[key] = count as number;
  }
  const includedScopes = stringArray(value.includedScopes, "includedScopes");
  const resetOnRestoreScopes = stringArray(value.resetOnRestoreScopes, "resetOnRestoreScopes");
  const excludedScopes = stringArray(value.excludedScopes, "excludedScopes");

  return {
    format: cockpitSnapshotFormat,
    createdAt: value.createdAt,
    instanceId: requireInstanceId(value.instanceId),
    schemaMigrations,
    database: {
      file: snapshotDatabaseFile,
      sha256: value.database.sha256,
      sizeBytes: value.database.sizeBytes,
    },
    tableCounts,
    includedScopes,
    resetOnRestoreScopes,
    excludedScopes,
  };
}

function stringArray(value: unknown[], field: string): string[] {
  if (!value.every((entry): entry is string => typeof entry === "string" && entry.length > 0)) {
    throw new CockpitSnapshotValidationError(`Snapshot manifest ${field} is invalid.`);
  }
  return value;
}

function requireInstanceId(value: string | null): string {
  if (!value || !/^cockpit_[a-f0-9]{32}$/u.test(value)) {
    throw new CockpitSnapshotValidationError("Cockpit database has no valid stable instance id.");
  }
  return value;
}

function changes(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function compactTimestamp(value: string): string {
  return value.replace(/[^0-9]/gu, "").slice(0, 17) || "unknown-time";
}

function uniqueSnapshotPath(root: string, base: string): string {
  let candidate = join(root, base);
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = join(root, `${base}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function readLockRecord(path: string): CockpitDatabaseLockRecord | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(value)) return null;
    if (
      typeof value.pid !== "number" ||
      typeof value.acquiredAt !== "string" ||
      typeof value.databasePath !== "string" ||
      typeof value.ownerToken !== "string"
    ) {
      return null;
    }
    return {
      pid: value.pid,
      acquiredAt: value.acquiredAt,
      databasePath: value.databasePath,
      ownerToken: value.ownerToken,
    };
  } catch {
    return null;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
  }
}

function lockFileIsFresh(path: string, now = Date.now()): boolean {
  try {
    return now - statSync(path).mtimeMs < 30_000;
  } catch {
    return true;
  }
}

function removeSqliteSidecars(databasePath: string): void {
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

function removeFileBestEffort(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The restored database is already committed; stale sidecars are ignored by its new inode.
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function isPermissionError(error: unknown): boolean {
  return isRecord(error) && error.code === "EPERM";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
