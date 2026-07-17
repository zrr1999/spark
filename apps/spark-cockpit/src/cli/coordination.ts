import { type TaskGraph } from "@zendev-lab/spark-tasks";
import type { Project, ProjectRef, Task, TaskRef } from "@zendev-lab/spark-extension-api";
import { createId, parseSparkAssignment } from "@zendev-lab/spark-protocol";

import {
  consoleSparkCliErrorOutput,
  consoleSparkCliOutput,
  parseSparkCliOptions,
  printSparkCliResult,
  readBooleanOption,
  readNumberOption,
  readStringOption,
  type SparkCliOutput,
} from "./shared.ts";
import type {
  CockpitInstanceCliFailure,
  CockpitInstanceCliOptions,
  CockpitInstanceCliResult,
} from "./instance.ts";
import {
  loadSparkCockpitCoordinationState,
  type SparkCockpitCoordinationState,
} from "./coordination-adapter.ts";
import {
  getManagedSession,
  submitAssignment,
  type CockpitCoordinationDaemonClientOptions,
} from "./coordination-daemon.ts";

export type SparkCockpitCliResource =
  | "help"
  | "status"
  | "project"
  | "task"
  | "goal"
  | "artifact"
  | "review"
  | "workflow"
  | "assign"
  | "instance";

export interface SparkCockpitCliCommand {
  resource: SparkCockpitCliResource;
  verb?: string;
  json?: boolean;
  selector?: string;
  limit?: number;
  sessionId?: string;
  goal?: string;
  title?: string;
  role?: string;
  workspaceId?: string;
  snapshotPath?: string;
  databasePath?: string;
  rollbackRoot?: string;
  yes?: boolean;
}

export interface SparkCockpitCliOptions {
  cwd?: string;
  daemonClient?: CockpitCoordinationDaemonClientOptions;
  graph?: TaskGraph | null;
  currentProjectRef?: ProjectRef;
  currentSessionKey?: string | null;
  goal?: SparkCockpitGoalSummary | null;
  artifacts?: SparkCockpitArtifactSummary[];
  reviews?: SparkCockpitReviewSummary[];
  workflows?: SparkCockpitWorkflowSummary[];
  instance?: CockpitInstanceCliOptions;
}

export type SparkCockpitGoalSource =
  | "none"
  | "current-project"
  | "unrelated-project"
  | "legacy-unscoped";

export interface SparkCockpitGoalSummary {
  status: string;
  objective?: string;
  goalId?: string;
  sessionKey?: string;
  projectRef?: ProjectRef;
  source?: SparkCockpitGoalSource;
  current?: boolean;
}

export interface SparkCockpitArtifactSummary {
  artifactRef: string;
  title?: string;
  kind?: string;
  status?: string;
}

export interface SparkCockpitReviewSummary {
  reviewRef: string;
  status?: string;
  targetRef?: string;
  outcome?: string;
}

export interface SparkCockpitWorkflowSummary {
  runRef: string;
  status?: string;
  name?: string;
}

export type SparkCockpitCliResult =
  | { action: "help"; text: string }
  | { action: "status"; result: SparkCockpitStatusResult }
  | { action: "project"; result: SparkCockpitProjectListResult | SparkCockpitProjectStatusResult }
  | { action: "task"; result: SparkCockpitTaskListResult | SparkCockpitTaskStatusResult }
  | { action: "goal"; result: SparkCockpitGoalResult }
  | { action: "artifact"; result: SparkCockpitArtifactListResult }
  | { action: "review"; result: SparkCockpitReviewListResult }
  | { action: "workflow"; result: SparkCockpitWorkflowListResult }
  | { action: "assign"; result: SparkCockpitAssignResult }
  | { action: "instance"; result: CockpitInstanceCliResult };

export interface SparkCockpitAssignResult {
  plane: "cockpit";
  resource: "assign";
  assignmentId: string;
  sessionId: string;
  goal: string;
  status: string;
  commandKind: "assignment.create.request";
  text: string;
}

export interface SparkCockpitStatusResult {
  plane: "cockpit";
  resource: "status";
  currentProjectRef: ProjectRef | null;
  currentProjectTitle?: string;
  projectCount: number;
  taskCounts: SparkCockpitTaskCounts;
  readyTasks: SparkCockpitTaskRow[];
  scope: SparkCockpitStatusScope;
  goal?: SparkCockpitGoalSummary | null;
  artifactCount: number;
  reviewCount: number;
  workflowRunCount: number;
  text: string;
}

