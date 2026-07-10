import { type TaskGraph } from "@zendev-lab/spark-tasks";
import type { Project, ProjectRef, Task, TaskRef } from "@zendev-lab/spark-extension-api";
import { createId, parseSparkAssignment } from "@zendev-lab/spark-protocol";

import {
  consoleSparkCliOutput,
  parseSparkCliOptions,
  printSparkCliResult,
  readBooleanOption,
  readNumberOption,
  readStringOption,
  type SparkCliOutput,
} from "./shared.ts";
import {
  loadSparkServerCoordinationState,
  type SparkServerCoordinationState,
} from "./server-adapter.ts";
import {
  clientGetManagedSession,
  handleSparkDaemonCliCommand,
  type SparkDaemonClientOptions,
} from "./daemon.ts";

export type SparkServerCliResource =
  | "help"
  | "status"
  | "project"
  | "task"
  | "goal"
  | "artifact"
  | "review"
  | "workflow"
  | "assign";

export interface SparkServerCliCommand {
  resource: SparkServerCliResource;
  verb?: string;
  json?: boolean;
  selector?: string;
  limit?: number;
  sessionId?: string;
  goal?: string;
  title?: string;
  role?: string;
  workspaceId?: string;
}

export interface SparkServerCliOptions {
  cwd?: string;
  sparkHome?: string;
  daemonClient?: SparkDaemonClientOptions;
  graph?: TaskGraph | null;
  currentProjectRef?: ProjectRef;
  currentSessionKey?: string | null;
  goal?: SparkServerGoalSummary | null;
  artifacts?: SparkServerArtifactSummary[];
  reviews?: SparkServerReviewSummary[];
  workflows?: SparkServerWorkflowSummary[];
}

export type SparkServerGoalSource =
  | "none"
  | "current-project"
  | "unrelated-project"
  | "legacy-unscoped";

export interface SparkServerGoalSummary {
  status: string;
  objective?: string;
  goalId?: string;
  sessionKey?: string;
  projectRef?: ProjectRef;
  source?: SparkServerGoalSource;
  current?: boolean;
}

export interface SparkServerArtifactSummary {
  artifactRef: string;
  title?: string;
  kind?: string;
  status?: string;
}

export interface SparkServerReviewSummary {
  reviewRef: string;
  status?: string;
  targetRef?: string;
  outcome?: string;
}

export interface SparkServerWorkflowSummary {
  runRef: string;
  status?: string;
  name?: string;
}

export type SparkServerCliResult =
  | { action: "help"; text: string }
  | { action: "status"; result: SparkServerStatusResult }
  | { action: "project"; result: SparkServerProjectListResult | SparkServerProjectStatusResult }
  | { action: "task"; result: SparkServerTaskListResult | SparkServerTaskStatusResult }
  | { action: "goal"; result: SparkServerGoalResult }
  | { action: "artifact"; result: SparkServerArtifactListResult }
  | { action: "review"; result: SparkServerReviewListResult }
  | { action: "workflow"; result: SparkServerWorkflowListResult }
  | { action: "assign"; result: SparkServerAssignResult };

export interface SparkServerAssignResult {
  plane: "server";
  resource: "assign";
  assignmentId: string;
  sessionId: string;
  goal: string;
  status: string;
  commandKind: "assignment.create.request";
  text: string;
}

export interface SparkServerStatusResult {
  plane: "server";
  resource: "status";
  currentProjectRef: ProjectRef | null;
  currentProjectTitle?: string;
  projectCount: number;
  taskCounts: SparkServerTaskCounts;
  readyTasks: SparkServerTaskRow[];
  scope: SparkServerStatusScope;
  goal?: SparkServerGoalSummary | null;
  artifactCount: number;
  reviewCount: number;
  workflowRunCount: number;
  text: string;
}

export interface SparkServerStatusScope {
  selectedWorkspace: string;
  selectedSessionKey: string | null;
  selectedProjectRef: ProjectRef | null;
  goalSource: SparkServerGoalSource;
}

export interface SparkServerTaskCounts {
  total: number;
  unfinished: number;
  ready: number;
  done: number;
  claimed: number;
}

export interface SparkServerProjectListResult {
  plane: "server";
  resource: "project";
  projects: SparkServerProjectRow[];
  text: string;
}

