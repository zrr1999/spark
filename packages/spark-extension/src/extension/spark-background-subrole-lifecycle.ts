import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import { newRef, nowIso } from "@zendev-lab/spark-extension-api";
import {
  createRoleRunClaimId,
  findResumableBackgroundRoleRunTasks,
  killActiveSparkRoleRunProcesses,
  runSparkTask,
} from "@zendev-lab/spark-runtime";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { loadSparkGraph, saveSparkGraphAndTodos, sparkSessionOwnerKey } from "./session-state.ts";
import { createSparkRoleRegistry } from "./spark-role-registry.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";
import { mergeTaskProgressIntoStore } from "./task-progress-store.ts";

export interface SparkBackgroundSubroleLifecycleOptions {
  refreshSparkWidget?: (cwd: string, ctx: SparkToolContext) => Promise<void>;
  runTask?: typeof runSparkTask;
}

export async function cleanupOwnedBackgroundSubroles(
  cwd: string,
  ctx: SparkToolContext,
  reason: string,
  options: Pick<SparkBackgroundSubroleLifecycleOptions, "refreshSparkWidget"> = {},
): Promise<number> {
  const store = defaultTaskGraphStore(cwd);
  const graph = await loadSparkGraph(cwd, ctx);
  if (!graph) return 0;
  const ownerSessionId = sparkSessionOwnerKey(ctx);
  const owned = findResumableBackgroundRoleRunTasks(graph, ownerSessionId);
  const ownedRunRefs = owned.flatMap((task) => (task.claim?.runRef ? [task.claim.runRef] : []));
  const ownedRoleNames = owned.flatMap((task) => (task.claim?.runName ? [task.claim.runName] : []));
  if (ownedRunRefs.length === 0 && ownedRoleNames.length === 0) return 0;
  const killed = await killActiveSparkRoleRunProcesses({
    reason: `spark session shutdown: ${reason}`,
    runRefs: ownedRunRefs.length > 0 ? ownedRunRefs : undefined,
    runNames: ownedRunRefs.length > 0 ? undefined : ownedRoleNames,
  });

  const killedRunRefs = new Set(killed.map((run) => run.runRef));
  const killedRoleNames = new Set(killed.flatMap((run) => (run.runName ? [run.runName] : [])));
  let changed = false;
  for (const task of owned) {
    const runRef = task.claim?.runRef;
    if (killedRunRefs.size > 0 && (!runRef || !killedRunRefs.has(runRef))) continue;
    if (
      killedRunRefs.size === 0 &&
      killedRoleNames.size > 0 &&
      !killedRoleNames.has(task.claim?.runName ?? "")
    )
      continue;
    if (runRef) {
      const run = graph.runs(task.projectRef).find((candidate) => candidate.ref === runRef);
      if (run?.status === "running" || run?.status === "queued") {
        graph.recordRun({
          ...run,
          status: "cancelled",
          failureKind: "runtime_error",
          errorMessage: `background role run killed on Spark session shutdown (${reason})`,
          finishedAt: nowIso(),
        });
        changed = true;
      }
    }
    graph.releaseTaskClaim(task.ref, task.claim?.claimedBy);
    changed = true;
  }
  if (changed) {
    await saveSparkGraphAndTodos(cwd, graph, ctx, store);
    await options.refreshSparkWidget?.(cwd, ctx);
  }
  return killed.length;
}

export async function resumeOwnedBackgroundSubroles(
  cwd: string,
  ctx: SparkToolContext,
  options: Pick<SparkBackgroundSubroleLifecycleOptions, "runTask"> = {},
): Promise<number> {
  const store = defaultTaskGraphStore(cwd);
  const graph = await loadSparkGraph(cwd, ctx);
  if (!graph) return 0;
  const ownerSessionId = sparkSessionOwnerKey(ctx);
  const resumable = findResumableBackgroundRoleRunTasks(graph, ownerSessionId);
  if (resumable.length === 0) return 0;
  const registry = await createSparkRoleRegistry(cwd);
  const artifactStore = defaultArtifactStore(cwd);
  let resumed = 0;
  for (const task of resumable) {
    const runName = task.claim?.runName;
    const claimedBy = runName ? createRoleRunClaimId(ownerSessionId, runName) : undefined;
    if (!runName || !claimedBy) continue;
    graph.releaseTaskClaim(task.ref, task.claim?.claimedBy);
    try {
      await (options.runTask ?? runSparkTask)({
        graph,
        taskRef: task.ref,
        registry,
        artifactStore,
        cwd,
        dryRun: false,
        claim: {
          sessionId: ownerSessionId,
          runName,
          claimedBy,
        },
      });
      resumed += 1;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const runRef = newRef("run");
      const finishedAt = nowIso();
      graph.recordRun({
        ref: runRef,
        projectRef: task.projectRef,
        taskRef: task.ref,
        roleRef: task.claim?.roleRef ?? task.roleRef,
        runName,
        ownerSessionId,
        status: "failed",
        failureKind: "runtime_error",
        errorMessage,
        startedAt: finishedAt,
        finishedAt,
        outputArtifacts: [],
        completionSummary: {
          runRef,
          taskRef: task.ref,
          roleRef: task.claim?.roleRef ?? task.roleRef,
          runName,
          status: "failed",
          summary: errorMessage,
          artifactRefs: [],
          createdAt: finishedAt,
        },
      });
      graph.setTaskStatus(task.ref, "failed");
    }
    await mergeTaskProgressIntoStore(store, graph, [task.ref]);
  }
  return resumed;
}
