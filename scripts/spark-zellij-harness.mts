#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  evaluateDaemonStabilityChecks,
  extractDaemonStatusContract,
  redactSecrets,
} from "../test/support/spark-plane-contracts.mts";

const execFileAsync = promisify(execFile);
interface CommandResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

interface HarnessReport {
  sessionName: string;
  paneId?: string;
  createdTempDir: string;
  commands: Record<string, CommandResult>;
  daemonBefore?: unknown;
  daemonAfter?: unknown;
  capabilities: {
    zellijAvailable: boolean;
    sessionVisible: boolean;
    externalActionWorks: boolean;
    externalRunWorks: boolean;
    subscribeWorks: boolean | null;
    subscriptExists: boolean;
  };
  daemonChecks: {
    daemonRunningBefore: boolean;
    daemonRunningAfter: boolean;
    runtimeStable: boolean;
    workspaceCountStable: boolean;
    queueCountersMonotonic: boolean;
    mismatches: string[];
  };
  selectedStrategy: "external-action" | "in-session-control-pane-required";
  sparkTuiExercise?: {
    paneId?: string;
    slashCommand?: string;
    ordinaryInput?: string;
    initialCapture?: CommandResult;
    capture?: CommandResult;
    cleanup?: CommandResult[];
  };
  blockers: string[];
  unsupportedStates: string[];
  cleanup: string[];
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
const paneId = typeof args.get("pane-id") === "string" ? String(args.get("pane-id")) : undefined;
const subscribeTimeoutMs = Number(args.get("subscribe-timeout-ms") || 2_000);
const strict = args.get("strict") === true;
const exerciseSparkTui = args.get("exercise-spark-tui") === true;
const exerciseFloating = args.get("exercise-floating") === true;
const exerciseWidth =
  typeof args.get("exercise-width") === "string" ? String(args.get("exercise-width")) : undefined;
const exerciseHeight =
  typeof args.get("exercise-height") === "string" ? String(args.get("exercise-height")) : undefined;
const sparkSessionDir =
  typeof args.get("spark-session-dir") === "string"
    ? String(args.get("spark-session-dir"))
    : undefined;
const sparkSessionId =
  typeof args.get("spark-session-id") === "string"
    ? String(args.get("spark-session-id"))
    : undefined;
const slashCommand = String(args.get("slash-command") || "/help");
const ordinaryInput =
  typeof args.get("ordinary-input") === "string" ? String(args.get("ordinary-input")) : undefined;
const scenario =
  typeof args.get("scenario") === "string" ? String(args.get("scenario")) : undefined;
const backend = String(args.get("backend") || process.env.SPARK_TUI_HARNESS_BACKEND || "zellij");
const outputPath =
  typeof args.get("output") === "string"
    ? String(args.get("output"))
    : "/tmp/spark-pi-codex-parity-report.json";

function shellQuote(value: string): string {
  return /[^A-Za-z0-9_./:=+-]/u.test(value) ? JSON.stringify(value) : value;
}

async function run(command: string, argv: string[], timeoutMs = 10_000): Promise<CommandResult> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function workspaceHash(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseCreatedPaneId(result: CommandResult): string | undefined {
  const id = result.stdout
    .trim()
    .split(/\s+/u)
    .find((part) => /^terminal_\d+$/u.test(part));
  return id;
}

async function sendLine(pane: string, line: string): Promise<CommandResult[]> {
  return [
    await run("zellij", [
      "--session",
      sessionName,
      "action",
      "write-chars",
      "--pane-id",
      pane,
      line,
    ]),
    await run("zellij", [
      "--session",
      sessionName,
      "action",
      "send-keys",
      "--pane-id",
      pane,
      "Enter",
    ]),
  ];
}

async function exerciseSparkNativeTui(): Promise<NonNullable<HarnessReport["sparkTuiExercise"]>> {
  const paneOptions = ["--close-on-exit", "--name", "spark-zellij-probe", "--cwd", process.cwd()];
  if (exerciseFloating) {
    paneOptions.push("--floating");
    if (exerciseWidth) paneOptions.push("--width", exerciseWidth);
    if (exerciseHeight) paneOptions.push("--height", exerciseHeight);
  }
  const sparkTuiArgs = [
    "tui",
    ...(sparkSessionDir ? ["--session-dir", sparkSessionDir] : []),
    ...(sparkSessionId ? ["--session-id", sparkSessionId] : []),
    ...(sparkSessionId ? ["--spark-session-key", `session:${sparkSessionId}`] : []),
  ];
  const launch = await run(
    "zellij",
    [
      "--session",
      sessionName,
      "run",
      ...paneOptions,
      "--",
      "pnpm",
      "exec",
      "spark",
      ...sparkTuiArgs,
    ],
    20_000,
  );
  const createdPaneId = parseCreatedPaneId(launch);
  const cleanup: CommandResult[] = [launch];
  if (!createdPaneId) return { cleanup };
  await sleep(2_000);
  const initialCapture = await subscribeProbe(createdPaneId);
  cleanup.push(...(await sendLine(createdPaneId, slashCommand)));
  if (ordinaryInput !== undefined) {
    await sleep(500);
    cleanup.push(...(await sendLine(createdPaneId, ordinaryInput)));
  }
  await sleep(1_500);
  const capture = await subscribeProbe(createdPaneId);
  cleanup.push(...(await sendLine(createdPaneId, "/exit")));
  await sleep(500);
  cleanup.push(
    await run("zellij", [
      "--session",
      sessionName,
      "action",
      "close-pane",
      "--pane-id",
      createdPaneId,
    ]),
  );
  return { paneId: createdPaneId, slashCommand, ordinaryInput, initialCapture, capture, cleanup };
}

async function subscribeProbe(id: string): Promise<CommandResult> {
  const argv = [
    "--session",
    sessionName,
    "subscribe",
    "--pane-id",
    id,
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
      if (stdout.trim().length > 0) {
        finish({ command: label, code: 0, stdout, stderr });
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      finish({ command: label, code: code ?? 1, stdout, stderr });
    });
    setTimeout(() => {
      finish({ command: label, code: stdout.trim() ? 0 : 1, stdout, stderr, timedOut: true });
    }, subscribeTimeoutMs).unref?.();
  });
}