export interface SparkServerProjectStatusResult {
  plane: "server";
  resource: "project";
  projectRef: ProjectRef;
  title: string;
  current: boolean;
  readyTasks: SparkServerTaskRow[];
  currentClaim: SparkServerTaskRow | null;
  statusCounts: Record<string, number>;
  text: string;
}

export interface SparkServerProjectRow {
  projectRef: ProjectRef;
  title: string;
  current: boolean;
  taskCount: number;
  unfinished: number;
  ready: number;
}

export interface SparkServerTaskListResult {
  plane: "server";
  resource: "task";
  projectRef: ProjectRef | null;
  tasks: SparkServerTaskRow[];
  text: string;
}

export interface SparkServerTaskStatusResult {
  plane: "server";
  resource: "task";
  task: SparkServerTaskRow;
  projectRef: ProjectRef;
  evidenceRefs: string[];
  text: string;
}

export interface SparkServerTaskRow {
  taskRef: TaskRef;
  name: string;
  title: string;
  status: string;
  kind: string;
  projectRef: ProjectRef;
  ready: boolean;
  claimed: boolean;
  owner?: string;
}

export interface SparkServerGoalResult {
  plane: "server";
  resource: "goal";
  goal: SparkServerGoalSummary | null;
  text: string;
}

export interface SparkServerArtifactListResult {
  plane: "server";
  resource: "artifact";
  artifacts: SparkServerArtifactSummary[];
  text: string;
}

export interface SparkServerReviewListResult {
  plane: "server";
  resource: "review";
  reviews: SparkServerReviewSummary[];
  text: string;
}

export interface SparkServerWorkflowListResult {
  plane: "server";
  resource: "workflow";
  workflows: SparkServerWorkflowSummary[];
  text: string;
}

export function parseSparkServerCliArgs(argv: string[]): SparkServerCliCommand {
  if (argv.length === 0) return { resource: "status", json: false };
  const [resourceToken, ...rest] = argv;
  if (resourceToken === "help" || resourceToken === "--help" || resourceToken === "-h") {
    return { resource: "help" };
  }
  const parsed = parseSparkCliOptions(rest);
  const json = readBooleanOption(parsed.options, "json");
  const limit = readNumberOption(parsed.options, "limit");
  const selector =
    readStringOption(parsed.options, "project") ?? readStringOption(parsed.options, "task");
  const [verb = defaultServerVerb(resourceToken), positionalSelector] = parsed.positionals;
  switch (resourceToken) {
    case "status":
      return { resource: "status", verb: "show", json, limit };
    case "project":
    case "task":
    case "goal":
    case "artifact":
    case "review":
    case "workflow":
      return {
        resource: resourceToken,
        verb,
        json,
        limit,
        selector: selector ?? positionalSelector,
      };
    case "assign": {
      const sessionId =
        readStringOption(parsed.options, "session")?.trim() || positionalSelector?.trim();
      const goal =
        readStringOption(parsed.options, "goal")?.trim() ||
        parsed.positionals
          .slice(verb === "create" || verb === "run" ? 1 : 0)
          .join(" ")
          .trim();
      return {
        resource: "assign",
        verb: verb === "create" || verb === "run" ? verb : "create",
        json,
        sessionId,
        goal: goal || undefined,
        title: readStringOption(parsed.options, "title")?.trim(),
        role: readStringOption(parsed.options, "role")?.trim(),
        workspaceId: readStringOption(parsed.options, "workspace")?.trim(),
      };
    }
    default:
      throw new Error(`unknown spark server resource: ${resourceToken}`);
  }
}

export async function handleSparkServerCliCommand(
  command: SparkServerCliCommand,
  options: SparkServerCliOptions = {},
): Promise<SparkServerCliResult> {
  if (command.resource === "help") return { action: "help", text: sparkServerHelpText() };
  const state = await loadServerState(options);
  switch (command.resource) {
    case "status":
      return { action: "status", result: await serverStatus(state, command) };
    case "project":
      return { action: "project", result: serverProject(state, command) };
    case "task":
      return { action: "task", result: serverTask(state, command) };
    case "goal":
      return { action: "goal", result: serverGoal(state) };
    case "artifact":
      return { action: "artifact", result: serverArtifacts(state, command) };
    case "review":
      return { action: "review", result: serverReviews(state, command) };
    case "workflow":
      return { action: "workflow", result: serverWorkflows(state, command) };
    case "assign":
      return { action: "assign", result: await serverAssign(command, options) };
  }
}