export interface SparkCockpitStatusScope {
  selectedWorkspace: string;
  selectedSessionKey: string | null;
  selectedProjectRef: ProjectRef | null;
  goalSource: SparkCockpitGoalSource;
}

export interface SparkCockpitTaskCounts {
  total: number;
  unfinished: number;
  ready: number;
  done: number;
  claimed: number;
}

export interface SparkCockpitProjectListResult {
  plane: "cockpit";
  resource: "project";
  projects: SparkCockpitProjectRow[];
  text: string;
}

export interface SparkCockpitProjectStatusResult {
  plane: "cockpit";
  resource: "project";
  projectRef: ProjectRef;
  title: string;
  current: boolean;
  readyTasks: SparkCockpitTaskRow[];
  currentClaim: SparkCockpitTaskRow | null;
  statusCounts: Record<string, number>;
  text: string;
}

export interface SparkCockpitProjectRow {
  projectRef: ProjectRef;
  title: string;
  current: boolean;
  taskCount: number;
  unfinished: number;
  ready: number;
}

export interface SparkCockpitTaskListResult {
  plane: "cockpit";
  resource: "task";
  projectRef: ProjectRef | null;
  tasks: SparkCockpitTaskRow[];
  text: string;
}

export interface SparkCockpitTaskStatusResult {
  plane: "cockpit";
  resource: "task";
  task: SparkCockpitTaskRow;
  projectRef: ProjectRef;
  evidenceRefs: string[];
  text: string;
}

export interface SparkCockpitTaskRow {
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

export interface SparkCockpitGoalResult {
  plane: "cockpit";
  resource: "goal";
  goal: SparkCockpitGoalSummary | null;
  text: string;
}

export interface SparkCockpitArtifactListResult {
  plane: "cockpit";
  resource: "artifact";
  artifacts: SparkCockpitArtifactSummary[];
  text: string;
}

export interface SparkCockpitReviewListResult {
  plane: "cockpit";
  resource: "review";
  reviews: SparkCockpitReviewSummary[];
  text: string;
}

export interface SparkCockpitWorkflowListResult {
  plane: "cockpit";
  resource: "workflow";
  workflows: SparkCockpitWorkflowSummary[];
  text: string;
}

export function parseSparkCockpitCliArgs(argv: string[]): SparkCockpitCliCommand {
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
  const [verb = defaultCockpitVerb(resourceToken), positionalSelector] = parsed.positionals;
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
    case "instance":
      return {
        resource: "instance",
        verb,
        json,
        snapshotPath:
          readStringOption(parsed.options, "snapshot")?.trim() || positionalSelector?.trim(),
        databasePath: readStringOption(parsed.options, "database")?.trim(),
        rollbackRoot: readStringOption(parsed.options, "rollback-root")?.trim(),
        yes: readBooleanOption(parsed.options, "yes") || readBooleanOption(parsed.options, "y"),
      };
    default:
      throw new Error(`unknown spark cockpit resource: ${resourceToken}`);
  }
}

export async function handleSparkCockpitCliCommand(
  command: SparkCockpitCliCommand,
  options: SparkCockpitCliOptions = {},
): Promise<SparkCockpitCliResult> {
  if (command.resource === "help") return { action: "help", text: sparkCockpitHelpText() };
  if (command.resource === "instance") {
    const { handleCockpitInstanceCliCommand } = await import("./instance.ts");
    return {
      action: "instance",
      result: await handleCockpitInstanceCliCommand(
        {
          operation: command.verb ?? "status",
          snapshotPath: command.snapshotPath,
          databasePath: command.databasePath,
          rollbackRoot: command.rollbackRoot,
          yes: command.yes,
        },
        options.instance,
      ),
    };
  }
  const state = await loadCockpitState(options);
  switch (command.resource) {
    case "status":
      return { action: "status", result: await cockpitStatus(state, command) };
    case "project":
      return { action: "project", result: cockpitProject(state, command) };
    case "task":
      return { action: "task", result: cockpitTask(state, command) };
    case "goal":
      return { action: "goal", result: cockpitGoal(state) };
    case "artifact":
      return { action: "artifact", result: cockpitArtifacts(state, command) };
    case "review":
      return { action: "review", result: cockpitReviews(state, command) };
    case "workflow":
      return { action: "workflow", result: cockpitWorkflows(state, command) };
    case "assign":
      return { action: "assign", result: await cockpitAssign(command, options) };
  }
}

