import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { builtinRoleRef, RoleRegistry } from "@zendev-lab/spark-roles";
import { TaskGraph } from "@zendev-lab/spark-tasks";
import { runSparkTask, type SparkRoleInstructionExecutor } from "@zendev-lab/spark-runtime";

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
        successCriteria: ["Injected executor receives the Spark task instruction."],
        evidenceRequired: ["Native executor result is returned."],
        steps: ["Run injected executor."],
        riskLevel: "normal",
        openQuestions: [],
        askRefs: [],
      },
    });
    const seen: string[] = [];
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
      piCommand: join(dir, "missing-pi-that-must-not-spawn"),
      roleExecutor,
      claim: { sessionId: "spark-daemon:test", runName: "spark-daemon-native-test" },
    });

    assert.equal(run.status, "succeeded");
    assert.equal(graph.getTask(task.ref).status, "done");
    assert.deepEqual(seen.slice(0, 2), [builtinRoleRef("worker"), run.ref]);
    assert.match(seen[2] ?? "", /Use the injected executor/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
