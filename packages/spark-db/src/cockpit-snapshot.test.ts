import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./client.js";
import {
  acquireCockpitDatabaseLock,
  cockpitDatabaseLockPath,
  CockpitDatabaseLockedError,
  createCockpitSnapshot,
  ensureCockpitInstanceId,
  inspectCockpitSnapshot,
  restoreCockpitSnapshot,
  type CockpitSnapshotManifest,
} from "./cockpit-snapshot.js";
import { migrate } from "./migrate.js";

const roots: string[] = [];
const now = "2026-07-15T00:00:00.000Z";
const sourceInstanceId = "cockpit_11111111111111111111111111111111";
const targetInstanceId = "cockpit_22222222222222222222222222222222";

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "spark-cockpit-snapshot-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Cockpit instance snapshots", { timeout: 15_000 }, () => {
  it("preserves durable identity and history while invalidating origin-bound transient state", async () => {
    const root = createRoot();
    const sourcePath = join(root, "source.sqlite");
    const targetPath = join(root, "target.sqlite");
    const snapshotPath = join(root, "source.snapshot");
    const rollbackRoot = join(root, "rollback");

    const source = seededSourceDatabase(sourcePath);
    const manifest = await createCockpitSnapshot({
      sourceDb: source,
      destination: snapshotPath,
      now,
    });
    source.close();

    expect(manifest.instanceId).toBe(sourceInstanceId);
    expect(manifest.schemaMigrations.map(({ version }) => version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      "0013",
      "0014",
      "0015",
    ]);
    expect(manifest.tableCounts).toMatchObject({
      workspaces: 1,
      projects: 1,
      runtime_connections: 1,
      runtime_tokens: 2,
      runtime_workspace_bindings: 1,
      sessions: 1,
      commands: 1,
      events: 1,
    });
    expect(manifest.resetOnRestoreScopes).toContain("browser_sessions");
    expect(manifest.resetOnRestoreScopes).toContain("runtime_websocket_sessions");
    expect(manifest.excludedScopes).toContain("deployment_environment_and_secrets");
    expect(inspectCockpitSnapshot(snapshotPath)).toMatchObject({
      integrityCheck: "ok",
      foreignKeyViolations: 0,
    });

    const target = seededTargetDatabase(targetPath);
    target.close();
    const result = await restoreCockpitSnapshot({
      snapshotPath,
      databasePath: targetPath,
      rollbackRoot,
      now: "2026-07-15T00:05:00.000Z",
    });

    expect(result).toMatchObject({
      instanceId: sourceInstanceId,
      transientReset: {
        browserSessionsDeleted: 1,
        runtimeSessionsClosed: 1,
        runtimesMarkedOffline: 1,
        deviceAuthorizationsDeleted: 1,
        artifactCacheRowsDeleted: 1,
        webPushSubscriptionsDeleted: 1,
      },
    });
    expect(result.rollbackSnapshotPath).not.toBeNull();
    expect(existsSync(result.rollbackSnapshotPath!)).toBe(true);
    expect(inspectCockpitSnapshot(result.rollbackSnapshotPath!).manifest.instanceId).toBe(
      targetInstanceId,
    );

    const restored = new DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(setting(restored, "spark_cockpit:instance_id")).toBe(sourceInstanceId);
      expect(setting(restored, "durable.setting")).toEqual({ retained: true });
      expect(setting(restored, "spark_cockpit:web_push_subscription")).toBeNull();
      expect(count(restored, "sessions")).toBe(0);
      expect(
        restored
          .prepare(
            "SELECT status, closed_at AS closedAt, close_reason AS closeReason FROM runtime_sessions",
          )
          .get(),
      ).toMatchObject({
        status: "closed",
        closedAt: "2026-07-15T00:05:00.000Z",
        closeReason: "cockpit_relocated",
      });
      expect(restored.prepare("SELECT status FROM runtime_connections").get()).toMatchObject({
        status: "offline",
      });
      expect(
        restored
          .prepare(
            "SELECT id, consumed_at AS consumedAt FROM runtime_device_authorizations ORDER BY id",
          )
          .all(),
      ).toEqual([{ id: "rtda_consumed", consumedAt: "2026-07-14T23:59:00.000Z" }]);
      expect(count(restored, "artifact_cache_blobs")).toBe(0);
      expect(
        restored
          .prepare(
            `SELECT w.id AS workspaceId,
                    p.id AS projectId,
                    rc.id AS runtimeId,
                    rt.token_hash AS tokenHash,
                    rwb.id AS bindingId,
                    wob.runtime_workspace_binding_id AS ownerBindingId,
                    c.id AS commandId,
                    cd.status AS deliveryStatus,
                    e.id AS eventId
             FROM workspaces w
             JOIN projects p ON p.workspace_id = w.id
             JOIN workspace_owner_bindings wob ON wob.workspace_id = w.id AND wob.ended_at IS NULL
             JOIN runtime_workspace_bindings rwb ON rwb.id = wob.runtime_workspace_binding_id
             JOIN runtime_connections rc ON rc.id = rwb.runtime_id
             JOIN runtime_tokens rt ON rt.runtime_id = rc.id AND rt.label = 'runtime refresh token'
             JOIN commands c ON c.workspace_id = w.id
             JOIN command_deliveries cd ON cd.command_id = c.id
             JOIN events e ON e.workspace_id = w.id`,
          )
          .get(),
      ).toEqual({
        workspaceId: "ws_source",
        projectId: "proj_source",
        runtimeId: "rt_source",
        tokenHash: "sha256:refresh-source",
        bindingId: "rtwb_source",
        ownerBindingId: "rtwb_source",
        commandId: "cmd_source",
        deliveryStatus: "pending",
        eventId: "evt_source",
      });
    } finally {
      restored.close();
    }

    const rollback = new DatabaseSync(join(result.rollbackSnapshotPath!, "cockpit.sqlite"), {
      readOnly: true,
    });
    try {
      expect(rollback.prepare("SELECT id FROM workspaces").get()).toEqual({ id: "ws_target" });
    } finally {
      rollback.close();
    }
  });

  it("rejects a corrupted snapshot before changing the target", async () => {
    const { root, snapshotPath, targetPath } = await snapshotAndTarget();
    appendFileSync(join(snapshotPath, "cockpit.sqlite"), "corruption", "utf8");
    const before = sha256(targetPath);

    await expect(
      restoreCockpitSnapshot({
        snapshotPath,
        databasePath: targetPath,
        rollbackRoot: join(root, "rb"),
      }),
    ).rejects.toThrow(/size mismatch|SHA-256/u);
    expect(sha256(targetPath)).toBe(before);
  });

  it("rejects foreign-key violations before changing the target", async () => {
    const { root, snapshotPath, targetPath } = await snapshotAndTarget();
    const snapshotDbPath = join(snapshotPath, "cockpit.sqlite");
    const snapshotDb = new DatabaseSync(snapshotDbPath);
    snapshotDb.exec("PRAGMA foreign_keys = OFF");
    snapshotDb
      .prepare(
        `INSERT INTO commands
          (id, workspace_id, kind, payload_json, status, created_at, updated_at)
         VALUES ('cmd_broken', 'ws_missing', 'task.start.request', '{}', 'queued', ?, ?)`,
      )
      .run(now, now);
    snapshotDb.close();
    refreshManifestDatabaseDigest(snapshotPath);
    const before = sha256(targetPath);

    await expect(
      restoreCockpitSnapshot({
        snapshotPath,
        databasePath: targetPath,
        rollbackRoot: join(root, "rb"),
      }),
    ).rejects.toThrow(/foreign key violation/u);
    expect(sha256(targetPath)).toBe(before);
  });

  it("rejects snapshots newer than the current migration set", async () => {
    const { root, snapshotPath, targetPath } = await snapshotAndTarget();
    const snapshotDbPath = join(snapshotPath, "cockpit.sqlite");
    const snapshotDb = new DatabaseSync(snapshotDbPath);
    snapshotDb
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES ('9999', 'future', ?)",
      )
      .run(now);
    snapshotDb.close();
    refreshManifestDatabaseDigest(snapshotPath);
    const before = sha256(targetPath);

    await expect(
      restoreCockpitSnapshot({
        snapshotPath,
        databasePath: targetPath,
        rollbackRoot: join(root, "rb"),
      }),
    ).rejects.toThrow(/newer than this Spark build/u);
    expect(sha256(targetPath)).toBe(before);
  });

  it("refuses restore while another process holds the Cockpit database lock", async () => {
    const { root, snapshotPath, targetPath } = await snapshotAndTarget();
    const lockPath = cockpitDatabaseLockPath(targetPath);
    const script = `
      const fs = require('node:fs');
      const path = process.argv[1];
      fs.writeFileSync(path, JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        databasePath: ${JSON.stringify(targetPath)},
        ownerToken: 'child-owner'
      }) + '\\n', { flag: 'wx', mode: 0o600 });
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script, lockPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await once(child.stdout!, "data");
    const before = sha256(targetPath);

    try {
      await expect(
        restoreCockpitSnapshot({
          snapshotPath,
          databasePath: targetPath,
          rollbackRoot: join(root, "rb"),
        }),
      ).rejects.toBeInstanceOf(CockpitDatabaseLockedError);
      expect(sha256(targetPath)).toBe(before);
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
      rmSync(lockPath, { force: true });
    }
  });

  it("restores the original target when atomic replacement fails after moving it", async () => {
    const { root, snapshotPath, targetPath } = await snapshotAndTarget();
    const before = sha256(targetPath);

    await expect(
      restoreCockpitSnapshot({
        snapshotPath,
        databasePath: targetPath,
        rollbackRoot: join(root, "rb"),
        testHooks: {
          afterTargetMoved() {
            throw new Error("injected replacement failure");
          },
        },
      }),
    ).rejects.toThrow("injected replacement failure");

    expect(sha256(targetPath)).toBe(before);
    const target = new DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(setting(target, "spark_cockpit:instance_id")).toBe(targetInstanceId);
      expect(target.prepare("SELECT id FROM workspaces").get()).toEqual({ id: "ws_target" });
    } finally {
      target.close();
    }
  });

  it("repairs an invalid stored instance id atomically", () => {
    const root = createRoot();
    const databasePath = join(root, "cockpit.sqlite");
    const db = openDatabase({ path: databasePath });
    migrate(db);
    db.prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
      "spark_cockpit:instance_id",
      JSON.stringify("invalid"),
      now,
    );

    const repaired = ensureCockpitInstanceId(db, { instanceId: sourceInstanceId, now });
    expect(repaired).toBe(sourceInstanceId);
    expect(setting(db, "spark_cockpit:instance_id")).toBe(sourceInstanceId);
    db.close();
  });

  it("does not remove a freshly-created lock whose record is still being written", () => {
    const root = createRoot();
    const databasePath = join(root, "cockpit.sqlite");
    const lockPath = cockpitDatabaseLockPath(databasePath);
    writeFileSync(lockPath, "", { mode: 0o600 });

    expect(() => acquireCockpitDatabaseLock(databasePath)).toThrow(CockpitDatabaseLockedError);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("repairs stale lock files but rejects a live lock in the current process", () => {
    const root = createRoot();
    const databasePath = join(root, "cockpit.sqlite");
    const lockPath = cockpitDatabaseLockPath(databasePath);
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        acquiredAt: now,
        databasePath,
        ownerToken: "stale",
      })}\n`,
      "utf8",
    );

    const lock = acquireCockpitDatabaseLock(databasePath);
    expect(lock.record.pid).toBe(process.pid);
    expect(() => acquireCockpitDatabaseLock(databasePath)).toThrow(CockpitDatabaseLockedError);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });
});

