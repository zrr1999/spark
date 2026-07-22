import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  createRoleSpec,
  defaultProjectRoleModelSettingsStore,
  ROLE_RUN_DEPTH_ENV,
  RoleRegistry,
} from "@zendev-lab/spark-roles";
import { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  SparkRolesReviewerRunner,
  buildReadOnlyReviewerSystemPrompt,
  capReviewerThinkingLevel,
  parseAskAutoAnswerResult,
  parseReviewerVerdictForInput,
  renderReviewerInstruction,
  reviewerInputFingerprint,
  type GoalReviewInput,
  type TaskReviewInput,
} from "../packages/spark-roles/src/reviewer-runner.ts";

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

test("ask auto-answer parser skips leading protocol wrappers", () => {
  const result = parseAskAutoAnswerResult(
    [
      '{"type":"session","id":"leading-event"}',
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                answers: { mode: { values: ["safe_mode"], notes: "clear" } },
                blocked: false,
                reason: "selected safe mode",
              }),
            },
          ],
        },
      }),
    ].join("\n"),
  );

  assert.equal(result.blocked, undefined);
  assert.equal(result.reason, "selected safe mode");
  assert.deepEqual(result.answers?.mode?.values, ["safe_mode"]);
  assert.equal(result.answers?.mode?.notes, "clear");
});

