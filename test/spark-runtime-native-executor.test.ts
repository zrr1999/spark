import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";

import { builtinRoleRef, RoleRegistry } from "@zendev-lab/spark-roles";
import { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  runRoleInstructionOnly,
  runSparkTask,
  type SparkRoleInstructionExecutor,
} from "@zendev-lab/spark-runtime";

test("runSparkTask can execute through a daemon-native role executor without spawning pi", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-role-executor-"));
  try {
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Native", description: "native executor" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Run natively",
      description: "Use the injected executor.",
      roleRef: builtinRoleRef("worker"),
      plan: {
        objective: "Prove daemon-native executor wiring.",
        contextRefs: [],
        constraints: [],
        nonGoals: [],
        successCriteria: [
          "Test assertion verifies the injected executor records the Spark task instruction.",
        ],
        evidenceRequired: ["Test assertion verifies native executor result is returned."],
        steps: ["Run injected executor and assert recorded instruction."],
        riskLevel: "normal",
        openQuestions: [],
        askRefs: [],
      },
    });
    const seen: string[] = [];
    const phases: Array<"plan" | "implement" | undefined> = [];
    const replayed: unknown[] = [];
    const roleExecutor: SparkRoleInstructionExecutor = async (input) => {
      seen.push(input.role.ref, input.record.ref, input.instruction.instruction);
      phases.push(input.phase);
      const outcome = {
        kind: "completed" as const,
        code: "task_contract_satisfied",
        reason: "native executor verified the task contract",
      };
      return {
        record: {
          ...input.record,
          status: "succeeded",
          outcome,
          finishedAt: "2026-06-20T00:00:00.000Z",
        },
        outcome,
        stdout: "native role result",
        stderr: "",
        jsonEvents: [
          {
            type: "turn_complete",
            message: { role: "assistant", content: [{ type: "text", text: "native role result" }] },
          },
        ],
      };
    };

    const run = await runSparkTask({
      graph,
      taskRef: task.ref,
      registry: new RoleRegistry(),
      cwd: dir,
      dryRun: false,
      roleExecutor,
      onRoleEvent: (event) => {
        replayed.push(event);
      },
      claim: { sessionId: "spark-daemon:test", runName: "spark-daemon-native-test" },
    });

    assert.equal(run.status, "succeeded");
    assert.equal(run.outcome?.kind, "completed");
    assert.equal(graph.getTask(task.ref).status, "done");
    assert.deepEqual(seen.slice(0, 2), [builtinRoleRef("worker"), run.ref]);
    assert.deepEqual(phases, ["implement"]);
    assert.match(seen[2] ?? "", /Use the injected executor/);
    assert.equal(replayed.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runSparkTask preserves a structured blocked outcome and its exact reason", async () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Blocked", description: "truthful outcome" });
  const task = graph.createTask({
    projectRef: project.ref,
    title: "Blocked natively",
    description: "Report a real blocker.",
    roleRef: builtinRoleRef("worker"),
    plan: {
      objective: "Preserve a blocked outcome.",
      contextRefs: [],
      constraints: [],
      nonGoals: [],
      successCriteria: [
        "Vitest assertions observe blocked task/run statuses and the exact structured reason.",
      ],
      evidenceRequired: [
        "test/spark-runtime-native-executor.test.ts output records passing blocked status, failure kind, and reason assertions.",
      ],
      steps: ["Report the missing_authorization blocker through the injected executor."],
      riskLevel: "normal",
      openQuestions: [],
      askRefs: [],
    },
  });
  const outcome = {
    kind: "blocked" as const,
    code: "missing_authorization",
    reason: "Required authorization was not available",
    nextAction: "Request authorization from the parent session",
  };

  const run = await runSparkTask({
    graph,
    taskRef: task.ref,
    registry: new RoleRegistry(),
    dryRun: false,
    roleExecutor: async (input) => ({
      record: { ...input.record, status: "failed", outcome },
      outcome,
      stdout: "blocked",
      stderr: "",
      jsonEvents: [],
    }),
    claim: { sessionId: "spark-daemon:blocked", runName: "blocked-outcome-test" },
  });

  assert.equal(run.status, "blocked");
  assert.equal(run.failureKind, "blocked");
  assert.equal(run.errorMessage, outcome.reason);
  assert.deepEqual(run.outcome, outcome);
  assert.deepEqual(run.completionSummary?.outcome, outcome);
  assert.equal(run.completionSummary?.summary, outcome.reason);
  assert.equal(graph.getTask(task.ref).status, "blocked");
});

