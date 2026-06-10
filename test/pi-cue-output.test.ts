import assert from "node:assert/strict";
import test from "node:test";

import {
  type JobInfo,
  type ScriptResult,
  type PiCueExtensionApi,
  normalizeCueBoolean,
  normalizeCueStderrForDisplay,
  normalizeCueTerminalOutput,
  normalizeCueLimit,
  normalizeCueTailBytes,
  normalizeCueTimeoutSeconds,
  renderCueChainStatus,
  renderCueScriptResult,
  registerPiCueTools,
  resolveCueWorkingDirectory,
} from "../packages/pi-cue/src/index.ts";

type RegisteredPiCueTool = Parameters<PiCueExtensionApi["registerTool"]>[0];

void test("normalizeCueTerminalOutput keeps final carriage-return frame", () => {
  assert.equal(normalizeCueTerminalOutput("Working 1\rWorking 2\rDone\n"), "Done\n");
});

void test("normalizeCueTerminalOutput preserves CRLF line content", () => {
  assert.equal(normalizeCueTerminalOutput("hello\r\n"), "hello\n");
});

void test("normalizeCueTerminalOutput collapses repeated spinner progress lines", () => {
  const output = [
    "⠋ Running hooks... vp check --fix...",
    "⠙ Running hooks... vp check --fix...",
    "⠹ Running hooks... vp check --fix...",
    "Passed",
  ].join("\n");

  assert.equal(
    normalizeCueTerminalOutput(output),
    ["⠹ Running hooks... vp check --fix...", "Passed"].join("\n"),
  );
});

void test("normalizeCueStderrForDisplay removes duplicated PTY merge note", () => {
  assert.equal(
    normalizeCueStderrForDisplay("[PTY: stdout and stderr are merged]\nhello\r\n", "hello\r\n"),
    "",
  );
  assert.equal(
    normalizeCueStderrForDisplay(
      ["[PTY: stdout and stderr are merged]", "[PTY: stdout and stderr are merged]", "hello"].join(
        "\n",
      ),
      "hello\n",
    ),
    "",
  );
});

void test("renderCueScriptResult includes source, timeout, item identity, and status", () => {
  const result = {
    scriptId: "script:one",
    source: { kind: "inline" },
    status: "failed",
    exitCode: 1,
    failedItemIndex: 1,
    timedOut: true,
    items: [
      {
        index: 0,
        source: "echo first",
        kind: "message",
        jobIds: [],
        chainId: null,
        cronId: null,
        message: "preflight message\n",
        stdout: "",
        stderr: "",
        status: "Done",
        exitCode: null,
        jobs: [],
      },
      {
        index: 1,
        source: "run test",
        kind: "job",
        jobIds: ["J1"],
        chainId: null,
        cronId: null,
        stdout: "ok\n",
        stderr: "bad\n",
        status: "Failed",
        exitCode: 2,
        jobs: [],
      },
    ],
  } satisfies ScriptResult;

  const rendered = renderCueScriptResult(result, {
    pathLabel: "<inline>",
    timeout: 12,
    tailBytes: 1024,
  }).join("\n");

  assert.match(rendered, /Script script:one: .*failed.*exit=1.*failed_item=1.*source=<inline>/);
  assert.match(rendered, /Script timed out after 12s/);
  assert.match(rendered, /--- item 0: echo first \[message\] .*message/);
  assert.match(rendered, /--- item 1: run test \[job J1\] .*failed \(exit 2\)/);
  assert.match(rendered, /\[stderr\]\nbad/);
});

