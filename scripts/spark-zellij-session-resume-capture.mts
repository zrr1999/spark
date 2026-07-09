#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
const outputPath = String(args.get("output") || "/tmp/spark-zellij-session-resume-surface.json");
const dumpDir = String(args.get("dump-dir") || "/tmp/spark-zellij-session-resume-surface-dumps");

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

async function waitForFile(path: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(path, "utf8");
      if (content.length > 0) return content;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "";
}

function parsePaneId(stdout: string): string | undefined {
  return stdout
    .trim()
    .split(/\s+/u)
    .find((part) => /^terminal_\d+$/u.test(part));
}

async function runPane(key: string, command: string[]) {
  await run("mkdir", ["-p", dumpDir]);
  const stdoutPath = join(dumpDir, `${key}.stdout.txt`);
  const stderrPath = join(dumpDir, `${key}.stderr.txt`);
  const exitPath = join(dumpDir, `${key}.exit`);
  const shell = `export PATH=${quoteShell(process.env.PATH ?? "")}; ${command.map(quoteShell).join(" ")} > ${quoteShell(stdoutPath)} 2> ${quoteShell(stderrPath)}; printf "%s" "$?" > ${quoteShell(exitPath)}; sleep 0.2`;
  const launch = await run("zellij", [
    "--session",
    sessionName,
    "run",
    "--close-on-exit",
    "--name",
    `spark-resume-${key}`,
    "--cwd",
    process.cwd(),
    "--",
    "/bin/sh",
    "-lc",
    shell,
  ]);
  const stdout = await waitForFile(stdoutPath);
  const stderr = await waitForFile(stderrPath, 1_000);
  const exitText = await waitForFile(exitPath);
  const exitStatus = exitText.trim() ? Number(exitText.trim()) : null;
  return {
    command,
    zellijCommand: launch.command,
    paneId: parsePaneId(launch.stdout),
    exitStatus: Number.isFinite(exitStatus) ? exitStatus : null,
    stdoutPath,
    stderrPath,
    stdoutExcerpt: stdout.slice(0, 3_000),
    stderrExcerpt: stderr.slice(0, 1_000),
  };
}

await run("zellij", ["attach", sessionName, "--create-background"]);
const help = await runPane("spark-help", [
  "pnpm",
  "exec",
  "node",
  "--experimental-strip-types",
  "apps/spark-tui/src/cli.ts",
  "--help",
]);
const sessions = await runPane("daemon-sessions", [
  "pnpm",
  "exec",
  "node",
  "--experimental-strip-types",
  "apps/spark-tui/src/cli.ts",
  "daemon",
  "session",
  "list",
  "--json",
]);
const combined = `${help.stdoutExcerpt}\n${sessions.stdoutExcerpt}`;
const report = {
  generatedAt: new Date().toISOString(),
  sessionName,
  help,
  sessions,
  assertions: {
    mentionsZellijSessionSpark: combined.includes("zellij --session spark"),
    mentionsDaemonSessionsList: combined.includes("spark daemon session list --json"),
    mentionsSessionId: combined.includes("--session-id"),
    mentionsWorkspaceBound: /workspace-bound|workspace hash|workspace/i.test(combined),
    helpExitStatusZero: help.exitStatus === 0,
    sessionsExitStatusZero: sessions.exitStatus === 0,
  },
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, assertions: report.assertions }, null, 2));
