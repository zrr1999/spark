import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TaskGraph } from "@zendev-lab/spark-tasks";

import type { CockpitCoordinationDaemonClientOptions } from "../apps/spark-cockpit/src/cli/coordination-daemon.ts";
import {
  handleSparkCockpitCliCommand,
  parseSparkCockpitCliArgs,
  runSparkCockpitCliCommand,
  sparkCockpitHelpText,
  type SparkCockpitCliOptions,
} from "../apps/spark-cockpit/src/cli/coordination.ts";

const PLAN = {
  objective: "Exercise Cockpit coordination CLI.",
  successCriteria: ["Cockpit coordination CLI emits stable JSON."],
  evidenceRequired: ["Unit assertion."],
  steps: ["Inspect fixture state."],
  constraints: ["Do not run daemon execution controls."],
  contextRefs: [],
  nonGoals: [],
  openQuestions: [],
  askRefs: [],
};

void test("parseSparkCockpitCliArgs routes Cockpit coordination resources", () => {
  assert.deepEqual(parseSparkCockpitCliArgs(["status", "--json"]), {
    resource: "status",
    verb: "show",
    json: true,
    limit: undefined,
  });
  assert.deepEqual(parseSparkCockpitCliArgs(["project", "status", "proj:fixture", "--json"]), {
    resource: "project",
    verb: "status",
    json: true,
    limit: undefined,
    selector: "proj:fixture",
  });
  assert.deepEqual(
    parseSparkCockpitCliArgs(["task", "list", "--project", "proj:fixture", "--json"]),
    {
      resource: "task",
      verb: "list",
      json: true,
      limit: undefined,
      selector: "proj:fixture",
    },
  );
});

void test("spark cockpit help documents coordination resources and excludes daemon execution controls", () => {
  const help = sparkCockpitHelpText();
  assert.match(help, /spark cockpit - Spark cross-daemon coordination CLI/u);
  assert.match(help, /spark cockpit project list/u);
  assert.match(help, /spark cockpit task list/u);
  assert.match(help, /spark cockpit goal status/u);
  assert.match(help, /spark cockpit artifact list/u);
  assert.match(help, /spark cockpit review list/u);
  assert.match(help, /spark cockpit workflow list/u);
  assert.match(help, /spark cockpit instance backup/u);
  assert.match(help, /spark cockpit instance inspect/u);
  assert.match(help, /spark cockpit instance restore/u);
  assert.match(help, /spark cockpit instance status/u);
  assert.doesNotMatch(help, /spark cockpit queue/u);
  assert.doesNotMatch(help, /spark cockpit events watch/u);
});

