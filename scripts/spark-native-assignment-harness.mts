#!/usr/bin/env node
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinRoleRef, RoleRegistry } from "@zendev-lab/spark-roles";
import { TaskGraph, defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { listActiveSparkRoleRunProcesses } from "@zendev-lab/spark-runtime";
import { runReadyTasks } from "@zendev-lab/spark-workflows";

import { createSparkCliHostServices } from "../apps/spark-tui/src/host/bootstrap.ts";
import { saveCurrentProjectRef } from "../packages/spark-extension/src/extension/current-project-state.ts";
import { createSparkRuntimeReadyTaskRunner } from "../packages/spark-extension/src/extension/spark-ready-task-runtime.ts";

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spark-native-assignment-"));
  const cwd = join(dir, "repo");
  const sparkHome = join(dir, "home");
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(sparkHome, { recursive: true });
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Native assignment smoke",
      description: "Controlled assignment smoke for daemon-native role executor wiring.",
    });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "native-assignment-leaf",
      title: "Native assignment leaf",
      description: "Complete through the daemon-native role executor stub.",
      roleRef: builtinRoleRef("worker"),
      plan: {
        objective:
          "Verify Spark assignment routes ready tasks through the daemon-native role executor.",
        contextRefs: [],
        constraints: [],
        nonGoals: [],
        successCriteria: [
          "Harness output shows the assigned task reaches done without spawning a process-backed child.",
        ],
        evidenceRequired: [
          "Harness JSON output includes raw run_status and project_status sections plus native executor calls.",
        ],
        steps: ["Run runReadyTasks with a stub native role executor and inspect status."],
        riskLevel: "normal",
        openQuestions: [],
        askRefs: [],
      },
    });
    const store = defaultTaskGraphStore(cwd);
    await store.save(graph);

    const services = await createSparkCliHostServices({
      cwd,
      sparkHome,
      config: { extensions: ["@zendev-lab/pi-extension/extension"], providers: [] },
      extensions: ["@zendev-lab/pi-extension/extension"],
      providers: [],
      sessionManager: { getLeafId: () => "session:native-assignment" },
    });
    const ctx = services.runtime.makeContext();
    await saveCurrentProjectRef(cwd, ctx, project.ref);

    const nativeCalls: Array<{ roleRef: string; runRef: string; instruction: string }> = [];
    const beforeRunStatus = await runTaskRead(services, ctx, {
      action: "run_status",
      runAction: "list",
    });
    const result = await runReadyTasks({
      graph,
      ...createSparkRuntimeReadyTaskRunner({
        registry: new RoleRegistry(),
        cwd,
        roleExecutor: async (input) => {
          nativeCalls.push({
            roleRef: input.role.ref,
            runRef: input.record.ref,
            instruction: input.instruction.instruction,
          });
          return {
            record: {
              ...input.record,
              status: "succeeded",
              finishedAt: "2026-07-07T00:00:00.000Z",
            },
            stdout: "native assignment result",
            stderr: "",
            jsonEvents: [
              {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "native assignment result" }],
                },
              },
            ],
          };
        },
      }),
      dryRun: false,
      maxConcurrency: 1,
      timeoutMs: 5_000,
      projectRef: project.ref,
      claim: { sessionId: "session:native-assignment" },
    });
    await store.save(TaskGraph.fromSnapshot(graph.snapshot()));

    const afterRunStatus = await runTaskRead(services, ctx, {
      action: "run_status",
      runAction: "list",
      includeHistory: true,
    });
    const taskStatus = await runTaskRead(services, ctx, {
      action: "task_status",
      task: "native-assignment-leaf",
      includeHistory: true,
    });
    const projectStatus = await runTaskRead(services, ctx, {
      action: "project_status",
      view: "active",
      limit: 8,
    });
    const activeForCwd = listActiveSparkRoleRunProcesses().filter((process) => process.cwd === cwd);
    const loaded = await store.load();
    const taskAfter = loaded?.getTask(task.ref);

    console.log(
      JSON.stringify(
        {
          cwd,
          taskRef: task.ref,
          result: {
            scheduled: result.scheduled,
            completed: result.completed,
            succeeded: result.succeeded,
            failed: result.failed,
            timedOut: result.timedOut,
            runRefs: result.runs.map((run) => run.ref),
          },
          nativeCalls,
          activeProcessCount: activeForCwd.length,
          taskStatusValue: taskAfter?.status,
          beforeRunStatus: beforeRunStatus.text,
          afterRunStatus: afterRunStatus.text,
          taskStatus: taskStatus.text,
          projectStatus: projectStatus.text,
          usedOsKill: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runTaskRead(
  services: Awaited<ReturnType<typeof createSparkCliHostServices>>,
  ctx: ReturnType<Awaited<ReturnType<typeof createSparkCliHostServices>>["runtime"]["makeContext"]>,
  params: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
  const tool = services.runtime.getTool("task_read")?.config;
  if (!tool) throw new Error("fresh host did not register task_read");
  const result = await tool.execute?.(
    `native-${Date.now().toString(36)}`,
    params,
    new AbortController().signal,
    async () => undefined,
    ctx,
  );
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map((entry) =>
      entry && typeof entry === "object" && "text" in entry ? String(entry.text) : "",
    )
    .filter(Boolean)
    .join("\n");
  return { text, details: result?.details };
}

await main();
