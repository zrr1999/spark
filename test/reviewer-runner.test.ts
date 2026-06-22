import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoleSpec,
  defaultProjectRoleModelSettingsStore,
  ROLE_RUN_DEPTH_ENV,
  RoleRegistry,
} from "@zendev-lab/pi-roles";
import { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  PiRolesReviewerRunner,
  buildReadOnlyReviewerSystemPrompt,
  parseReviewerVerdictForInput,
  renderReviewerInstruction,
  reviewerInputFingerprint,
  type GoalReviewInput,
  type TaskReviewInput,
} from "../packages/spark-extension/src/extension/reviewer-runner.ts";

function reviewTaskInput(): TaskReviewInput {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Review demo", description: "demo" });
  const task = graph.createTask({
    projectRef: project.ref,
    title: "Implement reviewer boundary",
    description: "Add reviewer runner types and adapter.",
  });
  return {
    targetKind: "task",
    cwd: process.cwd(),
    projectRef: project.ref,
    task,
    requestedStatus: "done",
    summary: "Implemented and tested.",
    evidenceRefs: [],
    sessionKey: "session:test",
  };
}

void test("reviewer verdict parser maps task approval verdicts", () => {
  const input = reviewTaskInput();
  const verdict = parseReviewerVerdictForInput(
    input,
    'prefix {"outcome":"approved","summary":"looks good","findings":["tested"],"blockers":[],"confidence":"high"} suffix',
  );

  assert.equal(verdict.targetKind, "task");
  assert.equal(verdict.taskRef, input.task.ref);
  assert.equal(verdict.approved, true);
  assert.equal(verdict.outcome, "approved");
  assert.equal(verdict.summary, "looks good");
  assert.deepEqual(verdict.findings, ["tested"]);
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.confidence, "high");
});

void test("reviewer verdict parser tolerates trailing JSON event wrappers", () => {
  const input = reviewTaskInput();
  const verdict = parseReviewerVerdictForInput(
    input,
    [
      '{"outcome":"approved","summary":"looks good {with brace text}","findings":[],"blockers":[],"confidence":"high"}',
      '{"type":"session","id":"trailing-event"}',
    ].join("\n"),
  );

  assert.equal(verdict.targetKind, "task");
  assert.equal(verdict.approved, true);
  assert.equal(verdict.summary, "looks good {with brace text}");
});

void test("reviewer verdict parser skips leading JSON protocol events", () => {
  const input = reviewTaskInput();
  const verdict = parseReviewerVerdictForInput(
    input,
    [
      '{"type":"session","id":"leading-event"}',
      '{"type":"message_start","message":{"role":"assistant"}}',
      '{"outcome":"approved","summary":"verdict after events","findings":[],"blockers":[],"confidence":"high"}',
    ].join("\n"),
  );

  assert.equal(verdict.targetKind, "task");
  assert.equal(verdict.approved, true);
  assert.equal(verdict.summary, "verdict after events");
});

void test("reviewer verdict parser extracts verdict from assistant message content", () => {
  const input = reviewTaskInput();
  const verdict = parseReviewerVerdictForInput(
    input,
    JSON.stringify({
      type: "message_start",
      message: {
        role: "assistant",
        content:
          '{"outcome":"approved","summary":"verdict in content","findings":[],"blockers":[],"confidence":"high"}',
      },
    }),
  );

  assert.equal(verdict.targetKind, "task");
  assert.equal(verdict.approved, true);
  assert.equal(verdict.summary, "verdict in content");
});

void test("reviewer verdict parser extracts verdict from agent_end messages", () => {
  const input = reviewTaskInput();
  const verdict = parseReviewerVerdictForInput(
    input,
    JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: '{"outcome":"approved","summary":"verdict in final message","findings":[],"blockers":[],"confidence":"high"}',
            },
          ],
        },
      ],
    }),
  );

  assert.equal(verdict.targetKind, "task");
  assert.equal(verdict.approved, true);
  assert.equal(verdict.summary, "verdict in final message");
});

