import type { RunRef } from "spark-core";
import type { TaskGraph } from "spark-tasks";

import {
  completionDigestFromTaskRuns,
  createSparkDagCompletionFollowUp,
} from "./dag-run-completion.ts";
import { reconcileDagRunCounters, uniqueRefs } from "./dag-run-counters.ts";
import type { SparkDagRunRecord, SparkDagRunStoreSnapshot } from "./index.ts";

export interface SparkDagRunSnapshotReconcileInput {
  graph?: TaskGraph;
  activeRunRefs: Set<RunRef>;
  now: string;
}

export function reconcileSparkDagRunSnapshot(
  snapshot: SparkDagRunStoreSnapshot,
  input: SparkDagRunSnapshotReconcileInput,
): void {
  for (const record of snapshot.runs) {
    if (recoverActiveStaleDagRun(snapshot, record, input.graph, input.activeRunRefs, input.now))
      continue;
    if (record.status !== "running") continue;
    recoverActiveDagTaskRunRefs(record, input.graph, input.activeRunRefs);
    if (isActiveSchedulingWindow(snapshot, record, input.activeRunRefs)) continue;
    if (record.taskRunRefs.some((runRef) => input.activeRunRefs.has(runRef))) continue;
    reconcileStaleDagRun(record, input.graph, input.now);
  }
  if (
    snapshot.manager.activeRunRef &&
    !snapshot.runs.some(
      (run) => run.ref === snapshot.manager.activeRunRef && run.status === "running",
    )
  ) {
    snapshot.manager.activeRunRef = undefined;
  }
  snapshot.manager.status = snapshot.manager.activeRunRef ? "running" : "idle";
  snapshot.manager.updatedAt = input.now;
}

function reconcileStaleDagRun(
  record: SparkDagRunRecord,
  graph: TaskGraph | undefined,
  now: string,
): void {
  const taskRuns = graph
    ? record.taskRunRefs.flatMap((runRef) => graph.runs().filter((run) => run.ref === runRef))
    : [];
  const runningRuns = taskRuns.filter((run) => run.status === "queued" || run.status === "running");
  if (runningRuns.length > 0) return;
  for (const run of taskRuns.filter(
    (candidate) => candidate.status !== "queued" && candidate.status !== "running",
  )) {
    if (!record.completedTaskRefs.includes(run.taskRef)) record.completedTaskRefs.push(run.taskRef);
  }
  reconcileDagRunCounters(record, {
    completedFallback: taskRuns.filter((run) => run.status !== "queued" && run.status !== "running")
      .length,
  });
  if (taskRuns.some((run) => run.status === "failed")) record.status = "failed";
  else if (taskRuns.length > 0 && taskRuns.every((run) => run.status === "succeeded"))
    record.status = "succeeded";
  else if (taskRuns.some((run) => run.status === "cancelled")) record.status = "failed";
  else record.status = "stale";
  record.errorMessage ??= `Spark orchestrator run was reconciled as ${record.status} after no active child process was found.`;
  record.finishedAt ??= now;
  record.updatedAt = now;
  if (record.completionDigest.length === 0)
    record.completionDigest = completionDigestFromTaskRuns(taskRuns);
  record.completionFollowUp ??= createSparkDagCompletionFollowUp(record);
}

function recoverActiveStaleDagRun(
  snapshot: SparkDagRunStoreSnapshot,
  record: SparkDagRunRecord,
  graph: TaskGraph | undefined,
  activeRunRefs: Set<RunRef>,
  now: string,
): boolean {
  if (record.status !== "stale" || record.acknowledgedAt) return false;
  recoverActiveDagTaskRunRefs(record, graph, activeRunRefs);
  if (!record.taskRunRefs.some((runRef) => activeRunRefs.has(runRef))) return false;
  record.status = "running";
  record.finishedAt = undefined;
  record.errorMessage = undefined;
  record.acknowledgedBySession = undefined;
  record.completionDigest = [];
  record.completionFollowUp = undefined;
  record.updatedAt = now;
  snapshot.manager.activeRunRef = record.ref;
  snapshot.manager.status = "running";
  snapshot.manager.updatedAt = now;
  return true;
}

function recoverActiveDagTaskRunRefs(
  record: SparkDagRunRecord,
  graph: TaskGraph | undefined,
  activeRunRefs: Set<RunRef>,
): void {
  if (!graph || activeRunRefs.size === 0 || record.scheduledTaskRefs.length === 0) return;
  const scheduledTaskRefs = new Set(record.scheduledTaskRefs);
  for (const task of graph.tasks()) {
    const runRef = task.claim?.runRef;
    if (runRef && activeRunRefs.has(runRef) && scheduledTaskRefs.has(task.ref))
      record.taskRunRefs.push(runRef);
  }
  for (const run of graph.runs()) {
    if (activeRunRefs.has(run.ref) && scheduledTaskRefs.has(run.taskRef))
      record.taskRunRefs.push(run.ref);
  }
  record.taskRunRefs = uniqueRefs(record.taskRunRefs);
}

function isActiveSchedulingWindow(
  snapshot: SparkDagRunStoreSnapshot,
  record: SparkDagRunRecord,
  activeRunRefs: Set<RunRef>,
): boolean {
  return (
    snapshot.manager.activeRunRef === record.ref &&
    activeRunRefs.size > 0 &&
    record.scheduledTaskRefs.length === 0 &&
    record.taskRunRefs.length === 0
  );
}
