import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveNaviaPaths } from "@zendev-lab/navia-system";
import { readRunnerConfig, writeRunnerConfig } from "./config.js";
import {
  nextRunnerTokenRefreshDelayMs,
  refreshRunnerCredentials,
  shouldRefreshRunnerToken,
} from "./token-refresh.js";

describe("runner token refresh", () => {
  it("detects tokens that need refresh before expiry", () => {
    expect(
      shouldRefreshRunnerToken(
        {
          installationId: "install-test",
          displayName: "Test runner",
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "navia_rt_test_token_00000000000000000000000000000000",
          runtimeTokenExpiresAt: "2026-05-25T00:04:59.000Z",
          refreshToken: "navia_rt_refresh_test_0000000000000000000000000000",
        },
        new Date("2026-05-25T00:00:00.000Z"),
      ),
    ).toBe(true);

    expect(
      nextRunnerTokenRefreshDelayMs(
        {
          installationId: "install-test",
          displayName: "Test runner",
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "navia_rt_test_token_00000000000000000000000000000000",
          runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
          refreshToken: "navia_rt_refresh_test_0000000000000000000000000000",
        },
        new Date("2026-05-25T00:00:00.000Z"),
      ),
    ).toBe(55 * 60 * 1000);
  });

  it("refreshes credentials and writes the rotated tokens to config", async () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-refresh-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        configFile: join(root, "config", "runner.toml"),
      },
    });
    const config = {
      installationId: "install-test",
      displayName: "Test runner",
      serverUrl: "http://127.0.0.1:5173",
      runtimeId: "rt_11111111111141111111111111111111",
      runtimeToken: "navia_rt_old_token_0000000000000000000000000000000",
      runtimeTokenExpiresAt: "2026-05-25T00:01:00.000Z",
      refreshToken: "navia_rt_refresh_old_000000000000000000000000000",
      refreshTokenExpiresAt: "2026-06-24T00:00:00.000Z",
    };
    writeRunnerConfig(paths, config);
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          runtimeId: config.runtimeId,
          runtimeToken: "navia_rt_new_token_0000000000000000000000000000000",
          runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
          refreshToken: "navia_rt_refresh_new_000000000000000000000000000",
          refreshTokenExpiresAt: "2026-06-24T00:30:00.000Z",
          refreshedAt: "2026-05-25T00:30:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const refreshed = await refreshRunnerCredentials({
        paths,
        config,
        fetchFn,
      });

      expect(fetchFn).toHaveBeenCalledWith(
        new URL(
          "/api/v1/runtime/runtimes/rt_11111111111141111111111111111111/token/refresh",
          "http://127.0.0.1:5173",
        ),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            refreshToken: "navia_rt_refresh_old_000000000000000000000000000",
          }),
        }),
      );
      expect(refreshed.runtimeToken).toBe("navia_rt_new_token_0000000000000000000000000000000");
      expect(config.refreshToken).toBe("navia_rt_refresh_new_000000000000000000000000000");
      expect(readRunnerConfig(paths)).toMatchObject({
        runtimeToken: "navia_rt_new_token_0000000000000000000000000000000",
        refreshToken: "navia_rt_refresh_new_000000000000000000000000000",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails loudly when token refresh has no server URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "navia-runner-refresh-"));
    const paths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        configFile: join(root, "config", "runner.toml"),
      },
    });
    const fetchFn = vi.fn();

    try {
      await expect(
        refreshRunnerCredentials({
          paths,
          config: {
            installationId: "install-test",
            displayName: "Test runner",
            runtimeId: "rt_11111111111141111111111111111111",
            runtimeToken: "navia_rt_old_token_0000000000000000000000000000000",
            refreshToken: "navia_rt_refresh_old_000000000000000000000000000",
          },
          fetchFn,
        }),
      ).rejects.toThrow("serverUrl");
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
