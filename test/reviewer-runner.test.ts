import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RoleRegistry } from "pi-roles";
import { TaskGraph } from "pi-tasks";
import {
  PiRolesReviewerRunner,
  buildReadOnlyReviewerSystemPrompt,
  parseReviewerVerdictForInput,
  renderReviewerInstruction,
  reviewerInputFingerprint,
  type TaskReviewInput,
} from "../packages/spark/src/extension/reviewer-runner.ts";

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
  assert.match(instruction, /"outcome": "approved" \| "needs_changes" \| "blocked"/);
  assert.equal(reviewerInputFingerprint(input), reviewerInputFingerprint(input));
});

void test("PiRolesReviewerRunner runs reviewer through forked pi-roles adapter", async () => {
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
    assert.ok(args.includes("--fork"));
    assert.equal(args[args.indexOf("--fork") + 1], "session:parent");
    assert.match(args.join("\n"), /Read-only verdict role/);
    assert.match(args.join("\n"), /Return ONLY compact JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