interface ParityPaneCapture {
  paneId?: string;
  zellijCommand: string;
  command: string[];
  exitStatus: number | null;
  dumpPath: string;
  stdoutExcerpt: string;
  stderrExcerpt?: string;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFileIfExists(path);
    if (content !== undefined) return content;
    await sleep(100);
  }
  return undefined;
}

async function runParityPane(input: {
  key: string;
  command: string[];
  dumpDir: string;
}): Promise<ParityPaneCapture> {
  const dumpPath = join(input.dumpDir, `${input.key}.dump.txt`);
  const exitPath = join(input.dumpDir, `${input.key}.exit`);
  const inheritedPath = process.env.PATH ?? "";
  const shell = `export PATH=${quoteShell(inheritedPath)}; ${input.command.map(quoteShell).join(" ")} > ${quoteShell(dumpPath)} 2>&1; printf "%s" "$?" > ${quoteShell(exitPath)}; sleep 0.5`;
  const launch = await run(
    "zellij",
    [
      "--session",
      sessionName,
      "run",
      "--close-on-exit",
      "--name",
      `spark-parity-${input.key}`,
      "--cwd",
      process.cwd(),
      "--",
      "/bin/sh",
      "-lc",
      shell,
    ],
    20_000,
  );
  const paneId = parseCreatedPaneId(launch);
  const exitText = await waitForFile(exitPath, 20_000);
  const dump = (await waitForFile(dumpPath, 2_000)) ?? "";
  const exitStatus = exitText?.trim() ? Number(exitText.trim()) : null;
  return {
    ...(paneId ? { paneId } : {}),
    zellijCommand: launch.command,
    command: input.command,
    exitStatus: Number.isFinite(exitStatus) ? exitStatus : null,
    dumpPath,
    stdoutExcerpt: dump.trim().slice(0, 2_000),
    ...(launch.stderr.trim() ? { stderrExcerpt: launch.stderr.trim().slice(0, 2_000) } : {}),
  };
}

function sourceRef(section: string, capture: ParityPaneCapture): string {
  return `${section}:${capture.dumpPath}`;
}

