#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface CommandResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
}

interface CueHarnessReport {
  generatedAt: string;
  backend: "cue";
  socketPath: string;
  commands: Record<string, CommandResult>;
  capabilities: {
    cueTuiAvailable: boolean;
    debugHelpDocumented: boolean;
    captureCliAvailable: boolean;
    sendKeysCliAvailable: boolean;
    writeCharsCliAvailable: boolean;
    stateCliAvailable: boolean;
    subscribeCliAvailable: boolean;
    liveExerciseAttempted: boolean;
    liveExercisePassed: boolean;
  };
  blockers: string[];
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

const strict = args.get("strict") === true;
const exercise = args.get("no-exercise") !== true;
const outputPath = String(args.get("output") || "/tmp/spark-cue-harness-report.json");

async function run(command: string, argv: string[], timeoutMs = 10_000): Promise<CommandResult> {
  const label = [command, ...argv].join(" ");
  try {
    const { stdout, stderr } = await execFileAsync(command, argv, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    return { command: label, code: 0, stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      command: label,
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? error),
    };
  }
}

async function exerciseDebugSocket(socketPath: string): Promise<{
  attempted: boolean;
  passed: boolean;
  commands: Record<string, CommandResult>;
}> {
  const commands: Record<string, CommandResult> = {};
  const child = spawn("cue-tui", ["--debug-socket", socketPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 800));
  commands.capture = await run("cue-tui", ["debug", "capture", "--socket", socketPath]);
  commands.state = await run("cue-tui", ["debug", "state", "--socket", socketPath]);
  commands.writeChars = await run("cue-tui", [
    "debug",
    "write-chars",
    "--socket",
    socketPath,
    ":help",
  ]);
  commands.sendKeys = await run("cue-tui", ["debug", "send-keys", "--socket", socketPath, "enter"]);
  commands.captureAfterInput = await run("cue-tui", ["debug", "capture", "--socket", socketPath]);
  commands.sendQuit = await run("cue-tui", [
    "debug",
    "send-keys",
    "--socket",
    socketPath,
    "ctrl+d",
  ]);
  const passed =
    commands.capture.code === 0 &&
    commands.state.code === 0 &&
    commands.writeChars.code === 0 &&
    commands.sendKeys.code === 0;
  return { attempted: true, passed, commands };
}

export async function runSparkCueHarness(
  options: {
    strict?: boolean;
    exercise?: boolean;
    outputPath?: string;
  } = {},
): Promise<CueHarnessReport> {
  const useStrict = options.strict ?? strict;
  const useExercise = options.exercise ?? exercise;
  const reportOutput = options.outputPath ?? outputPath;
  const socketPath = join(
    await mkdtemp(join(tmpdir(), "spark-cue-harness-")),
    "cue-tui-debug.sock",
  );
  const commands: Record<string, CommandResult> = {};
  const blockers: string[] = [];

  commands.whichCueTui = await run("which", ["cue-tui"]);
  commands.cueTuiVersion = await run("cue-tui", ["--version"]);
  commands.cueTuiHelp = await run("cue-tui", ["--help"]);
  commands.debugHelp = await run("cue-tui", ["debug", "--help"]);

  const help = `${commands.cueTuiHelp.stdout}\n${commands.debugHelp.stdout}`;
  const capabilities = {
    cueTuiAvailable: commands.whichCueTui.code === 0 && commands.cueTuiVersion.code === 0,
    debugHelpDocumented: /--debug-socket/u.test(help) && /debug capture/u.test(help),
    captureCliAvailable: /debug capture/u.test(help),
    sendKeysCliAvailable: /debug send-keys/u.test(help),
    writeCharsCliAvailable: /debug write-chars/u.test(help),
    stateCliAvailable: /debug state/u.test(help),
    subscribeCliAvailable: /debug subscribe/u.test(help),
    liveExerciseAttempted: false,
    liveExercisePassed: false,
  };

  if (!capabilities.cueTuiAvailable) {
    blockers.push("cue-tui is not available on PATH.");
  }
  if (!capabilities.debugHelpDocumented) {
    blockers.push("cue-tui help does not document --debug-socket and debug subcommands.");
  }

  if (useExercise && capabilities.cueTuiAvailable) {
    const live = await exerciseDebugSocket(socketPath);
    Object.assign(commands, live.commands);
    capabilities.liveExerciseAttempted = live.attempted;
    capabilities.liveExercisePassed = live.passed;
    if (!live.passed) {
      blockers.push("cue-tui live debug exercise failed (capture/state/write-chars/send-keys).");
    }
  }

  const report: CueHarnessReport = {
    generatedAt: new Date().toISOString(),
    backend: "cue",
    socketPath,
    commands,
    capabilities,
    blockers,
  };

  await writeFile(reportOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportPath: reportOutput, blockers, capabilities }, null, 2));

  if (useStrict && blockers.length > 0) {
    process.exitCode = 1;
  }

  try {
    await rm(socketPath, { force: true });
  } catch {
    // best-effort cleanup
  }

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSparkCueHarness().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