export async function runSparkServerCliCommand(
  command: SparkServerCliCommand,
  output: SparkCliOutput = consoleSparkCliOutput,
  options: SparkServerCliOptions = {},
): Promise<number> {
  const result = await handleSparkServerCliCommand(command, options);
  if (result.action === "help") {
    output.write(result.text);
    return 0;
  }
  if (!command.json && "text" in result.result) {
    output.write(result.result.text);
    return 0;
  }
  printSparkCliResult(output, result, { json: command.json });
  return 0;
}

export function sparkServerHelpText(): string {
  return `spark server - server coordination plane\n\nUsage:\n  spark server status [--json]\n  spark server project list [--json]\n  spark server project status <project-ref> [--json]\n  spark server task list [--project <project-ref>] [--json]\n  spark server task status <task-ref> [--json]\n  spark server goal status [--json]\n  spark server artifact list [--json]\n  spark server review list [--json]\n  spark server workflow list [--json]\n  spark server assign --session <session-id> --goal <text> [--title <text>] [--role <role>] [--workspace <id>] [--json]\n\nPlane boundary:\n  spark server is the coordination plane, not a network service in this phase.\n  Launch the Cockpit web UI with spark cockpit (not spark server).\n  Assign and IM channels share one assignment intent against daemon-owned sessions.\n  Execution controls belong under spark daemon run/session/events.\n`;
}

type LoadedServerState = SparkServerCoordinationState;

async function loadServerState(options: SparkServerCliOptions): Promise<LoadedServerState> {
  return await loadSparkServerCoordinationState(options);
}

async function serverStatus(
  state: LoadedServerState,
  command: SparkServerCliCommand,
): Promise<SparkServerStatusResult> {
  const graph = requireGraph(state.graph);
  const project = state.currentProjectRef ? findProject(graph, state.currentProjectRef) : undefined;
  const tasks = project ? graph.tasks(project.ref) : graph.tasks();
  const ready = readyTasksForServer(graph, project?.ref);
  const goal = normalizeGoalForProject(state.goal, project?.ref ?? null);
  const result: SparkServerStatusResult = {
    plane: "server",
    resource: "status",
    currentProjectRef: project?.ref ?? null,
    ...(project ? { currentProjectTitle: project.title } : {}),
    projectCount: graph.projects().length,
    taskCounts: taskCounts(tasks, ready),
    readyTasks: ready.slice(0, command.limit ?? 20).map((task) => taskRow(graph, task)),
    scope: statusScope(state, project?.ref ?? null, goal),
    goal,
    artifactCount: state.artifacts.length,
    reviewCount: state.reviews.length,
    workflowRunCount: state.workflows.length,
    text: "",
  };
  result.text = `${result.currentProjectRef ?? "no-project"} ${result.taskCounts.unfinished} unfinished ${result.taskCounts.ready} ready\n`;
  return result;
}

function serverProject(
  state: LoadedServerState,
  command: SparkServerCliCommand,
): SparkServerProjectListResult | SparkServerProjectStatusResult {
  const graph = requireGraph(state.graph);
  if ((command.verb ?? "list") === "list") {
    const projects = graph
      .projects()
      .map((project) => projectRow(graph, project, state.currentProjectRef));
    return {
      plane: "server",
      resource: "project",
      projects,
      text: projects
        .map((project) => `${project.current ? "*" : " "} ${project.projectRef} ${project.title}\n`)
        .join(""),
    };
  }
  const project = resolveProject(graph, command.selector ?? state.currentProjectRef ?? undefined);
  const tasks = graph.tasks(project.ref);
  const ready = readyTasksForServer(graph, project.ref);
  const currentClaim = tasks.find((task) => Boolean(task.claim));
  return {
    plane: "server",
    resource: "project",
    projectRef: project.ref,
    title: project.title,
    current: project.ref === state.currentProjectRef,
    readyTasks: ready.map((task) => taskRow(graph, task)),
    currentClaim: currentClaim ? taskRow(graph, currentClaim) : null,
    statusCounts: statusCounts(tasks),
    text: `${project.ref} ${project.title}: ${ready.length} ready\n`,
  };
}

