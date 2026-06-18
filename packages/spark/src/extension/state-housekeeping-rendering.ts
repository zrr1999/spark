import type { WorkflowRunPruneResult } from "@zendev-lab/pi-workflows";
import type { RoleRunArtifactRetentionPlan } from "@zendev-lab/spark-runtime";
import type {
  SparkProtectedStoreReason,
  SparkStateCacheKind,
  SparkStateCleanupPlan,
  SparkStateDiagnosticsSummary,
  SparkStateHousekeepingSummary,
} from "./state-housekeeping.ts";

export const SPARK_ROLE_RUN_RETENTION_RENDER_LIMIT = 20;

export function appendSparkStateHousekeepingLines(
  lines: string[],
  summary: SparkStateHousekeepingSummary,
): void {
  lines.push("\nSpark state cache:");
  for (const cache of summary.caches) {
    lines.push(
      `  ${formatSparkStateCacheKind(cache.kind)}: ${cache.files} files, ${formatByteSize(cache.bytes)}, active=${cache.activeFiles}, stale=${cache.staleFiles}, broken=${cache.brokenFiles}, safe-to-delete=${cache.safeToDeleteFiles}`,
    );
  }
  lines.push("V2 canonical stores (protected):");
  for (const store of summary.protectedStores) {
    lines.push(
      `  ${formatSparkProtectedStoreReason(store.reason)}: ${store.files} files, ${formatByteSize(store.bytes)} (${store.path})`,
    );
  }
  lines.push("Legacy import-only paths:");
  if (summary.legacyImportOnly.length === 0) lines.push("  none");
  for (const path of summary.legacyImportOnly) lines.push(`  ${path}`);
}

export function appendSparkStateDiagnosticsLines(
  lines: string[],
  diagnostics: SparkStateDiagnosticsSummary,
): void {
  lines.push(
    `Bounded output: showing at most ${diagnostics.boundedLimit} item(s) per category; large artifact threshold=${formatByteSize(diagnostics.largeArtifactThresholdBytes)}.`,
  );
  appendTerminalProjectDiagnostics(lines, diagnostics.terminalProjects);
  appendInactiveWorkflowRunDiagnostics(lines, diagnostics.inactiveWorkflowRuns);
  appendLargeArtifactDiagnostics(lines, diagnostics.largeArtifacts);
  appendOrphanBlobDiagnostics(lines, diagnostics.orphanBlobs);
  appendProtectedFileDiagnostics(lines, "notes", diagnostics.notes);
  appendProtectedFileDiagnostics(lines, "role reports", diagnostics.roleReports);
  appendStoreV2DoctorFindings(lines, diagnostics.doctor);
  lines.push(
    "Protected-store diagnostics are read-only; no project graph, TODO record, session state, artifact, note, role-report, workflow-run, or review index files were deleted.",
  );
}

export function appendSparkStateCleanupPlanLines(
  lines: string[],
  plan: SparkStateCleanupPlan,
): void {
  const actionLabel = plan.dryRun ? "would delete" : "deleted";
  lines.push(
    `Spark state cleanup ${plan.dryRun ? "dry-run" : "apply"}: ${actionLabel} ${plan.candidates.length} safe cache file(s).`,
  );
  for (const candidate of plan.candidates)
    lines.push(
      `  - ${candidate.path} (${formatSparkStateCacheKind(candidate.kind)}: ${candidate.reason})`,
    );
  lines.push("Skipped cache files:");
  for (const skipped of plan.skipped)
    lines.push(`  - ${formatSparkStateCacheKind(skipped.kind)}: ${skipped.files}`);
  lines.push("Protected stores were not considered for cleanup:");
  for (const store of plan.protectedStores)
    lines.push(`  - ${formatSparkProtectedStoreReason(store.reason)}: ${store.path}`);
}

