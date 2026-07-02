import {
  formatPiTaskActiveStatusLine,
  formatPiTaskStatusCounts,
  piTaskDisplayHandle,
  piTaskDisplayTitle,
} from "@zendev-lab/spark-tasks";

export interface CockpitProjectDisplayInput {
  name: string;
}

export interface CockpitProjectKindDisplayInput {
  badge?: string;
}

export interface CockpitTaskDisplayInput {
  runtimeTaskId: string;
  name: string | null;
  title: string;
  status: string;
  statusGroup: string;
  kind: string | null;
  agentRef: string | null;
  readyFrontier: boolean;
}

export interface CockpitTaskSummaryDisplayInput {
  total: number;
  byStatus: Record<string, number>;
}

export interface CockpitProjectTaskDisplayModel {
  projectLine: string;
  taskCountsLine: string;
  readyFrontierCount: number;
  tasks: CockpitTaskDisplayModel[];
  tasksByRuntimeId: Record<string, CockpitTaskDisplayModel>;
}

export interface CockpitTaskDisplayModel {
  runtimeTaskId: string;
  handle: string;
  title: string;
  statusLine: string;
  owner: string;
  kind: string;
  readyFrontier: boolean;
}

export function buildCockpitProjectTaskDisplay(input: {
  project: CockpitProjectDisplayInput;
  projectKind?: CockpitProjectKindDisplayInput | null;
  tasks: CockpitTaskDisplayInput[];
  taskSummary: CockpitTaskSummaryDisplayInput;
}): CockpitProjectTaskDisplayModel {
  const tasks = input.tasks.map(buildCockpitTaskDisplay);
  const tasksByRuntimeId = Object.fromEntries(tasks.map((task) => [task.runtimeTaskId, task]));
  const readyFrontierCount = tasks.filter((task) => task.readyFrontier).length;
  const claimedCount = tasks.filter(
    (task) => task.owner !== "unassigned" && task.owner !== "me",
  ).length;
  const kindSuffix = input.projectKind?.badge ? ` [${input.projectKind.badge}]` : "";
  return {
    projectLine: `Project ${input.project.name}${kindSuffix}`,
    taskCountsLine: `Tasks: ${input.taskSummary.total} total | ${claimedCount} claimed | 0 current_session_claimed | ready_frontier=${readyFrontierCount} | ${formatPiTaskStatusCounts(
      input.taskSummary.byStatus,
    )}`,
    readyFrontierCount,
    tasks,
    tasksByRuntimeId,
  };
}

export function buildCockpitTaskDisplay(task: CockpitTaskDisplayInput): CockpitTaskDisplayModel {
  const identity = {
    ref: task.runtimeTaskId,
    runtimeTaskId: task.runtimeTaskId,
    name: task.name,
    title: task.title,
    status: task.status,
  };
  const owner = taskOwnerLabel(task);
  return {
    runtimeTaskId: task.runtimeTaskId,
    handle: piTaskDisplayHandle(identity),
    title: piTaskDisplayTitle(identity),
    statusLine: formatPiTaskActiveStatusLine({
      task: identity,
      owner,
      readyFrontier: task.readyFrontier,
    }),
    owner,
    kind: task.kind ?? "generic",
    readyFrontier: task.readyFrontier,
  };
}

function taskOwnerLabel(task: CockpitTaskDisplayInput): string {
  const agent = task.agentRef?.trim();
  if (agent) return agent;
  if (task.statusGroup === "done") return "me";
  return "unassigned";
}