void test("spark cockpit status/project/task/goal/artifact/review/workflow expose stable JSON", async () => {
  const fixture = fixtureCockpitOptions();

  const status = await handleSparkCockpitCliCommand(
    { resource: "status", verb: "show", json: true },
    fixture.options,
  );
  assert.equal(status.action, "status");
  assert.equal(status.result.plane, "cockpit");
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

  const projects = await handleSparkCockpitCliCommand(
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
  assert.equal(projectList.projects[0]?.title, "Cockpit fixture");
  assert.equal(projectList.projects[0]?.current, true);
  assert.equal(projectList.projects[0]?.ready, 1);

  const projectStatus = await handleSparkCockpitCliCommand(
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

  const taskList = await handleSparkCockpitCliCommand(
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

  const taskStatus = await handleSparkCockpitCliCommand(
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
  assert.equal(taskStatusResult.plane, "cockpit");
  assert.equal(taskStatusResult.resource, "task");
  assert.equal(taskStatusResult.task.taskRef, fixture.ready.ref);
  assert.deepEqual(taskStatusResult.evidenceRefs, ["artifact:input-a"]);

  const goal = await handleSparkCockpitCliCommand(
    { resource: "goal", verb: "status", json: true },
    fixture.options,
  );
  assert.equal(goal.action, "goal");
  assert.equal(goal.result.goal?.status, "active");
  assert.equal(goal.result.goal?.current, true);
  assert.equal(goal.result.goal?.source, "current-project");

  const artifacts = await handleSparkCockpitCliCommand(
    { resource: "artifact", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(artifacts.action, "artifact");
  assert.equal(artifacts.result.artifacts[0]?.artifactRef, "artifact:fixture-a");

  const reviews = await handleSparkCockpitCliCommand(
    { resource: "review", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(reviews.action, "review");
  assert.equal(reviews.result.reviews[0]?.outcome, "approved");

  const workflows = await handleSparkCockpitCliCommand(
    { resource: "workflow", verb: "list", json: true },
    fixture.options,
  );
  assert.equal(workflows.action, "workflow");
  assert.equal(workflows.result.workflows[0]?.runRef, "run:workflow-a");
});

void test("spark cockpit status marks stale unrelated goals as non-current", async () => {
  const fixture = fixtureCockpitOptions();
  const other = fixture.graph.createProject({ title: "Other project", description: "Other" });
  const status = await handleSparkCockpitCliCommand(
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

void test("spark cockpit status scope distinguishes no project, no goal, and legacy unscoped goal", async () => {
  const emptyStatus = await handleSparkCockpitCliCommand(
    { resource: "status", verb: "show", json: true },
    { graph: new TaskGraph(), goal: null },
  );
  assert.equal(emptyStatus.action, "status");
  assert.equal(emptyStatus.result.currentProjectRef, null);
  assert.equal(emptyStatus.result.scope.selectedProjectRef, null);
  assert.equal(emptyStatus.result.scope.goalSource, "none");
  assert.equal(emptyStatus.result.goal, null);

  const fixture = fixtureCockpitOptions();
  const noGoal = await handleSparkCockpitCliCommand(
    { resource: "status", verb: "show", json: true },
    { ...fixture.options, goal: null },
  );
  assert.equal(noGoal.action, "status");
  assert.equal(noGoal.result.scope.selectedProjectRef, fixture.project.ref);
  assert.equal(noGoal.result.scope.goalSource, "none");
  assert.equal(noGoal.result.goal, null);

  const legacyGoal = await handleSparkCockpitCliCommand(
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

void test("spark cockpit status treats an uninitialized workspace as empty coordination state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-cockpit-empty-"));
  try {
    const output: string[] = [];
    const statusCode = await runSparkCockpitCliCommand(
      { resource: "status", verb: "show", json: true },
      { write: (text) => output.push(text) },
      { cwd: dir },
    );

    assert.equal(statusCode, 0);
    const status = JSON.parse(output.join("")) as {
      result: { currentProjectRef: string | null; projectCount: number };
    };
    assert.equal(status.result.currentProjectRef, null);
    assert.equal(status.result.projectCount, 0);
    assert.equal(existsSync(join(dir, ".spark", "projects")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Cockpit coordination commands do not start an HTTP listener", async () => {
  const fixture = fixtureCockpitOptions();
  const activeServers = () =>
    (process as NodeJS.Process & { _getActiveHandles(): unknown[] })
      ._getActiveHandles()
      .filter((handle: unknown): handle is Server => handle instanceof Server).length;
  const before = activeServers();
  const output: string[] = [];

  await runSparkCockpitCliCommand(
    { resource: "status", verb: "show", json: true },
    { write: (text) => output.push(text) },
    fixture.options,
  );

  assert.equal(output.length, 1);
  assert.equal(activeServers(), before);
});

void test("runSparkCockpitCliCommand prints JSON for Cockpit status and task list", async () => {
  const fixture = fixtureCockpitOptions();
  const statusOutput: string[] = [];
  const statusCode = await runSparkCockpitCliCommand(
    { resource: "status", verb: "show", json: true },
    { write: (text) => statusOutput.push(text) },
    fixture.options,
  );
  assert.equal(statusCode, 0);
  const status = JSON.parse(statusOutput.join("")) as {
    result: { plane: string; resource: string; currentProjectRef: string };
  };
  assert.equal(status.result.plane, "cockpit");
  assert.equal(status.result.resource, "status");
  assert.equal(status.result.currentProjectRef, fixture.project.ref);

  const taskOutput: string[] = [];
  const taskCode = await runSparkCockpitCliCommand(
    { resource: "task", verb: "list", selector: fixture.project.ref, json: true },
    { write: (text) => taskOutput.push(text) },
    fixture.options,
  );
  assert.equal(taskCode, 0);
  const tasks = JSON.parse(taskOutput.join("")) as {
    result: { plane: string; resource: string; tasks: unknown[] };
  };
  assert.equal(tasks.result.plane, "cockpit");
  assert.equal(tasks.result.resource, "task");
  assert.equal(tasks.result.tasks.length, 3);
});

void test("spark cockpit assign crosses the real daemon RPC without starting HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-cockpit-daemon-acceptance-"));
  const child = startCockpitAcceptanceDaemon(root);
  const activeServers = () =>
    (process as NodeJS.Process & { _getActiveHandles(): unknown[] })
      ._getActiveHandles()
      .filter((handle: unknown): handle is Server => handle instanceof Server).length;

  try {
    const ready = await waitForAcceptanceMessage(child, "ready");
    const listenersBefore = activeServers();
    const result = await handleSparkCockpitCliCommand(
      {
        resource: "assign",
        verb: "create",
        json: true,
        sessionId: ready.sessionId,
        goal: "prove Cockpit to daemon coordination",
        title: "Acceptance assignment",
        role: "role:reviewer",
      },
      {
        graph: new TaskGraph(),
        daemonClient: { runtimeDir: ready.runtimeDir },
      },
    );

    assert.equal(result.action, "assign");
    assert.equal(result.result.status, "queued");
    assert.equal(result.result.commandKind, "assignment.create.request");
    assert.equal(activeServers(), listenersBefore);

    const inspectionPromise = waitForAcceptanceMessage(child, "inspection");
    child.send({ action: "inspect" });
    const { invocation } = await inspectionPromise;
    assert.ok(invocation);
    assert.equal(invocation.sessionId, ready.sessionId);
    assert.equal(invocation.prompt, "prove Cockpit to daemon coordination");
    assert.deepEqual(invocation.task, {
      type: "session.run",
      sessionId: ready.sessionId,
      prompt: "prove Cockpit to daemon coordination",
      assignment: {
        goal: "prove Cockpit to daemon coordination",
        target: {
          sessionId: ready.sessionId,
          role: "role:reviewer",
          workspaceId: "ws_cockpit_acceptance",
        },
        constraints: [],
        evidence: [],
        source: { kind: "cli" },
        title: "Acceptance assignment",
      },
      workspaceId: "ws_cockpit_acceptance",
      cwd: root,
      messageMetadata: { origin: { kind: "cockpit", host: "cockpit", surface: "local" } },
      actor: "spark-daemon-local-rpc",
    });
    assert.equal(existsSync(join(root, "assignments", "v1", "assignments.json")), false);
  } finally {
    if (child.connected) {
      const stopped = waitForAcceptanceMessage(child, "stopped");
      const exited = waitForChildExit(child);
      child.send({ action: "stop" });
      await stopped;
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

void test("spark cockpit assign submits through the daemon RPC without a side assignment store", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-cockpit-assign-"));
  const runtimeDir = join(root, "runtime");
  const submissions: unknown[] = [];
  const now = "2026-07-09T00:00:00.000Z";
  const session = {
    sessionId: "sess_cli_assign",
    scope: { kind: "workspace" as const, workspaceId: "ws_cli" },
    workspaceId: "ws_cli",
    title: "CLI assign",
    status: "ready" as const,
    bindings: [],
    createdAt: now,
    updatedAt: now,
  };
  const daemonClient: CockpitCoordinationDaemonClientOptions = {
    runtimeDir,
    request: async <T>(method: string, params?: unknown) => {
      if (method === "session.get") return session as T;
      if (method === "turn.submit") {
        submissions.push(params);
        return { invocationId: "inv_assignment", status: "queued", acceptedAt: now } as T;
      }
      throw new Error(`unexpected daemon method: ${method}`);
    },
  };

  const result = await handleSparkCockpitCliCommand(
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
    { graph: new TaskGraph(), daemonClient },
  );

  assert.equal(result.action, "assign");
  assert.equal(result.result.commandKind, "assignment.create.request");
  assert.deepEqual(submissions, [
    {
      sessionId: "sess_cli_assign",
      prompt: "ship the assign path",
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
      messageMetadata: { origin: { kind: "cockpit", host: "cockpit", surface: "local" } },
    },
  ]);
  assert.equal(existsSync(join(root, "assignments", "v1", "assignments.json")), false);
  await rm(root, { recursive: true, force: true });
});

type AcceptanceMessage =
  | { kind: "ready"; runtimeDir: string; sessionId: string }
  | { kind: "inspection"; invocation?: AcceptanceInvocation }
  | { kind: "stopped" };

type AcceptanceInvocation = {
  sessionId?: string;
  prompt?: string;
  task?: unknown;
};

function startCockpitAcceptanceDaemon(root: string): ChildProcess {
  return spawn(
    fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)),
    [
      fileURLToPath(new URL("./support/spark-cockpit-daemon-acceptance-child.ts", import.meta.url)),
      root,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
}

function waitForAcceptanceMessage<K extends AcceptanceMessage["kind"]>(
  child: ChildProcess,
  kind: K,
): Promise<Extract<AcceptanceMessage, { kind: K }>> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onMessage = (message: AcceptanceMessage) => {
      if (message.kind !== kind) return;
      cleanup();
      resolve(message as Extract<AcceptanceMessage, { kind: K }>);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Cockpit acceptance daemon exited before ${kind} with code ${String(code)}.${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr?.off("data", onStderr);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stderr?.on("data", onStderr);
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Cockpit acceptance daemon exited with code ${String(code)}.`));
    });
  });
}

function fixtureCockpitOptions() {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Cockpit fixture", description: "Fixture project" });
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
  const options: SparkCockpitCliOptions = {
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