export async function runSparkCockpitCliCommand(
  command: SparkCockpitCliCommand,
  output: SparkCliOutput = consoleSparkCliOutput,
  options: SparkCockpitCliOptions = {},
  errorOutput: SparkCliOutput = consoleSparkCliErrorOutput,
): Promise<number> {
  try {
    const result = await handleSparkCockpitCliCommand(command, options);
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
  } catch (error) {
    const instanceFailure = readCockpitInstanceFailure(error);
    if (!instanceFailure) throw error;
    const failure = { action: "error", error: instanceFailure } as const;
    if (command.json) {
      printSparkCliResult(errorOutput, failure, { json: true });
    } else {
      errorOutput.write(`${instanceFailure.code}: ${instanceFailure.message}\n`);
    }
    return instanceFailure.exitCode;
  }
}

function readCockpitInstanceFailure(error: unknown): CockpitInstanceCliFailure | null {
  if (!(error instanceof Error) || error.name !== "CockpitInstanceCliError") return null;
  const failure = (error as Error & { failure?: unknown }).failure;
  if (!failure || typeof failure !== "object") return null;
  const candidate = failure as Partial<CockpitInstanceCliFailure>;
  return typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.exitCode === "number"
    ? (candidate as CockpitInstanceCliFailure)
    : null;
}

export function sparkCockpitHelpText(): string {
  return `spark cockpit - Spark cross-daemon coordination CLI\n\nUsage:\n  spark cockpit status [--json]\n  spark cockpit project list [--json]\n  spark cockpit project status <project-ref> [--json]\n  spark cockpit task list [--project <project-ref>] [--json]\n  spark cockpit task status <task-ref> [--json]\n  spark cockpit goal status [--json]\n  spark cockpit artifact list [--json]\n  spark cockpit review list [--json]\n  spark cockpit workflow list [--json]\n  spark cockpit assign --session <session-id> --goal <text> [--title <text>] [--role <role>] [--workspace <id>] [--json]\n  spark cockpit instance status [--database <path>] [--json]\n  spark cockpit instance backup [snapshot-path] [--database <path>] [--json]\n  spark cockpit instance inspect <snapshot-path> [--json]\n  spark cockpit instance restore <snapshot-path> [--database <path>] [--rollback-root <path>] [--yes] [--json]\n\nThese commands use Cockpit coordination without starting the Web host.\nInstance restore replaces the complete Cockpit database and requires confirmation.\nExecution controls belong under spark daemon run/session/events.\n`;
}

type LoadedCockpitState = SparkCockpitCoordinationState;

async function loadCockpitState(options: SparkCockpitCliOptions): Promise<LoadedCockpitState> {
  return await loadSparkCockpitCoordinationState(options);
}