function serverTask(
  state: LoadedServerState,
  command: SparkServerCliCommand,
): SparkServerTaskListResult | SparkServerTaskStatusResult {
  const graph = requireGraph(state.graph);
  if ((command.verb ?? "list") === "list") {
    const project = command.selector
      ? resolveProject(graph, command.selector)
      : state.currentProjectRef
        ? findProject(graph, state.currentProjectRef)
        : undefined;
    const tasks = (project ? graph.tasks(project.ref) : graph.tasks()).slice(
      0,
      command.limit ?? 50,
    );
    const rows = tasks.map((task) => taskRow(graph, task));
    return {
      plane: "server",
      resource: "task",
      projectRef: project?.ref ?? null,
      tasks: rows,
      text: rows.map((task) => `${task.status} ${task.taskRef} ${task.title}\n`).join(""),
    };
  }
  const task = resolveTask(graph, command.selector);
  return {
    plane: "server",
    resource: "task",
    task: taskRow(graph, task),
    projectRef: task.projectRef,
    evidenceRefs: [...(task.inputArtifacts ?? []), ...(task.outputArtifacts ?? [])],
    text: `${task.status} ${task.ref} ${task.title}\n`,
  };
}

function serverGoal(state: LoadedServerState): SparkServerGoalResult {
  const goal = normalizeGoalForProject(state.goal, state.currentProjectRef);
  return {
    plane: "server",
    resource: "goal",
    goal,
    text: goal ? `${goal.status} ${goal.objective ?? ""}\n` : "No Spark goal found.\n",
  };
}

function serverArtifacts(
  state: LoadedServerState,
  command: SparkServerCliCommand,
): SparkServerArtifactListResult {
  const artifacts = state.artifacts.slice(0, command.limit ?? 50);
  return {
    plane: "server",
    resource: "artifact",
    artifacts,
    text: artifacts.map((artifact) => `${artifact.artifactRef} ${artifact.title ?? ""}\n`).join(""),
  };
}

function serverReviews(
  state: LoadedServerState,
  command: SparkServerCliCommand,
): SparkServerReviewListResult {
  const reviews = state.reviews.slice(0, command.limit ?? 50);
  return {
    plane: "server",
    resource: "review",
    reviews,
    text: reviews
      .map((review) => `${review.reviewRef} ${review.outcome ?? review.status ?? ""}\n`)
      .join(""),
  };
}

function serverWorkflows(
  state: LoadedServerState,
  command: SparkServerCliCommand,
): SparkServerWorkflowListResult {
  const workflows = state.workflows.slice(0, command.limit ?? 50);
  return {
    plane: "server",
    resource: "workflow",
    workflows,
    text: workflows
      .map((workflow) => `${workflow.runRef} ${workflow.status ?? ""} ${workflow.name ?? ""}\n`)
      .join(""),
  };
}

function normalizeGoalForProject(
  goal: SparkServerGoalSummary | null,
  currentProjectRef: ProjectRef | null,
): SparkServerGoalSummary | null {
  if (!goal) return null;
  const current = Boolean(
    goal.projectRef && currentProjectRef && goal.projectRef === currentProjectRef,
  );
  const source: SparkServerGoalSource = goal.projectRef
    ? current
      ? "current-project"
      : "unrelated-project"
    : "legacy-unscoped";
  return { ...goal, current, source };
}

function statusScope(
  state: LoadedServerState,
  selectedProjectRef: ProjectRef | null,
  goal: SparkServerGoalSummary | null,
): SparkServerStatusScope {
  return {
    selectedWorkspace: state.cwd,
    selectedSessionKey: goal?.current
      ? (goal.sessionKey ?? state.currentSessionKey)
      : state.currentSessionKey,
    selectedProjectRef,
    goalSource: goal?.source ?? "none",
  };
}

function defaultServerVerb(resource: string): string {
  return resource === "status" || resource === "goal" ? "status" : "list";
}

function requireGraph(graph: TaskGraph | null): TaskGraph {
  if (!graph) throw new Error("Spark server coordination state not found: .spark/projects");
  return graph;
}

function resolveProject(graph: TaskGraph, selector: string | undefined): Project {
  if (!selector) {
    const first = graph.projects()[0];
    if (!first) throw new Error("no Spark projects found");
    return first;
  }
  const project = graph
    .projects()
    .find((candidate) => candidate.ref === selector || candidate.title === selector);
  if (!project) throw new Error(`unknown project: ${selector}`);
  return project;
}