test("reviewer verdict parser maps task approval verdicts", () => {
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

test("reviewer instruction and verdict parser support tool_approval subject", () => {
  const input = {
    targetKind: "tool_approval" as const,
    cwd: process.cwd(),
    toolName: "cue_exec",
    toolCallId: "tc-1",
    arguments: { command: "echo hi" },
    reason: "requires approval",
  };
  const instruction = renderReviewerInstruction(input);
  assert.match(instruction, /tool-call approval/);
  assert.match(instruction, /cue_exec/);
  assert.match(instruction, /echo hi/);

  const verdict = parseReviewerVerdictForInput(
    input,
    '{"outcome":"blocked","summary":"risky","findings":[],"blockers":["rm -rf"],"confidence":"high"}',
  );
  assert.equal(verdict.targetKind, "tool_approval");
  assert.equal(verdict.toolName, "cue_exec");
  assert.equal(verdict.approved, false);
  assert.equal(verdict.outcome, "blocked");
  assert.equal(verdict.summary, "risky");
});

test("reviewer verdict parser tolerates trailing JSON event wrappers", () => {
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

test("reviewer verdict parser skips leading JSON protocol events", () => {
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

test("reviewer verdict parser extracts verdict from assistant message content", () => {
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

test("reviewer verdict parser extracts verdict from agent_end messages", () => {
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

test("reviewer verdict parser maps goal remaining-work verdicts", () => {
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
      evidence_valid: true,
      objective_satisfied: false,
      remainingWork: "wire task.finish reviewer gate",
    }),
  );

  assert.equal(verdict.targetKind, "goal");
  assert.equal(verdict.goalId, "goal-1");
  assert.equal(verdict.achieved, false);
  assert.equal(verdict.remainingWork, "wire task.finish reviewer gate");
  assert.equal(verdict.outcome, "needs_changes");
  assert.equal(verdict.evidenceValid, true);
  assert.equal(verdict.objectiveSatisfied, false);
});

test("goal reviewer approval requires explicit evidence and objective semantic gates", () => {
  const input: GoalReviewInput = {
    targetKind: "goal",
    cwd: process.cwd(),
    projectRef: "proj:demo",
    goalId: "goal-1",
    originalObjective: "Use the new compiler to compile Spore source code.",
    objective: "Finish bootstrap fixed point evidence",
    status: "active",
    requestedStatus: "complete",
    evidenceRefs: ["evidence:compiler-proof"],
  };

  const missing = parseReviewerVerdictForInput(
    input,
    JSON.stringify({
      outcome: "approved",
      summary: "approved but underspecified",
      findings: [],
      blockers: [],
      confidence: "high",
      achieved: true,
      remainingWork: "",
    }),
  );

  assert.equal(missing.targetKind, "goal");
  assert.equal(missing.outcome, "needs_changes");
  assert.equal(missing.achieved, false);
  assert.match(missing.blockers.join("\n"), /evidence_valid=true and objective_satisfied=true/);

  const approved = parseReviewerVerdictForInput(
    input,
    JSON.stringify({
      outcome: "approved",
      summary: "evidence and semantics both satisfy the original goal",
      findings: [],
      blockers: [],
      confidence: "high",
      achieved: true,
      evidence_valid: true,
      objective_satisfied: true,
      remainingWork: "",
    }),
  );

  assert.equal(approved.targetKind, "goal");
  assert.equal(approved.outcome, "approved");
  assert.equal(approved.achieved, true);
  assert.equal(approved.evidenceValid, true);
  assert.equal(approved.objectiveSatisfied, true);
});

test("goal reviewer rejects an approved verdict when any requirement is missing", () => {
  const input: GoalReviewInput = {
    targetKind: "goal",
    cwd: process.cwd(),
    goalId: "goal-requirements",
    objective: "Ship the complete feature",
    status: "active",
    requestedStatus: "complete",
    evidenceRefs: ["evidence:implemented"],
    requirements: [
      {
        id: "implemented",
        description: "Feature is implemented",
        status: "verified",
        evidenceRefs: ["evidence:implemented"],
      },
      {
        id: "validated",
        description: "Feature passes acceptance validation",
        status: "missing",
        evidenceRefs: [],
      },
    ],
    unresolved: [],
  };
  const verdict = parseReviewerVerdictForInput(
    input,
    JSON.stringify({
      outcome: "approved",
      summary: "incorrect approval",
      findings: [],
      blockers: [],
      confidence: "high",
      achieved: true,
      evidence_valid: true,
      objective_satisfied: true,
      remainingWork: "",
    }),
  );

  assert.equal(verdict.targetKind, "goal");
  assert.equal(verdict.outcome, "needs_changes");
  assert.equal(verdict.achieved, false);
  assert.match(verdict.blockers.join("\n"), /requirement validated is missing/);
});

test("goal reviewer rejects unresolved work and verified requirements without evidence", () => {
  const base: GoalReviewInput = {
    targetKind: "goal",
    cwd: process.cwd(),
    goalId: "goal-unresolved",
    objective: "Ship the complete feature",
    status: "active",
    requestedStatus: "complete",
    evidenceRefs: ["evidence:global-only"],
    requirements: [
      {
        id: "acceptance",
        description: "Acceptance behavior is verified",
        status: "verified",
        evidenceRefs: [],
      },
    ],
    unresolved: ["verify the rollback path"],
  };
  const verdictJson = JSON.stringify({
    outcome: "approved",
    summary: "incorrect approval",
    findings: [],
    blockers: [],
    confidence: "high",
    achieved: true,
    evidence_valid: true,
    objective_satisfied: true,
    remainingWork: "",
  });
  const verdict = parseReviewerVerdictForInput(base, verdictJson);

  assert.equal(verdict.targetKind, "goal");
  assert.equal(verdict.outcome, "needs_changes");
  assert.equal(verdict.achieved, false);
  assert.match(verdict.blockers.join("\n"), /verified requirement acceptance has no mapped/);
  assert.match(verdict.blockers.join("\n"), /unresolved: verify the rollback path/);
});

test("goal reviewer approves only an evidence-mapped fully resolved protocol", () => {
  const input: GoalReviewInput = {
    targetKind: "goal",
    cwd: process.cwd(),
    goalId: "goal-resolved",
    objective: "Ship the complete feature",
    status: "active",
    requestedStatus: "complete",
    evidenceRefs: ["evidence:implementation", "evidence:acceptance"],
    requirements: [
      {
        id: "implemented",
        description: "Feature is implemented",
        status: "verified",
        evidenceRefs: ["evidence:implementation"],
      },
      {
        id: "validated",
        description: "Acceptance behavior passes",
        status: "verified",
        evidenceRefs: ["evidence:acceptance"],
      },
    ],
    validationRuns: ["pnpm test: passed"],
    unresolved: [],
  };
  const verdict = parseReviewerVerdictForInput(
    input,
    JSON.stringify({
      outcome: "approved",
      summary: "all requirements are evidenced",
      findings: [],
      blockers: [],
      confidence: "high",
      achieved: true,
      evidence_valid: true,
      objective_satisfied: true,
      remainingWork: "",
    }),
  );

  assert.equal(verdict.targetKind, "goal");
  assert.equal(verdict.outcome, "approved");
  assert.equal(verdict.achieved, true);
});

test("reviewer verdict parser normalizes common outcome aliases", () => {
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

test("reviewer instruction and system prompt enforce read-only verdict boundary", () => {
  const input = reviewTaskInput();
  const prompt = buildReadOnlyReviewerSystemPrompt("Base reviewer prompt.");
  const instruction = renderReviewerInstruction(input);

  assert.notEqual(prompt, "Base reviewer prompt.");
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
  assert.equal(reviewerInputFingerprint(input), reviewerInputFingerprint(input));
});

test("task reviewer instruction scopes task finish independently from sibling project work", () => {
  const instruction = renderReviewerInstruction(reviewTaskInput());

  assert.match(instruction, /For targetKind=task, review only the selected task's requestedStatus/);
  assert.match(instruction, /Do not reject a task finish merely because sibling/);
  assert.match(instruction, /dependency chains require scoped leaf tasks to close/);
  assert.doesNotMatch(instruction, /projectStatus\.taskCounts\.unfinished > 0/);
  assert.doesNotMatch(
    instruction,
    /For requestedStatus=complete, approve only when the objective is achieved/,
  );
});

test("goal reviewer instruction still gates completion on unfinished project work", () => {
  const instruction = renderReviewerInstruction({
    targetKind: "goal",
    cwd: process.cwd(),
    projectRef: "proj:active",
    currentProjectSelected: true,
    projectEvidenceSource: "current_project",
    projectStatus: {
      ref: "proj:active",
      title: "Active project",
      taskCounts: { total: 2, unfinished: 1, claimed: 0, statusCounts: { done: 1, pending: 1 } },
      readyTasks: [
        { ref: "task:remaining", title: "Remaining", status: "pending", kind: "implement" },
      ],
      unfinishedTasks: [
        { ref: "task:remaining", title: "Remaining", status: "pending", kind: "implement" },
      ],
    },
    goalId: "goal-1",
    objective: "Finish implementation",
    status: "active",
    requestedStatus: "complete",
    evidenceRefs: [],
  });

  assert.match(instruction, /semantic satisfaction of the immutable original user goal/);
  assert.match(instruction, /evidence_valid=true/);
  assert.match(instruction, /objective_satisfied=true/);
  assert.match(instruction, /core execution path proof/);
  assert.match(instruction, /If projectStatus\.taskCounts\.unfinished > 0/);
  assert.match(instruction, /When unfinished project work remains/);
  assert.match(instruction, /"requestedStatus": "complete"/);
  assert.match(instruction, /"requirements": \[/);
  assert.match(instruction, /"id": "goal:objective"/);
  assert.match(instruction, /"validationRuns": \[\]/);
  assert.match(instruction, /"unresolved": \[\]/);
});

test("goal reviewer instruction does not treat missing current project as completion", () => {
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
    evidenceRefs: ["evidence:completed-project-evidence"],
    evidencePreviews: [
      {
        ref: "evidence:completed-project-evidence",
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
});

test("reviewer verdict parser reports missing verdict objects clearly", () => {
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

test("reviewer thinking cap defaults to medium without raising lower host settings", () => {
  assert.equal(capReviewerThinkingLevel(undefined), "medium");
  assert.equal(capReviewerThinkingLevel("off"), "off");
  assert.equal(capReviewerThinkingLevel("minimal"), "minimal");
  assert.equal(capReviewerThinkingLevel("low"), "low");
  assert.equal(capReviewerThinkingLevel("medium"), "medium");
  assert.equal(capReviewerThinkingLevel("high"), "medium");
  assert.equal(capReviewerThinkingLevel("xhigh"), "medium");
});

function approvedReviewerNativeExecutor(
  capture?: (
    request: Parameters<
      NonNullable<ConstructorParameters<typeof SparkRolesReviewerRunner>[0]["nativeExecutor"]>
    >[0],
  ) => void,
): NonNullable<ConstructorParameters<typeof SparkRolesReviewerRunner>[0]["nativeExecutor"]> {
  return async (request) => {
    capture?.(request);
    return {
      record: { ...request.record, status: "succeeded", finishedAt: "2026-01-01T00:00:00.000Z" },
      stdout: JSON.stringify({
        outcome: "approved",
        summary: "approved by fake reviewer",
        findings: [],
        blockers: [],
        confidence: "high",
        evidence_valid: true,
        objective_satisfied: true,
      }),
      stderr: "",
      jsonEvents: [],
    };
  };
}

function askAnswerNativeExecutor(
  capture?: (
    request: Parameters<
      NonNullable<ConstructorParameters<typeof SparkRolesReviewerRunner>[0]["nativeExecutor"]>
    >[0],
  ) => void,
): NonNullable<ConstructorParameters<typeof SparkRolesReviewerRunner>[0]["nativeExecutor"]> {
  return async (request) => {
    capture?.(request);
    return {
      record: { ...request.record, status: "succeeded", finishedAt: "2026-01-01T00:00:00.000Z" },
      stdout: JSON.stringify({
        answers: { mode: { values: ["safe_mode"] } },
        blocked: false,
        reason: "depth checked",
      }),
      stderr: "",
      jsonEvents: [],
    };
  };
}

const reviewerRunnerTestEnv = { ...process.env, [ROLE_RUN_DEPTH_ENV]: "4" };

test("SparkRolesReviewerRunner resolves reviewer model from role model settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reviewer-runner-model-settings-"));
  try {
    await defaultProjectRoleModelSettingsStore(dir).save("role:builtin-reviewer", "test/reviewer");
    let captured:
      | Awaited<
          Parameters<
            NonNullable<ConstructorParameters<typeof SparkRolesReviewerRunner>[0]["nativeExecutor"]>
          >[0]
        >
      | undefined;

    const input = { ...reviewTaskInput(), cwd: dir };
    const runner = new SparkRolesReviewerRunner({
      registry: new RoleRegistry(),
      cwd: dir,
      timeoutMs: 15_000,
      env: reviewerRunnerTestEnv,
      nativeExecutor: approvedReviewerNativeExecutor((request) => {
        captured = request;
      }),
    });

    const result = await runner.review(input);

    assert.equal(result.verdict.outcome, "approved");
    assert.equal(captured?.model, "test/reviewer");
    assert.equal(captured?.launch, "fresh");
    assert.equal(captured?.record.launch, "fresh");
    assert.equal(captured?.record.model, "test/reviewer");
    assert.equal(result.record.thinking, "medium");
    const tools = captured?.role.allowedTools ?? [];
    assert.ok(tools.includes("read"));
    assert.ok(tools.includes("grep"));
    assert.ok(tools.includes("find"));
    assert.equal(tools.includes("web_search"), false);
    assert.equal(tools.includes("fetch_content"), false);
    assert.equal(tools.includes("get_search_content"), false);
    assert.equal(tools.includes("cue_exec"), false);
    assert.equal(tools.includes("script_eval"), false);
    assert.equal(tools.includes("learning"), false);
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

test("SparkRolesReviewerRunner strips reviewer role orchestration and interaction tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reviewer-runner-tool-gate-"));
  try {
    let captured:
      | Parameters<
          NonNullable<ConstructorParameters<typeof SparkRolesReviewerRunner>[0]["nativeExecutor"]>
        >[0]
      | undefined;

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

    const runner = new SparkRolesReviewerRunner({
      registry,
      cwd: dir,
      reviewerRoleRef: projectReviewer.ref,
      timeoutMs: 15_000,
      env: reviewerRunnerTestEnv,
      nativeExecutor: approvedReviewerNativeExecutor((request) => {
        captured = request;
      }),
    });

    const result = await runner.review({ ...reviewTaskInput(), cwd: dir });

    assert.equal(result.verdict.outcome, "approved");
    assert.equal(captured?.launch, "fresh");
    assert.deepEqual(captured?.role.allowedTools, ["read", "task_read"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkRolesReviewerRunner auto-answer decrements role depth for reviewer child runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reviewer-ask-depth-"));
  const previousDepth = process.env[ROLE_RUN_DEPTH_ENV];
  try {
    let capturedDepth: string | undefined;
    process.env[ROLE_RUN_DEPTH_ENV] = "2";

    const runner = new SparkRolesReviewerRunner({
      registry: new RoleRegistry(),
      cwd: dir,
      timeoutMs: 15_000,
      env: { ...process.env, [ROLE_RUN_DEPTH_ENV]: "2" },
      nativeExecutor: askAnswerNativeExecutor((request) => {
        capturedDepth = request.env?.[ROLE_RUN_DEPTH_ENV];
      }),
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
    assert.equal(capturedDepth, "1");
  } finally {
    if (previousDepth === undefined) delete process.env[ROLE_RUN_DEPTH_ENV];
    else process.env[ROLE_RUN_DEPTH_ENV] = previousDepth;
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkRolesReviewerRunner auto-answer reports exhausted role depth before spawning", async () => {
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

    const runner = new SparkRolesReviewerRunner({
      registry: new RoleRegistry(),
      cwd: dir,
      timeoutMs: 15_000,
      env: { ...process.env, [ROLE_RUN_DEPTH_ENV]: "0" },
      nativeExecutor: async () => {
        await writeFile(spawnedPath, "spawned", "utf8");
        return {
          record: {
            ref: "run:unexpected",
            roleRef: "role:builtin-reviewer",
            instruction: "unexpected",
            status: "succeeded",
          },
          stdout: JSON.stringify({ answers: {}, blocked: false, reason: "should not spawn" }),
          stderr: "",
          jsonEvents: [],
        };
      },
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

test("SparkRolesReviewerRunner runs reviewer gates in fresh mode even with parent session context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-reviewer-runner-"));
  try {
    let captured:
      | Parameters<
          NonNullable<ConstructorParameters<typeof SparkRolesReviewerRunner>[0]["nativeExecutor"]>
        >[0]
      | undefined;

    const input = { ...reviewTaskInput(), cwd: dir, forkFromSession: "session:parent" };
    const runner = new SparkRolesReviewerRunner({
      registry: new RoleRegistry(),
      cwd: dir,
      timeoutMs: 15_000,
      env: reviewerRunnerTestEnv,
      nativeExecutor: approvedReviewerNativeExecutor((request) => {
        captured = request;
      }),
    });

    const result = await runner.review(input);

    assert.equal(result.verdict.targetKind, "task");
    assert.equal(result.verdict.outcome, "approved");
    assert.equal(result.verdict.approved, true);
    assert.equal(result.verdict.summary, "approved by fake reviewer");
    assert.equal(result.record.roleRef, "role:builtin-reviewer");
    assert.equal(captured?.forkFromSession, undefined);
    assert.equal(captured?.record.forkFromSession, undefined);
    assert.equal(captured?.launch, "fresh");
    const tools = captured?.role.allowedTools ?? [];
    assert.ok(tools.includes("read"));
    assert.ok(tools.includes("grep"));
    assert.ok(tools.includes("find"));
    assert.equal(tools.includes("web_search"), false);
    assert.equal(tools.includes("fetch_content"), false);
    assert.equal(tools.includes("get_search_content"), false);
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
    assert.ok(captured);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
