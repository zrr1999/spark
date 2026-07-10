import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskGraph } from "@zendev-lab/spark-tasks";

import type { SparkDaemonClientOptions } from "../apps/spark-tui/src/cli/daemon.ts";
import { parseSparkCliCommand } from "../apps/spark-tui/src/cli.ts";
import {
  handleSparkServerCliCommand,
  parseSparkServerCliArgs,
  runSparkServerCliCommand,
  sparkServerHelpText,
  type SparkServerCliOptions,
} from "../apps/spark-tui/src/cli/server.ts";

const PLAN = {
  objective: "Exercise server CLI.",
  successCriteria: ["Server CLI emits stable JSON."],
  evidenceRequired: ["Unit assertion."],
  steps: ["Inspect fixture state."],
  constraints: ["Do not run daemon execution controls."],
  contextRefs: [],
  nonGoals: [],
  openQuestions: [],
  askRefs: [],
};

void test("parseSparkCliCommand routes server namespace to coordination CLI", () => {
  assert.deepEqual(parseSparkCliCommand(["server", "status", "--json"]), {
    kind: "server",
    command: { resource: "status", verb: "show", json: true, limit: undefined },
  });
  assert.deepEqual(parseSparkCliCommand(["server", "--help"]), {
    kind: "server",
    command: { resource: "help" },
  });
  assert.deepEqual(parseSparkServerCliArgs(["project", "status", "proj:fixture", "--json"]), {
    resource: "project",
    verb: "status",
    json: true,
    limit: undefined,
    selector: "proj:fixture",
  });
  assert.deepEqual(
    parseSparkServerCliArgs(["task", "list", "--project", "proj:fixture", "--json"]),
    {
      resource: "task",
      verb: "list",
      json: true,
      limit: undefined,
      selector: "proj:fixture",
    },
  );
});

void test("spark server help documents coordination resources and excludes daemon execution controls", () => {
  const help = sparkServerHelpText();
  assert.match(help, /spark server - server coordination plane/u);
  assert.match(help, /spark server project list/u);
  assert.match(help, /spark server task list/u);
  assert.match(help, /spark server goal status/u);
  assert.match(help, /spark server artifact list/u);
  assert.match(help, /spark server review list/u);
  assert.match(help, /spark server workflow list/u);
  assert.doesNotMatch(help, /spark server queue/u);
  assert.doesNotMatch(help, /spark server events watch/u);
});

