#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = new Map<string, string | boolean>();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]!;
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, true);
  }
}
const sessionName = String(args.get("session") || "spark");
const outputPath = String(args.get("output") || "/tmp/spark-zellij-daemon-cycle-report.json");

interface CommandResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

function shellQuote(value: string): string {
  return /[^A-Za-z0-9_./:=+-]/u.test(value) ? JSON.stringify(value) : value;
}

async function run(command: string, argv: string[], timeoutMs = 20_000): Promise<CommandResult> {
  const label = [command, ...argv.map(shellQuote)].join(" ");
  try {
    const result = await execFileAsync(command, argv, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return { command: label, code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    return {
      command: label,
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(error),
      timedOut: err.killed === true,
    };
  }
}

function parseJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function redactDaemon(value: any): any {
  if (!value || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value))
    copy[key] = /token|secret|key/iu.test(key) ? "<redacted>" : field;
  return copy;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePaneId(stdout: string): string | undefined {
  return stdout
    .trim()
    .split(/\s+/u)
    .find((part) => /^terminal_\d+$/u.test(part));
}

async function subscribeProbe(paneId: string): Promise<CommandResult> {
  const argv = [
    "--session",
    sessionName,
    "subscribe",
    "--pane-id",
    paneId,
    "--scrollback",
    "20",
    "--format",
    "raw",
  ];
  const label = ["zellij", ...argv.map(shellQuote)].join(" ");
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("zellij", argv, { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.trim()) finish({ command: label, code: 0, stdout, stderr });
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("exit", (code) => finish({ command: label, code: code ?? 1, stdout, stderr }));
    setTimeout(
      () => finish({ command: label, code: stdout.trim() ? 0 : 1, stdout, stderr, timedOut: true }),
      3_000,
    ).unref?.();
  });
}

async function daemonStatus(): Promise<{ raw: CommandResult; json: any }> {
  const raw = await run("pnpm", ["exec", "spark", "daemon", "status", "--json"]);
  return { raw, json: redactDaemon(parseJson(raw.stdout)) };
}

async function sessionList(): Promise<{ raw: CommandResult; ids: string[] }> {
  const raw = await run("pnpm", [
    "exec",
    "node",
    "--experimental-strip-types",
    "apps/spark-tui/src/cli.ts",
    "daemon",
    "sessions",
    "list",
    "--all-workspaces",
    "--json",
  ]);
  const parsed = parseJson(raw.stdout);
  const sessions = parsed?.result?.sessions;
  const ids = Array.isArray(sessions)
    ? sessions.map((session: any) => String(session.id ?? ""))
    : [];
  return { raw, ids };
}

await run("zellij", ["attach", sessionName, "--create-background"]);
const sessionsBefore = await sessionList();
const cycles = [];
for (let index = 0; index < 3; index += 1) {
  const daemonBefore = await daemonStatus();
  const launch = await run("zellij", [
    "--session",
    sessionName,
    "run",
    "--name",
    `spark-daemon-cycle-${index + 1}`,
    "--cwd",
    process.cwd(),
    "--",
    "pnpm",
    "exec",
    "node",
    "--experimental-strip-types",
    "apps/spark-tui/src/cli.ts",
  ]);
  const paneId = parsePaneId(launch.stdout);
  let subscribeCapture: CommandResult = {
    command: "zellij subscribe <missing>",
    code: 1,
    stdout: "",
    stderr: "missing pane id",
  };
  let writeExit: CommandResult | undefined;
  let sendExit: CommandResult | undefined;
  let closePane: CommandResult = {
    command: "zellij close-pane <missing>",
    code: 1,
    stdout: "",
    stderr: "missing pane id",
  };
  if (paneId) {
    await sleep(1_500);
    subscribeCapture = await subscribeProbe(paneId);
    writeExit = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "write-chars",
      "--pane-id",
      paneId,
      "/exit",
    ]);
    sendExit = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "send-keys",
      "--pane-id",
      paneId,
      "Enter",
    ]);
    await sleep(400);
    closePane = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "close-pane",
      "--pane-id",
      paneId,
    ]);
  }
  const daemonAfter = await daemonStatus();
  cycles.push({
    index: index + 1,
    paneId,
    launch,
    subscribeCapture,
    writeExit,
    sendExit,
    closePane,
    daemonBefore: daemonBefore.json,
    daemonAfter: daemonAfter.json,
  });
}
const sessionsAfter = await sessionList();
const newSessionIds = sessionsAfter.ids.filter((id) => !sessionsBefore.ids.includes(id));
const allStartupText = cycles.map((cycle) => cycle.subscribeCapture.stdout).join("\n");
const staleStartupFailureLines = allStartupText
  .split(/\r?\n/u)
  .filter((line) =>
    /run:14d81710|run:820f9a6c|run:23f2e672|old-path failure|stale failure/iu.test(line),
  ).length;
const anonymousSessionJsonlCreated = newSessionIds.some((id) =>
  /anonymous|no-session|reviewer|verifier/iu.test(id),
);
const report = {
  generatedAt: new Date().toISOString(),
  sessionName,
  sessionsBeforeCount: sessionsBefore.ids.length,
  sessionsAfterCount: sessionsAfter.ids.length,
  newSessionIds,
  staleStartupFailureLines,
  anonymousSessionJsonlCreated,
  cycles,
  invariants: {
    exactlyThreeCycles: cycles.length === 3,
    everyLaunchSucceeded: cycles.every((cycle) => cycle.launch.code === 0),
    everySubscribeSucceeded: cycles.every((cycle) => cycle.subscribeCapture.code === 0),
    everyCloseSucceeded: cycles.every((cycle) => cycle.closePane.code === 0),
    everyDaemonRunningBefore: cycles.every((cycle) => cycle.daemonBefore?.daemonRunning === true),
    everyDaemonRunningAfter: cycles.every((cycle) => cycle.daemonAfter?.daemonRunning === true),
    everyRuntimeStable: cycles.every(
      (cycle) => cycle.daemonBefore?.runtimeId === cycle.daemonAfter?.runtimeId,
    ),
    noStaleStartupFailures: staleStartupFailureLines === 0,
    noAnonymousSessionJsonlCreated: anonymousSessionJsonlCreated === false,
  },
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    { outputPath, cycles: cycles.length, staleStartupFailureLines, anonymousSessionJsonlCreated },
    null,
    2,
  ),
);
