import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSparkHome, resolveSparkPaths, resolveSparkUserPaths } from "./paths.js";

const home = "/Users/example";

describe("Spark path resolution", () => {
  it("uses one $HOME/.spark tree by default", () => {
    const root = join(home, ".spark");
    const user = resolveSparkUserPaths({ env: { HOME: home }, cwd: "/" });
    const cockpit = resolveSparkPaths({ app: "cockpit", env: { HOME: home }, cwd: "/" });

    expect(resolveSparkHome({ env: { HOME: home }, cwd: "/" })).toBe(root);
    expect(user).toMatchObject({
      root,
      configFile: join(root, "config.json"),
      authFile: join(root, "auth.json"),
      sessionsDir: join(root, "sessions"),
      askConfigFile: join(root, "ask.json"),
      rolesDir: join(home, ".agents", "roles"),
      roleModelSettingsFile: join(root, "role-model-settings.json"),
      workflowsDir: join(root, "workflows"),
      skillsDir: join(root, "skills"),
      userAgentsSkillsDir: join(home, ".agents", "skills"),
      learningsDir: join(root, "learnings"),
      recallFile: join(root, "recall-candidates.json"),
      memoryFile: join(root, "memory", "memory.json"),
      keybindingsFile: join(root, "agent", "keybindings.json"),
      cueVersionCacheFile: join(root, "cache", "cued-version.json"),
    });
    expect(cockpit.configFile).toBe(join(root, "apps", "cockpit", "config.toml"));
    expect(cockpit.databasePath).toBe(join(root, "apps", "cockpit", "data", "cockpit.sqlite"));
    expect(cockpit.cacheDir).toBe(join(root, "apps", "cockpit", "cache"));
    expect(cockpit.stateDir).toBe(join(root, "apps", "cockpit", "state"));
    expect(cockpit.runtimeDir).toBe(join(root, "apps", "cockpit", "run"));
  });

  it("keeps daemon data under the same default root", () => {
    const root = join(home, ".spark", "apps", "daemon");
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: home }, cwd: "/" });

    expect(paths.configFile).toBe(join(root, "config.toml"));
    expect(paths.databasePath).toBe(join(root, "data", "daemon.sqlite"));
    expect(paths.artifactBlobsDir).toBe(join(root, "data", "artifacts", "blobs", "sha256"));
    expect(paths.piAgentDir).toBe(join(root, "data", "pi-agent"));
    expect(paths.logDir).toBe(join(root, "state", "logs"));
    expect(paths.pidFile).toBe(join(root, "run", "daemon.pid"));
  });

  it("relocates the complete Spark-owned tree with SPARK_HOME", () => {
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
    expect(user.roleModelSettingsFile).toBe(join(sparkHome, "role-model-settings.json"));
    expect(user.memoryFile).toBe(join(sparkHome, "memory", "memory.json"));
    expect(user.rolesDir).toBe(join(home, ".agents", "roles"));
    expect(user.userAgentsSkillsDir).toBe(join(home, ".agents", "skills"));
    expect(daemon.databasePath).toBe(join(sparkHome, "apps", "daemon", "data", "daemon.sqlite"));
    expect(
      resolveSparkHome({
        sparkHome: "/explicit/spark",
        env: { HOME: home, SPARK_HOME: sparkHome },
        cwd: "/",
      }),
    ).toBe("/explicit/spark");
  });

  it("ignores legacy component and XDG path variables", () => {
    const root = join(home, ".spark");
    const env = {
      HOME: home,
      PI_ROLES_HOME: "/legacy/roles",
      PI_CODING_AGENT_DIR: "/legacy/pi-agent",
      SPARK_MEMORY_HOME: "/legacy/memory",
      SPARK_AGENT_DIR: "/legacy/agent",
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "/xdg/cache",
      XDG_STATE_HOME: "/xdg/state",
      XDG_RUNTIME_DIR: "/xdg/runtime",
      SPARK_COCKPIT_DATA_DIR: "/legacy/cockpit-data",
      SPARK_DAEMON_RUNTIME_DIR: "/legacy/daemon-run",
    };
    const user = resolveSparkUserPaths({ env, cwd: "/workspace" });
    const cockpit = resolveSparkPaths({ app: "cockpit", env, cwd: "/workspace" });
    const daemon = resolveSparkPaths({ app: "daemon", env, cwd: "/workspace" });

    expect(user.rolesDir).toBe(join(home, ".agents", "roles"));
    expect(user.learningsDir).toBe(join(root, "learnings"));
    expect(user.memoryFile).toBe(join(root, "memory", "memory.json"));
    expect(user.keybindingsFile).toBe(join(root, "agent", "keybindings.json"));
    expect(cockpit.dataDir).toBe(join(root, "apps", "cockpit", "data"));
    expect(daemon.runtimeDir).toBe(join(root, "apps", "daemon", "run"));
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
