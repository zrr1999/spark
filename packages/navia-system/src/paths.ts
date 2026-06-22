import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type NaviaApp = "server" | "daemon";

export interface NaviaPathOverrides {
  configFile?: string;
  dataDir?: string;
  cacheDir?: string;
  stateDir?: string;
  runtimeDir?: string;
}

export interface ResolveNaviaPathsOptions {
  app: NaviaApp;
  env?: Record<string, string | undefined>;
  overrides?: NaviaPathOverrides;
  cwd?: string;
}

export interface NaviaPaths {
  app: NaviaApp;
  configDir: string;
  configFile: string;
  dataDir: string;
  cacheDir: string;
  stateDir: string;
  runtimeDir: string;
  databasePath: string;
  artifactCacheDir: string;
  artifactBlobsDir: string;
  piAgentDir: string | undefined;
  logDir: string;
  logFile: string;
  pidFile: string;
  legacyRepoDataDir: string;
  deprecatedDataDirAlias: string | undefined;
}

const appDatabaseNames: Record<NaviaApp, string> = {
  server: "navia.sqlite",
  daemon: "daemon.sqlite",
};

export function resolveNaviaPaths(options: ResolveNaviaPathsOptions): NaviaPaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = env.HOME || homedir();
  const app = options.app;
  const prefix = app === "daemon" ? "SPARK_DAEMON" : `NAVIA_${app.toUpperCase()}`;
  const overrides = options.overrides ?? {};

  const configHome = absoluteDir(env.XDG_CONFIG_HOME ?? join(home, ".config"), cwd);
  const dataHome = absoluteDir(env.XDG_DATA_HOME ?? join(home, ".local", "share"), cwd);
  const cacheHome = absoluteDir(env.XDG_CACHE_HOME ?? join(home, ".cache"), cwd);
  const stateHome = absoluteDir(env.XDG_STATE_HOME ?? join(home, ".local", "state"), cwd);

  const namespace = app === "daemon" ? "spark" : "navia";
  const configDir = join(configHome, namespace);
  const configFile = absoluteDir(overrides.configFile ?? join(configDir, `${app}.toml`), cwd);
  const explicitDataDir = env[`${prefix}_DATA_DIR`];
  const deprecatedDataDirAlias =
    app === "server" && !explicitDataDir ? env.NAVIA_DATA_DIR : undefined;
  const dataDir = absoluteDir(
    overrides.dataDir ??
      explicitDataDir ??
      deprecatedDataDirAlias ??
      join(dataHome, namespace, app),
    cwd,
  );
  const cacheDir = absoluteDir(
    overrides.cacheDir ?? env[`${prefix}_CACHE_DIR`] ?? join(cacheHome, namespace, app),
    cwd,
  );
  const stateDir = absoluteDir(
    overrides.stateDir ?? env[`${prefix}_STATE_DIR`] ?? join(stateHome, namespace, app),
    cwd,
  );
  const runtimeDir = absoluteDir(
    overrides.runtimeDir ??
      env[`${prefix}_RUNTIME_DIR`] ??
      (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, namespace, app) : join(stateDir, "run")),
    cwd,
  );
  const artifactCacheDir = join(cacheDir, "artifacts");

  return {
    app,
    configDir,
    configFile,
    dataDir,
    cacheDir,
    stateDir,
    runtimeDir,
    databasePath: join(dataDir, appDatabaseNames[app]),
    artifactCacheDir,
    artifactBlobsDir:
      app === "daemon"
        ? join(dataDir, "artifacts", "blobs", "sha256")
        : join(artifactCacheDir, "blobs", "sha256"),
    piAgentDir: app === "daemon" ? join(dataDir, "pi-agent") : undefined,
    logDir: join(stateDir, "logs"),
    logFile: join(stateDir, "logs", `${app}.jsonl`),
    pidFile: join(runtimeDir, `${app}.pid`),
    legacyRepoDataDir: resolve(cwd, ".navia"),
    deprecatedDataDirAlias,
  };
}

function absoluteDir(path: string, cwd: string): string {
  return resolve(cwd, path);
}
