import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { builtinRoleRef, RoleRegistry } from "@zendev-lab/spark-roles";
import { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  runRoleInstructionOnly,
  runSparkTask,
  type SparkRoleInstructionExecutor,
} from "@zendev-lab/spark-runtime";

void test("runSparkTask can execute through a daemon-native role executor without spawning pi", async () => {
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
    const replayed: unknown[] = [];
    const roleExecutor: SparkRoleInstructionExecutor = async (input) => {
      seen.push(input.role.ref, input.record.ref, input.instruction.instruction);
      return {
        record: {
          ...input.record,
          status: "succeeded",
          finishedAt: "2026-06-20T00:00:00.000Z",
        },
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
    assert.equal(graph.getTask(task.ref).status, "done");
    assert.deepEqual(seen.slice(0, 2), [builtinRoleRef("worker"), run.ref]);
    assert.match(seen[2] ?? "", /Use the injected executor/);
    assert.equal(replayed.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("daemon-native role events arrive before the role executor settles", async () => {
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
