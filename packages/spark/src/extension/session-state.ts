import { defaultTaskGraphStore, defaultTaskTodoStore, type TaskGraph } from "@zendev-lab/pi-tasks";
import { sparkSessionKey, type SparkSessionContext } from "./session-identity.ts";

export {
  clearCurrentProjectRef,
  currentSparkProject,
  currentProjectStorePath,
  importLegacyCurrentProjectState,
  loadCurrentProjectRef,
  loadCurrentProjectState,
  saveCurrentProjectRef,
  sparkRunStrategyForMaxConcurrency,
  sparkRunStrategyMaxConcurrency,
  type CurrentProjectStoreSnapshot,
  type SparkAgentMode,
  type SparkPlanningModeSource,
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
  importLegacyHiddenRoleRunInboxState,
  loadHiddenRoleRunInboxState,
  saveHiddenRoleRunInboxState,
  type HiddenRoleRunInboxState,
} from "./hidden-role-run-inbox.ts";
export { importLegacySessionGoal } from "./spark-session-goals.ts";
export { importLegacySessionLoop } from "./spark-session-loops.ts";
export { importLegacyTodoDisplayNumberState } from "./session-todos.ts";
export { writeJsonFileAtomic } from "./json-store.ts";
export {
  currentSessionDirectoryName,
  rebuildSessionIndex,
  sessionDirectoryPath,
  sessionHiddenRoleRunInboxStorePath,
  sessionIndexStorePath,
  sessionLoopStorePathV2,
  sessionGoalStorePathV2,
  sessionStateStorePath,
  sessionTodoDisplayNumberStorePath,
  type SparkSessionIndexEntry,
  type SparkSessionIndexSnapshot,
} from "./session-directory-store.ts";
export {
  sanitizeStoreScope,
  sparkSessionKey,
  sparkSessionOwnerKey,
  type SparkSessionContext,
} from "./session-identity.ts";

export async function loadSparkGraph(
  cwd: string,
  _ctx?: SparkSessionContext,
): Promise<TaskGraph | null> {
  return defaultTaskGraphStore(cwd).load();
}

export async function saveSparkGraphAndTodos(
  cwd: string,
  graph: TaskGraph,
  _ctx?: SparkSessionContext,
  store = defaultTaskGraphStore(cwd),
): Promise<void> {
  await store.withLock(async () => {
    await store.save(graph);
  });
}

export function sparkTodoStore(
  cwd: string,
  ctx?: SparkSessionContext,
): ReturnType<typeof defaultTaskTodoStore> {
  return defaultTaskTodoStore(cwd, sparkSessionKey(ctx));
}
