import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type JobInfo,
  type ScriptResult,
  type PiCueExtensionApi,
  type PiCueToolContext,
  normalizeCueBoolean,
  normalizeCueStderrForDisplay,
  normalizeCueTerminalOutput,
  normalizeCueLimit,
  normalizeCueResourceNeeds,
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

  assert.deepEqual(normalizeCueResourceNeeds({ gpu: 1, gpu_mem: "24GiB" }), {
    gpu: 1,
    gpu_mem: "24GiB",
  });
  assert.equal(normalizeCueResourceNeeds({}), undefined);
  assert.throws(() => normalizeCueResourceNeeds(["gpu"]), /must be an object/);
  assert.throws(() => normalizeCueResourceNeeds({ "need.gpu": 1 }), /omit the need\. prefix/);
  assert.throws(() => normalizeCueResourceNeeds({ gpu: -1 }), /non-negative integer/);
  assert.throws(() => normalizeCueResourceNeeds({ gpu: " " }), /non-empty string/);
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
  const resourceTool = tools.get("cue_resources");
  assert.ok(execTool);
  assert.ok(runTool);
  assert.ok(scriptTool);
  assert.ok(scopeTool);
  assert.ok(resourceTool);

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
      execTool.execute(
        "call-3b",
        { command: "echo ok", needs: { "need.gpu": 1 } },
        new AbortController().signal,
        () => undefined,
        {},
      ),
    /cue_exec needs keys must omit the need\. prefix/,
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