async function cockpitStatus(
  state: LoadedCockpitState,
  command: SparkCockpitCliCommand,
): Promise<SparkCockpitStatusResult> {
  const graph = requireGraph(state.graph);
  const project = state.currentProjectRef ? findProject(graph, state.currentProjectRef) : undefined;
  const tasks = project ? graph.tasks(project.ref) : graph.tasks();
  const ready = readyTasksForServer(graph, project?.ref);
  const goal = normalizeGoalForProject(state.goal, project?.ref ?? null);
  const result: SparkCockpitStatusResult = {
    plane: "cockpit",
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

function cockpitProject(
  state: LoadedCockpitState,
  command: SparkCockpitCliCommand,
): SparkCockpitProjectListResult | SparkCockpitProjectStatusResult {
  const graph = requireGraph(state.graph);
  if ((command.verb ?? "list") === "list") {
    const projects = graph
      .projects()
      .map((project) => projectRow(graph, project, state.currentProjectRef));
    return {
      plane: "cockpit",
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
    plane: "cockpit",
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

function cockpitTask(
  state: LoadedCockpitState,
  command: SparkCockpitCliCommand,
): SparkCockpitTaskListResult | SparkCockpitTaskStatusResult {
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
      plane: "cockpit",
      resource: "task",
      projectRef: project?.ref ?? null,
      tasks: rows,
      text: rows.map((task) => `${task.status} ${task.taskRef} ${task.title}\n`).join(""),
    };
  }
  const task = resolveTask(graph, command.selector);
  return {
    plane: "cockpit",
    resource: "task",
    task: taskRow(graph, task),
    projectRef: task.projectRef,
    evidenceRefs: [...(task.inputArtifacts ?? []), ...(task.outputArtifacts ?? [])],
    text: `${task.status} ${task.ref} ${task.title}\n`,
  };
}

function cockpitGoal(state: LoadedCockpitState): SparkCockpitGoalResult {
  const goal = normalizeGoalForProject(state.goal, state.currentProjectRef);
  return {
    plane: "cockpit",
    resource: "goal",
    goal,
    text: goal ? `${goal.status} ${goal.objective ?? ""}\n` : "No Spark goal found.\n",
  };
}

function cockpitArtifacts(
  state: LoadedCockpitState,
  command: SparkCockpitCliCommand,
): SparkCockpitArtifactListResult {
  const artifacts = state.artifacts.slice(0, command.limit ?? 50);
  return {
    plane: "cockpit",
    resource: "artifact",
    artifacts,
    text: artifacts.map((artifact) => `${artifact.artifactRef} ${artifact.title ?? ""}\n`).join(""),
  };
}

function cockpitReviews(
  state: LoadedCockpitState,
  command: SparkCockpitCliCommand,
): SparkCockpitReviewListResult {
  const reviews = state.reviews.slice(0, command.limit ?? 50);
  return {
    plane: "cockpit",
    resource: "review",
    reviews,
    text: reviews
      .map((review) => `${review.reviewRef} ${review.outcome ?? review.status ?? ""}\n`)
      .join(""),
  };
}

function cockpitWorkflows(
  state: LoadedCockpitState,
  command: SparkCockpitCliCommand,
): SparkCockpitWorkflowListResult {
  const workflows = state.workflows.slice(0, command.limit ?? 50);
  return {
    plane: "cockpit",
    resource: "workflow",
    workflows,
    text: workflows
      .map((workflow) => `${workflow.runRef} ${workflow.status ?? ""} ${workflow.name ?? ""}\n`)
      .join(""),
  };
}

function normalizeGoalForProject(
  goal: SparkCockpitGoalSummary | null,
  currentProjectRef: ProjectRef | null,
): SparkCockpitGoalSummary | null {
  if (!goal) return null;
  const current = Boolean(
    goal.projectRef && currentProjectRef && goal.projectRef === currentProjectRef,
  );
  const source: SparkCockpitGoalSource = goal.projectRef
    ? current
      ? "current-project"
      : "unrelated-project"
    : "legacy-unscoped";
  return { ...goal, current, source };
}

function statusScope(
  state: LoadedCockpitState,
  selectedProjectRef: ProjectRef | null,
  goal: SparkCockpitGoalSummary | null,
): SparkCockpitStatusScope {
  return {
    selectedWorkspace: state.cwd,
    selectedSessionKey: goal?.current
      ? (goal.sessionKey ?? state.currentSessionKey)
      : state.currentSessionKey,
    selectedProjectRef,
    goalSource: goal?.source ?? "none",
  };
}

function defaultCockpitVerb(resource: string): string {
  return resource === "status" || resource === "goal" || resource === "instance"
    ? "status"
    : "list";
}

function requireGraph(graph: TaskGraph | null): TaskGraph {
  if (!graph) throw new Error("Spark cockpit coordination state not found: .spark/projects");
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

async function cockpitAssign(
  command: SparkCockpitCliCommand,
  options: SparkCockpitCliOptions,
): Promise<SparkCockpitAssignResult> {
  const sessionId = command.sessionId?.trim();
  const goal = command.goal?.trim();
  if (!sessionId) throw new Error("spark cockpit assign requires --session <session-id>");
  if (!goal) throw new Error("spark cockpit assign requires --goal <text>");

  const session = await getManagedSession(sessionId, options.daemonClient);
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
  const submitted = await submitAssignment(
    { sessionId, prompt: goal, assignment },
    options.daemonClient,
  );

  return {
    plane: "cockpit",
    resource: "assign",
    assignmentId,
    sessionId,
    goal,
    status: submitted.status,
    commandKind: "assignment.create.request",
    text: `queued assignment ${assignmentId} -> session ${sessionId} (${submitted.invocationId})\n`,
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
): SparkCockpitProjectRow {
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

function taskRow(graph: TaskGraph, task: Task): SparkCockpitTaskRow {
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

function taskCounts(tasks: Task[], ready: Task[]): SparkCockpitTaskCounts {
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
