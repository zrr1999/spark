import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig, writeSparkDaemonConfig } from "./config.js";
import {
  getSparkDaemonServerProfile,
  listSparkDaemonServerProfiles,
  sparkDaemonConfigForServerProfile,
  upsertSparkDaemonServerProfile,
} from "./server-profiles.js";
import {
  nextSparkDaemonTokenRefreshDelayMs,
  refreshSparkDaemonCredentials,
  shouldRefreshSparkDaemonToken,
} from "./token-refresh.js";

describe("Spark daemon token refresh", () => {
  it("detects tokens that need refresh before expiry", () => {
    expect(
      shouldRefreshSparkDaemonToken(
        {
          installationId: "install-test",
          displayName: "Test daemon",
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "spark_rt_test_token_00000000000000000000000000000000",
          runtimeTokenExpiresAt: "2026-05-25T00:04:59.000Z",
          refreshToken: "spark_rt_refresh_test_0000000000000000000000000000",
        },
        new Date("2026-05-25T00:00:00.000Z"),
      ),
    ).toBe(true);

    expect(
      nextSparkDaemonTokenRefreshDelayMs(
        {
          installationId: "install-test",
          displayName: "Test daemon",
          runtimeId: "rt_11111111111141111111111111111111",
          runtimeToken: "spark_rt_test_token_00000000000000000000000000000000",
          runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
          refreshToken: "spark_rt_refresh_test_0000000000000000000000000000",
        },
        new Date("2026-05-25T00:00:00.000Z"),
      ),
    ).toBe(55 * 60 * 1000);
  });

  it("refreshes credentials and writes the rotated tokens to config", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-refresh-"));
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
    const config = {
      installationId: "install-test",
      displayName: "Test daemon",
      serverUrl: "http://127.0.0.1:5173",
      runtimeId: "rt_11111111111141111111111111111111",
      runtimeToken: "spark_rt_old_token_0000000000000000000000000000000",
      runtimeTokenExpiresAt: "2026-05-25T00:01:00.000Z",
      refreshToken: "spark_rt_refresh_old_000000000000000000000000000",
      refreshTokenExpiresAt: "2026-06-24T00:00:00.000Z",
    };
    writeSparkDaemonConfig(paths, config);
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          runtimeId: config.runtimeId,
          runtimeToken: "spark_rt_new_token_0000000000000000000000000000000",
          runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
          refreshToken: "spark_rt_refresh_new_000000000000000000000000000",
          refreshTokenExpiresAt: "2026-06-24T00:30:00.000Z",
          refreshedAt: "2026-05-25T00:30:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const refreshed = await refreshSparkDaemonCredentials({
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
            refreshToken: "spark_rt_refresh_old_000000000000000000000000000",
          }),
        }),
      );
      expect(refreshed.runtimeToken).toBe("spark_rt_new_token_0000000000000000000000000000000");
      expect(config.refreshToken).toBe("spark_rt_refresh_new_000000000000000000000000000");
      expect(readSparkDaemonConfig(paths)).toEqual({
        installationId: "install-test",
        displayName: "Test daemon",
      });
      expect(getSparkDaemonServerProfile(paths, "http://127.0.0.1:5173")).toMatchObject({
        runtimeToken: "spark_rt_new_token_0000000000000000000000000000000",
        refreshToken: "spark_rt_refresh_new_000000000000000000000000000",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rotates only the requested server profile when daemon.toml points elsewhere", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-refresh-"));
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
    const legacy = {
      installationId: "install-test",
      displayName: "Test daemon",
      serverUrl: "https://other.example.test",
      runtimeId: "rt_other",
      runtimeToken: "spark_rt_other",
      refreshToken: "spark_refresh_other",
      webSocketUrl: "wss://other.example.test/runtime/ws",
    };
    writeSparkDaemonConfig(paths, legacy);
    const targetProfile = await upsertSparkDaemonServerProfile(paths, {
      serverUrl: "https://target.example.test",
      runtimeId: "rt_22222222222242222222222222222222",
      runtimeToken: "spark_rt_target_old_000000000000000000000000000000",
      runtimeTokenExpiresAt: "2026-05-25T00:01:00.000Z",
      refreshToken: "spark_refresh_target_old_000000000000000000000000000",
      webSocketUrl: "wss://target.example.test/runtime/ws",
    });
    const config = sparkDaemonConfigForServerProfile(legacy, targetProfile);

    try {
      await refreshSparkDaemonCredentials({
        paths,
        config,
        fetchFn: async (url, init) => {
          const requestUrl =
            url instanceof URL ? url.toString() : typeof url === "string" ? url : url.url;
          expect(requestUrl).toContain(
            "https://target.example.test/api/v1/runtime/runtimes/rt_22222222222242222222222222222222/token/refresh",
          );
          expect(init?.body).toBe(
            JSON.stringify({
              refreshToken: "spark_refresh_target_old_000000000000000000000000000",
            }),
          );
          return new Response(
            JSON.stringify({
              runtimeId: "rt_22222222222242222222222222222222",
              runtimeToken: "spark_rt_target_new_000000000000000000000000000000",
              runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
              refreshToken: "spark_refresh_target_new_000000000000000000000000000",
              refreshTokenExpiresAt: "2026-06-24T00:30:00.000Z",
              refreshedAt: "2026-05-25T00:30:00.000Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      });

      expect(listSparkDaemonServerProfiles(paths)).toEqual([
        expect.objectContaining({
          serverUrl: "https://other.example.test/",
          runtimeId: "rt_other",
          runtimeToken: "spark_rt_other",
          webSocketUrl: "wss://other.example.test/runtime/ws",
        }),
        expect.objectContaining({
          serverUrl: "https://target.example.test/",
          runtimeId: "rt_22222222222242222222222222222222",
          runtimeToken: "spark_rt_target_new_000000000000000000000000000000",
          webSocketUrl: "wss://target.example.test/runtime/ws",
        }),
      ]);
      expect(readSparkDaemonConfig(paths)).toEqual({
        installationId: "install-test",
        displayName: "Test daemon",
      });
      expect(config).toMatchObject({
        serverUrl: "https://target.example.test/",
        runtimeId: "rt_22222222222242222222222222222222",
        runtimeToken: "spark_rt_target_new_000000000000000000000000000000",
        webSocketUrl: "wss://target.example.test/runtime/ws",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discards a late refresh response when registration replaced the credential tuple", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-refresh-cas-"));
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
    const identity = {
      installationId: "install-cas-test",
      displayName: "CAS test daemon",
    };
    writeSparkDaemonConfig(paths, identity);
    const originalProfile = await upsertSparkDaemonServerProfile(paths, {
      serverUrl: "https://cockpit.example.test",
      runtimeId: "rt_11111111111141111111111111111111",
      runtimeToken: "runtime-token-original",
      runtimeTokenExpiresAt: "2026-05-25T00:01:00.000Z",
      refreshToken: "refresh-token-original",
      webSocketUrl: "wss://cockpit.example.test/runtime/original",
    });
    const config = sparkDaemonConfigForServerProfile(identity, originalProfile);
    let resolveFetch!: (response: Response) => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const fetchResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>(() => {
      markRequestStarted();
      return fetchResponse;
    });

    try {
      const refreshing = refreshSparkDaemonCredentials({ paths, config, fetchFn });
      await requestStarted;
      const replacement = await upsertSparkDaemonServerProfile(paths, {
        serverUrl: "https://cockpit.example.test",
        runtimeId: "rt_22222222222242222222222222222222",
        runtimeToken: "runtime-token-from-registration",
        runtimeTokenExpiresAt: "2026-05-25T02:00:00.000Z",
        refreshToken: "refresh-token-from-registration",
        refreshTokenExpiresAt: "2026-06-25T00:00:00.000Z",
        webSocketUrl: "wss://cockpit.example.test/runtime/replacement",
      });
      resolveFetch(
        new Response(
          JSON.stringify({
            runtimeId: originalProfile.runtimeId,
            runtimeToken: "runtime-token-from-late-refresh-0000000000000000",
            runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
            refreshToken: "refresh-token-from-late-refresh-0000000000000000",
            refreshTokenExpiresAt: "2026-06-24T00:30:00.000Z",
            refreshedAt: "2026-05-25T00:30:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      await expect(refreshing).resolves.toMatchObject(replacement);
      expect(getSparkDaemonServerProfile(paths, "https://cockpit.example.test")).toEqual(
        replacement,
      );
      expect(config).toMatchObject({
        runtimeId: "rt_22222222222242222222222222222222",
        runtimeToken: "runtime-token-from-registration",
        refreshToken: "refresh-token-from-registration",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes AbortSignal to fetch and preserves an identifiable AbortError", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-refresh-abort-"));
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
    const identity = {
      installationId: "install-abort-test",
      displayName: "Abort test daemon",
    };
    writeSparkDaemonConfig(paths, identity);
    const profile = await upsertSparkDaemonServerProfile(paths, {
      serverUrl: "https://cockpit.example.test",
      runtimeId: "rt_11111111111141111111111111111111",
      runtimeToken: "runtime-token-original",
      runtimeTokenExpiresAt: "2026-05-25T00:01:00.000Z",
      refreshToken: "refresh-token-original",
      webSocketUrl: "wss://cockpit.example.test/runtime/original",
    });
    const config = sparkDaemonConfigForServerProfile(identity, profile);
    const controller = new AbortController();
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let observedSignal: AbortSignal | null | undefined;
    const fetchFn = vi.fn<typeof fetch>((_url, init) => {
      observedSignal = init?.signal;
      markRequestStarted();
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
          once: true,
        });
      });
    });

    try {
      const refreshing = refreshSparkDaemonCredentials({
        paths,
        config,
        fetchFn,
        signal: controller.signal,
      });
      await requestStarted;
      expect(observedSignal).toBe(controller.signal);
      controller.abort();

      await expect(refreshing).rejects.toMatchObject({ name: "AbortError" });
      expect(getSparkDaemonServerProfile(paths, "https://cockpit.example.test")).toEqual(profile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails loudly when token refresh has no server URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-refresh-"));
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
    const fetchFn = vi.fn();

    try {
      await expect(
        refreshSparkDaemonCredentials({
          paths,
          config: {
            installationId: "install-test",
            displayName: "Test daemon",
            runtimeId: "rt_11111111111141111111111111111111",
            runtimeToken: "spark_rt_old_token_0000000000000000000000000000000",
            refreshToken: "spark_rt_refresh_old_000000000000000000000000000",
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