export function appendRoleRunArtifactRetentionLines(
  lines: string[],
  plan: RoleRunArtifactRetentionPlan,
  limit: number,
): void {
  lines.push(
    `Scanned ${plan.scanned} artifact metadata file(s); threshold=${formatByteSize(plan.thresholdBytes)}; tail=${formatByteSize(plan.tailBytes)}.`,
  );
  if (plan.exportDir) lines.push(`Export directory: ${plan.exportDir}`);
  const visible = plan.candidates.slice(0, limit);
  lines.push(
    `Candidates: ${plan.candidates.length}${visible.length < plan.candidates.length ? ` (showing ${visible.length})` : ""}`,
  );
  for (const candidate of visible) {
    lines.push(
      `  - ${candidate.ref} ${formatByteSize(candidate.bytes)} ${candidate.candidateReason} task=${candidate.taskRef ?? "unknown"} run=${candidate.runRef ?? candidate.runName ?? "unknown"} blob=${candidate.blobPath}`,
    );
    lines.push(`    replacement: ${candidate.replacementSummary}`);
    lines.push(
      `    tail: ${formatByteSize(candidate.transcriptTail?.tailBytes ?? 0)} retained${candidate.exportPath ? `; export=${candidate.exportPath}` : ""}${candidate.deleted ? "; full transcript blob deleted" : ""}`,
    );
  }
  if (visible.length < plan.candidates.length)
    lines.push(`  - … ${plan.candidates.length - visible.length} more candidate(s)`);
  const keepCount = plan.skipped.filter((item) => item.reason === "not_role_run_artifact").length;
  const belowThreshold = plan.skipped.filter((item) => item.reason === "below_threshold").length;
  const alreadyRetained = plan.skipped.filter((item) => item.reason === "already_retained").length;
  const invalidJson = plan.skipped.filter((item) => item.reason === "invalid_json").length;
  const invalidBlobPath = plan.skipped.filter((item) => item.reason === "invalid_blob_path").length;
  const missingBlob = plan.skipped.filter(
    (item) => item.reason === "missing_blob" || item.reason === "missing_blob_path",
  ).length;
  lines.push(
    `Skipped: non-role-run=${keepCount}, below-threshold=${belowThreshold}, already-retained=${alreadyRetained}, invalid-json=${invalidJson}, invalid-blob-path=${invalidBlobPath}, missing-blob=${missingBlob}.`,
  );
  lines.push(
    plan.dryRun
      ? "Dry-run only: no metadata was rewritten and no full transcript blobs were deleted. Run with dryRun=false only after reviewing candidates and, if needed, setting exportDir."
      : "Apply complete: each deleted full transcript blob has replacement summary/tail metadata and optional export path recorded before deletion.",
  );
}

function appendTerminalProjectDiagnostics(
  lines: string[],
  summary: SparkStateDiagnosticsSummary["terminalProjects"],
): void {
  lines.push(
    `Terminal/no-unfinished projects: ${summary.count}${summary.shown < summary.count ? ` (showing ${summary.shown})` : ""}`,
  );
  for (const project of summary.candidates)
    lines.push(
      `  - ${project.ref} ${project.status} tasks=${project.tasks} unfinished=${project.unfinishedTasks} updated=${project.updatedAt} ${project.title}`,
    );
}

function appendInactiveWorkflowRunDiagnostics(
  lines: string[],
  summary: SparkStateDiagnosticsSummary["inactiveWorkflowRuns"],
): void {
  lines.push(
    `Inactive workflow runs: ${summary.count}${summary.shown < summary.count ? ` (showing ${summary.shown})` : ""}`,
  );
  for (const run of summary.candidates)
    lines.push(
      `  - ${run.ref} ${run.status} scheduled=${run.scheduled} completed=${run.completed} updated=${run.updatedAt}${run.projectRef ? ` project=${run.projectRef}` : ""}`,
    );
}