void test("renderCueScriptResult compacts clean successful items", () => {
  const result = {
    scriptId: "script:clean",
    source: { kind: "file", path: "build.cue" },
    status: "done",
    exitCode: 0,
    failedItemIndex: null,
    timedOut: false,
    items: [
      {
        index: 0,
        source: "true",
        kind: "job",
        jobIds: ["J1"],
        chainId: null,
        cronId: null,
        stdout: "",
        stderr: "",
        status: "Done",
        exitCode: 0,
        jobs: [],
      },
      {
        index: 1,
        source: "echo hidden-clean",
        kind: "chain",
        jobIds: ["J2", "J3"],
        chainId: "CH1",
        cronId: null,
        stdout: "\r",
        stderr: "",
        status: "Done",
        exitCode: null,
        jobs: [],
      },
      {
        index: 2,
        source: "echo visible",
        kind: "job",
        jobIds: ["J4"],
        chainId: null,
        cronId: null,
        stdout: "visible\n",
        stderr: "",
        status: "Done",
        exitCode: 0,
        jobs: [],
      },
    ],
  } satisfies ScriptResult;

  const rendered = renderCueScriptResult(result, {
    pathLabel: "build.cue",
    timeout: 300,
    tailBytes: 1024,
  }).join("\n");

  assert.match(
    rendered,
    /--- 2 clean item\(s\) done with no output \(0:job J1, 1:chain CH1 \(J2,J3\)\)/,
  );
  assert.doesNotMatch(rendered, /--- item 0:/);
  assert.doesNotMatch(rendered, /--- item 1:/);
  assert.match(rendered, /--- item 2: echo visible \[job J4\] .*done/);
  assert.match(rendered, /visible/);
});

void test("renderCueChainStatus prioritizes non-clean leaves and compacts clean leaves", async () => {
  const outputRequests: Array<{ id: string; tailBytes?: number }> = [];
  const errorRequests: Array<{ id: string; tailBytes?: number }> = [];
  const reader = {
    async jobOutput(id: string, tailBytes?: number) {
      outputRequests.push({ id, tailBytes });
      return {
        stdout: id === "J3" ? "done output\n" : id === "J4" ? "failed output\n" : "",
        stderr: "",
        truncated: false,
      };
    },
    async jobError(id: string, tailBytes?: number) {
      errorRequests.push({ id, tailBytes });
      return { stderr: id === "J4" ? "failed stderr\n" : "", truncated: false };
    },
  };
  const jobs = [
    chainJob("J1", 0, "setup", "Done", 0),
    chainJob("J2", 1, "build", "Done", 0),
    chainJob("J3", 2, "test", "Done", 0),
    chainJob("J4", 3, "deploy", "Failed", 1),
  ];

  const rendered = (await renderCueChainStatus(reader, "CH1", jobs, 2048)).join("\n");

  assert.match(rendered, /^❌ failed — chain CH1/);
  assert.match(
    rendered,
    /Leaf 4\/4: ❌ failed — deploy\nExit code: 1\n\nfailed output\n\n\[stderr\]\nfailed stderr/,
  );
  assert.match(rendered, /Leaf 3\/4: ✅ done — test\nExit code: 0\n\ndone output/);
  assert.match(
    rendered,
    /--- 2 clean successful leaf\(s\) done with no output \(leaf 1:J1, leaf 2:J2\)/,
  );
  assert.equal(rendered.includes("Leaf 1/4: ✅ done — setup"), false);
  assert.deepEqual(outputRequests, [
    { id: "J1", tailBytes: 2048 },
    { id: "J2", tailBytes: 2048 },
    { id: "J3", tailBytes: 2048 },
    { id: "J4", tailBytes: 2048 },
  ]);
  assert.deepEqual(errorRequests, outputRequests);
});

function chainJob(
  id: string,
  chainIndex: number,
  pipeline: string,
  status: JobInfo["status"],
  exitCode: number | null,
): JobInfo {
  return {
    id,
    status,
    pipeline,
    exit_code: exitCode,
    open_hint: "stream",
    chain_id: "CH1",
    chain_index: chainIndex,
    chain_total: 4,
  };
}