test("runSparkTask maps structured cancelled outcomes to cancelled task/run state", async () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Cancelled", description: "truthful outcome" });
  const task = graph.createTask({
    projectRef: project.ref,
    title: "Cancel natively",
    description: "Report cancellation.",
    roleRef: builtinRoleRef("worker"),
    plan: {
      objective: "Preserve cancellation.",
      contextRefs: [],
      constraints: [],
      nonGoals: [],
      successCriteria: [
        "Vitest assertions observe cancelled task/run statuses and runtime_cancelled failure kind.",
      ],
      evidenceRequired: [
        "test/spark-runtime-native-executor.test.ts output records passing cancelled status and outcome assertions.",
      ],
      steps: ["Report parent_cancelled through the injected executor."],
      riskLevel: "normal",
      openQuestions: [],
      askRefs: [],
    },
  });
  const outcome = {
    kind: "cancelled" as const,
    code: "parent_cancelled",
    reason: "Parent cancelled the worker",
  };

  const run = await runSparkTask({
    graph,
    taskRef: task.ref,
    registry: new RoleRegistry(),
    dryRun: false,
    roleExecutor: async (input) => ({
      record: { ...input.record, status: "cancelled", outcome },
      outcome,
      stdout: "cancelled",
      stderr: "",
      jsonEvents: [],
    }),
    claim: { sessionId: "spark-daemon:cancelled", runName: "cancelled-outcome-test" },
  });

  assert.equal(run.status, "cancelled");
  assert.equal(run.failureKind, "runtime_cancelled");
  assert.deepEqual(run.outcome, outcome);
  assert.equal(graph.getTask(task.ref).status, "cancelled");
});

test("runSparkTask fails closed when a custom executor ignores the required outcome contract", async () => {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Fail closed", description: "missing outcome" });
  const task = graph.createTask({
    projectRef: project.ref,
    title: "Require outcome",
    description: "A custom executor must not bypass structured completion.",
    roleRef: builtinRoleRef("worker"),
    plan: {
      objective: "Reject an ambiguous success.",
      contextRefs: [],
      constraints: [],
      nonGoals: [],
      successCriteria: [
        "Vitest assertions observe failed status and unchanged pending plan item after a missing outcome.",
      ],
      evidenceRequired: [
        "test/spark-runtime-native-executor.test.ts output records passing missing-outcome and pending-item assertions.",
      ],
      steps: [
        "Return succeeded from the injected executor without an outcome and inspect the task.",
      ],
      items: [
        {
          id: "item-1",
          title: "Inspect the task plan item and verify it remains pending",
          status: "pending",
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      ],
      riskLevel: "normal",
      openQuestions: [],
      askRefs: [],
    },
  });

  const run = await runSparkTask({
    graph,
    taskRef: task.ref,
    registry: new RoleRegistry(),
    dryRun: false,
    roleExecutor: async (input) => ({
      record: { ...input.record, status: "succeeded" },
      stdout: "ambiguous success",
      stderr: "",
      jsonEvents: [],
    }),
    claim: { sessionId: "spark-daemon:missing-outcome", runName: "missing-outcome-test" },
  });

  assert.equal(run.status, "failed");
  assert.equal(run.failureKind, "runtime_error");
  assert.match(run.errorMessage ?? "", /without a required structured completion outcome/u);
  assert.equal(run.outcome, undefined);
  assert.equal(graph.getTask(task.ref).status, "failed");
  assert.equal(graph.getTask(task.ref).plan?.items?.[0]?.status, "pending");
});

test("daemon-native role events arrive before the role executor settles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-role-streaming-"));
  try {
    const releaseExecutor = Promise.withResolvers<void>();
    const eventObserved = Promise.withResolvers<void>();
    const event = { type: "stream_event", event: { type: "text_delta", delta: "live" } };
    const streamed: unknown[] = [];
    let settled = false;

    const execution = runRoleInstructionOnly(
      new RoleRegistry(),
      { roleRef: builtinRoleRef("worker"), instruction: "Stream before completing." },
      {
        cwd: dir,
        dryRun: false,
        roleExecutor: async (input) => {
          await input.onEvent?.(event);
          eventObserved.resolve();
          await releaseExecutor.promise;
          return {
            record: { ...input.record, status: "succeeded" },
            stdout: "live",
            stderr: "",
            jsonEvents: [event],
          };
        },
        onRoleEvent: (value) => {
          streamed.push(value);
        },
      },
    );
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await eventObserved.promise;
    assert.equal(settled, false);
    assert.deepEqual(streamed, [event]);

    releaseExecutor.resolve();
    const result = await execution;
    assert.equal(result.record.status, "succeeded");
    assert.deepEqual(streamed, [event]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
