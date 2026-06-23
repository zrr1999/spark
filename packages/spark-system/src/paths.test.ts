import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSparkPaths } from "./paths.js";

const home = "/Users/example";

describe("resolveSparkPaths", () => {
  it("uses XDG defaults for Cockpit paths", () => {
    const paths = resolveSparkPaths({ app: "cockpit", env: { HOME: home }, cwd: "/" });

    expect(paths.configFile).toBe(join(home, ".config", "spark", "cockpit.toml"));
    expect(paths.dataDir).toBe(join(home, ".local", "share", "spark", "cockpit"));
    expect(paths.databasePath).toBe(
      join(home, ".local", "share", "spark", "cockpit", "cockpit.sqlite"),
    );
    expect(paths.artifactCacheDir).toBe(join(home, ".cache", "spark", "cockpit", "artifacts"));
    expect(paths.logDir).toBe(join(home, ".local", "state", "spark", "cockpit", "logs"));
    expect(paths.runtimeDir).toBe(join(home, ".local", "state", "spark", "cockpit", "run"));
  });

  it("uses XDG defaults for daemon-specific paths", () => {
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: home }, cwd: "/" });

    expect(paths.configFile).toBe(join(home, ".config", "spark", "daemon.toml"));
    expect(paths.databasePath).toBe(
      join(home, ".local", "share", "spark", "daemon", "daemon.sqlite"),
    );
    expect(paths.artifactBlobsDir).toBe(
      join(home, ".local", "share", "spark", "daemon", "artifacts", "blobs", "sha256"),
    );
    expect(paths.piAgentDir).toBe(join(home, ".local", "share", "spark", "daemon", "pi-agent"));
  });

  it("honors explicit XDG homes and runtime dir", () => {
    const paths = resolveSparkPaths({
      app: "daemon",
      env: {
        HOME: home,
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_DATA_HOME: "/xdg/data",
        XDG_CACHE_HOME: "/xdg/cache",
        XDG_STATE_HOME: "/xdg/state",
        XDG_RUNTIME_DIR: "/xdg/runtime",
      },
      cwd: "/",
    });

    expect(paths.configFile).toBe("/xdg/config/spark/daemon.toml");
    expect(paths.dataDir).toBe("/xdg/data/spark/daemon");
    expect(paths.cacheDir).toBe("/xdg/cache/spark/daemon");
    expect(paths.stateDir).toBe("/xdg/state/spark/daemon");
    expect(paths.runtimeDir).toBe("/xdg/runtime/spark/daemon");
  });

  it("honors the Spark daemon runtime directory environment override", () => {
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: home, SPARK_DAEMON_RUNTIME_DIR: "/daemon-run" },
      cwd: "/",
    });

    expect(paths.runtimeDir).toBe("/daemon-run");
    expect(paths.pidFile).toBe("/daemon-run/daemon.pid");
  });

  it("honors Spark Cockpit overrides before legacy Navia aliases", () => {
    const paths = resolveSparkPaths({
      app: "cockpit",
      env: {
        HOME: home,
        NAVIA_DATA_DIR: "/legacy",
        NAVIA_SERVER_DATA_DIR: "/legacy-server-data",
        NAVIA_SERVER_CACHE_DIR: "/legacy-server-cache",
        NAVIA_SERVER_STATE_DIR: "/legacy-server-state",
        SPARK_COCKPIT_DATA_DIR: "/cockpit-data",
        SPARK_COCKPIT_CACHE_DIR: "/cockpit-cache",
        SPARK_COCKPIT_STATE_DIR: "/cockpit-state",
      },
      cwd: "/",
    });

    expect(paths.dataDir).toBe("/cockpit-data");
    expect(paths.cacheDir).toBe("/cockpit-cache");
    expect(paths.stateDir).toBe("/cockpit-state");
    expect(paths.legacyDataDirAlias).toBeUndefined();
  });

  it("keeps Navia data directory variables as Cockpit-only legacy aliases", () => {
    const cockpitPaths = resolveSparkPaths({
      app: "cockpit",
      env: { HOME: home, NAVIA_DATA_DIR: "/legacy" },
      cwd: "/",
    });
    const daemonPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: home, NAVIA_DATA_DIR: "/legacy" },
      cwd: "/",
    });

    expect(cockpitPaths.dataDir).toBe("/legacy");
    expect(cockpitPaths.legacyDataDirAlias).toBe("/legacy");
    expect(daemonPaths.dataDir).toBe(join(home, ".local", "share", "spark", "daemon"));
  });

  it("honors direct test overrides", () => {
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: home },
      cwd: "/repo",
      overrides: {
        dataDir: "tmp/data",
        cacheDir: "tmp/cache",
        stateDir: "tmp/state",
        runtimeDir: "tmp/run",
      },
    });

    expect(paths.dataDir).toBe("/repo/tmp/data");
    expect(paths.cacheDir).toBe("/repo/tmp/cache");
    expect(paths.stateDir).toBe("/repo/tmp/state");
    expect(paths.runtimeDir).toBe("/repo/tmp/run");
  });
});
