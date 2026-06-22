import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { launchctlCommand, type NaviaPaths } from "@zendev-lab/navia-system";

const launchdLabel = "dev.spark.daemon";
const legacyLaunchdLabel = "dev.navia.runner";

export interface SparkDaemonServiceResult {
  kind: "launchd" | "detached";
  alreadyRunning: boolean;
  detail: string;
}

export function startSparkDaemonService(paths: NaviaPaths): SparkDaemonServiceResult {
  if (process.platform === "darwin") {
    return startLaunchdService(paths);
  }

  return startDetachedSparkDaemon(paths);
}

export function stopSparkDaemonService(paths: NaviaPaths): SparkDaemonServiceResult | null {
  if (process.platform === "darwin") {
    const uid = readCurrentUid();
    cleanupLegacyLaunchdService(uid);
    const target = `gui/${uid}/${launchdLabel}`;
    const stopped = runLaunchctl(["bootout", target]);
    if (stopped.status === 0) {
      return {
        kind: "launchd",
        alreadyRunning: false,
        detail: `Stopped Spark daemon ${launchdLabel}.`,
      };
    }
  }

  return stopPidFileProcess(paths);
}

function startLaunchdService(paths: NaviaPaths): SparkDaemonServiceResult {
  const uid = readCurrentUid();
  cleanupLegacyLaunchdService(uid);
  const plistPath = writeLaunchdPlist(paths);
  const target = `gui/${uid}/${launchdLabel}`;

  runLaunchctl(["bootout", target]);
  runLaunchctl(["bootout", `gui/${uid}`, plistPath]);
  const bootstrap = runLaunchctl(["bootstrap", `gui/${uid}`, plistPath]);
  if (bootstrap.status !== 0) {
    throw new Error(`Failed to register Spark daemon: ${bootstrap.stderr || bootstrap.stdout}`);
  }

  const kickstart = runLaunchctl(["kickstart", "-k", target]);
  if (kickstart.status !== 0) {
    throw new Error(`Failed to start Spark daemon: ${kickstart.stderr || kickstart.stdout}`);
  }

  return {
    kind: "launchd",
    alreadyRunning: false,
    detail: `Started Spark daemon ${launchdLabel}.`,
  };
}

function writeLaunchdPlist(paths: NaviaPaths): string {
  const home = process.env.HOME || homedir();
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDir, `${launchdLabel}.plist`);
  mkdirSync(launchAgentsDir, { recursive: true, mode: 0o755 });
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });

  const programArguments = sparkDaemonStartCommand();
  const stdoutPath = join(paths.logDir, "service.stdout.log");
  const stderrPath = join(paths.logDir, "service.stderr.log");
  const environment = serviceEnvironment();

  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(launchdLabel)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment)
  .map(
    ([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
  )
  .join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(process.cwd())}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`,
    { encoding: "utf8", mode: 0o644 },
  );

  return plistPath;
}

function startDetachedSparkDaemon(paths: NaviaPaths): SparkDaemonServiceResult {
  const runningPid = readRunningPid(paths);
  if (runningPid) {
    return {
      kind: "detached",
      alreadyRunning: true,
      detail: `Spark daemon is already running as process ${runningPid}.`,
    };
  }

  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  const stdout = openSync(join(paths.logDir, "service.stdout.log"), "a", 0o600);
  const stderr = openSync(join(paths.logDir, "service.stderr.log"), "a", 0o600);
  const command = sparkDaemonStartCommand();
  const child = spawn(command[0]!, command.slice(1), {
    detached: true,
    env: process.env,
    stdio: ["ignore", stdout, stderr],
  });
  child.unref();

  return {
    kind: "detached",
    alreadyRunning: false,
    detail: `Started Spark daemon in the background as process ${child.pid}.`,
  };
}

function stopPidFileProcess(paths: NaviaPaths): SparkDaemonServiceResult | null {
  const runningPid = readRunningPid(paths);
  if (!runningPid) {
    return null;
  }

  process.kill(runningPid, "SIGTERM");
  return {
    kind: "detached",
    alreadyRunning: false,
    detail: `Stopped Spark daemon process ${runningPid}.`,
  };
}

export function readRunningPid(paths: NaviaPaths): number | null {
  if (!existsSync(paths.pidFile)) {
    return null;
  }

  const pid = Number(readFileSync(paths.pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function sparkDaemonStartCommand(): string[] {
  const cliPath = realpathSync(process.argv[1] ?? fileURLToPath(import.meta.url));
  return [process.execPath, cliPath, "start"];
}

function serviceEnvironment(): Record<string, string> {
  const keys = [
    "HOME",
    "PATH",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "SPARK_DAEMON_DATA_DIR",
    "SPARK_DAEMON_CACHE_DIR",
    "SPARK_DAEMON_STATE_DIR",
    "SPARK_DAEMON_RUNTIME_DIR",
  ];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function cleanupLegacyLaunchdService(uid: number): void {
  const home = process.env.HOME || homedir();
  const legacyPlistPath = join(home, "Library", "LaunchAgents", `${legacyLaunchdLabel}.plist`);
  runLaunchctl(["bootout", `gui/${uid}/${legacyLaunchdLabel}`]);
  runLaunchctl(["bootout", `gui/${uid}`, legacyPlistPath]);
  rmSync(legacyPlistPath, { force: true });
}

function runLaunchctl(args: string[]) {
  return spawnSync(launchctlCommand(), args, { encoding: "utf8" });
}

function readCurrentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("launchd service registration requires a POSIX user id.");
  }
  return uid;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
