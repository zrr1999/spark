import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSparkHome, resolveSparkPaths, resolveSparkUserPaths } from "./paths.js";

const home = "/Users/example";

describe("Spark path resolution", () => {
  it("uses standard XDG defaults when SPARK_HOME is unset", () => {
    const user = resolveSparkUserPaths({ env: { HOME: home }, cwd: "/" });
    const cockpit = resolveSparkPaths({ app: "cockpit", env: { HOME: home }, cwd: "/" });

    expect(resolveSparkHome({ env: { HOME: home }, cwd: "/" })).toBe(
      join(home, ".local", "share", "spark"),
    );
    expect(user).toMatchObject({
      configRoot: join(home, ".config", "spark"),
      dataRoot: join(home, ".local", "share", "spark"),
      cacheRoot: join(home, ".cache", "spark"),
      stateRoot: join(home, ".local", "state", "spark"),
      runtimeRoot: join(home, ".local", "state", "spark"),
      configFile: join(home, ".config", "spark", "config.json"),
      authFile: join(home, ".config", "spark", "auth.json"),
      sessionsDir: join(home, ".local", "share", "spark", "sessions"),
      askConfigFile: join(home, ".config", "spark", "ask.json"),
      rolesDir: join(home, ".agents", "roles"),
      roleModelSettingsFile: join(home, ".config", "spark", "role-model-settings.json"),
      workflowsDir: join(home, ".agents", "workflows"),
      userAgentsSkillsDir: join(home, ".agents", "skills"),
      learningsDir: join(home, ".local", "share", "spark", "learnings"),
      memoryFile: join(home, ".local", "share", "spark", "memory", "memory.json"),
      keybindingsFile: join(home, ".config", "spark", "agent", "keybindings.json"),
      cueVersionCacheFile: join(home, ".cache", "spark", "cued-version.json"),
    });
    expect(cockpit.configFile).toBe(join(home, ".config", "spark", "cockpit.toml"));
    expect(cockpit.databasePath).toBe(
      join(home, ".local", "share", "spark", "cockpit", "cockpit.sqlite"),
    );
    expect(cockpit.cacheDir).toBe(join(home, ".cache", "spark", "cockpit"));
    expect(cockpit.stateDir).toBe(join(home, ".local", "state", "spark", "cockpit"));
    expect(cockpit.runtimeDir).toBe(join(home, ".local", "state", "spark", "cockpit", "run"));
  });

  it("honors every XDG directory independently", () => {
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "/xdg/cache",
      XDG_STATE_HOME: "/xdg/state",
      XDG_RUNTIME_DIR: "/xdg/runtime",
    };
    const user = resolveSparkUserPaths({ env, cwd: "/" });
    const daemon = resolveSparkPaths({ app: "daemon", env, cwd: "/" });

    expect(user.configFile).toBe("/xdg/config/spark/config.json");
    expect(user.sessionsDir).toBe("/xdg/data/spark/sessions");
    expect(user.cueVersionCacheFile).toBe("/xdg/cache/spark/cued-version.json");
    expect(daemon.configFile).toBe("/xdg/config/spark/daemon.toml");
    expect(daemon.databasePath).toBe("/xdg/data/spark/daemon/daemon.sqlite");
    expect(daemon.cacheDir).toBe("/xdg/cache/spark/daemon");
    expect(daemon.stateDir).toBe("/xdg/state/spark/daemon");
    expect(daemon.runtimeDir).toBe("/xdg/runtime/spark/daemon");
  });

  it("uses one categorized tree when SPARK_HOME is set", () => {
    const sparkHome = "/srv/spark";
    const user = resolveSparkUserPaths({ env: { HOME: home, SPARK_HOME: sparkHome }, cwd: "/" });
    const daemon = resolveSparkPaths({
      app: "daemon",
      env: { HOME: home, SPARK_HOME: sparkHome },
      cwd: "/",
    });

    expect(resolveSparkHome({ env: { HOME: home, SPARK_HOME: sparkHome }, cwd: "/" })).toBe(
      sparkHome,
    );
    expect(user.configFile).toBe(join(sparkHome, "config.json"));
    expect(user.memoryFile).toBe(join(sparkHome, "memory", "memory.json"));
    expect(user.cueVersionCacheFile).toBe(join(sparkHome, "cache", "cued-version.json"));
    expect(user.rolesDir).toBe(join(home, ".agents", "roles"));
    expect(user.workflowsDir).toBe(join(home, ".agents", "workflows"));
    expect(user.userAgentsSkillsDir).toBe(join(home, ".agents", "skills"));
    expect(daemon.configFile).toBe(join(sparkHome, "apps", "daemon", "config.toml"));
    expect(daemon.databasePath).toBe(join(sparkHome, "apps", "daemon", "data", "daemon.sqlite"));
    expect(daemon.runtimeDir).toBe(join(sparkHome, "apps", "daemon", "run"));
    expect(
      resolveSparkUserPaths({
        sparkHome: "/explicit/spark",
        env: { HOME: home, SPARK_HOME: sparkHome },
        cwd: "/",
      }).configFile,
    ).toBe("/explicit/spark/config.json");
  });

  it("does not implement retired component-specific variables", () => {
    const env = {
      HOME: home,
      PI_ROLES_HOME: "/retired/roles",
      PI_CODING_AGENT_DIR: "/retired/pi-agent",
      PI_MEMORY_DIR: "/retired/pi-memory",
      SPARK_MEMORY_HOME: "/retired/memory",
      SPARK_MEMORY_COMPAT_DIR: "/retired/compat-memory",
      SPARK_AGENT_DIR: "/retired/agent",
      SPARK_COCKPIT_DATA_DIR: "/retired/cockpit-data",
      SPARK_DAEMON_RUNTIME_DIR: "/retired/daemon-run",
    };
    const user = resolveSparkUserPaths({ env, cwd: "/workspace" });
    const cockpit = resolveSparkPaths({ app: "cockpit", env, cwd: "/workspace" });
    const daemon = resolveSparkPaths({ app: "daemon", env, cwd: "/workspace" });

    expect(user.rolesDir).toBe(join(home, ".agents", "roles"));
    expect(user.memoryFile).toBe(join(home, ".local", "share", "spark", "memory", "memory.json"));
    expect(user.keybindingsFile).toBe(join(home, ".config", "spark", "agent", "keybindings.json"));
    expect(cockpit.dataDir).toBe(join(home, ".local", "share", "spark", "cockpit"));
    expect(daemon.runtimeDir).toBe(join(home, ".local", "state", "spark", "daemon", "run"));
  });

  it("honors explicit API overrides for embedded and test hosts", () => {
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: home },
      cwd: "/repo",
      overrides: {
        configFile: "tmp/config.toml",
        dataDir: "tmp/data",
        cacheDir: "tmp/cache",
        stateDir: "tmp/state",
        runtimeDir: "tmp/run",
      },
    });

    expect(paths.configFile).toBe("/repo/tmp/config.toml");
    expect(paths.dataDir).toBe("/repo/tmp/data");
    expect(paths.cacheDir).toBe("/repo/tmp/cache");
    expect(paths.stateDir).toBe("/repo/tmp/state");
    expect(paths.runtimeDir).toBe("/repo/tmp/run");
  });
});
