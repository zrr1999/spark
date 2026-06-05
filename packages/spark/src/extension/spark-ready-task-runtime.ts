import type { RoleRegistry } from "pi-roles";
import type { ArtifactStore } from "pi-artifacts";
import type { RoleRef } from "pi-extension-api";
import { killActiveSparkRoleRunProcesses, runSparkTask, type RoleRunMode } from "spark-runtime";
import type { TaskGraph } from "pi-tasks";
import type { SparkReadyTaskRun, SparkReadyTaskRunKiller } from "pi-workflows";

export interface SparkRuntimeReadyTaskRunner {
  runTask: SparkReadyTaskRun;
  killRuns: SparkReadyTaskRunKiller;
}

export interface SparkRuntimeReadyTaskRunnerOptions {
  registry: RoleRegistry;
  /** Role assigned when a ready task has no task-level role hint. Defaults by task kind, then worker. */
  defaultRoleRef?: RoleRef;
  artifactStore?: ArtifactStore;
  cwd?: string;
  piCommand?: string;
  sessionDir?: string;
  mode?: RoleRunMode;
  forkFromSession?: string;
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
        mode: options.mode,
        forkFromSession: options.forkFromSession,
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
