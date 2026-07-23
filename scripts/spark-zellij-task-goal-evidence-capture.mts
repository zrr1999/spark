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
const outputPath = String(
  args.get("output") || "/tmp/spark-zellij-task-goal-evidence-capture.json",
);
const dumpDir = String(args.get("dump-dir") || "/tmp/spark-zellij-task-goal-evidence-dumps");
const stateParent = String(
  args.get("state-parent") ||
    "/Users/zhanrongrui/Library/pnpm/store/v11/projects/0a7ab7df0c343f8056478bcad7c0b499",
);
const sessionKey = String(args.get("session-key") || "session:5ad35e499eafe941");
const projectRef = String(args.get("project") || "proj:bed53537-5e15-441d-b68a-95b914ad6d41");

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
async function waitForFile(path: string, timeoutMs = 20_000): Promise<string> {
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

const summaryScript = join(dumpDir, "summary.mts");
const stdoutPath = join(dumpDir, "summary.stdout.txt");
const stderrPath = join(dumpDir, "summary.stderr.txt");
const exitPath = join(dumpDir, "summary.exit");
await run("mkdir", ["-p", dumpDir]);
await writeFile(
  summaryScript,
  `
import { join } from "node:path";
import { createSparkCliHostServices } from "${process.cwd()}/apps/spark-tui/src/host/bootstrap.ts";
const services = await createSparkCliHostServices({ cwd: ${JSON.stringify(stateParent)}, sparkStateRoot: join(${JSON.stringify(stateParent)}, ".spark"), extensions: ["@zendev-lab/spark-extension/extension"], sessionManager: { getLeafId: () => ${JSON.stringify(sessionKey)} } });
const ctx = services.runtime.makeContext();
const read = services.runtime.getTool("task_read")?.config;
if (!read?.execute) throw new Error("task_read unavailable");
const result = await read.execute("zellij-summary", { action: "project_status", project: ${JSON.stringify(projectRef)}, view: "active", format: "json", limit: 20 }, new AbortController().signal, async () => undefined, ctx);
const details = result.details;
const project = details.selectedProject;
const counts = project.taskCounts;
const goal = details.sessionGoal;
const lines = [
  "Spark task/goal summary",
  \`Project: \${project.title}\`,
  \`Tasks: \${counts.statusCounts.done ?? 0}/\${counts.total} done · unfinished \${counts.unfinished} · ready \${counts.ready}\`,
  \`Goal: \${goal?.status ?? "none"} · \${String(goal?.objective ?? "none").slice(0, 80)}\`
];
console.log(lines.join("\\n"));
`,
  "utf8",
);
await run("zellij", ["attach", sessionName, "--create-background"]);
const shell = `export PATH=${quoteShell(process.env.PATH ?? "")}; pnpm exec node --experimental-strip-types ${quoteShell(summaryScript)} > ${quoteShell(stdoutPath)} 2> ${quoteShell(stderrPath)}; printf "%s" "$?" > ${quoteShell(exitPath)}; sleep 0.2`;
const launch = await run("zellij", [
  "--session",
  sessionName,
  "run",
  "--close-on-exit",
  "--name",
  "spark-task-goal-evidence",
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
const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
const report = {
  generatedAt: new Date().toISOString(),
  sessionName,
  paneId: parsePaneId(launch.stdout),
  zellijCommand: launch.command,
  exitStatus: exitText.trim() ? Number(exitText.trim()) : null,
  stdoutPath,
  stderrPath,
  stdout,
  stderr,
  summaryLineCount: lines.length,
  assertions: {
    hasProject: /Project:/u.test(stdout),
    hasTaskCounts: /Tasks: \d+\/\d+ done · unfinished \d+ · ready \d+/u.test(stdout),
    hasGoalStatus: /Goal: /u.test(stdout),
    hasEvidenceReview: /Evidence\/review:/u.test(stdout),
    compactAtMostSixLines: lines.length <= 6,
  },
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      outputPath,
      paneId: report.paneId,
      exitStatus: report.exitStatus,
      summaryLineCount: report.summaryLineCount,
      assertions: report.assertions,
    },
    null,
    2,
  ),
);
