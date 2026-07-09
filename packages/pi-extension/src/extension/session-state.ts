import {
  defaultTaskGraphStore,
  defaultTaskTodoStore,
  type TaskGraph,
} from "@zendev-lab/spark-tasks";
import { sparkSessionKey, sparkStateCwd, type SparkSessionContext } from "./session-identity.ts";

export {
  clearCurrentProjectRef,
  currentSparkProject,
  currentProjectStorePath,
  importLegacyCurrentProjectState,
  loadCurrentProjectRef,
  loadCurrentProjectState,
  saveCurrentProjectRef,
  saveSessionPhase,
  sparkRunStrategyForMaxConcurrency,
  sparkRunStrategyMaxConcurrency,
  type CurrentProjectStoreSnapshot,
  type SparkAgentMode,
  type SparkAgentPhase,
  type SparkPlanningModeSource,
  type SparkRunStrategy,
} from "./current-project-state.ts";
export {
  clearSparkMode,
  clearSparkPhase,
  loadSparkMode,
  loadSparkPhase,
  nextSparkSessionMode,
  nextSparkSessionPhase,
  saveSparkMode,
  saveSparkPhase,
  SPARK_SESSION_MODE_CYCLE,
  SPARK_SESSION_PHASE_CYCLE,
  type SparkSessionMode,
  type SparkSessionModeInput,
  type SparkSessionModeState,
  type SparkSessionPhase,
  type SparkSessionPhaseInput,
  type SparkSessionPhaseState,
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
  sparkStateCwd,
  sparkStateRootPath,
  type SparkSessionContext,
} from "./session-identity.ts";

export async function loadSparkGraph(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<TaskGraph | null> {
  return defaultTaskGraphStore(sparkStateCwd(cwd, ctx)).load();
}

export async function saveSparkGraphAndTodos(
  cwd: string,
  graph: TaskGraph,
  ctx?: SparkSessionContext,
  store = defaultTaskGraphStore(sparkStateCwd(cwd, ctx)),
): Promise<void> {
  await store.withLock(async () => {
    await store.save(graph);
  });
}

export function sparkTodoStore(
  cwd: string,
  ctx?: SparkSessionContext,
): ReturnType<typeof defaultTaskTodoStore> {
  return defaultTaskTodoStore(sparkStateCwd(cwd, ctx), sparkSessionKey(ctx));
}
