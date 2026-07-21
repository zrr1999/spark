export * from "./common.ts";
export * from "./display.ts";
export * from "./graph.ts";
export * from "./graph-store.ts";
export * from "./todo-store.ts";
export {
  applyIndependentTodoOps,
  assertAcyclic,
  collectNonConcreteTaskIssues,
  decideTaskPlanBeforeCreate,
  independentTodoDisplayKey,
  isActiveSessionTodo,
  isDeletedSessionTodo,
  isUnfinishedTaskStatus,
  normalizeTaskPlan,
  renderNonConcreteTaskIssues,
  renderTaskPlanReadinessRules,
  taskCompletionReadiness,
  taskPlanReadiness,
  TASK_PLAN_READINESS_RULES,
} from "./internal.ts";
export type { TaskPlanReadinessRule } from "./internal.ts";

export type {
  SparkTaskAction,
  SparkTaskActionHandler,
  SparkTaskToolHandlers,
  SparkTaskToolResult,
  SparkTodoAction,
  SparkTodoToolOptions,
} from "./extension.ts";
export {
  registerSparkTaskTool,
  registerSparkTodoTool,
  normalizeSparkTodoAction,
} from "./extension.ts";
