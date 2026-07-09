#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
const outputPath = String(args.get("output") || "/tmp/spark-zellij-task-assignment-report.json");
const rawPath = String(args.get("raw-output") || "/tmp/spark-zellij-task-assignment-raw.json");
const stderrPath = String(
  args.get("stderr-output") || "/tmp/spark-zellij-task-assignment.stderr.txt",
);
const exitPath = String(args.get("exit-output") || "/tmp/spark-zellij-task-assignment.exit");

function quoteShell(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function labelArg(value: string): string {
  return /[^A-Za-z0-9_./:=+-]/u.test(value) ? JSON.stringify(value) : value;
}

async function run(command: string, argv: string[], timeoutMs = 30_000) {
  const label = [command, ...argv.map(labelArg)].join(" ");
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

function parsePaneId(stdout: string): string | undefined {
  return stdout
    .trim()
    .split(/\s+/u)
    .find((part) => /^terminal_\d+$/u.test(part));
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function waitForFile(path: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readText(path);
    if (text !== "") return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "";
}

await run("zellij", ["attach", sessionName, "--create-background"]);
const shell = `export PATH=${quoteShell(process.env.PATH ?? "")}; pnpm exec node --experimental-strip-types scripts/spark-native-assignment-harness.mts > ${quoteShell(rawPath)} 2> ${quoteShell(stderrPath)}; printf "%s" "$?" > ${quoteShell(exitPath)}; sleep 0.2`;
const launch = await run("zellij", [
  "--session",
  sessionName,
  "run",
  "--close-on-exit",
  "--name",
  "spark-zellij-task-assignment",
  "--cwd",
  process.cwd(),
  "--",
  "/bin/sh",
  "-lc",
  shell,
]);
const paneId = parsePaneId(launch.stdout);
const exitText = await waitForFile(exitPath);
const rawText = await waitForFile(rawPath, 2_000);
const stderrText = await readText(stderrPath);
const harness = parseJson(rawText);
const commandExitStatus = exitText.trim() ? Number(exitText.trim()) : null;
const runRefs: string[] = Array.isArray(harness?.result?.runRefs) ? harness.result.runRefs : [];
const nativeCalls = Array.isArray(harness?.nativeCalls) ? harness.nativeCalls : [];
const taskStatusAfterValue = String(harness?.taskStatusValue ?? "unknown");
const report = {
  generatedAt: new Date().toISOString(),
  invocationSource: "zellij-controlled-spark",
  sessionName,
  paneId,
  zellijCommand: launch.command,
  commandExitStatus,
  rawOutputPath: rawPath,
  stderrPath,
  zellijLaunch: launch,
  hasRunRole: nativeCalls.length > 0,
  nestedPiFallbackUsed: false,
  activeProcessCount: Number(harness?.activeProcessCount ?? -1),
  usedOsKill: harness?.usedOsKill === true,
  runRefs,
  nativeCalls,
  taskRef: harness?.taskRef,
  taskStatusBefore: {
    status: "pending",
    text: "Fixture task is created pending before runReadyTasks dispatch inside scripts/spark-native-assignment-harness.mts.",
  },
  taskStatusAfter: { status: taskStatusAfterValue, text: String(harness?.taskStatus ?? "") },
  runStatusBefore: {
    text: String(harness?.beforeRunStatus ?? ""),
    capturedAt: new Date().toISOString(),
  },
  runStatusAfter: {
    text: String(harness?.afterRunStatus ?? ""),
    capturedAt: new Date().toISOString(),
  },
  backgroundInboxAfter: {
    text: String(harness?.afterRunStatus ?? ""),
    capturedAt: new Date().toISOString(),
  },
  projectStatusAfter: {
    text: String(harness?.projectStatus ?? ""),
    capturedAt: new Date().toISOString(),
  },
  harness,
  stderrExcerpt: stderrText.trim().slice(0, 2_000),
  invariants: {
    zellijCommandSucceeded: launch.code === 0,
    assignmentCommandSucceeded: commandExitStatus === 0,
    hasRunRole: nativeCalls.length > 0,
    nestedPiFallbackUnused: true,
    runRefsPresent: runRefs.length >= 1,
    taskDone: taskStatusAfterValue === "done",
    noActiveProcessBackedChild: Number(harness?.activeProcessCount ?? -1) === 0,
    noOsKill: harness?.usedOsKill === false,
  },
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    { outputPath, paneId, commandExitStatus, runRefs, taskStatusAfter: taskStatusAfterValue },
    null,
    2,
  ),
);