function findProject(graph: TaskGraph, ref: ProjectRef): Project | undefined {
  return graph.projects().find((project) => project.ref === ref);
}

async function serverAssign(
  command: SparkServerCliCommand,
  options: SparkServerCliOptions,
): Promise<SparkServerAssignResult> {
  const sessionId = command.sessionId?.trim();
  const goal = command.goal?.trim();
  if (!sessionId) throw new Error("spark server assign requires --session <session-id>");
  if (!goal) throw new Error("spark server assign requires --goal <text>");

  const sparkHome = options.daemonClient?.sparkHome ?? options.sparkHome;
  const session = await clientGetManagedSession(sessionId, {
    ...(options.daemonClient ?? {}),
    ...(sparkHome ? { sparkHome } : {}),
  });
  if (session.status === "archived") {
    throw new Error(`cannot assign to archived session: ${sessionId}`);
  }

  const role = command.role?.trim();
  const title = command.title?.trim();
  const assignment = parseSparkAssignment({
    goal,
    target: {
      sessionId,
      ...(role ? { role } : {}),
      workspaceId: command.workspaceId?.trim() || session.workspaceId,
    },
    constraints: [],
    evidence: [],
    source: { kind: "cli" },
    ...(title ? { title } : {}),
  });
  const assignmentId = createId("asn");
  const daemonClient: SparkDaemonClientOptions = {
    ...(options.daemonClient ?? {}),
    ...(sparkHome ? { sparkHome } : {}),
  };
  const submitted = await handleSparkDaemonCliCommand(
    {
      action: "submit",
      json: true,
      sessionId,
      prompt: goal,
      assignment,
    },
    daemonClient,
  );
  if (submitted.action !== "submit") {
    throw new Error("spark server assign expected daemon submit result");
  }

  return {
    plane: "server",
    resource: "assign",
    assignmentId,
    sessionId,
    goal,
    status: "queued",
    commandKind: "assignment.create.request",
    text: `queued assignment ${assignmentId} -> session ${sessionId} (${submitted.result.fileName})\n`,
  };
}

function resolveTask(graph: TaskGraph, selector: string | undefined): Task {
  if (!selector) throw new Error("task status requires a task ref, name, or title");
  const task = graph
    .tasks()
    .find(
      (candidate) =>
        candidate.ref === selector || candidate.name === selector || candidate.title === selector,
    );
  if (!task) throw new Error(`unknown task: ${selector}`);
  return task;
}

function projectRow(
  graph: TaskGraph,
  project: Project,
  currentProjectRef: ProjectRef | null,
): SparkServerProjectRow {
  const tasks = graph.tasks(project.ref);
  const ready = readyTasksForServer(graph, project.ref);
  return {
    projectRef: project.ref,
    title: project.title,
    current: project.ref === currentProjectRef,
    taskCount: tasks.length,
    unfinished: tasks.filter((task) => task.status !== "done" && task.status !== "cancelled")
      .length,
    ready: ready.length,
  };
}

function taskRow(graph: TaskGraph, task: Task): SparkServerTaskRow {
  return {
    taskRef: task.ref,
    name: task.name,
    title: task.title,
    status: task.status,
    kind: task.kind,
    projectRef: task.projectRef,
    ready: readyTasksForServer(graph, task.projectRef).some((ready) => ready.ref === task.ref),
    claimed: Boolean(task.claim),
    ...(task.claim?.claimedBy ? { owner: task.claim.claimedBy } : {}),
  };
}

function readyTasksForServer(graph: TaskGraph, projectRef?: ProjectRef): Task[] {
  const byRef = new Map<TaskRef, Task>();
  for (const task of graph.readyTasks(projectRef)) byRef.set(task.ref, task);
  for (const task of graph.tasks(projectRef)) {
    if (task.status === "ready") byRef.set(task.ref, task);
  }
  return [...byRef.values()];
}

function taskCounts(tasks: Task[], ready: Task[]): SparkServerTaskCounts {
  return {
    total: tasks.length,
    unfinished: tasks.filter((task) => task.status !== "done" && task.status !== "cancelled")
      .length,
    ready: ready.length,
    done: tasks.filter((task) => task.status === "done").length,
    claimed: tasks.filter((task) => Boolean(task.claim)).length,
  };
}

function statusCounts(tasks: Task[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}
