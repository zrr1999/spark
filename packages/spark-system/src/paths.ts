import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SparkApp = "cockpit" | "daemon";

export interface ResolveSparkHomeOptions {
  sparkHome?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  cwd?: string | undefined;
}

export interface SparkUserPaths {
  root: string;
  configFile: string;
  authFile: string;
  sessionsDir: string;
  askConfigFile: string;
  rolesDir: string;
  roleModelSettingsFile: string;
  workflowsDir: string;
  skillsDir: string;
  userAgentsSkillsDir: string;
  promptTemplatesDir: string;
  themesDir: string;
  learningsDir: string;
  recallFile: string;
  memoryFile: string;
  agentDir: string;
  keybindingsFile: string;
  exportsDir: string;
  shareDir: string;
  workspacesDir: string;
  cursorModelCacheFile: string;
  cueVersionCacheFile: string;
}

export interface SparkPathOverrides {
  configFile?: string;
  dataDir?: string;
  cacheDir?: string;
  stateDir?: string;
  runtimeDir?: string;
}

export interface ResolveSparkPathsOptions extends ResolveSparkHomeOptions {
  app: SparkApp;
  overrides?: SparkPathOverrides;
}

export interface SparkPaths {
  app: SparkApp;
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
}

const appDatabaseNames: Record<SparkApp, string> = {
  cockpit: "cockpit.sqlite",
  daemon: "daemon.sqlite",
};

/** Resolve the single user-level Spark root. Workspace state remains under `<cwd>/.spark`. */
export function resolveSparkHome(options: ResolveSparkHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = nonEmpty(env.HOME) ?? homedir();
  return absolutePath(
    nonEmpty(options.sparkHome) ?? nonEmpty(env.SPARK_HOME) ?? join(home, ".spark"),
    cwd,
  );
}

/** Resolve Spark-owned user paths plus the public cross-harness discovery roots. */
export function resolveSparkUserPaths(options: ResolveSparkHomeOptions = {}): SparkUserPaths {
  const env = options.env ?? process.env;
  const home = nonEmpty(env.HOME) ?? homedir();
  const root = resolveSparkHome(options);
  const agentDir = join(root, "agent");

  return {
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
    promptTemplatesDir: join(root, "prompts"),
    themesDir: join(root, "themes"),
    learningsDir: join(root, "learnings"),
    recallFile: join(root, "recall-candidates.json"),
    memoryFile: join(root, "memory", "memory.json"),
    agentDir,
    keybindingsFile: join(agentDir, "keybindings.json"),
    exportsDir: join(root, "exports"),
    shareDir: join(root, "share"),
    workspacesDir: join(root, "workspaces"),
    cursorModelCacheFile: join(root, "cursor-sdk-model-list.json"),
    cueVersionCacheFile: join(root, "cache", "cued-version.json"),
  };
}

export function resolveSparkPaths(options: ResolveSparkPathsOptions): SparkPaths {
  const cwd = options.cwd ?? process.cwd();
  const app = options.app;
  const overrides = options.overrides ?? {};
  const appRoot = join(resolveSparkHome(options), "apps", app);
  const configDir = appRoot;

  const configFile = absolutePath(overrides.configFile ?? join(appRoot, "config.toml"), cwd);
  const dataDir = absolutePath(overrides.dataDir ?? join(appRoot, "data"), cwd);
  const cacheDir = absolutePath(overrides.cacheDir ?? join(appRoot, "cache"), cwd);
  const stateDir = absolutePath(overrides.stateDir ?? join(appRoot, "state"), cwd);
  const runtimeDir = absolutePath(overrides.runtimeDir ?? join(appRoot, "run"), cwd);
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
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function absolutePath(path: string, cwd: string): string {
  return resolve(cwd, path);
}
