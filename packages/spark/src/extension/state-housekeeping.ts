import { join, relative } from "node:path";

import { nowIso } from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  collectSparkProtectedStoreSummaries,
  collectSparkStateCacheSummaries,
  collectSparkStateCleanupCandidates,
  type SparkProtectedStoreSummary,
  type SparkStateCacheSummary,
  type SparkStateCleanupCandidate,
  type SparkStateCleanupSkippedSummary,
  type SparkStateSessionScopes,
} from "./state-cache-cleanup.ts";

export {
  SPARK_STATE_DIAGNOSTIC_ITEM_LIMIT,
  SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES,
  collectSparkStateDiagnostics,
  type SparkStateDiagnosticsSummary,
  type SparkStateInactiveWorkflowRunCandidate,
  type SparkStateLargeArtifactCandidate,
  type SparkStateOrphanBlobCandidate,
  type SparkStateDoctorFinding,
  type SparkStateProtectedFileCandidate,
  type SparkStateTerminalProjectCandidate,
} from "./state-diagnostics.ts";
export type {
  SparkProtectedStoreReason,
  SparkStateCacheKind,
  SparkStateCacheSummary,
  SparkStateCleanupCandidate,
  SparkStateCleanupReason,
  SparkStateCleanupSkippedSummary,
  SparkStateSessionScopes,
} from "./state-cache-cleanup.ts";

export interface SparkStateHousekeepingSummary {
  root: string;
  generatedAt: string;
  caches: SparkStateCacheSummary[];
  protectedStores: SparkProtectedStoreSummary[];
}

export interface SparkStateCleanupPlan {
  root: string;
  generatedAt: string;
  dryRun: boolean;
  olderThanDays: number;
  includeBroken: boolean;
  candidates: SparkStateCleanupCandidate[];
  deleted: SparkStateCleanupCandidate[];
  skipped: SparkStateCleanupSkippedSummary[];
  protectedStores: SparkProtectedStoreSummary[];
}

export async function collectSparkStateHousekeeping(
  cwd: string,
  scopes: SparkStateSessionScopes,
  graph: TaskGraph,
): Promise<SparkStateHousekeepingSummary> {
  const root = join(cwd, ".spark");
  const staleCutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  return {
    root: relative(cwd, root) || ".spark",
    generatedAt: nowIso(),
    caches: await collectSparkStateCacheSummaries(root, scopes, graph, staleCutoffMs),
    protectedStores: await collectSparkProtectedStoreSummaries(root),
  };
}

export async function collectSparkStateCleanupPlan(
  cwd: string,
  scopes: SparkStateSessionScopes,
  graph: TaskGraph,
  options: { dryRun: boolean; olderThanDays: number; includeBroken: boolean },
): Promise<SparkStateCleanupPlan> {
  const root = join(cwd, ".spark");
  const staleCutoffMs = Date.now() - options.olderThanDays * 24 * 60 * 60 * 1_000;
  const [protectedStores, candidates, caches] = await Promise.all([
    collectSparkProtectedStoreSummaries(root),
    collectSparkStateCleanupCandidates(
      cwd,
      root,
      scopes,
      graph,
      staleCutoffMs,
      options.includeBroken,
    ),
    collectSparkStateCacheSummaries(root, scopes, graph, staleCutoffMs),
  ]);
  const candidateCountByKind = new Map<string, number>();
  for (const candidate of candidates)
    candidateCountByKind.set(candidate.kind, (candidateCountByKind.get(candidate.kind) ?? 0) + 1);
  return {
    root: relative(cwd, root) || ".spark",
    generatedAt: nowIso(),
    dryRun: options.dryRun,
    olderThanDays: options.olderThanDays,
    includeBroken: options.includeBroken,
    candidates,
    deleted: [],
    skipped: caches.map((cache) => ({
      kind: cache.kind,
      files: Math.max(0, cache.files - (candidateCountByKind.get(cache.kind) ?? 0)),
    })),
    protectedStores,
  };
}
