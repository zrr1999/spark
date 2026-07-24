import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBuildFingerprint } from "./build-info.ts";
import {
  DEFAULT_SPARK_UPDATE_CONFIG,
  parseUpdateToml,
  readSparkUpdateConfig,
  writeSparkUpdateConfig,
} from "./config.ts";
import { SparkUpdateManager, canAutomaticallyApply, isNetworkCheckDue } from "./manager.ts";
import {
  emptySparkUpdateState,
  nextUpdateRetryAt,
  readSparkUpdateState,
  resolveSparkUpdatePaths,
  withSparkUpdateLock,
  writeSparkUpdateState,
} from "./state.ts";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Spark update configuration and state", () => {
  it("uses notify/latest defaults and applies environment overrides", async () => {
    const root = await temporaryRoot();
    const paths = resolveSparkUpdatePaths({ env: { SPARK_HOME: root, HOME: root } });
    expect(paths.versionsDir).toBe(join(root, ".local", "share", "spark", "versions"));
    expect(await readSparkUpdateConfig(paths, {})).toEqual(DEFAULT_SPARK_UPDATE_CONFIG);

    await writeSparkUpdateConfig(paths, {
      policy: "notify",
      channel: "latest",
      checkIntervalHours: 12,
    });
    expect(
      await readSparkUpdateConfig(paths, {
        SPARK_UPDATE_POLICY: "auto",
        SPARK_UPDATE_CHANNEL: "next",
      }),
    ).toEqual({ policy: "auto", channel: "next", checkIntervalHours: 12 });
    expect(await readFile(paths.configFile, "utf8")).toContain('policy = "notify"');
  });

  it("rejects unknown TOML settings and invalid intervals", () => {
    expect(() => parseUpdateToml('other = "value"')).toThrow(/Unknown/u);
    expect(() => parseUpdateToml("checkIntervalHours = 0")).toThrow(/between 1 and 168/u);
  });

  it("fails closed on invalid environment policy overrides", async () => {
    const root = await temporaryRoot();
    const paths = resolveSparkUpdatePaths({ env: { SPARK_HOME: root, HOME: root } });
    await expect(
      readSparkUpdateConfig(paths, { SPARK_UPDATE_POLICY: "sometimes" }),
    ).rejects.toThrow(/SPARK_UPDATE_POLICY/u);
  });

  it("writes updater state atomically and rejects concurrent owners", async () => {
    const root = await temporaryRoot();
    const paths = resolveSparkUpdatePaths({ env: { SPARK_HOME: root, HOME: root } });
    const state = {
      ...emptySparkUpdateState(),
      currentVersion: "0.1.0",
      currentFingerprint: createBuildFingerprint({
        version: "0.1.0",
        gitSha: "abc",
        protocolVersion: 1,
        migrationHead: "001.sql",
      }),
    };
    await writeSparkUpdateState(paths, state);
    await expect(readSparkUpdateState(paths)).resolves.toEqual(state);

    let releaseLock!: () => void;
    const held = withSparkUpdateLock(
      paths,
      async () =>
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        }),
    );
    await vi.waitFor(async () => {
      await expect(readFile(paths.lockFile, "utf8")).resolves.toMatch(/\d+/u);
    });
    await expect(withSparkUpdateLock(paths, async () => undefined)).rejects.toThrow(
      /already running/u,
    );
    releaseLock();
    await held;
  });

  it("recovers a lock left by a dead updater process", async () => {
    const root = await temporaryRoot();
    const paths = resolveSparkUpdatePaths({ env: { SPARK_HOME: root, HOME: root } });
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.lockFile, "99999999\n");
    await expect(withSparkUpdateLock(paths, async () => "recovered")).resolves.toBe("recovered");
  });
});