void test("reviewer verdict parser maps goal remaining-work verdicts", () => {
  const verdict = parseReviewerVerdictForInput(
    {
      targetKind: "goal",
      cwd: process.cwd(),
      projectRef: "proj:demo",
      goalId: "goal-1",
      objective: "Finish the slice",
      status: "active",
      requestedStatus: "complete",
      evidenceRefs: [],
    },
    JSON.stringify({
      outcome: "needs_changes",
      summary: "not done",
      findings: ["task.finish gate missing"],
      blockers: ["reviewer not wired"],
      confidence: "medium",
      achieved: false,
      remainingWork: "wire task.finish reviewer gate",
    }),
  );

  assert.equal(verdict.targetKind, "goal");
  assert.equal(verdict.goalId, "goal-1");
  assert.equal(verdict.achieved, false);
  assert.equal(verdict.remainingWork, "wire task.finish reviewer gate");
  assert.equal(verdict.outcome, "needs_changes");
});

void test("reviewer verdict parser normalizes common outcome aliases", () => {
  const input = reviewTaskInput();
  const verdict = parseReviewerVerdictForInput(
    input,
    JSON.stringify({
      outcome: "changes-requested",
      summary: "needs edits",
      findings: [],
      blockers: ["missing evidence"],
      confidence: "high",
    }),
  );

  assert.equal(verdict.targetKind, "task");
  assert.equal(verdict.outcome, "needs_changes");
  assert.equal(verdict.approved, false);
  assert.throws(
    () =>
      parseReviewerVerdictForInput(
        input,
        JSON.stringify({
          outcome: "unclear",
          summary: "cannot decide",
          findings: [],
          blockers: [],
          confidence: "low",
        }),
      ),
    /got "unclear"/u,
  );
});

void test("reviewer instruction and system prompt enforce read-only verdict boundary", () => {
  const input = reviewTaskInput();
  const prompt = buildReadOnlyReviewerSystemPrompt("Base reviewer prompt.");
  const instruction = renderReviewerInstruction(input);

  assert.match(prompt, /Read-only verdict role/);
  assert.match(prompt, /Do not mutate tasks, goals, files, artifacts, recall, learning, asks/);
  assert.match(prompt, /Return verdict JSON only/);
  assert.match(prompt, /Never ask interactively/);
  assert.match(instruction, /Review packet:/);
  assert.match(instruction, /"requestedStatus": "done"/);
  const goalInstruction = renderReviewerInstruction({
    targetKind: "goal",
    cwd: process.cwd(),
    goalId: "goal-1",
    objective: "Pause when blocked",
    status: "active",
    requestedStatus: "paused",
    reason: "blocked by missing user decision",
    evidenceRefs: [],
  });
  assert.match(goalInstruction, /"requestedStatus": "paused"/);
  assert.match(goalInstruction, /"reason": "blocked by missing user decision"/);
  assert.doesNotMatch(instruction, /Return ONLY one valid JSON object/);
  assert.equal(reviewerInputFingerprint(input), reviewerInputFingerprint(input));
});