export function appendSparkWorkflowRunPruneLines(
  lines: string[],
  prune: WorkflowRunPruneResult,
): void {
  lines.push(
    `Retention: olderThanDays=${prune.olderThanDays} cutoff=${prune.cutoffIso} keepRecent=${prune.keepRecent} keepRecentPerProject=${prune.keepRecentPerProject} before=${prune.before} after=${prune.after}`,
  );
  lines.push(
    `${prune.dryRun ? "Candidates" : "Deleted"}: ${prune.dryRun ? prune.candidates.length : prune.deleted.length}; kept=${prune.kept.length}`,
  );
  const visibleCandidates = (prune.dryRun ? prune.candidates : prune.deleted).slice(0, 20);
  for (const candidate of visibleCandidates)
    lines.push(
      `  - ${candidate.ref} ${candidate.status} reason=${candidate.reason} retentionDate=${candidate.retentionDate}${candidate.projectRef ? ` project=${candidate.projectRef}` : ""}`,
    );
  const hidden =
    (prune.dryRun ? prune.candidates : prune.deleted).length - visibleCandidates.length;
  if (hidden > 0) lines.push(`  … ${hidden} more prune candidate(s)`);
  const keptReasons = new Map<string, number>();
  for (const kept of prune.kept)
    keptReasons.set(kept.reason, (keptReasons.get(kept.reason) ?? 0) + 1);
  if (keptReasons.size > 0)
    lines.push(
      `Kept reasons: ${[...keptReasons.entries()]
        .map(([reason, count]) => `${reason}=${count}`)
        .join(", ")}`,
    );
}

function appendLargeArtifactDiagnostics(
  lines: string[],
  summary: SparkStateDiagnosticsSummary["largeArtifacts"],
): void {
  lines.push(
    `Large artifacts: ${summary.count}${summary.shown < summary.count ? ` (showing ${summary.shown})` : ""}`,
  );
  for (const artifact of summary.candidates) {
    const provenance = [
      artifact.producer ? `producer=${artifact.producer}` : undefined,
      artifact.projectRef ? `project=${artifact.projectRef}` : undefined,
      artifact.taskRef ? `task=${artifact.taskRef}` : undefined,
      artifact.roleRef ? `role=${artifact.roleRef}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `  - ${artifact.ref} [${artifact.kind}] ${formatByteSize(artifact.bytes)} metadata=${formatByteSize(artifact.metadataBytes)} updated=${artifact.updatedAt ?? "unknown"}${provenance ? ` ${provenance}` : ""}`,
    );
  }
}

function appendOrphanBlobDiagnostics(
  lines: string[],
  summary: SparkStateDiagnosticsSummary["orphanBlobs"],
): void {
  lines.push(
    `Orphan artifact blobs: ${summary.count}${summary.shown < summary.count ? ` (showing ${summary.shown})` : ""}`,
  );
  for (const blob of summary.candidates)
    lines.push(`  - ${blob.path} ${formatByteSize(blob.bytes)} mtime=${blob.mtime}`);
}

function appendStoreV2DoctorFindings(
  lines: string[],
  summary: SparkStateDiagnosticsSummary["doctor"],
): void {
  lines.push(
    `Store V2 doctor findings: ${summary.count}${summary.shown < summary.count ? ` (showing ${summary.shown})` : ""}`,
  );
  for (const finding of summary.findings) {
    const path = finding.path ? ` (${finding.path})` : "";
    lines.push(`  - [${finding.severity}] ${finding.code}${path}: ${finding.message}`);
    lines.push(`    repair: ${finding.repair}`);
  }
}

function appendProtectedFileDiagnostics(
  lines: string[],
  label: string,
  summary: SparkStateDiagnosticsSummary["notes"],
): void {
  lines.push(
    `${label}: ${summary.count}${summary.shown < summary.count ? ` (showing ${summary.shown})` : ""}`,
  );
  for (const file of summary.candidates)
    lines.push(`  - ${file.path} ${formatByteSize(file.bytes)} mtime=${file.mtime}`);
}

export function formatSparkStateCacheKind(kind: SparkStateCacheKind): string {
  switch (kind) {
    case "sessions":
      return "sessions";
    case "task-todos":
      return "task todos";
    case "session-todos":
      return "session todos";
    case "todo-display-numbers":
      return "todo display numbers";
    case "legacy-task-todos":
      return "legacy task todos";
  }
}

export function formatSparkProtectedStoreReason(reason: SparkProtectedStoreReason): string {
  switch (reason) {
    case "artifact-history":
      return "artifacts";
    case "task-graph":
      return "project graph";
    case "todo-records":
      return "TODO records";
    case "session-state":
      return "session state";
    case "notes":
      return "notes";
    case "role-reports":
      return "role reports";
    case "reviews":
      return "reviews";
    case "workflow-runs":
      return "workflow runs";
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units.at(-1))
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    value /= 1024;
  }
  return `${bytes} B`;
}
