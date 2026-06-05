import { nowIso, type RunRef, type ProjectRef } from "pi-extension-api";

import type { SparkDagRunRecord, SparkDagRunStoreSnapshot } from "./index.ts";
import { isAcknowledgeableDagRun, isTerminalDagRunStatus } from "./dag-run-status.ts";

export type SparkDagRunRetentionCandidateReason = "old-succeeded" | "old-acknowledged-problem";

export type SparkDagRunRetentionKeepReason =
  | "active-run"
  | "running"
  | "non-terminal"
  | "global-recent-window"
  | "project-recent-window"
  | "within-retention-age"
  | "unacknowledged-problem"
  | "unsafe-status"
  | "invalid-timestamp";

export interface SparkDagRunRetentionEntry {
  ref: RunRef;
  projectRef?: ProjectRef;
  status: SparkDagRunRecord["status"];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  acknowledgedAt?: string;
  retentionDate: string;
  ageDays?: number;
  reason: SparkDagRunRetentionCandidateReason | SparkDagRunRetentionKeepReason;
}

export interface SparkDagRunPruneOptions {
  dryRun?: boolean;
  olderThanDays?: number;
  keepRecent?: number;
  keepRecentPerProject?: number;
  activeRunRefs?: Iterable<RunRef>;
  now?: string;
}

export interface SparkDagRunPruneResult {
  snapshot: SparkDagRunStoreSnapshot;
  dryRun: boolean;
  olderThanDays: number;
  keepRecent: number;
  keepRecentPerProject: number;
  cutoffIso: string;
  before: number;
  after: number;
  candidates: SparkDagRunRetentionEntry[];
  deleted: SparkDagRunRetentionEntry[];
  kept: SparkDagRunRetentionEntry[];
}

export interface NormalizedSparkDagRunPruneOptions {
  dryRun: boolean;
  olderThanDays: number;
  keepRecent: number;
  keepRecentPerProject: number;
  activeRunRefs: Set<RunRef>;
  nowMs: number;
  cutoffMs: number;
  cutoffIso: string;
}

export function normalizeSparkDagRunPruneOptions(
  options: SparkDagRunPruneOptions,
): NormalizedSparkDagRunPruneOptions {
  const olderThanDays = Number.isFinite(options.olderThanDays ?? 30)
    ? Math.max(0, Math.floor(options.olderThanDays ?? 30))
    : 30;
  const keepRecent = Number.isFinite(options.keepRecent ?? 10)
    ? Math.max(0, Math.floor(options.keepRecent ?? 10))
    : 10;
  const keepRecentPerProject = Number.isFinite(options.keepRecentPerProject ?? 10)
    ? Math.max(0, Math.floor(options.keepRecentPerProject ?? 10))
    : 10;
  const nowMs = Date.parse(options.now ?? nowIso());
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cutoffMs = safeNowMs - olderThanDays * 24 * 60 * 60 * 1_000;
  return {
    dryRun: options.dryRun ?? true,
    olderThanDays,
    keepRecent,
    keepRecentPerProject,
    activeRunRefs: new Set(options.activeRunRefs ?? []),
    nowMs: safeNowMs,
    cutoffMs,
    cutoffIso: new Date(cutoffMs).toISOString(),
  };
}

export function planSparkDagRunPrune(
  snapshot: SparkDagRunStoreSnapshot,
  options: NormalizedSparkDagRunPruneOptions,
): SparkDagRunPruneResult {
  const activeRunRefs = new Set(options.activeRunRefs);
  if (snapshot.manager.activeRunRef) activeRunRefs.add(snapshot.manager.activeRunRef);
  const terminalRuns = snapshot.runs
    .filter((run) => isTerminalDagRunStatus(run.status))
    .sort(compareSparkDagRunRetentionDateDesc);
  const globallyRecent = new Set(terminalRuns.slice(0, options.keepRecent).map((run) => run.ref));
  const recentlyByProject = new Set<RunRef>();
  const byProject = new Map<string, SparkDagRunRecord[]>();
  for (const run of terminalRuns) {
    const projectKey = run.projectRef ?? "__unprojected__";
    byProject.set(projectKey, [...(byProject.get(projectKey) ?? []), run]);
  }
  for (const runs of byProject.values())
    for (const run of runs.slice(0, options.keepRecentPerProject)) recentlyByProject.add(run.ref);

  const candidates: SparkDagRunRetentionEntry[] = [];
  const kept: SparkDagRunRetentionEntry[] = [];
  for (const run of snapshot.runs) {
    const decision = sparkDagRunRetentionDecision(run, options, {
      activeRunRefs,
      globallyRecent,
      recentlyByProject,
    });
    if (decision.reason === "old-succeeded" || decision.reason === "old-acknowledged-problem")
      candidates.push(decision);
    else kept.push(decision);
  }
  return {
    snapshot,
    dryRun: options.dryRun,
    olderThanDays: options.olderThanDays,
    keepRecent: options.keepRecent,
    keepRecentPerProject: options.keepRecentPerProject,
    cutoffIso: options.cutoffIso,
    before: snapshot.runs.length,
    after: options.dryRun ? snapshot.runs.length : snapshot.runs.length - candidates.length,
    candidates,
    deleted: [],
    kept,
  };
}

function sparkDagRunRetentionDecision(
  run: SparkDagRunRecord,
  options: NormalizedSparkDagRunPruneOptions,
  windows: {
    activeRunRefs: Set<RunRef>;
    globallyRecent: Set<RunRef>;
    recentlyByProject: Set<RunRef>;
  },
): SparkDagRunRetentionEntry {
  const retentionDate = sparkDagRunRetentionDate(run);
  const retentionMs = Date.parse(retentionDate);
  const ageDays = Number.isFinite(retentionMs)
    ? Math.max(0, (options.nowMs - retentionMs) / (24 * 60 * 60 * 1_000))
    : undefined;
  const entry = (reason: SparkDagRunRetentionEntry["reason"]): SparkDagRunRetentionEntry => ({
    ref: run.ref,
    projectRef: run.projectRef,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    acknowledgedAt: run.acknowledgedAt,
    retentionDate,
    ageDays,
    reason,
  });
  if (
    windows.activeRunRefs.has(run.ref) ||
    run.taskRunRefs.some((ref) => windows.activeRunRefs.has(ref))
  )
    return entry("active-run");
  if (run.status === "running") return entry("running");
  if (!isTerminalDagRunStatus(run.status)) return entry("non-terminal");
  if (windows.globallyRecent.has(run.ref)) return entry("global-recent-window");
  if (windows.recentlyByProject.has(run.ref)) return entry("project-recent-window");
  if (!Number.isFinite(retentionMs)) return entry("invalid-timestamp");
  if (retentionMs >= options.cutoffMs) return entry("within-retention-age");
  if (run.status === "succeeded") return entry("old-succeeded");
  if (isAcknowledgeableDagRun(run)) {
    if (!run.acknowledgedAt) return entry("unacknowledged-problem");
    return entry("old-acknowledged-problem");
  }
  return entry("unsafe-status");
}

function sparkDagRunRetentionDate(run: SparkDagRunRecord): string {
  return run.finishedAt ?? run.updatedAt ?? run.startedAt;
}

function compareSparkDagRunRetentionDateDesc(a: SparkDagRunRecord, b: SparkDagRunRecord): number {
  const byDate = sparkDagRunRetentionDate(b).localeCompare(sparkDagRunRetentionDate(a));
  if (byDate !== 0) return byDate;
  return b.ref.localeCompare(a.ref);
}