void test("goal reviewer instruction does not treat missing current project as completion", () => {
  const input: GoalReviewInput = {
    targetKind: "goal",
    cwd: process.cwd(),
    projectRef: "proj:completed-evidence",
    currentProjectSelected: false,
    projectEvidenceSource: "project_evidence_fallback",
    projectStatus: {
      ref: "proj:completed-evidence",
      title: "Completed evidence project",
      taskCounts: { total: 1, unfinished: 0, claimed: 0, statusCounts: { done: 1 } },
      readyTasks: [],
      unfinishedTasks: [],
    },
    goalId: "goal-1",
    objective: "Continue discovering and planning remaining crate surface work",
    status: "active",
    requestedStatus: "complete",
    evidenceRefs: ["artifact:completed-project-evidence"],
    evidencePreviews: [
      {
        ref: "artifact:completed-project-evidence",
        title: "Completed project evidence",
        kind: "record",
        format: "markdown",
        provenance: { producer: "task", projectRef: "proj:completed-evidence" },
        bodyPreview: "Concrete inspected evidence covers the crate surface planning outcome.",
      },
    ],
  };

  const instruction = renderReviewerInstruction(input);

  assert.match(instruction, /currentProjectSelected": false/);
  assert.match(instruction, /projectEvidenceSource": "project_evidence_fallback"/);
  assert.match(instruction, /evidencePreviews/);
  assert.match(instruction, /Concrete inspected evidence covers/);
  assert.match(
    instruction,
    /may complete without a current project only when evidenceRefs\/projectStatus directly cover the objective/,
  );
  assert.match(
    instruction,
    /never use "no current project", "project cleared", or "all historical tasks are done" as the completion rationale/,
  );
  assert.match(instruction, /task_write\(\{ action: "project_use", title, description \}\)/);
  assert.match(instruction, /task_write\(\{ action: "plan" \}\)/);
});

void test("reviewer verdict parser reports missing verdict objects clearly", () => {
  const input = reviewTaskInput();
  assert.throws(
    () =>
      parseReviewerVerdictForInput(
        input,
        [
          '{"type":"session","id":"leading-event"}',
          '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I need more evidence."}]}}',
        ].join("\n"),
      ),
    /did not contain a verdict JSON object with outcome/u,
  );
});

void test("PiRolesReviewerRunner resolves reviewer model from role model settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reviewer-runner-model-settings-"));
  try {
    const argsPath = join(dir, "args.json");
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdout.write(JSON.stringify({ outcome: 'approved', summary: 'approved by fake reviewer', findings: [], blockers: [], confidence: 'high' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);
    await defaultProjectRoleModelSettingsStore(dir).save("role:builtin-reviewer", "test/reviewer");

    const input = { ...reviewTaskInput(), cwd: dir };
    const runner = new PiRolesReviewerRunner({
      registry: new RoleRegistry(),
      cwd: dir,
      piCommand: fakePi,
      timeoutMs: 5_000,
    });

    const result = await runner.review(input);

    assert.equal(result.verdict.outcome, "approved");
    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.ok(args.includes("--no-session"));
    assert.ok(args.includes("--model"));
    assert.equal(args[args.indexOf("--model") + 1], "test/reviewer");
    assert.ok(args.includes("--tools"));
    const tools = args[args.indexOf("--tools") + 1]?.split(",") ?? [];
    assert.ok(tools.includes("read"));
    assert.ok(tools.includes("web_search"));
    assert.equal(tools.includes("cue_exec"), false);
    assert.equal(tools.includes("script_eval"), false);
    assert.equal(tools.includes("learning"), false);
    assert.equal(tools.includes("artifact"), false);
    assert.equal(tools.includes("task"), false);
    assert.equal(tools.includes("task_write"), false);
    assert.equal(tools.includes("goal"), false);
    assert.equal(tools.includes("assign"), false);
    assert.equal(tools.includes("role"), false);
    assert.equal(tools.includes("workflow"), false);
    assert.equal(tools.includes("graft_patch"), false);
    assert.equal(tools.includes("ask"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("PiRolesReviewerRunner strips reviewer role orchestration and interaction tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reviewer-runner-tool-gate-"));
  try {
    const argsPath = join(dir, "args.json");
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdout.write(JSON.stringify({ outcome: 'approved', summary: 'approved by gated reviewer', findings: [], blockers: [], confidence: 'high' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const projectReviewer = createRoleSpec({
      id: "project-reviewer",
      source: "project",
      description: "Project reviewer with an overbroad declared tool set.",
      systemPrompt: "Review only.",
      rationale: "Verify reviewer gate filtering.",
      expectedUses: ["review"],
      allowedTools: [
        "read",
        "web_search",
        "cue_exec",
        "cue_run",
        "cue_script",
        "script_run",
        "script_eval",
        "cue_jobs",
        "task_read",
        "ask",
        "ask_user",
        "ask_flow",
        "task",
        "task_write",
        "goal",
        "assign",
        "role",
        "workflow",
        "graft_patch",
        "patch",
      ],
    });
    const registry = new RoleRegistry();
    registry.add(projectReviewer);

    const runner = new PiRolesReviewerRunner({
      registry,
      cwd: dir,
      piCommand: fakePi,
      reviewerRoleRef: projectReviewer.ref,
      timeoutMs: 5_000,
    });

    const result = await runner.review({ ...reviewTaskInput(), cwd: dir });

    assert.equal(result.verdict.outcome, "approved");
    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.ok(args.includes("--no-session"));
    const tools = args[args.indexOf("--tools") + 1]?.split(",") ?? [];
    assert.deepEqual(tools, ["read", "web_search", "task_read"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("PiRolesReviewerRunner auto-answer decrements role depth for reviewer child runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reviewer-ask-depth-"));
  const previousDepth = process.env[ROLE_RUN_DEPTH_ENV];
  try {
    const depthPath = join(dir, "depth.txt");
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(depthPath)}, process.env.${ROLE_RUN_DEPTH_ENV} ?? 'missing');`,
        "process.stdout.write(JSON.stringify({ answers: { mode: { values: ['safe_mode'] } }, blocked: false, reason: 'depth checked' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env[ROLE_RUN_DEPTH_ENV] = "2";

    const runner = new PiRolesReviewerRunner({
      registry: new RoleRegistry(),
      cwd: dir,
      piCommand: fakePi,
      timeoutMs: 5_000,
    });

    const result = await runner.answerAsk({
      cwd: dir,
      request: {
        title: "Choose mode",
        questions: [
          { id: "mode", type: "single", options: [{ label: "Safe", value: "safe_mode" }] },
        ],
      },
    });

    assert.equal(result.blocked, undefined);
    assert.equal(result.answers?.mode?.values?.[0], "safe_mode");
    assert.equal(await readFile(depthPath, "utf8"), "1");
  } finally {
    if (previousDepth === undefined) delete process.env[ROLE_RUN_DEPTH_ENV];
    else process.env[ROLE_RUN_DEPTH_ENV] = previousDepth;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("PiRolesReviewerRunner auto-answer reports exhausted role depth before spawning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reviewer-ask-depth-exhausted-"));
  const previousDepth = process.env[ROLE_RUN_DEPTH_ENV];
  try {
    const spawnedPath = join(dir, "spawned.txt");
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(spawnedPath)}, 'spawned');`,
        "process.stdout.write(JSON.stringify({ answers: {}, blocked: false, reason: 'should not spawn' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);
    process.env[ROLE_RUN_DEPTH_ENV] = "0";

    const runner = new PiRolesReviewerRunner({
      registry: new RoleRegistry(),
      cwd: dir,
      piCommand: fakePi,
      timeoutMs: 5_000,
    });

    const result = await runner.answerAsk({
      cwd: dir,
      request: { title: "Choose mode", questions: [{ id: "mode", type: "single" }] },
    });

    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /PI_ROLE_DEPTH exhausted/);
    await assert.rejects(readFile(spawnedPath, "utf8"), /ENOENT/);
  } finally {
    if (previousDepth === undefined) delete process.env[ROLE_RUN_DEPTH_ENV];
    else process.env[ROLE_RUN_DEPTH_ENV] = previousDepth;
    await rm(dir, { recursive: true, force: true });
  }
});

void test("PiRolesReviewerRunner runs reviewer gates in fresh mode even with parent session context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reviewer-runner-"));
  try {
    const argsPath = join(dir, "args.json");
    const fakePi = join(dir, "fake-pi.cjs");
    await writeFile(
      fakePi,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdout.write(JSON.stringify({ outcome: 'approved', summary: 'approved by fake reviewer', findings: [], blockers: [], confidence: 'high' }) + '\\n');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePi, 0o755);

    const input = { ...reviewTaskInput(), cwd: dir, forkFromSession: "session:parent" };
    const runner = new PiRolesReviewerRunner({
      registry: new RoleRegistry(),
      cwd: dir,
      piCommand: fakePi,
      timeoutMs: 5_000,
    });

    const result = await runner.review(input);

    assert.equal(result.verdict.targetKind, "task");
    assert.equal(result.verdict.outcome, "approved");
    assert.equal(result.verdict.approved, true);
    assert.equal(result.verdict.summary, "approved by fake reviewer");
    assert.equal(result.record.roleRef, "role:builtin-reviewer");
    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.equal(args.includes("--fork"), false);
    assert.ok(args.includes("--no-session"));
    assert.ok(args.includes("--tools"));
    const tools = args[args.indexOf("--tools") + 1]?.split(",") ?? [];
    assert.ok(tools.includes("read"));
    assert.ok(tools.includes("web_search"));
    assert.equal(tools.includes("cue_exec"), false);
    assert.equal(tools.includes("script_eval"), false);
    assert.equal(tools.includes("learning"), false);
    assert.equal(tools.includes("artifact"), false);
    assert.equal(tools.includes("task"), false);
    assert.equal(tools.includes("task_write"), false);
    assert.equal(tools.includes("goal"), false);
    assert.equal(tools.includes("assign"), false);
    assert.equal(tools.includes("role"), false);
    assert.equal(tools.includes("workflow"), false);
    assert.equal(tools.includes("graft_patch"), false);
    assert.equal(tools.includes("ask"), false);
    assert.match(args.join("\n"), /Read-only verdict role/);
    assert.match(args.join("\n"), /Never ask interactively/);
    assert.match(args.join("\n"), /Return ONLY one valid JSON object/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
