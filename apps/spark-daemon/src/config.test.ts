import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNaviaPaths } from "@zendev-lab/navia-system";
import { readSparkDaemonConfig, writeSparkDaemonConfig } from "./config.js";

describe("Spark daemon config", () => {
  it("round-trips daemon TOML with private file permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-config-"));
    const paths = resolveNaviaPaths({
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

    try {
      writeSparkDaemonConfig(paths, {
        installationId: "install-test",
        displayName: "Test Daemon",
        serverUrl: "http://127.0.0.1:5173",
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeToken: "navia_rt_test_token_00000000000000000000000000000000",
        runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
        refreshToken: "navia_rt_refresh_test_0000000000000000000000000000",
        refreshTokenExpiresAt: "2026-06-24T00:00:00.000Z",
        webSocketUrl: "ws://127.0.0.1:5173/api/v1/runtime/runtimes/rt/ws",
      });

      expect(readSparkDaemonConfig(paths)).toMatchObject({
        installationId: "install-test",
        displayName: "Test Daemon",
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
        refreshTokenExpiresAt: "2026-06-24T00:00:00.000Z",
      });
      expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