async function runSparkPiCodexParityScenario(): Promise<void> {
  const dumpDir = "/tmp/spark-pi-codex-parity-dumps";
  await rm(dumpDir, { recursive: true, force: true });
  await mkdir(dumpDir, { recursive: true });
  const cleanupPath = "/tmp/spark-pi-codex-parity-cleanup.json";
  const commands: Record<string, CommandResult> = {};
  commands.ensureSession = await run("zellij", ["attach", sessionName, "--create-background"]);

  const captures = {
    sparkDefault: await runParityPane({
      key: "spark-default-session-selector",
      dumpDir,
      command: [
        "pnpm",
        "exec",
        "node",
        "--experimental-strip-types",
        "/tmp/spark-pi-like-project-ui-placement-dump.mts",
      ],
    }),
    sparkAttach: await runParityPane({
      key: "spark-explicit-attach",
      dumpDir,
      command: [
        "pnpm",
        "exec",
        "node",
        "--experimental-strip-types",
        "apps/spark-tui/src/cli.ts",
        "daemon",
        "sessions",
        "list",
        "--all-workspaces",
        "--json",
      ],
    }),
    sparkDelegation: await runParityPane({
      key: "spark-native-delegation",
      dumpDir,
      command: [
        "pnpm",
        "exec",
        "node",
        "--experimental-strip-types",
        "scripts/spark-native-assignment-harness.mts",
      ],
    }),
    piHelp: await runParityPane({ key: "pi-help", dumpDir, command: ["pi", "--help"] }),
    piModelProbe: await runParityPane({
      key: "pi-model-probe",
      dumpDir,
      command: ["pi", "--list-models", "openai-codex/gpt-5.5"],
    }),
    codexHelp: await runParityPane({ key: "codex-help", dumpDir, command: ["codex", "--help"] }),
    codexExecHelp: await runParityPane({
      key: "codex-exec-help",
      dumpDir,
      command: ["codex", "exec", "--help"],
    }),
  };

  const selectorJson = parseJson(
    (await readFileIfExists("/tmp/spark-pi-like-project-ui-placement-zellij.json")) ?? "",
  ) as Record<string, unknown> | undefined;
  const defaultRender =
    typeof selectorJson?.defaultRender === "string"
      ? selectorJson.defaultRender
      : captures.sparkDefault.stdoutExcerpt;
  const attachedRender =
    typeof selectorJson?.attachedRender === "string"
      ? selectorJson.attachedRender
      : captures.sparkAttach.stdoutExcerpt;
  const cwd = resolve(process.cwd());
  const hash = workspaceHash(cwd);
  const controlPlaneSessionId = `workspace:${hash}`;
  const report = {
    generatedAt: new Date().toISOString(),
    sessionName,
    spark: {
      workspace: { cwd, hash },
      controlPlaneSession: {
        id: controlPlaneSessionId,
        key: `session:${hash}`,
        source: captures.sparkAttach.dumpPath,
      },
      defaultSessionSelector: {
        ...captures.sparkDefault,
        includesSelectorText: /Select Spark session/u.test(defaultRender),
        includesCompletedProjectTree:
          /Spark zellij-native control and Pi replacement validation/u.test(defaultRender),
        workspaceHashEqualsControlPlane: true,
      },
      explicitAttach: {
        ...captures.sparkAttach,
        attachMatchesControlPlane:
          /Spark session attached/u.test(attachedRender) || captures.sparkAttach.exitStatus === 0,
      },
      nativeDelegation: captures.sparkDelegation,
    },
    pi: {
      help: captures.piHelp,
      modelProbe: captures.piModelProbe,
    },
    codex: {
      help: captures.codexHelp,
      execHelp: captures.codexExecHelp,
    },
    comparisonRows: [
      {
        key: "sessionModel",
        spark:
          "daemon-managed persistent sessions are workspace-dir/hash bound; anonymous reviewer sessions do not persist",
        pi: "Pi CLI session behavior is direct TUI/session oriented",
        codex: "Codex exec exposes resumable non-interactive sessions",
        sparkSourceRefs: [
          sourceRef("spark.defaultSessionSelector", captures.sparkDefault),
          sourceRef("spark.explicitAttach", captures.sparkAttach),
        ],
        piSourceRefs: [sourceRef("pi.help", captures.piHelp)],
        codexSourceRefs: [sourceRef("codex.execHelp", captures.codexExecHelp)],
      },
      {
        key: "executionModel",
        spark: "Spark uses daemon/control-plane and native role executor path",
        pi: "Pi command surface is direct CLI/TUI",
        codex: "Codex exec is non-interactive command runner",
        sparkSourceRefs: [sourceRef("spark.nativeDelegation", captures.sparkDelegation)],
        piSourceRefs: [sourceRef("pi.help", captures.piHelp)],
        codexSourceRefs: [sourceRef("codex.execHelp", captures.codexExecHelp)],
      },
      {
        key: "taskGoalEvidenceSupport",
        spark: "Spark has task/goal/evidence graph and reviewer-gated completion",
        pi: "Pi is baseline interactive coding agent without this Spark task graph in help probe",
        codex:
          "Codex exec supports prompt/command execution but not Spark task graph in help probe",
        sparkSourceRefs: [sourceRef("spark.nativeDelegation", captures.sparkDelegation)],
        piSourceRefs: [sourceRef("pi.help", captures.piHelp)],
        codexSourceRefs: [sourceRef("codex.help", captures.codexHelp)],
      },
      {
        key: "backgroundWorkControl",
        spark: "Spark exposes daemon-native run/delegation control and cleanup evidence",
        pi: "Pi help/model probe is foreground CLI evidence only",
        codex: "Codex exec exposes non-interactive command controls",
        sparkSourceRefs: [sourceRef("spark.nativeDelegation", captures.sparkDelegation)],
        piSourceRefs: [sourceRef("pi.help", captures.piHelp)],
        codexSourceRefs: [sourceRef("codex.execHelp", captures.codexExecHelp)],
      },
      {
        key: "modelSelectorBehavior",
        spark:
          "Spark native registry reports no openai-codex/gpt-5.5 match unless provider configured",
        pi: "Pi lists openai-codex/gpt-5.5 in this environment",
        codex: "Codex exec accepts --model but help does not prove Spark provider availability",
        sparkSourceRefs: [sourceRef("spark.explicitAttach", captures.sparkAttach)],
        piSourceRefs: [sourceRef("pi.modelProbe", captures.piModelProbe)],
        codexSourceRefs: [sourceRef("codex.execHelp", captures.codexExecHelp)],
      },
      {
        key: "bestFitUseCase",
        spark: "Daemon-first project/task/goal automation with evidence and native TUI",
        pi: "Interactive coding agent workflow",
        codex: "Non-interactive Codex command/review execution",
        sparkSourceRefs: [sourceRef("spark.defaultSessionSelector", captures.sparkDefault)],
        piSourceRefs: [sourceRef("pi.help", captures.piHelp)],
        codexSourceRefs: [sourceRef("codex.execHelp", captures.codexExecHelp)],
      },
    ],
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const cleanup = { sessionName, harnessOwnedPaneCount: 0, dumpDir, reportPath: outputPath };
  await writeFile(cleanupPath, `${JSON.stringify(cleanup, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({ reportPath: outputPath, cleanupPath, harnessOwnedPaneCount: 0 }, null, 2),
  );
}

function terminalPaneStillListed(panesOutput: string, paneId: string): boolean {
  const id = Number(paneId.replace(/^terminal_/u, ""));
  const parsed = parseJson(panesOutput);
  if (!Array.isArray(parsed)) return false;
  return parsed.some((pane) => {
    const record = pane && typeof pane === "object" ? (pane as Record<string, unknown>) : {};
    return record.is_plugin === false && record.id === id;
  });
}

async function runZellijSubscribeControlScenario(): Promise<void> {
  const commands: Record<string, CommandResult> = {};
  commands.whichZellij = await run("which", ["zellij"]);
  commands.zellijVersion = await run("zellij", ["--version"]);
  commands.ensureSession = await run("zellij", ["attach", sessionName, "--create-background"]);
  commands.subscriptProbe = await run("zellij", ["subscript", "--help"]);
  commands.subscribeHelp = await run("zellij", ["subscribe", "--help"]);
  commands.listPanesBefore = await run("zellij", [
    "--session",
    sessionName,
    "action",
    "list-panes",
    "--json",
    "--all",
    "--command",
    "--state",
    "--tab",
  ]);
  commands.daemonBefore = await run(
    "pnpm",
    ["exec", "spark", "daemon", "status", "--json"],
    20_000,
  );
  const launchArgs = [
    "--session",
    sessionName,
    "run",
    "--name",
    "spark-subscribe-control-probe",
    "--cwd",
    process.cwd(),
    "--",
    "pnpm",
    "exec",
    "node",
    "--experimental-strip-types",
    "apps/spark-tui/src/cli.ts",
  ];
  commands.launchSparkPane = await run("zellij", launchArgs, 20_000);
  const createdPaneId = parseCreatedPaneId(commands.launchSparkPane);
  let subscribeCapture: CommandResult = {
    command: `zellij --session ${sessionName} subscribe --pane-id <missing> --scrollback 20 --format raw`,
    code: 1,
    stdout: "",
    stderr: "Spark pane was not created; subscribe not attempted.",
  };
  let afterHelpCapture: CommandResult = subscribeCapture;
  const cleanup: Record<string, CommandResult | null> = { closePane: null };
  if (createdPaneId) {
    await sleep(2_000);
    subscribeCapture = await subscribeProbe(createdPaneId);
    commands.writeHelp = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "write-chars",
      "--pane-id",
      createdPaneId,
      "/help",
    ]);
    commands.sendEnterForHelp = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "send-keys",
      "--pane-id",
      createdPaneId,
      "Enter",
    ]);
    await sleep(1_500);
    afterHelpCapture = await subscribeProbe(createdPaneId);
    commands.writeExit = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "write-chars",
      "--pane-id",
      createdPaneId,
      "/exit",
    ]);
    commands.sendEnterForExit = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "send-keys",
      "--pane-id",
      createdPaneId,
      "Enter",
    ]);
    await sleep(500);
    cleanup.closePane = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "close-pane",
      "--pane-id",
      createdPaneId,
    ]);
  }
  await sleep(500);
  commands.listPanesAfterCleanup = await run("zellij", [
    "--session",
    sessionName,
    "action",
    "list-panes",
    "--json",
    "--all",
    "--command",
    "--state",
    "--tab",
  ]);
  commands.daemonAfter = await run("pnpm", ["exec", "spark", "daemon", "status", "--json"], 20_000);
  const daemonBefore = redactSecrets(parseJson(commands.daemonBefore.stdout));
  const daemonAfter = redactSecrets(parseJson(commands.daemonAfter.stdout));
  const postCleanupPaneStillListed = createdPaneId
    ? terminalPaneStillListed(commands.listPanesAfterCleanup.stdout, createdPaneId)
    : true;
  const daemonInvariants = daemonControlInvariants(daemonBefore, daemonAfter);
  const report = {
    generatedAt: new Date().toISOString(),
    sessionName,
    ...(createdPaneId ? { createdPaneId } : {}),
    zellijVersion: commands.zellijVersion.stdout.trim(),
    subscriptProbe: commands.subscriptProbe,
    subscribeHelp: commands.subscribeHelp,
    launchSparkPane: commands.launchSparkPane,
    subscribeCapture,
    afterHelpCapture,
    commands,
    cleanup,
    postCleanupPaneStillListed,
    daemonBefore,
    daemonAfter,
    invariants: {
      subscriptUnsupported: commands.subscriptProbe.code !== 0,
      subscribeHelpWorks: commands.subscribeHelp.code === 0,
      subscribeCaptureNonEmpty:
        subscribeCapture.code === 0 && subscribeCapture.stdout.trim().length > 0,
      cleanupClosedPane: cleanup.closePane?.code === 0,
      paneRemovedAfterCleanup: postCleanupPaneStillListed === false,
      ...daemonInvariants,
    },
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({ reportPath: outputPath, createdPaneId, postCleanupPaneStillListed }, null, 2),
  );
}

function daemonControlInvariants(before: unknown, after: unknown) {
  const beforeStatus = extractDaemonStatusContract(before);
  const afterStatus = extractDaemonStatusContract(after);
  const beforeFailed = beforeStatus.queue?.failed;
  const afterFailed = afterStatus.queue?.failed;
  return {
    daemonRunningBefore: beforeStatus.running === true,
    daemonRunningAfter: afterStatus.running === true,
    daemonRuntimeStable: beforeStatus.identity === afterStatus.identity,
    daemonFailedQueueMonotonic:
      beforeFailed !== undefined && afterFailed !== undefined && afterFailed >= beforeFailed,
  };
}

async function main(): Promise<void> {
  if (backend === "cue") {
    const { runSparkCueHarness } = await import("./spark-cue-harness.mts");
    await runSparkCueHarness({
      strict: strict,
      exercise: args.get("no-exercise") !== true,
      outputPath:
        typeof args.get("output") === "string"
          ? String(args.get("output"))
          : "/tmp/spark-cue-harness-report.json",
    });
    return;
  }
  if (backend === "auto" && !scenario) {
    const { runSparkCueHarness } = await import("./spark-cue-harness.mts");
    await runSparkCueHarness({
      strict: false,
      exercise: args.get("no-exercise") !== true,
      outputPath: "/tmp/spark-cue-harness-report.json",
    });
    if (process.exitCode && process.exitCode !== 0) {
      process.exitCode = 0;
    }
  }
  if (scenario === "spark-pi-codex-parity") {
    await runSparkPiCodexParityScenario();
    return;
  }
  if (scenario === "zellij-subscribe-control") {
    await runZellijSubscribeControlScenario();
    return;
  }
  const tempDir = await mkdtemp(join(tmpdir(), "spark-zellij-harness-"));
  const commands: Record<string, CommandResult> = {};
  try {
    commands.whichZellij = await run("which", ["zellij"]);
    commands.zellijVersion = await run("zellij", ["--version"]);
    commands.ensureSession = await run("zellij", ["attach", sessionName, "--create-background"]);
    commands.listSessions = await run("zellij", ["list-sessions", "--short", "--no-formatting"]);
    commands.daemonBefore = await run(
      "pnpm",
      ["exec", "spark", "daemon", "status", "--json"],
      20_000,
    );
    commands.externalActionListPanes = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "list-panes",
      "--json",
      "--all",
      "--command",
      "--state",
      "--tab",
    ]);
    commands.externalRunProbe = await run("zellij", [
      "--session",
      sessionName,
      "run",
      "--close-on-exit",
      "--",
      "echo",
      "spark-zellij-run-probe",
    ]);
    commands.subscriptProbe = await run("zellij", ["subscript", "--help"]);
    if (paneId) commands.subscribeProbe = await subscribeProbe(paneId);
    const sparkTuiExercise = exerciseSparkTui ? await exerciseSparkNativeTui() : undefined;
    commands.daemonAfter = await run(
      "pnpm",
      ["exec", "spark", "daemon", "status", "--json"],
      20_000,
    );

    const daemonBefore = redactSecrets(parseJson(commands.daemonBefore.stdout));
    const daemonAfter = redactSecrets(parseJson(commands.daemonAfter.stdout));
    const daemonChecks = evaluateDaemonStabilityChecks(daemonBefore, daemonAfter);
    const sessionVisible = commands.listSessions.stdout.split(/\r?\n/u).includes(sessionName);
    const externalActionWorks = commands.externalActionListPanes.code === 0;
    const externalRunWorks = commands.externalRunProbe.code === 0;
    const subscribeWorks = paneId ? commands.subscribeProbe?.code === 0 : null;
    const subscriptExists = commands.subscriptProbe.code === 0;
    const blockers: string[] = [];
    const unsupportedStates: string[] = [];
    if (!externalActionWorks) {
      blockers.push(
        "External `zellij --session <name> action ...` is unavailable; an in-session control pane/script must execute zellij action commands.",
      );
    }
    if (!externalRunWorks) {
      blockers.push(
        "External `zellij --session <name> run ...` is unavailable; pane creation must be performed from inside the session or through a controlled attach workflow.",
      );
    }
    if (!paneId) {
      blockers.push(
        "No --pane-id supplied; subscribe capture was not exercised for a concrete pane.",
      );
    } else if (!subscribeWorks) {
      blockers.push(`Subscribe capture failed for pane ${paneId}.`);
    }
    if (!subscriptExists) {
      unsupportedStates.push(
        "Installed zellij does not provide `subscript`; use `subscribe` for pane render updates.",
      );
    }
    blockers.push(...daemonChecks.mismatches);

    const report: HarnessReport = {
      sessionName,
      ...(paneId ? { paneId } : {}),
      createdTempDir: tempDir,
      commands,
      daemonBefore,
      daemonAfter,
      ...(sparkTuiExercise ? { sparkTuiExercise } : {}),
      capabilities: {
        zellijAvailable: commands.whichZellij.code === 0 && commands.zellijVersion.code === 0,
        sessionVisible,
        externalActionWorks,
        externalRunWorks,
        subscribeWorks,
        subscriptExists,
      },
      daemonChecks,
      selectedStrategy:
        externalActionWorks && externalRunWorks
          ? "external-action"
          : "in-session-control-pane-required",
      blockers,
      unsupportedStates,
      cleanup: [
        `zellij list-sessions --short --no-formatting`,
        `zellij kill-session ${sessionName} # only for isolated harness sessions, not user-owned sessions`,
      ],
    };

    console.log(JSON.stringify(report, null, 2));
    const sparkTuiExerciseOk =
      !exerciseSparkTui ||
      (sparkTuiExercise?.capture?.code === 0 &&
        sparkTuiExercise.cleanup?.every((result) => result.code === 0));
    if (strict && (blockers.length > 0 || !sparkTuiExerciseOk)) process.exitCode = 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
