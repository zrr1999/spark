import type { ProjectRef, Task } from "@zendev-lab/pi-extension-api";
import { isUnfinishedTaskStatus, type TaskGraph } from "@zendev-lab/pi-tasks";
import type { SparkEntryMode } from "./spark-entry.ts";

export function suggestForegroundGoalMode(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef | undefined,
  objective: string,
): SparkEntryMode {
  const normalized = objective.trim();
  if (!selectedProjectRef) return "plan";

  const frontier = selectedProjectForegroundState(graph, selectedProjectRef);
  if (frontier.ready > 0) return "implement";
  if (frontier.unfinished > 0) return foregroundUnfinishedTaskMode(frontier.unfinishedTasks);
  if (emptyFrontierNeedsPlanning(normalized)) return "plan";

  if (foregroundPlanIntent(normalized)) return "plan";
  if (foregroundImplementIntent(normalized)) return "implement";
  if (foregroundResearchIntent(normalized)) return "research";
  return "implement";
}

interface ForegroundProjectState {
  ready: number;
  unfinished: number;
  unfinishedTasks: Task[];
}

function selectedProjectForegroundState(
  graph: TaskGraph,
  selectedProjectRef: ProjectRef,
): ForegroundProjectState {
  const unfinishedTasks = graph
    .tasks(selectedProjectRef)
    .filter((task) => isUnfinishedTaskStatus(task.status));
  return {
    ready: graph.readyTasks(selectedProjectRef).length,
    unfinished: unfinishedTasks.length,
    unfinishedTasks,
  };
}

export function foregroundUnfinishedTaskMode(tasks: readonly Pick<Task, "kind">[]): SparkEntryMode {
  if (tasks.length === 0) return "implement";
  if (tasks.some((task) => task.kind === "implement" || task.kind === "generic")) {
    return "implement";
  }
  if (tasks.some((task) => task.kind !== "research" && task.kind !== "review")) {
    return "implement";
  }
  return "research";
}

function emptyFrontierNeedsPlanning(objective: string): boolean {
  if (foregroundPlanIntent(objective)) return true;
  return foregroundResearchIntent(objective) && foregroundProgressOrCreationIntent(objective);
}

function foregroundResearchIntent(objective: string): boolean {
  return /(调研|研究|审阅|review|research|investigate|inspect|audit)/iu.test(objective);
}

function foregroundPlanIntent(objective: string): boolean {
  return /(规划|计划|拆分|创建(任务|计划|项目)?|生成(任务|计划)?|plan|clarify|decompose|break down|create tasks?|task creation)/iu.test(
    objective,
  );
}

function foregroundImplementIntent(objective: string): boolean {
  return /(执行|完成|修复|继续|跑完|ready queue|until done|finish|fix|implement|execute)/iu.test(
    objective,
  );
}

function foregroundProgressOrCreationIntent(objective: string): boolean {
  return /(不断|持续|继续|推进|优化|改进|完善|创建|拆分|任务|完成(任务|它们|这些|全部|所有|队列)|ongoing|continue|progress|optimise|optimize|improve|create|task|finish (tasks|queue|them|all)|complete (tasks|queue|them|all))/iu.test(
    objective,
  );
}
