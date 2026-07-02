import type { RoleRegistry } from "@zendev-lab/spark-roles";
import type { ArtifactStore } from "@zendev-lab/spark-artifacts";
import type { RoleRef } from "@zendev-lab/spark-extension-api";
import {
  killActiveSparkRoleRunProcesses,
  runSparkTask,
  type RoleLaunchMode,
} from "@zendev-lab/spark-runtime";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import type { ReadyTaskRun, ReadyTaskRunKiller } from "@zendev-lab/spark-workflows";

export interface SparkRuntimeReadyTaskRunner {
  runTask: ReadyTaskRun;
  killRuns: ReadyTaskRunKiller;
}

export interface SparkRuntimeReadyTaskRunnerOptions {
  registry: RoleRegistry;
  /** Role assigned when a ready task has no task-level role hint. Defaults by task kind, then worker. */
  defaultRoleRef?: RoleRef;
  artifactStore?: ArtifactStore;
  cwd?: string;
  piCommand?: string;
  sessionDir?: string;
  launch?: RoleLaunchMode;
  forkFromSession?: string;
  sessionModel?: string;
  heartbeatIntervalMs?: number;
  onHeartbeat?: (graph: TaskGraph) => void | Promise<void>;
}

export function createSparkRuntimeReadyTaskRunner(
  options: SparkRuntimeReadyTaskRunnerOptions,
): SparkRuntimeReadyTaskRunner {
  return {
    runTask: (input) =>
      runSparkTask({
        graph: input.graph,
        taskRef: input.taskRef,
        registry: options.registry,
        defaultRoleRef: options.defaultRoleRef,
        artifactStore: options.artifactStore,
        cwd: options.cwd,
        piCommand: options.piCommand,
        dryRun: input.dryRun,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        sessionDir: options.sessionDir,
        launch: options.launch,
        forkFromSession: options.forkFromSession,
        sessionModel: options.sessionModel,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        onHeartbeat: options.onHeartbeat,
        claim: input.claim,
      }),
    killRuns: (input) =>
      killActiveSparkRoleRunProcesses({
        runRefs: input.runRefs,
        reason: input.reason,
      }),
  };
}
