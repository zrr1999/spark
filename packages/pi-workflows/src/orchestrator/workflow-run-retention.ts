import { nowIso, type RunRef, type ProjectRef } from "@zendev-lab/pi-extension-api";

import type { WorkflowRunRecord, WorkflowRunStoreSnapshot } from "./index.ts";
import {
  isAcknowledgeableWorkflowRun,
  isTerminalWorkflowRunStatus,
} from "./workflow-run-status.ts";

export type WorkflowRunRetentionCandidateReason = "old-succeeded" | "old-acknowledged-problem";

export type WorkflowRunRetentionKeepReason =
  | "active-run"
  | "running"
  | "non-terminal"
  | "global-recent-window"
  | "project-recent-window"
  | "within-retention-age"
  | "unacknowledged-problem"
  | "unsafe-status"
  | "invalid-timestamp";

export interface WorkflowRunRetentionEntry {
  ref: RunRef;
  projectRef?: ProjectRef;
  status: WorkflowRunRecord["status"];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  acknowledgedAt?: string;
  retentionDate: string;
  ageDays?: number;
  reason: WorkflowRunRetentionCandidateReason | WorkflowRunRetentionKeepReason;
}

export interface WorkflowRunPruneOptions {
  dryRun?: boolean;
  olderThanDays?: number;
  keepRecent?: number;
  keepRecentPerProject?: number;
  activeRunRefs?: Iterable<RunRef>;
  now?: string;
}

export interface WorkflowRunPruneResult {
  snapshot: WorkflowRunStoreSnapshot;
  dryRun: boolean;
  olderThanDays: number;
  keepRecent: number;
  keepRecentPerProject: number;
  cutoffIso: string;
  before: number;
  after: number;
  candidates: WorkflowRunRetentionEntry[];
  deleted: WorkflowRunRetentionEntry[];
  kept: WorkflowRunRetentionEntry[];
}

export interface NormalizedWorkflowRunPruneOptions {
  dryRun: boolean;
  olderThanDays: number;
  keepRecent: number;
  keepRecentPerProject: number;
  activeRunRefs: Set<RunRef>;
  nowMs: number;
  cutoffMs: number;
  cutoffIso: string;
}

export function normalizeWorkflowRunPruneOptions(
  options: WorkflowRunPruneOptions,
): NormalizedWorkflowRunPruneOptions {
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

export function planWorkflowRunPrune(
  snapshot: WorkflowRunStoreSnapshot,
  options: NormalizedWorkflowRunPruneOptions,
): WorkflowRunPruneResult {
  const activeRunRefs = new Set(options.activeRunRefs);
  if (snapshot.manager.activeRunRef) activeRunRefs.add(snapshot.manager.activeRunRef);
  const terminalRuns = snapshot.runs
    .filter((run) => isTerminalWorkflowRunStatus(run.status))
    .sort(compareWorkflowRunRetentionDateDesc);
  const globallyRecent = new Set(terminalRuns.slice(0, options.keepRecent).map((run) => run.ref));
  const recentlyByProject = new Set<RunRef>();
  const byProject = new Map<string, WorkflowRunRecord[]>();
  for (const run of terminalRuns) {
    const projectKey = run.projectRef ?? "__unprojected__";
    byProject.set(projectKey, [...(byProject.get(projectKey) ?? []), run]);
  }
  for (const runs of byProject.values())
    for (const run of runs.slice(0, options.keepRecentPerProject)) recentlyByProject.add(run.ref);

  const candidates: WorkflowRunRetentionEntry[] = [];
  const kept: WorkflowRunRetentionEntry[] = [];
  for (const run of snapshot.runs) {
    const decision = workflowRunRetentionDecision(run, options, {
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

function workflowRunRetentionDecision(
  run: WorkflowRunRecord,
  options: NormalizedWorkflowRunPruneOptions,
  windows: {
    activeRunRefs: Set<RunRef>;
    globallyRecent: Set<RunRef>;
    recentlyByProject: Set<RunRef>;
  },
): WorkflowRunRetentionEntry {
  const retentionDate = workflowRunRetentionDate(run);
  const retentionMs = Date.parse(retentionDate);
  const ageDays = Number.isFinite(retentionMs)
    ? Math.max(0, (options.nowMs - retentionMs) / (24 * 60 * 60 * 1_000))
    : undefined;
  const entry = (reason: WorkflowRunRetentionEntry["reason"]): WorkflowRunRetentionEntry => ({
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
  if (!isTerminalWorkflowRunStatus(run.status)) return entry("non-terminal");
  if (windows.globallyRecent.has(run.ref)) return entry("global-recent-window");
  if (windows.recentlyByProject.has(run.ref)) return entry("project-recent-window");
  if (!Number.isFinite(retentionMs)) return entry("invalid-timestamp");
  if (retentionMs >= options.cutoffMs) return entry("within-retention-age");
  if (run.status === "succeeded") return entry("old-succeeded");
  if (isAcknowledgeableWorkflowRun(run)) {
    if (!run.acknowledgedAt) return entry("unacknowledged-problem");
    return entry("old-acknowledged-problem");
  }
  return entry("unsafe-status");
}

function workflowRunRetentionDate(run: WorkflowRunRecord): string {
  return run.finishedAt ?? run.updatedAt ?? run.startedAt;
}

function compareWorkflowRunRetentionDateDesc(a: WorkflowRunRecord, b: WorkflowRunRecord): number {
  const byDate = workflowRunRetentionDate(b).localeCompare(workflowRunRetentionDate(a));
  if (byDate !== 0) return byDate;
  return b.ref.localeCompare(a.ref);
}
