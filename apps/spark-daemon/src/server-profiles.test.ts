import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig, writeSparkDaemonConfig } from "./config.js";
import {
  getSparkDaemonServerProfile,
  listSparkDaemonServerProfiles,
  removeSparkDaemonServerProfile,
  sparkDaemonConfigForServerProfile,
  sparkDaemonServerProfilesLockPath,
  sparkDaemonServerProfilesFile,
  SparkDaemonServerProfilesLockTimeoutError,
  upsertSparkDaemonServerProfile,
  withSparkDaemonServerProfilesLock,
} from "./server-profiles.js";

describe("Spark daemon server profiles", () => {
  it("normalizes profile keys and atomically writes a private profile file", async () => {
    const { root, paths } = tempSparkPaths();

    try {
      await upsertSparkDaemonServerProfile(paths, {
        serverUrl: "https://COCKPIT.example.test:443",
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeToken: "spark_rt_a",
        refreshToken: "spark_refresh_a",
      });

      expect(getSparkDaemonServerProfile(paths, "https://cockpit.example.test")).toEqual({
        serverUrl: "https://cockpit.example.test/",
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeToken: "spark_rt_a",
        refreshToken: "spark_refresh_a",
      });
      expect(statSync(sparkDaemonServerProfilesFile(paths)).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(root, "config"))).toEqual(["daemon-server-profiles.json"]);
      await expect(
        removeSparkDaemonServerProfile(paths, "https://cockpit.example.test"),
      ).resolves.toBe(true);
      expect(getSparkDaemonServerProfile(paths, "https://cockpit.example.test")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads legacy daemon.toml as fallback and migrates it without losing another server", async () => {
    const { root, paths } = tempSparkPaths();
    writeSparkDaemonConfig(paths, {
      installationId: "install-test",
      displayName: "Test daemon",
      serverUrl: "https://legacy.example.test",
      runtimeId: "rt_legacy",
      runtimeToken: "spark_rt_legacy",
      refreshToken: "spark_refresh_legacy",
      webSocketUrl: "wss://legacy.example.test/runtime/ws",
    });

    try {
      expect(getSparkDaemonServerProfile(paths, "https://legacy.example.test")).toMatchObject({
        serverUrl: "https://legacy.example.test/",
        runtimeId: "rt_legacy",
      });

      await upsertSparkDaemonServerProfile(paths, {
        serverUrl: "https://second.example.test",
        runtimeId: "rt_second",
        runtimeToken: "spark_rt_second",
        refreshToken: "spark_refresh_second",
        webSocketUrl: "wss://second.example.test/runtime/ws",
      });

      expect(listSparkDaemonServerProfiles(paths)).toEqual([
        expect.objectContaining({
          serverUrl: "https://legacy.example.test/",
          runtimeId: "rt_legacy",
          runtimeToken: "spark_rt_legacy",
        }),
        expect.objectContaining({
          serverUrl: "https://second.example.test/",
          runtimeId: "rt_second",
          runtimeToken: "spark_rt_second",
        }),
      ]);
      expect(readSparkDaemonConfig(paths)).toMatchObject({
        serverUrl: "https://legacy.example.test",
        runtimeToken: "spark_rt_legacy",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes interleaved read-merge-write mutations through the filesystem lock", async () => {
    const { root, paths } = tempSparkPaths();
    let releaseHeldLock!: () => void;
    let markLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      markLockHeld = resolve;
    });
    const releaseLock = new Promise<void>((resolve) => {
      releaseHeldLock = resolve;
    });

    try {
      const holder = withSparkDaemonServerProfilesLock(paths, async () => {
        markLockHeld();
        await releaseLock;
      });
      await lockHeld;

      let firstSettled = false;
      let secondSettled = false;
      const first = upsertSparkDaemonServerProfile(paths, {
        serverUrl: "https://first.example.test",
        runtimeId: "rt_first",
        refreshToken: "refresh-first",
      }).then(() => {
        firstSettled = true;
      });
      const second = upsertSparkDaemonServerProfile(paths, {
        serverUrl: "https://second.example.test",
        runtimeId: "rt_second",
        refreshToken: "refresh-second",
      }).then(() => {
        secondSettled = true;
      });

      await delay(40);
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      releaseHeldLock();
      await Promise.all([holder, first, second]);

      expect(listSparkDaemonServerProfiles(paths).map(({ serverUrl }) => serverUrl)).toEqual([
        "https://first.example.test/",
        "https://second.example.test/",
      ]);
    } finally {
      releaseHeldLock?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for a profile lock owned by another process", async () => {
    const { root, paths } = tempSparkPaths();
    const lockPath = sparkDaemonServerProfilesLockPath(paths);
    const holder = spawn(
      process.execPath,
      [
        "--eval",
        `
          const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
          const { dirname, join } = require("node:path");
          const lockPath = process.argv[1];
          mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
          mkdirSync(lockPath, { recursive: false, mode: 0o700 });
          writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
            ownerId: "child-process-owner",
            pid: process.pid,
            startedAt: new Date().toISOString(),
            heartbeatAt: new Date().toISOString(),
          }), { mode: 0o600 });
          process.stdout.write("locked\\n");
          process.stdin.once("data", () => {
            rmSync(lockPath, { recursive: true, force: true });
            process.exit(0);
          });
          process.stdin.resume();
        `,
        lockPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    try {
      await waitForChildReady(holder);
      let settled = false;
      const mutation = upsertSparkDaemonServerProfile(paths, {
        serverUrl: "https://cross-process.example.test",
        runtimeId: "rt_cross_process",
        refreshToken: "refresh-cross-process",
      }).then(() => {
        settled = true;
      });

      await delay(40);
      expect(settled).toBe(false);
      holder.stdin.write("release\n");
      await mutation;
      await waitForChildExit(holder);
      expect(
        getSparkDaemonServerProfile(paths, "https://cross-process.example.test"),
      ).toMatchObject({ runtimeId: "rt_cross_process" });
    } finally {
      if (holder.exitCode === null && !holder.stdin.destroyed) {
        holder.stdin.write("release\n");
        holder.kill();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds lock waits instead of blocking the event loop indefinitely", async () => {
    const { root, paths } = tempSparkPaths();
    let releaseHeldLock!: () => void;
    let markLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      markLockHeld = resolve;
    });
    const releaseLock = new Promise<void>((resolve) => {
      releaseHeldLock = resolve;
    });

    try {
      const holder = withSparkDaemonServerProfilesLock(paths, async () => {
        markLockHeld();
        await releaseLock;
      });
      await lockHeld;

      await expect(
        upsertSparkDaemonServerProfile(
          paths,
          {
            serverUrl: "https://waiting.example.test",
            runtimeId: "rt_waiting",
            refreshToken: "refresh-waiting",
          },
          { timeoutMs: 30, retryIntervalMs: 5, staleMs: 60_000 },
        ),
      ).rejects.toBeInstanceOf(SparkDaemonServerProfilesLockTimeoutError);

      releaseHeldLock();
      await holder;
    } finally {
      releaseHeldLock?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers an abandoned stale filesystem lock", async () => {
    const { root, paths } = tempSparkPaths();
    const lockPath = sparkDaemonServerProfilesLockPath(paths);
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        ownerId: "abandoned-owner",
        pid: 999_999,
        startedAt: "2020-01-01T00:00:00.000Z",
        heartbeatAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    try {
      await expect(
        upsertSparkDaemonServerProfile(
          paths,
          {
            serverUrl: "https://recovered.example.test",
            runtimeId: "rt_recovered",
            refreshToken: "refresh-recovered",
          },
          { timeoutMs: 500, retryIntervalMs: 5, staleMs: 1 },
        ),
      ).resolves.toMatchObject({ serverUrl: "https://recovered.example.test/" });
      expect(getSparkDaemonServerProfile(paths, "https://recovered.example.test")).toMatchObject({
        runtimeId: "rt_recovered",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds compatibility configs without credentials from a different server", () => {
    expect(
      sparkDaemonConfigForServerProfile(
        {
          installationId: "install-test",
          displayName: "Test daemon",
        },
        {
          serverUrl: "https://target.example.test",
          runtimeId: "rt_target",
          runtimeToken: "spark_rt_target",
        },
      ),
    ).toEqual({
      installationId: "install-test",
      displayName: "Test daemon",
      serverUrl: "https://target.example.test/",
      runtimeId: "rt_target",
      runtimeToken: "spark_rt_target",
    });
  });
});

function tempSparkPaths() {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-server-profiles-"));
  return {
    root,
    paths: resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        configFile: join(root, "config", "daemon.toml"),
      },
    }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Lock holder exited early with code ${code}.`)));
    child.stdout.once("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("locked")) {
        resolve();
      } else {
        reject(new Error(`Unexpected lock holder output: ${chunk.toString("utf8")}`));
      }
    });
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Lock holder exited with code ${code}.`));
      }
    });
  });
}
