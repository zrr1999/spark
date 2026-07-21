import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  desiredUplinkServerUrls,
  parkSparkDaemonUplink,
  preferSparkDaemonWorkspaceUplink,
  sparkDaemonUplinkStatus,
  unparkSparkDaemonUplink,
} from "./uplink.js";
import { upsertSparkDaemonServerProfile } from "./server-profiles.js";
import { openSparkDaemonDatabase } from "./store/schema.js";
import { getWorkspaceById, registerWorkspace } from "./store/workspaces.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon uplink park/prefer", () => {
  it("omits parked origins from the desired uplink set and restores on unpark", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-uplink-park-"));
    roots.push(root);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        configFile: join(root, "config", "daemon.toml"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    const workspacePath = join(root, "checkout");
    mkdirSync(workspacePath, { recursive: true });
    const serverUrl = "http://127.0.0.1:5173/";
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl,
      runtimeId: "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      runtimeToken: "spark_rt_access_00000000000000000000000000000000",
    });
    registerWorkspace(db, {
      serverUrl,
      localPath: workspacePath,
      localWorkspaceKey: "checkout",
      displayName: "checkout",
      serverBindingId: "rtwb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      serverWorkspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect([...desiredUplinkServerUrls(paths, db)]).toEqual([serverUrl]);
    await parkSparkDaemonUplink(paths, serverUrl);
    expect([...desiredUplinkServerUrls(paths, db)]).toEqual([]);
    expect(sparkDaemonUplinkStatus(paths, db).origins[0]).toMatchObject({
      serverUrl,
      parked: true,
      desired: false,
    });
    await unparkSparkDaemonUplink(paths, serverUrl);
    expect([...desiredUplinkServerUrls(paths, db)]).toEqual([serverUrl]);
    db.close();
  });

  it("prefers a workspace onto another runnable origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-uplink-prefer-"));
    roots.push(root);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        configFile: join(root, "config", "daemon.toml"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    const workspacePath = join(root, "spark");
    mkdirSync(workspacePath, { recursive: true });
    const prod = "https://prod.example/";
    const local = "http://127.0.0.1:5173/";
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: prod,
      runtimeId: "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      runtimeToken: "spark_rt_access_11111111111111111111111111111111",
    });
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: local,
      runtimeId: "rt_cccccccccccccccccccccccccccccccc",
      runtimeToken: "spark_rt_access_22222222222222222222222222222222",
    });
    const workspace = registerWorkspace(db, {
      serverUrl: prod,
      localPath: workspacePath,
      localWorkspaceKey: "spark",
      displayName: "spark",
      serverBindingId: "rtwb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      serverWorkspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    const preferred = preferSparkDaemonWorkspaceUplink(paths, db, {
      workspace: workspace.id,
      serverUrl: local,
    });
    expect(preferred.previousServerUrl).toBe(prod);
    expect(preferred.serverUrl).toBe(local);
    expect(getWorkspaceById(db, workspace.id)?.serverUrl).toBe(local);
    db.close();
  });
});
