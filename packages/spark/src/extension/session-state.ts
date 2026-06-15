import { defaultTaskGraphStore, defaultTaskTodoStore, type TaskGraph } from "@zendev-lab/pi-tasks";
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
  clearSparkMode,
  loadSparkMode,
  nextSparkSessionMode,
  saveSparkMode,
  SPARK_SESSION_MODE_CYCLE,
  type SparkSessionMode,
  type SparkSessionModeInput,
  type SparkSessionModeState,
} from "./mode-state.ts";
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

export async function saveSparkGraphAndTodos(
  cwd: string,
  graph: TaskGraph,
  ctx?: SparkSessionContext,
  store = defaultTaskGraphStore(cwd),
): Promise<void> {
  await store.withLock(async () => {
    await store.save(graph);
    await sparkTodoStore(cwd, ctx).save(graph);
  });
}

export function sparkTodoStore(
  cwd: string,
  ctx?: SparkSessionContext,
): ReturnType<typeof defaultTaskTodoStore> {
  return defaultTaskTodoStore(cwd, sparkSessionKey(ctx));
}
