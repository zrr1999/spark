import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { launchctlCommand, type NaviaPaths } from "@zendev-lab/navia-system";

const launchdLabel = "dev.navia.runner";

export interface RunnerServiceResult {
  kind: "launchd" | "detached";
  alreadyRunning: boolean;
  detail: string;
}

export function startRunnerService(paths: NaviaPaths): RunnerServiceResult {
  if (process.platform === "darwin") {
    return startLaunchdService(paths);
  }

  return startDetachedRunner(paths);
}

export function stopRunnerService(paths: NaviaPaths): RunnerServiceResult | null {
  if (process.platform === "darwin") {
    const uid = readCurrentUid();
    const target = `gui/${uid}/${launchdLabel}`;
    const stopped = runLaunchctl(["bootout", target]);
    if (stopped.status === 0) {
      return {
        kind: "launchd",
        alreadyRunning: false,
        detail: `Stopped Navia local service ${launchdLabel}.`,
      };
    }
  }

  return stopPidFileProcess(paths);
}

function startLaunchdService(paths: NaviaPaths): RunnerServiceResult {
  const uid = readCurrentUid();
  const plistPath = writeLaunchdPlist(paths);
  const target = `gui/${uid}/${launchdLabel}`;

  runLaunchctl(["bootout", target]);
  runLaunchctl(["bootout", `gui/${uid}`, plistPath]);
  const bootstrap = runLaunchctl(["bootstrap", `gui/${uid}`, plistPath]);
  if (bootstrap.status !== 0) {
    throw new Error(
      `Failed to register Navia local service: ${bootstrap.stderr || bootstrap.stdout}`,
    );
  }

  const kickstart = runLaunchctl(["kickstart", "-k", target]);
  if (kickstart.status !== 0) {
    throw new Error(`Failed to start Navia local service: ${kickstart.stderr || kickstart.stdout}`);
  }

  return {
    kind: "launchd",
    alreadyRunning: false,
    detail: `Started Navia local service ${launchdLabel}.`,
  };
}

function writeLaunchdPlist(paths: NaviaPaths): string {
  const home = process.env.HOME || homedir();
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDir, `${launchdLabel}.plist`);
  mkdirSync(launchAgentsDir, { recursive: true, mode: 0o755 });
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });

  const programArguments = runnerStartCommand();
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

function startDetachedRunner(paths: NaviaPaths): RunnerServiceResult {
  const runningPid = readRunningPid(paths);
  if (runningPid) {
    return {
      kind: "detached",
      alreadyRunning: true,
      detail: `Navia local service is already running as process ${runningPid}.`,
    };
  }

  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  const stdout = openSync(join(paths.logDir, "service.stdout.log"), "a", 0o600);
  const stderr = openSync(join(paths.logDir, "service.stderr.log"), "a", 0o600);
  const command = runnerStartCommand();
  const child = spawn(command[0]!, command.slice(1), {
    detached: true,
    env: process.env,
    stdio: ["ignore", stdout, stderr],
  });
  child.unref();

  return {
    kind: "detached",
    alreadyRunning: false,
    detail: `Started Navia local service in the background as process ${child.pid}.`,
  };
}

function stopPidFileProcess(paths: NaviaPaths): RunnerServiceResult | null {
  const runningPid = readRunningPid(paths);
  if (!runningPid) {
    return null;
  }

  process.kill(runningPid, "SIGTERM");
  return {
    kind: "detached",
    alreadyRunning: false,
    detail: `Stopped Navia local service process ${runningPid}.`,
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

function runnerStartCommand(): string[] {
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
    "NAVIA_RUNNER_DATA_DIR",
    "NAVIA_RUNNER_CACHE_DIR",
    "NAVIA_RUNNER_STATE_DIR",
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
