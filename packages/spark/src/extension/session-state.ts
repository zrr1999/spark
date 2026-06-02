import { defaultTaskGraphStore, defaultTaskTodoStore, type TaskGraph } from "spark-tasks";
import { sparkSessionKey, type SparkSessionContext } from "./session-identity.ts";

export {
  clearCurrentProjectRef,
  clearSparkExecutionMode,
  currentSparkProject,
  loadCurrentProjectRef,
  loadCurrentProjectState,
  loadSparkExecutionMode,
  loadSparkRunMode,
  saveCurrentProjectRef,
  saveSparkExecutionMode,
  saveSparkPlanningMode,
  saveSparkRunMode,
  sparkRunStrategyForMaxConcurrency,
  sparkRunStrategyMaxConcurrency,
  updateSparkRunModeStatus,
  type CurrentProjectStoreSnapshot,
  type SparkAgentMode,
  type SparkExecuteStrategy,
  type SparkExecutionBudget,
  type SparkExecutionModeState,
  type SparkPlanningModeSource,
  type SparkPlanningModeState,
  type SparkRunModeState,
  type SparkRunModeStatus,
  type SparkRunStrategy,
} from "./current-project-state.ts";
export {
  loadHiddenRoleRunInboxState,
  saveHiddenRoleRunInboxState,
  type HiddenRoleRunInboxState,
} from "./hidden-role-run-inbox.ts";
export { writeJsonFileAtomic } from "./json-store.ts";
export {
  sanitizeStoreScope,
  sparkSessionKey,
  sparkSessionOwnerKey,
  type SparkSessionContext,
} from "./session-identity.ts";

export async function loadSparkGraph(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<TaskGraph | null> {
  const graph = await defaultTaskGraphStore(cwd).load();
  if (!graph) return null;
  await sparkTodoStore(cwd, ctx).hydrate(graph);
  return graph;
}

export function sparkTodoStore(
  cwd: string,
  ctx?: SparkSessionContext,
): ReturnType<typeof defaultTaskTodoStore> {
  return defaultTaskTodoStore(cwd, sparkSessionKey(ctx));
}