void test("script_run and script_eval route venv only to python", async () => {
  const tools = registerCueToolsForTest();
  const runTool = tools.get("script_run");
  const evalTool = tools.get("script_eval");
  assert.ok(runTool);
  assert.ok(evalTool);
  const commands: string[] = [];
  const fakeClient = {
    isClosed: false,
    async runJob(command: string) {
      commands.push(command);
      return {
        jobId: `J${commands.length}`,
        status: "Done" as const,
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        warnings: [],
      };
    },
  };
  const ctx = { cwd: "/work", cueClient: fakeClient } as unknown as PiCueToolContext;

  const fileResult = await runTool.execute(
    "call-venv-run",
    { language: "python", path: "tools/check.py", venv: ".venv" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(commands[0], "/work/.venv/bin/python /work/tools/check.py");
  assert.equal((fileResult.details as { venv?: string }).venv, "/work/.venv");

  const evalResult = await evalTool.execute(
    "call-venv-eval",
    { language: "python", script: "print('ok')", venv: "/opt/venv" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(commands[1], "/opt/venv/bin/python -c \"print('ok')\"");
  assert.equal((evalResult.details as { venv?: string }).venv, "/opt/venv");

  await assert.rejects(
    () =>
      runTool.execute(
        "call-bad-venv-run",
        { language: "cue-shell", path: "script.cue", venv: ".venv" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
    /script_run venv is only supported for language=python/,
  );
  await assert.rejects(
    () =>
      evalTool.execute(
        "call-bad-venv-eval",
        { language: "cue-shell", script: "msg", venv: ".venv" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
    /script_eval venv is only supported for language=python/,
  );
});

void test("pi-cue tool descriptions match cue-shell chain operator contract", () => {
  const tools = registerCueToolsForTest();
  const execTool = tools.get("cue_exec");
  const runTool = tools.get("cue_run");
  const scriptTool = tools.get("cue_script");
  assert.ok(execTool);
  assert.ok(runTool);
  assert.ok(scriptTool);

  const execDescription = `${execTool.description} ${JSON.stringify(execTool.parameters)}`;
  assert.match(execDescription, /\|\|\| runs jobs in parallel|\|\|\| for parallel jobs/);
  assert.match(
    execDescription,
    /\|\?\| races jobs until one succeeds|\|\?\| for any-success race jobs/,
  );
  assert.match(execDescription, /&&\/\|\| are job-internal logical operators|'&&'\/'\|\|'/);
  assert.doesNotMatch(execDescription, /\|\| runs in parallel|\|\| parallel|\|\|\?\s+parallel/);

  assert.match(runTool.description, /`\|\|\|`/);
  assert.match(runTool.description, /`\|\?\|`/);
  assert.match(scriptTool.description, /`\|\|\|`/);
  assert.match(scriptTool.description, /`\|\?\|`/);
});

void test("pi-cue docs document script runner venv, scope, and python -c behavior", async () => {
  const skill = await readFile("packages/pi-cue/skills/pi-cue/SKILL.md", "utf8");
  const readme = await readFile("packages/pi-cue/README.md", "utf8");
  const toolsDoc = await readFile("docs/tools.md", "utf8");

  assert.match(skill, /`script_run`\s+\|[^\n]+`venv\?`, `scope\?`/);
  assert.match(skill, /`script_eval`\s+\|[^\n]+`venv\?`, `scope\?`/);
  assert.match(skill, /`venv` is valid only with `language="python"`/);
  assert.match(skill, /`scope` is valid only with `language="cue-shell"`/);

  assert.match(readme, /`venv` interpreter/);
  assert.match(readme, /`scope` is valid only for `language: "cue-shell"`/);
  assert.match(readme, /python -c/);

  assert.match(toolsDoc, /`pi-cue` tools \([^\n]+`cue_resources`[^\n]+\)/);
  assert.match(toolsDoc, /`cue_resources` — inspect resource providers and snapshots/);
  assert.match(toolsDoc, /python -c/);
  assert.match(toolsDoc, /`venv` is python-only and `scope` is cue-shell-only/);
  assert.doesNotMatch(toolsDoc, /temporary file before execution/);
});

void test("script_run and script_eval pass scope only to cue-shell RunScript", async () => {
  const tools = registerCueToolsForTest();
  const runTool = tools.get("script_run");
  const evalTool = tools.get("script_eval");
  assert.ok(runTool);
  assert.ok(evalTool);
  const dir = await mkdtemp(join(tmpdir(), "pi-cue-script-scope-"));
  const scriptPath = join(dir, "build.cue");
  await writeFile(scriptPath, "msg\n", "utf8");
  const calls: Array<{ path: string; input: string; scope?: string }> = [];
  const fakeClient = {
    isClosed: false,
    async runScript(options: { path: string; input: string; scope?: string }) {
      calls.push(options);
      return {
        scriptId: `script:${calls.length}`,
        source: { kind: "file" as const, path: options.path },
        status: "done" as const,
        exitCode: 0,
        failedItemIndex: null,
        timedOut: false,
        items: [],
      } satisfies ScriptResult;
    },
  };
  const ctx = { cwd: dir, cueClient: fakeClient } as unknown as PiCueToolContext;

  const fileResult = await runTool.execute(
    "call-scope-run",
    { language: "cue-shell", path: "build.cue", scope: "abc123" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(calls[0]?.path, scriptPath);
  assert.equal(calls[0]?.input, "msg\n");
  assert.equal(calls[0]?.scope, "abc123");
  assert.equal((fileResult.details as { scope?: string }).scope, "abc123");

  await evalTool.execute(
    "call-scope-eval",
    { language: "cue-shell", script: "msg", scope: "def456" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(calls[1]?.path, "<inline>");
  assert.equal(calls[1]?.input, "msg");
  assert.equal(calls[1]?.scope, "def456");

  await assert.rejects(
    () =>
      runTool.execute(
        "call-bad-scope-run",
        { language: "python", path: "script.py", scope: "abc123" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
    /script_run scope is only supported for language=cue-shell/,
  );
  await assert.rejects(
    () =>
      evalTool.execute(
        "call-bad-scope-eval",
        { language: "python", script: "print('ok')", scope: "abc123" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
    /script_eval scope is only supported for language=cue-shell/,
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
