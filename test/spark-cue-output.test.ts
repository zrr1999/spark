import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CueError,
  defaultSocketPath,
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
} from "../packages/spark-cue/src/index.ts";

type RegisteredPiCueTool = Parameters<PiCueExtensionApi["registerTool"]>[0];

void test("defaultSocketPath treats an empty XDG_RUNTIME_DIR as unset", () => {
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = "";
  try {
    assert.equal(defaultSocketPath(), join(tmpdir(), "cue-shell", "cued.sock"));
  } finally {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
  }
});

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

void test("renderCueChainStatus reads each leaf output once and propagates failures", async () => {
  const outputRequests: Array<{ id: string; tailBytes?: number }> = [];
  const reader = {
    async jobOutput(id: string, tailBytes?: number) {
      outputRequests.push({ id, tailBytes });
      return {
        stdout: id === "J3" ? "done output\n" : id === "J4" ? "failed output\n" : "",
        stderr: id === "J4" ? "failed stderr\n" : "",
        stdoutEncoding: "utf8" as const,
        stderrEncoding: "utf8" as const,
        truncated: false,
        stderrTruncated: false,
      };
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
  await assert.rejects(
    renderCueChainStatus(
      {
        async jobOutput() {
          throw new CueError("INTERNAL", "output store unavailable");
        },
      },
      "CH1",
      jobs,
      2048,
    ),
    (error) => error instanceof CueError && error.code === "INTERNAL",
  );
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

void test("spark-cue numeric and boolean normalizers reject invalid explicit values", () => {
  assert.equal(normalizeCueTailBytes(undefined, 128), 128);
  assert.equal(normalizeCueTailBytes(4096), 4096);
  assert.throws(() => normalizeCueTailBytes("4096"), /tail_bytes must be a finite number/);
  assert.throws(() => normalizeCueTailBytes(0), /tail_bytes must be a positive integer/);
  assert.throws(() => normalizeCueTailBytes(1.5), /tail_bytes must be a positive integer/);
  assert.throws(() => normalizeCueTailBytes(-1), /tail_bytes must be a positive integer/);

  assert.equal(normalizeCueLimit(null, 10), 10);
  assert.equal(normalizeCueLimit(5), 5);
  assert.throws(() => normalizeCueLimit(Number.NaN), /limit must be a finite number/);
  assert.throws(() => normalizeCueLimit(0), /limit must be a positive integer/);
  assert.throws(() => normalizeCueLimit(2.25), /limit must be a positive integer/);

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

void test("spark-cue tools validate bad parameters before connecting to cued", async () => {
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
    /cue_exec tail is not supported; use tail_bytes/,
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
    /cue_scope env_tail_bytes is not supported; use tail_bytes/,
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
        { cwd: "/tmp/spark-cue-test" },
      ),
    /cue_run path must end in \.cue \(got \/tmp\/spark-cue-test\/notes\.txt\)/,
  );

  await assert.rejects(
    () =>
      runTool.execute(
        "call-5",
        { path: "missing.cue" },
        new AbortController().signal,
        () => undefined,
        { cwd: "/tmp/spark-cue-test" },
      ),
    /cue_run failed to read \/tmp\/spark-cue-test\/missing\.cue:/,
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

void test("cue_resources explains empty provider state", async () => {
  const tools = registerCueToolsForTest();
  const resourceTool = tools.get("cue_resources");
  assert.ok(resourceTool);
  const result = await resourceTool.execute(
    "call-resources",
    { action: "providers" },
    new AbortController().signal,
    () => undefined,
    {
      cwd: "/work",
      cueClient: {
        isClosed: false,
        async evalText(command: string) {
          assert.equal(command, ":providers");
          return "No resource providers registered.\n";
        },
      },
    } as unknown as PiCueToolContext,
  );

  assert.match(result.content[0].text, /No resource providers registered/);
  assert.match(result.content[0].text, /Hint: no cue-shell resource provider/);
  assert.match(result.content[0].text, /remove needs=\{\.\.\.\}/);
  assert.match(result.content[0].text, /gpu\/gpu_mem/);
  assert.match(String((result.details as { hint?: unknown }).hint), /resource provider/);
});

void test("script_eval renders a bounded inline code preview", () => {
  const tools = registerCueToolsForTest();
  const evalTool = tools.get("script_eval");
  assert.ok(evalTool);
  const rendered = evalTool
    .renderCall?.(
      {
        language: "python",
        script:
          "\nprint('first')\nprint('second')\nprint('third')\nprint('fourth')\nprint('fifth')\nprint('sixth')\n",
      },
      { bold: (text: string) => text },
      {},
    )
    .render(400)
    .join("\n");
  assert.match(rendered ?? "", /inline=6line\(s\)/);
  assert.match(rendered ?? "", /preview=/);
  assert.match(rendered ?? "", /print\('first'\).*print\('fifth'/);
  assert.doesNotMatch(rendered ?? "", /print\('sixth'\)/);
});

void test("script_run executes python through uv run and script_eval uses uv run --script", async () => {
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
  const ctx = {
    cwd: "/work",
    cueClient: fakeClient,
    env: { PATH: "/usr/bin" },
  } as unknown as PiCueToolContext;

  const defaultEval = await evalTool.execute(
    "call-default-python",
    {
      language: "python",
      script: "print('modern')",
    },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(commands[0], `printf %s "print('modern')" |> uv run --script -`);
  assert.deepEqual((defaultEval.details as { pythonRunner?: unknown }).pythonRunner, {
    executable: "uv",
    source: "uv",
    argv: ["uv", "run", "--script"],
    note: "Python scripts are executed through `uv run --script <path>` or `uv run --script -`; inline scripts are piped through stdin.",
  });
  assert.equal(
    (defaultEval.details as { temporaryScriptPath?: string }).temporaryScriptPath,
    undefined,
  );
  assert.equal((defaultEval.details as { resolvedScriptPath?: string }).resolvedScriptPath, "-");

  const fileResult = await runTool.execute(
    "call-venv-run",
    { language: "python", path: "tools/check.py", venv: ".venv" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(commands[1], "uv run --python /work/.venv/bin/python --script /work/tools/check.py");
  assert.equal((fileResult.details as { venv?: string }).venv, "/work/.venv");

  const evalResult = await evalTool.execute(
    "call-venv-eval",
    {
      language: "python",
      script: "print('ok')",
      venv: "/opt/venv",
    },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(
    commands[2],
    "printf %s \"print('ok')\" |> uv run --python /opt/venv/bin/python --script -",
  );
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

void test("spark-cue tool descriptions match cue-shell chain operator contract", () => {
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
  assert.match(execDescription, /&&\/\|\| are job-internal logical operators|'&&'\/\|\|'/);
  assert.doesNotMatch(execDescription, /\|\| runs in parallel|\|\| parallel|\|\|\?\s+parallel/);

  assert.match(runTool.description, /`\|\|\|`/);
  assert.match(runTool.description, /`\|\?\|`/);
  assert.match(scriptTool.description, /`\|\|\|`/);
  assert.match(scriptTool.description, /`\|\?\|`/);
});

void test("cue_jobs exposes chain IDs for status and wait", async () => {
  const jobsTool = registerCueToolsForTest().get("cue_jobs");
  assert.ok(jobsTool);

  const contract = `${jobsTool.description} ${JSON.stringify(jobsTool.parameters)}`;
  assert.match(contract, /action='status' inspects a job, chain, or cron/);
  assert.match(contract, /action='wait' waits for a job or chain/);
  assert.match(contract, /chain CH<n> for status\/wait/);

  const jobs = [
    {
      id: "J1",
      status: "Done" as const,
      pipeline: "true",
      exit_code: 0,
      open_hint: "stream" as const,
      chain_id: "CH1",
      chain_index: 0,
      chain_total: 2,
    },
    {
      id: "J2",
      status: "Done" as const,
      pipeline: "true",
      exit_code: 0,
      open_hint: "stream" as const,
      chain_id: "CH1",
      chain_index: 1,
      chain_total: 2,
    },
  ];
  const ctx = {
    cueClient: {
      isClosed: false,
      async listJobs() {
        return jobs;
      },
      async jobOutput() {
        return { stdout: "", stderr: "", truncated: false, stderrTruncated: false };
      },
    },
  } as unknown as PiCueToolContext;

  for (const action of ["status", "wait"] as const) {
    const result = await jobsTool.execute(
      `call-chain-${action}`,
      { action, id: "CH1", timeout: 1 },
      new AbortController().signal,
      () => undefined,
      ctx,
    );
    assert.match(result.content[0]?.text ?? "", /done — chain CH1/);
    assert.equal((result.details as { chainId?: string }).chainId, "CH1");
  }
});

void test("cue_schedule filters the cron statuses emitted by cue-shell", async () => {
  const scheduleTool = registerCueToolsForTest().get("cue_schedule");
  assert.ok(scheduleTool);

  const description = `${scheduleTool.description} ${JSON.stringify(scheduleTool.parameters)}`;
  assert.match(description, /scheduled, paused, completed, expired, failed, all/);
  assert.doesNotMatch(description, /scheduled, paused, completed, expired, active/);

  const ctx = {
    cueClient: {
      isClosed: false,
      async listCrons() {
        return [
          { id: "C1", schedule: "in 1h", command: "true", status: "scheduled" as const },
          { id: "C2", schedule: "in 1m", command: "false", status: "failed" as const },
        ];
      },
    },
  } as unknown as PiCueToolContext;

  const failed = await scheduleTool.execute(
    "call-list-failed",
    { action: "list", status: "failed" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.match(failed.content[0]?.text ?? "", /C2  \[failed\]/);
  assert.doesNotMatch(failed.content[0]?.text ?? "", /C1/);

  await assert.rejects(
    () =>
      scheduleTool.execute(
        "call-list-active",
        { action: "list", status: "active" },
        new AbortController().signal,
        () => undefined,
        ctx,
      ),
    /cue_schedule status must be all, scheduled, paused, completed, expired, or failed/,
  );
});

void test("spark-cue docs document script runner venv and uv script behavior", async () => {
  const skill = await readFile("packages/spark-cue/skills/spark-cue/SKILL.md", "utf8");
  const readme = await readFile("packages/spark-cue/README.md", "utf8");
  const toolsDoc = await readFile("docs/specs/tools.md", "utf8");

  assert.match(skill, /`script_run`\s+\|[^\n]+`venv\?`/);
  assert.match(skill, /`script_eval`\s+\|[^\n]+`venv\?`/);
  assert.doesNotMatch(skill, /`script_run`\s+\|[^\n]+`scope\?`/);
  assert.doesNotMatch(skill, /`script_eval`\s+\|[^\n]+`scope\?`/);
  assert.match(skill, /Python script files execute through `uv run --script <path>`/);
  assert.match(skill, /inline Python is piped to `uv run --script -`/);
  assert.match(skill, /`venv` is valid only with `language="python"`/);
  assert.match(skill, /`&&` is valid cue-shell job logic/);
  assert.doesNotMatch(skill, /`&&` is bash; use `->`/);

  assert.match(readme, /uv run --python <venv>\/bin\/python --script <path>/);
  assert.match(readme, /uv run --python <venv>\/bin\/python --script -/);
  assert.match(readme, /Tool-call rendering shows a fixed, bounded preview/);
  assert.doesNotMatch(readme, /`scope` is valid only for `language: "cue-shell"`/);

  assert.match(toolsDoc, /`spark-cue` tools \([^\n]+`cue_resources`[^\n]+\)/);
  assert.match(toolsDoc, /`cue_resources` — inspect resource providers and snapshots/);
  assert.match(toolsDoc, /uv run --script -/);
  assert.match(toolsDoc, /`venv` is python-only/);
  assert.match(toolsDoc, /`scope` is not a `script_run`\/`script_eval` parameter/);
  assert.match(toolsDoc, /`RunScript \{ path, input \}`/);
  assert.doesNotMatch(toolsDoc, /scope` is cue-shell-only/);
  assert.doesNotMatch(toolsDoc, /temporary `\.py` file/);
});

void test("script_run and script_eval do not pass removed scope to RunScript", async () => {
  const tools = registerCueToolsForTest();
  const runTool = tools.get("script_run");
  const evalTool = tools.get("script_eval");
  assert.ok(runTool);
  assert.ok(evalTool);
  const dir = await mkdtemp(join(tmpdir(), "spark-cue-script-scope-"));
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
  assert.equal(calls[0]?.scope, undefined);
  assert.equal((fileResult.details as { scope?: string }).scope, undefined);

  await evalTool.execute(
    "call-scope-eval",
    { language: "cue-shell", script: "msg", scope: "def456" },
    new AbortController().signal,
    () => undefined,
    ctx,
  );
  assert.equal(calls[1]?.path, "<inline>");
  assert.equal(calls[1]?.input, "msg");
  assert.equal(calls[1]?.scope, undefined);
});

function registerCueToolsForTest(): Map<string, RegisteredPiCueTool> {
  const tools = new Map<string, RegisteredPiCueTool>();
  registerPiCueTools({
    registerTool: (config) => tools.set(config.name, config),
    on: () => undefined,
    getActiveTools: () => [...tools.keys()],
    setActiveTools: () => undefined,
  });
  return tools;
}