void test("spark server status/project/task/goal/artifact/review/workflow expose stable JSON", async () => {
  const fixture = fixtureServerOptions();

  const status = await handleSparkServerCliCommand(
    { resource: "status", verb: "show", json: true },
    fixture.options,
  );
  assert.equal(status.action, "status");
  assert.equal(status.result.plane, "server");
  assert.equal(status.result.resource, "status");
  assert.equal(status.result.currentProjectRef, fixture.project.ref);
  assert.equal(status.result.taskCounts.ready, 1);
  assert.equal(status.result.readyTasks[0]?.taskRef, fixture.ready.ref);
  assert.equal(status.result.artifactCount, 1);
  assert.equal(status.result.reviewCount, 1);
  assert.equal(status.result.workflowRunCount, 1);
  assert.deepEqual(status.result.scope, {
    selectedWorkspace: process.cwd(),
    selectedSessionKey: "session:fixture",
    selectedProjectRef: fixture.project.ref,
    goalSource: "current-project",
  });
  assert.equal(status.result.goal?.current, true);
  assert.equal(status.result.goal?.source, "current-project");

  const projects = await handleSparkServerCliCommand(
    { resource: "project", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(projects.action, "project");
  const projectList = projects.result as {
    projects: Array<{ projectRef: string; title: string; current: boolean; ready: number }>;
  };
  assert.deepEqual(
    projectList.projects.map((project) => project.projectRef),
    [fixture.project.ref],
  );
  assert.equal(projectList.projects[0]?.title, "Server fixture");
  assert.equal(projectList.projects[0]?.current, true);
  assert.equal(projectList.projects[0]?.ready, 1);

  const projectStatus = await handleSparkServerCliCommand(
    { resource: "project", verb: "status", selector: fixture.project.ref, json: true },
    fixture.options,
  );
  assert.equal(projectStatus.action, "project");
  const projectStatusResult = projectStatus.result as {
    readyTasks: unknown[];
    currentClaim: { taskRef: string } | null;
    statusCounts: Record<string, number>;
  };
  assert.equal(projectStatusResult.readyTasks.length, 1);
  assert.equal(projectStatusResult.currentClaim?.taskRef, fixture.claimed.ref);
  assert.equal(projectStatusResult.statusCounts.done, 1);

  const taskList = await handleSparkServerCliCommand(
    { resource: "task", verb: "list", selector: fixture.project.ref, json: true },
    fixture.options,
  );
  assert.equal(taskList.action, "task");
  const taskListResult = taskList.result as {
    projectRef: string;
    tasks: Array<{ taskRef: string; ready: boolean; claimed: boolean }>;
  };
  assert.equal(taskListResult.projectRef, fixture.project.ref);
  assert.equal(
    taskListResult.tasks.find((task) => task.taskRef === fixture.ready.ref)?.ready,
    true,
  );
  assert.equal(
    taskListResult.tasks.find((task) => task.taskRef === fixture.claimed.ref)?.claimed,
    true,
  );

  const taskStatus = await handleSparkServerCliCommand(
    { resource: "task", verb: "status", selector: fixture.ready.ref, json: true },
    fixture.options,
  );
  assert.equal(taskStatus.action, "task");
  const taskStatusResult = taskStatus.result as {
    plane: string;
    resource: string;
    task: { taskRef: string };
    evidenceRefs: string[];
  };
  assert.equal(taskStatusResult.plane, "server");
  assert.equal(taskStatusResult.resource, "task");
  assert.equal(taskStatusResult.task.taskRef, fixture.ready.ref);
  assert.deepEqual(taskStatusResult.evidenceRefs, ["artifact:input-a"]);

  const goal = await handleSparkServerCliCommand(
    { resource: "goal", verb: "status", json: true },
    fixture.options,
  );
  assert.equal(goal.action, "goal");
  assert.equal(goal.result.goal?.status, "active");
  assert.equal(goal.result.goal?.current, true);
  assert.equal(goal.result.goal?.source, "current-project");

  const artifacts = await handleSparkServerCliCommand(
    { resource: "artifact", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(artifacts.action, "artifact");
  assert.equal(artifacts.result.artifacts[0]?.artifactRef, "artifact:fixture-a");

  const reviews = await handleSparkServerCliCommand(
    { resource: "review", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(reviews.action, "review");
  assert.equal(reviews.result.reviews[0]?.outcome, "approved");

  const workflows = await handleSparkServerCliCommand(
    { resource: "workflow", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(workflows.action, "workflow");
  assert.equal(workflows.result.workflows[0]?.runRef, "run:workflow-a");
});

void test("spark server status marks stale unrelated goals as non-current", async () => {
  const fixture = fixtureServerOptions();
  const other = fixture.graph.createProject({ title: "Other project", description: "Other" });
  const status = await handleSparkServerCliCommand(
    { resource: "status", verb: "show", json: true },
    {
      ...fixture.options,
      currentProjectRef: fixture.project.ref,
      currentSessionKey: null,
      goal: {
        status: "complete",
        objective: "stale goal",
        goalId: "goal:stale",
        sessionKey: "session:stale",
        projectRef: other.ref,
      },
    },
  );

  assert.equal(status.action, "status");
  assert.equal(status.result.currentProjectRef, fixture.project.ref);
  assert.equal(status.result.scope.selectedProjectRef, fixture.project.ref);
  assert.equal(status.result.scope.selectedSessionKey, null);
  assert.equal(status.result.scope.goalSource, "unrelated-project");
  assert.equal(status.result.goal?.current, false);
  assert.equal(status.result.goal?.projectRef, other.ref);
});

void test("spark server status scope distinguishes no project, no goal, and legacy unscoped goal", async () => {
  const emptyStatus = await handleSparkServerCliCommand(
    { resource: "status", verb: "show", json: true },
    { graph: new TaskGraph(), goal: null },
  );
  assert.equal(emptyStatus.action, "status");
  assert.equal(emptyStatus.result.currentProjectRef, null);
  assert.equal(emptyStatus.result.scope.selectedProjectRef, null);
  assert.equal(emptyStatus.result.scope.goalSource, "none");
  assert.equal(emptyStatus.result.goal, null);

  const fixture = fixtureServerOptions();
  const noGoal = await handleSparkServerCliCommand(
    { resource: "status", verb: "show", json: true },
    { ...fixture.options, goal: null },
  );
  assert.equal(noGoal.action, "status");
  assert.equal(noGoal.result.scope.selectedProjectRef, fixture.project.ref);
  assert.equal(noGoal.result.scope.goalSource, "none");
  assert.equal(noGoal.result.goal, null);

  const legacyGoal = await handleSparkServerCliCommand(
    { resource: "status", verb: "show", json: true },
    {
      ...fixture.options,
      goal: { status: "complete", objective: "legacy goal", sessionKey: "session:legacy" },
    },
  );
  assert.equal(legacyGoal.action, "status");
  assert.equal(legacyGoal.result.scope.goalSource, "legacy-unscoped");
  assert.equal(legacyGoal.result.goal?.current, false);
});

void test("runSparkServerCliCommand prints JSON for server status and task list", async () => {
  const fixture = fixtureServerOptions();
  const statusOutput: string[] = [];
  const statusCode = await runSparkServerCliCommand(
    { resource: "status", verb: "show", json: true },
    { write: (text) => statusOutput.push(text) },
    fixture.options,
  );
  assert.equal(statusCode, 0);
  const status = JSON.parse(statusOutput.join("")) as {
    result: { plane: string; resource: string; currentProjectRef: string };
  };
  assert.equal(status.result.plane, "server");
  assert.equal(status.result.resource, "status");
  assert.equal(status.result.currentProjectRef, fixture.project.ref);

  const taskOutput: string[] = [];
  const taskCode = await runSparkServerCliCommand(
    { resource: "task", verb: "list", selector: fixture.project.ref, json: true },
    { write: (text) => taskOutput.push(text) },
    fixture.options,
  );
  assert.equal(taskCode, 0);
  const tasks = JSON.parse(taskOutput.join("")) as {
    result: { plane: string; resource: string; tasks: unknown[] };
  };
  assert.equal(tasks.result.plane, "server");
  assert.equal(tasks.result.resource, "task");
  assert.equal(tasks.result.tasks.length, 3);
});

void test("spark server assign submits the daemon session.run path without a side assignment store", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-server-assign-"));
  const sparkHome = join(root, "spark-home");
  const previousSparkHome = process.env.SPARK_HOME;
  const submissions: Array<{
    sessionId: string;
    prompt: string;
    reset?: boolean;
    assignment?: unknown;
  }> = [];
  const now = "2026-07-09T00:00:00.000Z";
  try {
    process.env.SPARK_HOME = sparkHome;
    const session = {
      sessionId: "sess_cli_assign",
      workspaceId: "ws_cli",
      title: "CLI assign",
      status: "ready" as const,
      bindings: [],
      createdAt: now,
      updatedAt: now,
    };
    const daemonClient = {
      sparkHome,
      managedSessions: {
        get: async () => session,
        create: async () => session,
        list: async () => [session],
        bind: async () => session,
        unbind: async () => session,
        archive: async () => ({ ...session, status: "archived" as const }),
      },
      daemonStatus: async () => ({
        observedAt: now,
        servers: [],
        queue: { inbox: 0, processed: 0, failed: 0 },
      }),
      turnSubmit: async (_paths, input) => {
        submissions.push(input);
        return {
          fileName: "assignment.json",
          filePath: join(sparkHome, "daemon", "inbox", "assignment.json"),
          task: { type: "session.run" as const, ...input },
          observedAt: now,
        };
      },
    } satisfies SparkDaemonClientOptions;

    const result = await handleSparkServerCliCommand(
      {
        resource: "assign",
        verb: "create",
        json: true,
        sessionId: session.sessionId,
        goal: "ship the assign path",
        title: "Ship assign",
        role: "role:reviewer",
        workspaceId: "ws_override",
      },
      { graph: new TaskGraph(), daemonClient } as SparkServerCliOptions & {
        daemonClient: SparkDaemonClientOptions;
      },
    );

    assert.equal(result.action, "assign");
    assert.equal(result.result.commandKind, "assignment.create.request");
    assert.deepEqual(submissions, [
      {
        sessionId: "sess_cli_assign",
        prompt: "ship the assign path",
        reset: undefined,
        assignment: {
          goal: "ship the assign path",
          target: {
            sessionId: "sess_cli_assign",
            role: "role:reviewer",
            workspaceId: "ws_override",
          },
          constraints: [],
          evidence: [],
          source: { kind: "cli" },
          title: "Ship assign",
        },
      },
    ]);
    assert.equal(existsSync(join(sparkHome, "assignments", "v1", "assignments.json")), false);
  } finally {
    if (previousSparkHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousSparkHome;
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureServerOptions() {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Server fixture", description: "Fixture project" });
  const done = graph.createTask({
    projectRef: project.ref,
    name: "done-task",
    title: "Done task",
    description: "Done task",
    kind: "implement",
    status: "done",
    plan: PLAN,
  });
  const ready = graph.createTask({
    projectRef: project.ref,
    name: "ready-task",
    title: "Ready task",
    description: "Ready task",
    kind: "implement",
    status: "ready",
    inputArtifacts: ["artifact:input-a"],
    plan: PLAN,
  });
  const claimedBase = graph.createTask({
    projectRef: project.ref,
    name: "claimed-task",
    title: "Claimed task",
    description: "Claimed task",
    kind: "review",
    status: "pending",
    plan: PLAN,
  });
  const claimed = graph.claimTask(claimedBase.ref, {
    kind: "main",
    claimedBy: "session:fixture",
    sessionId: "session:fixture",
    now: "2026-07-08T00:00:00.000Z",
    leaseMs: 60_000,
  });
  graph.addDependency(ready.ref, done.ref);
  const options: SparkServerCliOptions = {
    graph,
    currentProjectRef: project.ref,
    currentSessionKey: "session:fixture",
    goal: {
      status: "active",
      objective: "ship server plane",
      goalId: "goal:fixture",
      sessionKey: "session:fixture",
      projectRef: project.ref,
    },
    artifacts: [{ artifactRef: "artifact:fixture-a", title: "Fixture artifact", kind: "record" }],
    reviews: [{ reviewRef: "review:fixture-a", outcome: "approved", targetRef: ready.ref }],
    workflows: [{ runRef: "run:workflow-a", status: "running", name: "Fixture workflow" }],
  };
  return { graph, project, done, ready, claimed, options };
}
