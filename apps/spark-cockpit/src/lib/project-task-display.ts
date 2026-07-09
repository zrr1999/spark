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
    taskCountsLine: `Tasks: ${input.taskSummary.total} total | ${claimedCount} claimed | ready_frontier=${readyFrontierCount} | ${formatTaskStatusCounts(
      input.taskSummary.byStatus,
    )}`,
    readyFrontierCount,
    tasks,
    tasksByRuntimeId,
  };
}

export function buildCockpitTaskDisplay(task: CockpitTaskDisplayInput): CockpitTaskDisplayModel {
  const handle = taskDisplayHandle(task);
  const owner = taskOwnerLabel(task);
  const readyLabel = task.readyFrontier ? "ready frontier" : null;
  const metaParts = [task.status, owner !== "unassigned" ? `@${owner}` : null, readyLabel].filter(
    Boolean,
  );
  return {
    runtimeTaskId: task.runtimeTaskId,
    handle,
    title: task.title,
    statusLine: metaParts.join(" · "),
    owner,
    kind: task.kind ?? "generic",
    readyFrontier: task.readyFrontier,
  };
}

function taskDisplayHandle(task: CockpitTaskDisplayInput): string {
  const named = task.name?.trim();
  if (named) return named.startsWith("@") ? named : `@${named}`;
  return "task";
}

function taskOwnerLabel(task: CockpitTaskDisplayInput): string {
  const agent = task.agentRef?.trim();
  if (agent) return agent;
  if (task.statusGroup === "done") return "me";
  return "unassigned";
}

function formatTaskStatusCounts(counts: Record<string, number>): string {
  const order = ["running", "blocked", "pending", "ready", "failed", "done", "cancelled"];
  const parts = order.flatMap((status) => {
    const count = counts[status] ?? 0;
    return count > 0 ? [`${status}=${count}`] : [];
  });
  return parts.length > 0 ? parts.join(" ") : "none";
}
