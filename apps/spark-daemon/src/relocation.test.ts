import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig, writeSparkDaemonConfig } from "./config.ts";
import { relocateSparkDaemonCockpit } from "./relocation.ts";
import {
  getSparkDaemonServerProfile,
  listSparkDaemonServerProfiles,
  upsertSparkDaemonServerProfile,
} from "./server-profiles.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import { ensureLocalWorkspace, registerWorkspace } from "./store/workspaces.ts";

const sourceUrl = "http://127.0.0.1:4173/";
const targetUrl = "https://target.example.test/";
const thirdUrl = "https://third.example.test/";
const instanceId = "cockpit_11111111111111111111111111111111";
const runtimeId = "rt_11111111111111111111111111111111";
const now = "2026-07-15T00:00:00.000Z";

interface Harness {
  root: string;
  paths: ReturnType<typeof resolveSparkPaths>;
  db: DatabaseSync;
  sourceBindingId: string;
  localBindingId: string;
  thirdBindingId: string;
  cleanup(): Promise<void>;
}

interface SetupOptions {
  sourceCredentials?: "profile" | "legacy";
  includeThirdProfile?: boolean;
}

describe("daemon Cockpit relocation", () => {
  it("moves only source-origin routes while preserving stable identities", async () => {
    const h = await setup();
    const reconnect = vi.fn();
    try {
      const result = await relocateSparkDaemonCockpit(
        h.paths,
        h.db,
        { fromServerUrl: sourceUrl, toServerUrl: targetUrl },
        { fetchFn: relocationFetch(), now: () => now, onUplinkReconfigure: reconnect },
      );

      expect(result).toMatchObject({
        instanceId,
        installationId: "install-relocation",
        runtimeId,
        fromServerUrl: sourceUrl,
        toServerUrl: targetUrl,
        webSocketUrl: `wss://target.example.test/api/v1/runtime/runtimes/${runtimeId}/ws`,
        workspaceBindingIds: [h.sourceBindingId],
        workspaceCount: 1,
      });
      expect(reconnect).toHaveBeenCalledOnce();
      expect(reconnect).toHaveBeenCalledWith(sourceUrl);
      expect(readSparkDaemonConfig(h.paths)).toEqual({
        installationId: "install-relocation",
        displayName: "Relocation daemon",
      });
      expect(getSparkDaemonServerProfile(h.paths, targetUrl)).toMatchObject({
        runtimeId,
        serverUrl: targetUrl,
        runtimeToken: "runtime-token-rotated-00000000000000000000",
        refreshToken: "refresh-token-rotated-00000000000000000000",
        webSocketUrl: `wss://target.example.test/api/v1/runtime/runtimes/${runtimeId}/ws`,
      });
      expect(getSparkDaemonServerProfile(h.paths, sourceUrl)).toBeUndefined();
      expect(getSparkDaemonServerProfile(h.paths, thirdUrl)).toMatchObject({
        serverUrl: thirdUrl,
        runtimeId: "rt_33333333333333333333333333333333",
        runtimeToken: "runtime-token-third-0000000000000000000000",
      });
      const routes = workspaceRoutes(h.db);
      expect(routes).toHaveLength(3);
      expect(routes).toEqual(
        expect.arrayContaining([
          { id: h.localBindingId, serverUrl: "" },
          { id: h.sourceBindingId, serverUrl: targetUrl },
          { id: h.thirdBindingId, serverUrl: thirdUrl },
        ]),
      );
      expect(serverRoutes(h.db)).toContainEqual({ serverUrl: targetUrl, workspaceCount: 1 });
      expect(serverRoutes(h.db)).toContainEqual({ serverUrl: thirdUrl, workspaceCount: 1 });
      expect(auditRows(h.db)).toEqual([
        expect.objectContaining({
          instanceId,
          runtimeId,
          fromServerUrl: sourceUrl,
          toServerUrl: targetUrl,
          workspaceCount: 1,
          outcome: "succeeded",
        }),
      ]);
      expect(databaseText(h.db)).not.toContain("runtime-token-rotated");
      expect(databaseText(h.db)).not.toContain("refresh-token-rotated");
    } finally {
      await h.cleanup();
    }
  });

  it.each([
    ["instance mismatch", { targetInstanceId: "cockpit_22222222222222222222222222222222" }],
    ["runtime missing", { preflightStatus: 409, preflightCode: "relocation_runtime_not_found" }],
    ["token rejected", { preflightStatus: 401, preflightCode: "refresh_token_invalid" }],
    ["runtime mismatch", { responseRuntimeId: "rt_22222222222222222222222222222222" }],
    ["target unreachable", { unreachable: true }],
    ["cross-origin websocket", { webSocketUrl: "wss://attacker.example.test/runtime" }],
  ] as const)("rejects %s before local mutation", async (_name, scenario) => {
    const h = await setup();
    const before = localDigest(h);
    const reconnect = vi.fn();
    try {
      await expect(
        relocateSparkDaemonCockpit(
          h.paths,
          h.db,
          { fromServerUrl: sourceUrl, toServerUrl: targetUrl },
          { fetchFn: relocationFetch(scenario), onUplinkReconfigure: reconnect },
        ),
      ).rejects.toThrow();
      expect(localDigest(h)).toBe(before);
      expect(reconnect).not.toHaveBeenCalled();
      expect(auditRows(h.db)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it("rejects a locally registered target collision before network preflight", async () => {
    const h = await setup();
    try {
      registerWorkspace(h.db, {
        serverUrl: targetUrl,
        serverBindingId: "rtwb_44444444444444444444444444444444",
        serverWorkspaceId: "ws_44444444444444444444444444444444",
        localWorkspaceKey: "target",
        displayName: "Target collision",
        workspaceName: "Target collision",
        workspaceSlug: "target",
        localPath: join(h.root, "target"),
        now,
      });
      const before = localDigest(h);
      const fetchFn = vi.fn<typeof fetch>();
      await expect(
        relocateSparkDaemonCockpit(
          h.paths,
          h.db,
          { fromServerUrl: sourceUrl, toServerUrl: targetUrl },
          { fetchFn },
        ),
      ).rejects.toMatchObject({ code: "RELOCATION_TARGET_COLLISION" });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(localDigest(h)).toBe(before);
    } finally {
      await h.cleanup();
    }
  });

  it("rolls back SQLite and config when the local commit fails", async () => {
    const h = await setup();
    await upsertSparkDaemonServerProfile(h.paths, {
      serverUrl: targetUrl,
      runtimeId: "rt_22222222222222222222222222222222",
      runtimeToken: "runtime-token-target-before-000000000000000000",
      refreshToken: "refresh-token-target-before-000000000000000000",
      webSocketUrl: "wss://target.example.test/runtime-before",
    });
    const before = localDigest(h);
    const reconnect = vi.fn();
    try {
      await expect(
        relocateSparkDaemonCockpit(
          h.paths,
          h.db,
          { fromServerUrl: sourceUrl, toServerUrl: targetUrl },
          {
            fetchFn: relocationFetch(),
            beforeCommit: () => {
              throw new Error("injected local transaction failure");
            },
            onUplinkReconfigure: reconnect,
          },
        ),
      ).rejects.toThrow("injected local transaction failure");
      expect(localDigest(h)).toBe(before);
      expect(getSparkDaemonServerProfile(h.paths, targetUrl)).toMatchObject({
        runtimeId: "rt_22222222222222222222222222222222",
        runtimeToken: "runtime-token-target-before-000000000000000000",
      });
      expect(reconnect).not.toHaveBeenCalled();
      expect(auditRows(h.db)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it("infers the only workspace-bound source profile when fromServerUrl is omitted", async () => {
    const h = await setup({ includeThirdProfile: false });
    try {
      const result = await relocateSparkDaemonCockpit(
        h.paths,
        h.db,
        { toServerUrl: targetUrl },
        { fetchFn: relocationFetch(), now: () => now },
      );

      expect(result.fromServerUrl).toBe(sourceUrl);
      expect(getSparkDaemonServerProfile(h.paths, sourceUrl)).toBeUndefined();
      expect(getSparkDaemonServerProfile(h.paths, targetUrl)?.runtimeId).toBe(runtimeId);
    } finally {
      await h.cleanup();
    }
  });

  it("requires fromServerUrl when multiple workspace-bound profiles exist", async () => {
    const h = await setup();
    const fetchFn = vi.fn<typeof fetch>();
    try {
      await expect(
        relocateSparkDaemonCockpit(h.paths, h.db, { toServerUrl: targetUrl }, { fetchFn }),
      ).rejects.toMatchObject({ code: "RELOCATION_SOURCE_REQUIRED" });
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      await h.cleanup();
    }
  });

  it("migrates a legacy source tuple and leaves daemon.toml identity-only", async () => {
    const h = await setup({ sourceCredentials: "legacy" });
    try {
      await relocateSparkDaemonCockpit(
        h.paths,
        h.db,
        { fromServerUrl: sourceUrl, toServerUrl: targetUrl },
        { fetchFn: relocationFetch(), now: () => now },
      );

      expect(readSparkDaemonConfig(h.paths)).toEqual({
        installationId: "install-relocation",
        displayName: "Relocation daemon",
      });
      expect(getSparkDaemonServerProfile(h.paths, sourceUrl)).toBeUndefined();
      expect(getSparkDaemonServerProfile(h.paths, targetUrl)?.runtimeId).toBe(runtimeId);
      expect(getSparkDaemonServerProfile(h.paths, thirdUrl)?.runtimeId).toBe(
        "rt_33333333333333333333333333333333",
      );
    } finally {
      await h.cleanup();
    }
  });
});

interface RelocationFetchScenario {
  targetInstanceId?: string;
  preflightStatus?: number;
  preflightCode?: string;
  responseRuntimeId?: string;
  webSocketUrl?: string;
  unreachable?: boolean;
}

function relocationFetch(scenario: RelocationFetchScenario = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (scenario.unreachable && url.origin === new URL(targetUrl).origin) {
      throw new Error("target unreachable");
    }
    if (url.pathname.endsWith("/relocation/metadata")) {
      return Response.json({
        instanceId:
          url.origin === new URL(targetUrl).origin
            ? (scenario.targetInstanceId ?? instanceId)
            : instanceId,
        protocolVersion: runtimeProtocolVersion,
      });
    }
    if (url.pathname.endsWith("/relocation/preflight")) {
      if (scenario.preflightStatus) {
        return Response.json(
          {
            error: {
              code: scenario.preflightCode ?? "preflight_rejected",
              message: "injected target preflight rejection",
            },
          },
          { status: scenario.preflightStatus },
        );
      }
      return Response.json({
        instanceId,
        runtimeId: scenario.responseRuntimeId ?? runtimeId,
        runtimeToken: "runtime-token-rotated-00000000000000000000",
        runtimeTokenExpiresAt: "2026-07-15T01:00:00.000Z",
        refreshToken: "refresh-token-rotated-00000000000000000000",
        refreshTokenExpiresAt: "2026-08-15T00:00:00.000Z",
        refreshedAt: now,
        webSocketUrl:
          scenario.webSocketUrl ??
          `wss://target.example.test/api/v1/runtime/runtimes/${scenario.responseRuntimeId ?? runtimeId}/ws`,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "spark-daemon-relocation-"));
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "data"),
      configFile: join(root, "config", "daemon.toml"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  const db = openSparkDaemonDatabase(paths);
  const identity = {
    installationId: "install-relocation",
    displayName: "Relocation daemon",
  };
  writeSparkDaemonConfig(paths, identity);
  if (options.includeThirdProfile !== false) {
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: thirdUrl,
      runtimeId: "rt_33333333333333333333333333333333",
      runtimeToken: "runtime-token-third-0000000000000000000000",
      refreshToken: "refresh-token-third-0000000000000000000000",
      webSocketUrl: "wss://third.example.test/runtime",
    });
  }
  const sourceCredentials = {
    serverUrl: sourceUrl,
    runtimeId,
    runtimeToken: "runtime-token-source-000000000000000000000",
    runtimeTokenExpiresAt: "2026-07-15T01:00:00.000Z",
    refreshToken: "refresh-token-source-000000000000000000000",
    refreshTokenExpiresAt: "2026-08-15T00:00:00.000Z",
    webSocketUrl: `ws://127.0.0.1:4173/api/v1/runtime/runtimes/${runtimeId}/ws`,
  };
  if (options.sourceCredentials === "legacy") {
    writeSparkDaemonConfig(paths, { ...identity, ...sourceCredentials });
  } else {
    await upsertSparkDaemonServerProfile(paths, sourceCredentials);
  }
  const source = registerWorkspace(db, {
    serverUrl: sourceUrl,
    serverBindingId: "rtwb_11111111111111111111111111111111",
    serverWorkspaceId: "ws_11111111111111111111111111111111",
    localWorkspaceKey: "source",
    displayName: "Source",
    workspaceName: "Source",
    workspaceSlug: "source",
    localPath: join(root, "source"),
    serverCredential: {
      runtimeId,
      runtimeToken: "runtime-token-source-000000000000000000000",
      refreshToken: "refresh-token-source-000000000000000000000",
    },
    now,
  });
  const local = ensureLocalWorkspace(db, {
    localPath: join(root, "local"),
    localWorkspaceKey: "local",
    displayName: "Local",
    now,
  });
  const third = registerWorkspace(db, {
    serverUrl: thirdUrl,
    serverBindingId: "rtwb_33333333333333333333333333333333",
    serverWorkspaceId: "ws_33333333333333333333333333333333",
    localWorkspaceKey: "third",
    displayName: "Third",
    workspaceName: "Third",
    workspaceSlug: "third",
    localPath: join(root, "third"),
    now,
  });
  return {
    root,
    paths,
    db,
    sourceBindingId: source.id,
    localBindingId: local.id,
    thirdBindingId: third.id,
    async cleanup() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function localDigest(h: Harness): string {
  const tables = [
    "workspaces",
    "daemon_servers",
    "daemon_server_credentials",
    "daemon_workspaces",
    "daemon_relocation_audit",
  ];
  const state = {
    config: readFileSync(h.paths.configFile, "utf8"),
    profiles: listSparkDaemonServerProfiles(h.paths),
    tables: tables.map((table) => ({
      table,
      rows: h.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    })),
  };
  return createHash("sha256").update(JSON.stringify(state, jsonBigInt)).digest("hex");
}

function workspaceRoutes(db: DatabaseSync) {
  return db
    .prepare("SELECT id, server_url AS serverUrl FROM workspaces ORDER BY id")
    .all() as Array<{ id: string; serverUrl: string }>;
}

function serverRoutes(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT s.server_url AS serverUrl, COUNT(w.id) AS workspaceCount
       FROM daemon_servers s
       LEFT JOIN daemon_workspaces w ON w.server_id = s.id
       GROUP BY s.id
       ORDER BY s.server_url`,
    )
    .all() as Array<{ serverUrl: string; workspaceCount: number }>;
}

function auditRows(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT instance_id AS instanceId, runtime_id AS runtimeId,
              from_server_url AS fromServerUrl, to_server_url AS toServerUrl,
              workspace_count AS workspaceCount, outcome
       FROM daemon_relocation_audit
       ORDER BY created_at`,
    )
    .all();
}

function databaseText(db: DatabaseSync): string {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return JSON.stringify(
    tables.map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM ${name}`).all() })),
    jsonBigInt,
  );
}

function jsonBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}