void test("pi-cue numeric and boolean normalizers reject invalid explicit values", () => {
  assert.equal(normalizeCueTailBytes(undefined, 128), 128);
  assert.equal(normalizeCueTailBytes(0), 0);
  assert.equal(normalizeCueTailBytes(4096), 4096);
  assert.throws(() => normalizeCueTailBytes("4096"), /tail_bytes must be a finite number/);
  assert.throws(() => normalizeCueTailBytes(1.5), /tail_bytes must be a non-negative integer/);
  assert.throws(() => normalizeCueTailBytes(-1), /tail_bytes must be a non-negative integer/);

  assert.equal(normalizeCueLimit(null, 10), 10);
  assert.equal(normalizeCueLimit(5), 5);
  assert.throws(() => normalizeCueLimit(Number.NaN), /limit must be a finite number/);
  assert.throws(() => normalizeCueLimit(2.25), /limit must be a non-negative integer/);

  assert.equal(normalizeCueTimeoutSeconds(undefined, 300), 300);
  assert.equal(normalizeCueTimeoutSeconds(0.25, 300), 0.25);
  assert.throws(() => normalizeCueTimeoutSeconds("300", 300), /timeout must be a finite number/);
  assert.throws(() => normalizeCueTimeoutSeconds(-1, 300), /timeout must be non-negative/);

  assert.equal(normalizeCueBoolean(undefined, false, "cue_exec background"), false);
  assert.equal(normalizeCueBoolean(true, false, "cue_exec background"), true);
  assert.throws(
    () => normalizeCueBoolean("true", false, "cue_exec background"),
    /must be a boolean/,
  );
});

void test("resolveCueWorkingDirectory anchors explicit relative cwd to the Pi context cwd", () => {
  assert.equal(
    resolveCueWorkingDirectory(".", "/tmp/pi-session", "/tmp/process-cwd"),
    "/tmp/pi-session",
  );
  assert.equal(
    resolveCueWorkingDirectory("worktree", "/tmp/pi-session", "/tmp/process-cwd"),
    "/tmp/pi-session/worktree",
  );
  assert.equal(
    resolveCueWorkingDirectory("/var/tmp/absolute", "/tmp/pi-session", "/tmp/process-cwd"),
    "/var/tmp/absolute",
  );
  assert.equal(
    resolveCueWorkingDirectory(undefined, undefined, "/tmp/process-cwd"),
    "/tmp/process-cwd",
  );
});

void test("pi-cue tools validate bad parameters before connecting to cued", async () => {
  const tools = registerCueToolsForTest();
  const execTool = tools.get("cue_exec");
  const runTool = tools.get("cue_run");
  const scriptTool = tools.get("cue_script");
  const scopeTool = tools.get("cue_scope");
  assert.ok(execTool);
  assert.ok(runTool);
  assert.ok(scriptTool);
  assert.ok(scopeTool);

  await assert.rejects(
    () =>
      execTool.execute(
        "call-1",
        { command: "echo ok", tail_bytes: "4096" },
        new AbortController().signal,
        () => undefined,
        {},
      ),
    /cue_exec tail_bytes must be a finite number/,
  );

  await assert.rejects(
    () =>
      execTool.execute(
        "call-2",
        { command: "echo ok", tail: false },
        new AbortController().signal,
        () => undefined,
        {},
      ),
    /cue_exec tail is no longer supported; use tail_bytes=0/,
  );

  await assert.rejects(
    () =>
      scopeTool.execute(
        "call-3",
        { env_tail_bytes: 2048 },
        new AbortController().signal,
        () => undefined,
        {},
      ),
    /cue_scope env_tail_bytes is no longer supported; use tail_bytes/,
  );

  await assert.rejects(
    () =>
      runTool.execute(
        "call-4",
        { path: "notes.txt" },
        new AbortController().signal,
        () => undefined,
        { cwd: "/tmp/pi-cue-test" },
      ),
    /cue_run path must end in \.cue \(got \/tmp\/pi-cue-test\/notes\.txt\)/,
  );

  await assert.rejects(
    () =>
      runTool.execute(
        "call-5",
        { path: "missing.cue" },
        new AbortController().signal,
        () => undefined,
        { cwd: "/tmp/pi-cue-test" },
      ),
    /cue_run failed to read \/tmp\/pi-cue-test\/missing\.cue:/,
  );

  await assert.rejects(
    () =>
      scriptTool.execute(
        "call-6",
        { script: "   " },
        new AbortController().signal,
        () => undefined,
        {},
      ),
    /cue_script script must be a non-empty string/,
  );
});

function registerCueToolsForTest(): Map<string, RegisteredPiCueTool> {
  const tools = new Map<string, RegisteredPiCueTool>();
  registerPiCueTools({
    registerTool: (config) => tools.set(config.name, config),
    on: () => undefined,
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    setActiveTools: () => undefined,
  });
  return tools;
}
