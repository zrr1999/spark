#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface PaneCapture {
  command: string[];
  zellijCommand: string;
  paneId?: string;
  exitStatus: number | null;
  availability: "available" | "unavailable";
  sourcePath: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

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
const outputPath = String(args.get("output") || "/tmp/spark-zellij-competitor-matrix.json");
const dumpDir = String(args.get("dump-dir") || "/tmp/spark-zellij-competitor-matrix-dumps");

function quoteShell(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function shellQuoteForLabel(value: string): string {
  return /[^A-Za-z0-9_./:=+-]/u.test(value) ? JSON.stringify(value) : value;
}

async function run(command: string, argv: string[], timeoutMs = 20_000) {
  const label = [command, ...argv.map(shellQuoteForLabel)].join(" ");
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

async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFileIfExists(path);
    if (content !== undefined) return content;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

function parsePaneId(stdout: string): string | undefined {
  return stdout
    .trim()
    .split(/\s+/u)
    .find((part) => /^terminal_\d+$/u.test(part));
}

async function runPane(key: string, command: string[]): Promise<PaneCapture> {
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
    `spark-matrix-${key}`,
    "--cwd",
    process.cwd(),
    "--",
    "/bin/sh",
    "-lc",
    shell,
  ]);
  const paneId = parsePaneId(launch.stdout);
  const exitText = await waitForFile(exitPath);
  const stdout = (await waitForFile(stdoutPath, 2_000)) ?? "";
  const stderr = (await waitForFile(stderrPath, 2_000)) ?? "";
  const parsedExit = exitText?.trim() ? Number(exitText.trim()) : null;
  const exitStatus = Number.isFinite(parsedExit) ? parsedExit : null;
  return {
    command,
    zellijCommand: launch.command,
    ...(paneId ? { paneId } : {}),
    exitStatus,
    availability: exitStatus === 0 ? "available" : "unavailable",
    sourcePath: stdoutPath,
    stdoutExcerpt: stdout.trim().slice(0, 2_000),
    stderrExcerpt: stderr.trim().slice(0, 2_000),
  };
}

await rm(dumpDir, { recursive: true, force: true });
await mkdir(dumpDir, { recursive: true });
const ensureSession = await run("zellij", ["attach", sessionName, "--create-background"]);
const captures = {
  spark: await runPane("spark-help", [
    "pnpm",
    "exec",
    "node",
    "--experimental-strip-types",
    "apps/spark-tui/src/cli.ts",
    "--help",
  ]),
  pi: await runPane("pi-help", ["pi", "--help"]),
  codex: await runPane("codex-help", ["codex", "--help"]),
  copilot: await runPane("copilot-help", ["copilot", "--help"]),
};

const source = (tool: keyof typeof captures) => `${tool}:${captures[tool].sourcePath}`;
const report = {
  generatedAt: new Date().toISOString(),
  sessionName,
  ensureSession,
  dumpDir,
  spark: captures.spark,
  pi: captures.pi,
  codex: captures.codex,
  copilot: captures.copilot,
  gapRows: [
    {
      key: "zellijNativeObservation",
      impactRank: 1,
      tractabilityRank: 1,
      sparkEvidenceRef: "artifact:9d4653da-9fd3-4e48-ba57-cfa4cd7ffcfc",
      competitorEvidenceRef: source("pi"),
      finding:
        "Spark now has external zellij subscribe/control evidence, while Pi help is primarily direct CLI/TUI oriented.",
      recommendedFollowUp:
        "Promote the subscribe-control harness into a documented check and reuse it for regression cycles.",
    },
    {
      key: "sessionResumeSurface",
      impactRank: 2,
      tractabilityRank: 2,
      sparkEvidenceRef: source("spark"),
      competitorEvidenceRef: source("pi"),
      finding:
        "Pi exposes mature --continue/--resume/--session/session-dir flags directly in help; Spark exposes daemon-first operation but needs equally compact user-facing session verbs in zellij docs/status.",
      recommendedFollowUp:
        "Add/verify concise Spark session resume examples that map daemon sessions to zellij workflows.",
    },
    {
      key: "nonInteractiveAutomation",
      impactRank: 3,
      tractabilityRank: 2,
      sparkEvidenceRef: source("spark"),
      competitorEvidenceRef: source("codex"),
      finding:
        "Codex advertises non-interactive exec/review commands; Spark help has --print/json/rpc but the zellij automation path is harness-driven rather than a polished workflow command.",
      recommendedFollowUp:
        "Expose a first-class scripted zellij/daemon automation recipe for Spark parity with codex exec.",
    },
    {
      key: "copilotAvailability",
      impactRank: 4,
      tractabilityRank: 3,
      sparkEvidenceRef: source("spark"),
      competitorEvidenceRef: source("copilot"),
      finding:
        captures.copilot.availability === "available"
          ? "Copilot command is available in this environment and should be compared with a deeper interactive-safe probe."
          : "The direct copilot command is unavailable in this environment; Spark evaluation should record this as an environment limit instead of inventing Copilot claims.",
      recommendedFollowUp:
        captures.copilot.availability === "available"
          ? "Add a credential-safe Copilot interactive/help probe to the next matrix iteration."
          : "Probe gh extension surfaces separately and keep Copilot claims unavailable until a concrete CLI is present.",
    },
    {
      key: "taskGoalEvidenceDifferentiator",
      impactRank: 5,
      tractabilityRank: 1,
      sparkEvidenceRef: source("spark"),
      competitorEvidenceRef: source("pi"),
      finding:
        "Spark's differentiator is daemon-backed task/goal/evidence orchestration, but the help surface does not make this advantage as discoverable as Pi's compact option list.",
      recommendedFollowUp:
        "Make task/goal/evidence status prominent in zellij captures and final replacement docs.",
    },
  ],
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      outputPath,
      dumpDir,
      availability: Object.fromEntries(
        Object.entries(captures).map(([key, value]) => [key, value.availability]),
      ),
    },
    null,
    2,
  ),
);