describe("Spark update policy", () => {
  it("keeps pre-1.0 cross-minor upgrades notify-only", () => {
    expect(canAutomaticallyApply("0.1.9", "0.1.10")).toBe(true);
    expect(canAutomaticallyApply("0.1.9", "0.2.0")).toBe(false);
    expect(canAutomaticallyApply("1.1.0", "1.2.0")).toBe(true);
    expect(canAutomaticallyApply("1.2.0", "1.1.9")).toBe(false);
  });

  it("caps failure backoff at 24 hours and respects the due time", () => {
    const now = new Date("2026-07-24T00:00:00.000Z");
    expect(nextUpdateRetryAt(1, now)).toBe("2026-07-24T00:30:00.000Z");
    expect(nextUpdateRetryAt(2, now)).toBe("2026-07-24T02:00:00.000Z");
    expect(nextUpdateRetryAt(3, now)).toBe("2026-07-24T06:00:00.000Z");
    expect(nextUpdateRetryAt(99, now)).toBe("2026-07-25T00:00:00.000Z");
    expect(
      isNetworkCheckDue(
        { checkIntervalHours: 6 },
        {
          failure: {
            code: "network",
            message: "offline",
            count: 1,
            firstAt: now.toISOString(),
            lastAt: now.toISOString(),
            nextRetryAt: "2026-07-24T00:30:00.000Z",
          },
        },
        new Date("2026-07-24T00:10:00.000Z"),
      ),
    ).toBe(false);
  });

  it("never performs a background network check under manual policy", async () => {
    const root = await temporaryRoot();
    const env = { HOME: root };
    const paths = resolveSparkUpdatePaths({ env });
    await writeSparkUpdateConfig(paths, {
      policy: "manual",
      channel: "latest",
      checkIntervalHours: 6,
    });
    const fetchMock = vi.fn<typeof fetch>();
    const manager = new SparkUpdateManager({ env, fetch: fetchMock });

    await expect(manager.check({ background: true })).resolves.toMatchObject({
      config: { policy: "manual" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("npm registry projection", () => {
  it("sends ETag and projects the selected immutable release", async () => {
    const root = await temporaryRoot();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"old"');
      return new Response(
        JSON.stringify({
          "dist-tags": { latest: "0.1.1", next: "0.2.0-beta.1" },
          versions: {
            "0.1.1": {
              version: "0.1.1",
              dist: {
                integrity: "sha512-release",
                tarball: "https://registry.npmjs.org/spark/-/spark-0.1.1.tgz",
              },
              engines: { node: ">=26.0.0 <27" },
            },
          },
        }),
        { status: 200, headers: { etag: '"new"' } },
      );
    });
    const manager = new SparkUpdateManager({
      env: { SPARK_HOME: root, HOME: root },
      fetch: fetchMock,
    });
    await expect(manager.queryRegistry("latest", '"old"')).resolves.toEqual({
      version: "0.1.1",
      integrity: "sha512-release",
      tarball: "https://registry.npmjs.org/spark/-/spark-0.1.1.tgz",
      nodeRequirement: ">=26.0.0 <27",
      etag: '"new"',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("treats a 304 response as an unchanged projection", async () => {
    const root = await temporaryRoot();
    const manager = new SparkUpdateManager({
      env: { SPARK_HOME: root, HOME: root },
      fetch: vi.fn(async () => new Response(null, { status: 304, headers: { etag: '"same"' } })),
    });
    await expect(manager.queryRegistry("latest", '"same"')).resolves.toMatchObject({
      notModified: true,
      etag: '"same"',
    });
  });

  it("immediately retries one transient registry response", async () => {
    const root = await temporaryRoot();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            "dist-tags": { latest: "0.1.1" },
            versions: {
              "0.1.1": {
                version: "0.1.1",
                dist: {
                  integrity: "sha512-release",
                  tarball: "https://registry.npmjs.org/spark/-/spark-0.1.1.tgz",
                },
              },
            },
          }),
        ),
      );
    const manager = new SparkUpdateManager({
      env: { HOME: root },
      fetch: fetchMock,
    });

    await expect(manager.queryRegistry("latest")).resolves.toMatchObject({ version: "0.1.1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("managed filesystem transaction", () => {
  it("installs, atomically upgrades, and transactionally rolls back immutable versions", async () => {
    const root = await temporaryRoot();
    const env = { SPARK_HOME: root, HOME: root };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let manager!: SparkUpdateManager;
    let unhealthyVersion: string | undefined;
    let daemonBusy = false;
    let npmPackCount = 0;
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "launchctl") return { code: 0, stdout: "", stderr: "" };
      if (command === "npm" && args[0] === "pack") {
        npmPackCount += 1;
        const version = args[1]!.split("@").at(-1)!;
        const destination = args[args.indexOf("--pack-destination") + 1]!;
        const filename = `zendev-lab-spark-${version}.tgz`;
        await writeFile(join(destination, filename), version);
        return {
          code: 0,
          stdout: JSON.stringify([{ filename, integrity: `sha512-${version}` }]),
          stderr: "",
        };
      }
      if (command === "npm" && args[0] === "install") {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const tarball = args.at(-1)!;
        const version = /spark-(.+)\.tgz$/u.exec(basename(tarball))?.[1]!;
        const product = join(prefix, "node_modules", "@zendev-lab", "spark");
        await mkdir(join(product, "dist"), { recursive: true });
        await mkdir(join(product, "bin"), { recursive: true });
        const build = testBuildInfo(version);
        await writeFile(join(product, "dist", "build-info.json"), JSON.stringify(build));
        await writeFile(
          join(product, "bin", "spark"),
          '#!/usr/bin/env node\nif (process.argv[2] === "probe-launcher") console.log(JSON.stringify({ launcher: process.env.SPARK_STABLE_LAUNCHER, state: process.env.SPARK_MANAGED_STATE_DIR }));\n',
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === process.execPath) {
        return { code: 0, stdout: JSON.stringify(testBuildInfo("0.0.0")), stderr: "" };
      }
      if (command === manager.paths.launcherPath && args[0] === "daemon") {
        if (args[1] === "status") {
          const current = await realpath(manager.paths.currentLink);
          const build = JSON.parse(
            await readFile(
              join(current, "node_modules", "@zendev-lab", "spark", "dist", "build-info.json"),
              "utf8",
            ),
          );
          return {
            code: 0,
            stdout: JSON.stringify({
              invocations: { queued: 0, running: daemonBusy ? 1 : 0 },
              build: {
                runningFingerprint:
                  build.version === unhealthyVersion ? "sha256:unhealthy" : build.fingerprint,
              },
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "{}", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const version = decodeURIComponent(url.split("/").at(-1)!);
      return new Response(
        JSON.stringify({
          version,
          dist: {
            integrity: `sha512-${version}`,
            tarball: `https://registry.invalid/spark-${version}.tgz`,
          },
          engines: { node: ">=26.0.0 <27" },
        }),
      );
    });
    manager = new SparkUpdateManager({ env, fetch: fetchMock, run });

    await mkdir(join(manager.paths.stagingDir, "interrupted"), { recursive: true });
    await manager.installManaged("0.1.0");
    expect(await readlink(manager.paths.currentLink)).toBe("0.1.0");
    await expect(realpath(join(manager.paths.stagingDir, "interrupted"))).rejects.toThrow();
    await expect(readFile(manager.paths.launcherPath, "utf8")).resolves.toContain(
      "SPARK_STABLE_LAUNCHER",
    );
    await expect(readFile(manager.paths.launcherPath, "utf8")).resolves.toContain(
      "SPARK_MANAGED_STATE_DIR",
    );
    const launcherProbe = await execFileAsync(manager.paths.launcherPath, ["probe-launcher"], {
      env: { ...process.env, ...env },
    });
    expect(JSON.parse(launcherProbe.stdout)).toEqual({
      launcher: await realpath(manager.paths.launcherPath),
      state: manager.paths.stateDir,
    });
    daemonBusy = true;
    await manager.apply("0.1.1", { automatic: true, wait: true });
    expect(await readlink(manager.paths.currentLink)).toBe("0.1.0");
    await expect(manager.status()).resolves.toMatchObject({
      state: { currentVersion: "0.1.0", pendingVersion: "0.1.1" },
    });
    expect(npmPackCount).toBe(2);

    daemonBusy = false;
    await manager.apply("0.1.1", { automatic: true, wait: true });
    expect(npmPackCount).toBe(2);
    expect(await readlink(manager.paths.currentLink)).toBe("0.1.1");
    await expect(manager.status()).resolves.toMatchObject({
      state: { currentVersion: "0.1.1", rollbackVersion: "0.1.0" },
    });

    await manager.rollback({ wait: true });
    expect(await readlink(manager.paths.currentLink)).toBe("0.1.0");
    await expect(manager.status()).resolves.toMatchObject({
      state: { currentVersion: "0.1.0", rollbackVersion: "0.1.1" },
    });

    unhealthyVersion = "0.1.1";
    await expect(manager.rollback({ wait: true })).rejects.toThrow(/does not match/u);
    expect(await readlink(manager.paths.currentLink)).toBe("0.1.0");
    await expect(manager.status()).resolves.toMatchObject({
      state: {
        currentVersion: "0.1.0",
        failure: { code: "update_rollback_failed", version: "0.1.1" },
      },
    });
    errorLog.mockRestore();
  });

  it("fails closed and quarantines a package whose bytes disagree with registry integrity", async () => {
    const root = await temporaryRoot();
    const env = { SPARK_HOME: root, HOME: root };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new SparkUpdateManager({
      env,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: "0.1.0",
              dist: {
                integrity: "sha512-registry",
                tarball: "https://registry.invalid/spark.tgz",
              },
            }),
          ),
      ),
      run: vi.fn(async (_command, args) => {
        if (_command === "launchctl") return { code: 0, stdout: "", stderr: "" };
        const destination = args[args.indexOf("--pack-destination") + 1]!;
        await writeFile(join(destination, "spark.tgz"), "corrupt");
        return {
          code: 0,
          stdout: JSON.stringify([{ filename: "spark.tgz", integrity: "sha512-corrupt" }]),
          stderr: "",
        };
      }),
    });

    await expect(manager.installManaged("0.1.0")).rejects.toThrow(/does not match registry/u);
    await expect(manager.status()).resolves.toMatchObject({
      state: { quarantined: [{ version: "0.1.0" }] },
    });
    errorLog.mockRestore();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spark-update-test-"));
  temporaryRoots.push(root);
  return root;
}

function testBuildInfo(version: string) {
  return {
    schemaVersion: 1 as const,
    packageName: "@zendev-lab/spark" as const,
    version,
    gitSha: `git-${version}`,
    protocolVersion: 1,
    minimumNodeVersion: ">=26.0.0 <27",
    migrationHead: "001.sql",
    migrationMode: "expand-only" as const,
    fingerprint: createBuildFingerprint({
      version,
      gitSha: `git-${version}`,
      protocolVersion: 1,
      migrationHead: "001.sql",
    }),
  };
}
