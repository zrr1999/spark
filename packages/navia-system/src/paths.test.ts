import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNaviaPaths } from "./paths.js";

const home = "/Users/example";

describe("resolveNaviaPaths", () => {
  it("uses XDG defaults for server paths", () => {
    const paths = resolveNaviaPaths({ app: "server", env: { HOME: home }, cwd: "/" });

    expect(paths.configFile).toBe(join(home, ".config", "navia", "server.toml"));
    expect(paths.dataDir).toBe(join(home, ".local", "share", "navia", "server"));
    expect(paths.databasePath).toBe(
      join(home, ".local", "share", "navia", "server", "navia.sqlite"),
    );
    expect(paths.artifactCacheDir).toBe(join(home, ".cache", "navia", "server", "artifacts"));
    expect(paths.logDir).toBe(join(home, ".local", "state", "navia", "server", "logs"));
    expect(paths.runtimeDir).toBe(join(home, ".local", "state", "navia", "server", "run"));
  });

  it("uses XDG defaults for runner-specific paths", () => {
    const paths = resolveNaviaPaths({ app: "runner", env: { HOME: home }, cwd: "/" });

    expect(paths.configFile).toBe(join(home, ".config", "navia", "runner.toml"));
    expect(paths.databasePath).toBe(
      join(home, ".local", "share", "navia", "runner", "runner.sqlite"),
    );
    expect(paths.artifactBlobsDir).toBe(
      join(home, ".local", "share", "navia", "runner", "artifacts", "blobs", "sha256"),
    );
    expect(paths.piAgentDir).toBe(join(home, ".local", "share", "navia", "runner", "pi-agent"));
  });

  it("honors explicit XDG homes and runtime dir", () => {
    const paths = resolveNaviaPaths({
      app: "runner",
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

    expect(paths.configFile).toBe("/xdg/config/navia/runner.toml");
    expect(paths.dataDir).toBe("/xdg/data/navia/runner");
    expect(paths.cacheDir).toBe("/xdg/cache/navia/runner");
    expect(paths.stateDir).toBe("/xdg/state/navia/runner");
    expect(paths.runtimeDir).toBe("/xdg/runtime/navia/runner");
  });

  it("honors app-specific overrides before the deprecated NAVIA_DATA_DIR alias", () => {
    const paths = resolveNaviaPaths({
      app: "server",
      env: {
        HOME: home,
        NAVIA_DATA_DIR: "/legacy",
        NAVIA_SERVER_DATA_DIR: "/server-data",
        NAVIA_SERVER_CACHE_DIR: "/server-cache",
        NAVIA_SERVER_STATE_DIR: "/server-state",
      },
      cwd: "/",
    });

    expect(paths.dataDir).toBe("/server-data");
    expect(paths.cacheDir).toBe("/server-cache");
    expect(paths.stateDir).toBe("/server-state");
    expect(paths.deprecatedDataDirAlias).toBeUndefined();
  });

  it("keeps NAVIA_DATA_DIR as a deprecated server-only alias", () => {
    const serverPaths = resolveNaviaPaths({
      app: "server",
      env: { HOME: home, NAVIA_DATA_DIR: "/legacy" },
      cwd: "/",
    });
    const runnerPaths = resolveNaviaPaths({
      app: "runner",
      env: { HOME: home, NAVIA_DATA_DIR: "/legacy" },
      cwd: "/",
    });

    expect(serverPaths.dataDir).toBe("/legacy");
    expect(serverPaths.deprecatedDataDirAlias).toBe("/legacy");
    expect(runnerPaths.dataDir).toBe(join(home, ".local", "share", "navia", "runner"));
  });

  it("honors direct test overrides", () => {
    const paths = resolveNaviaPaths({
      app: "runner",
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