async function snapshotAndTarget(): Promise<{
  root: string;
  snapshotPath: string;
  targetPath: string;
}> {
  const root = createRoot();
  const sourcePath = join(root, "source.sqlite");
  const targetPath = join(root, "target.sqlite");
  const snapshotPath = join(root, "source.snapshot");
  const source = seededSourceDatabase(sourcePath);
  await createCockpitSnapshot({ sourceDb: source, destination: snapshotPath, now });
  source.close();
  seededTargetDatabase(targetPath).close();
  return { root, snapshotPath, targetPath };
}

function seededSourceDatabase(path: string): ReturnType<typeof openDatabase> {
  const db = openDatabase({ path });
  migrate(db);
  ensureCockpitInstanceId(db, { instanceId: sourceInstanceId, now });
  db.prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
    "durable.setting",
    JSON.stringify({ retained: true }),
    now,
  );
  db.prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
    "spark_cockpit:web_push_subscription",
    JSON.stringify({ endpoint: "https://push.example.test/1", keys: { p256dh: "x", auth: "y" } }),
    now,
  );
  db.prepare(
    `INSERT INTO users (id, display_name, role, status, created_at, updated_at)
     VALUES ('usr_source', 'Owner', 'owner', 'active', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
     VALUES ('sess_source', 'usr_source', 'sha256:browser-source', ?, '2026-08-15T00:00:00.000Z')`,
  ).run(now);
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
       last_heartbeat_at, created_at, updated_at)
     VALUES ('rt_source', 'install-source', 'Source daemon', 'online', '1', '{}', '{}', ?, ?, ?)`,
  ).run(now, now, now);
  const insertRuntimeToken = db.prepare(
    `INSERT INTO runtime_tokens
      (id, runtime_id, token_hash, label, scopes_json, created_at)
     VALUES (?, 'rt_source', ?, ?, ?, ?)`,
  );
  insertRuntimeToken.run(
    "rttok_access",
    "sha256:access-source",
    "runtime access token",
    '["runtime:connect"]',
    now,
  );
  insertRuntimeToken.run(
    "rttok_refresh",
    "sha256:refresh-source",
    "runtime refresh token",
    '["runtime:refresh"]',
    now,
  );
  db.prepare(
    `INSERT INTO runtime_sessions
      (id, runtime_id, token_id, transport, status, connected_at, last_seen_at)
     VALUES ('rtsn_source', 'rt_source', 'rttok_access', 'websocket', 'connected', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, status, settings_json, created_at, updated_at)
     VALUES ('ws_source', 'source', 'Source workspace', 'active', '{}', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, local_path, display_name, status,
       capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES ('rtwb_source', 'rt_source', 'source', '/workspace/source', 'Source workspace',
             'available', '{}', '{}', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO workspace_owner_bindings
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, created_at)
     VALUES ('wob_source', 'ws_source', 'rtwb_source', 'primary', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO projects
      (id, workspace_id, slug, name, status, metadata_json, created_at, updated_at)
     VALUES ('proj_source', 'ws_source', 'source-project', 'Source project', 'running', '{}', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO commands
      (id, workspace_id, project_id, kind, payload_json, status, created_at, updated_at)
     VALUES ('cmd_source', 'ws_source', 'proj_source', 'task.start.request',
             '{"goal":"preserve"}', 'queued', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO command_deliveries
      (id, command_id, runtime_workspace_binding_id, status, attempt_count, created_at, updated_at)
     VALUES ('deliv_source', 'cmd_source', 'rtwb_source', 'pending', 0, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO events
      (id, workspace_id, project_id, actor_kind, kind, payload_json, created_at)
     VALUES ('evt_source', 'ws_source', 'proj_source', 'server', 'command.queued', '{}', ?)`,
  ).run(now);
  const insertDeviceAuthorization = db.prepare(
    `INSERT INTO runtime_device_authorizations
      (id, device_code_hash, user_code_hash, installation_id, display_name,
       registration_json, scopes_json, created_at, expires_at, interval_seconds, consumed_at,
       created_runtime_id)
     VALUES (?, ?, ?, 'install-source', 'Source daemon', '{}', '[]', ?,
             '2026-07-15T01:00:00.000Z', 5, ?, ?)`,
  );
  insertDeviceAuthorization.run(
    "rtda_pending",
    "sha256:device-pending",
    "sha256:user-pending",
    now,
    null,
    null,
  );
  insertDeviceAuthorization.run(
    "rtda_consumed",
    "sha256:device-consumed",
    "sha256:user-consumed",
    now,
    "2026-07-14T23:59:00.000Z",
    "rt_source",
  );
  db.prepare(
    `INSERT INTO artifacts
      (id, workspace_id, project_id, scope, kind, title, format, source,
       hash, content_ref_json, provenance_json, created_at, updated_at)
     VALUES ('art_source', 'ws_source', 'proj_source', 'project', 'report', 'Report',
             'markdown', 'server', 'sha256:artifact', '{}', '{}', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO artifact_cache_blobs
      (id, artifact_id, hash, cache_path, source_ref_json, state, created_at, updated_at)
     VALUES ('cache_source', 'art_source', 'sha256:artifact', '/old-origin/cache', '{}',
             'ready', ?, ?)`,
  ).run(now, now);
  return db;
}

function seededTargetDatabase(path: string): ReturnType<typeof openDatabase> {
  const db = openDatabase({ path });
  migrate(db);
  ensureCockpitInstanceId(db, { instanceId: targetInstanceId, now });
  db.prepare(
    `INSERT INTO users (id, display_name, role, status, created_at, updated_at)
     VALUES ('usr_target', 'Target Owner', 'owner', 'active', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, status, settings_json, created_at, updated_at)
     VALUES ('ws_target', 'target', 'Target workspace', 'active', '{}', ?, ?)`,
  ).run(now, now);
  return db;
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
  return row.count;
}

function setting(db: DatabaseSync, key: string): unknown {
  const row = db
    .prepare("SELECT value_json AS valueJson FROM app_settings WHERE key = ?")
    .get(key) as { valueJson: string } | undefined;
  return row ? (JSON.parse(row.valueJson) as unknown) : null;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function refreshManifestDatabaseDigest(snapshotPath: string): void {
  const manifestPath = join(snapshotPath, "manifest.json");
  const databasePath = join(snapshotPath, "cockpit.sqlite");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CockpitSnapshotManifest;
  manifest.database.sha256 = sha256(databasePath);
  manifest.database.sizeBytes = statSync(databasePath).size;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
