import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { resolveArtifactBlobPath } from "@zendev-lab/pi-artifacts";
import type { ArtifactKind } from "@zendev-lab/pi-artifacts";
import {
  nowIso,
  type ArtifactRef,
  type RunRef,
  type ProjectRef,
  type TaskRef,
} from "@zendev-lab/pi-extension-api";
import type { WorkflowRunStatus } from "@zendev-lab/pi-workflows";
import { isUnfinishedTaskStatus, type TaskGraph } from "@zendev-lab/pi-tasks";
import { listSparkStateFiles, readJsonObject, statIfPresent } from "./state-housekeeping-files.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { existingLegacyImportOnlyPaths } from "./store-v2-migration.ts";

export interface SparkStateTerminalProjectCandidate {
  ref: ProjectRef;
  title: string;
  tasks: number;
  unfinishedTasks: number;
  updatedAt: string;
}

export interface SparkStateInactiveWorkflowRunCandidate {
  ref: RunRef;
  projectRef?: ProjectRef;
  status: WorkflowRunStatus;
  scheduled: number;
  completed: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  acknowledgedAt?: string;
}

export interface SparkStateLargeArtifactCandidate {
  ref: ArtifactRef;
  kind: ArtifactKind;
  title?: string;
  format?: string;
  bytes: number;
  metadataBytes: number;
  producer?: string;
  projectRef?: string;
  taskRef?: string;
  roleRef?: string;
  createdAt?: string;
  updatedAt?: string;
  blobPath?: string;
}

export interface SparkStateOrphanBlobCandidate {
  path: string;
  bytes: number;
  mtime: string;
}

export interface SparkStateProtectedFileCandidate {
  path: string;
  bytes: number;
  mtime: string;
}

export interface SparkStateDoctorFinding {
  code: string;
  severity: "warning" | "error";
  path?: string;
  message: string;
  repair: string;
}

export interface SparkStateDiagnosticsSummary {
  root: string;
  generatedAt: string;
  boundedLimit: number;
  largeArtifactThresholdBytes: number;
  terminalProjects: {
    count: number;
    shown: number;
    candidates: SparkStateTerminalProjectCandidate[];
  };
  inactiveWorkflowRuns: {
    count: number;
    shown: number;
    candidates: SparkStateInactiveWorkflowRunCandidate[];
  };
  largeArtifacts: {
    count: number;
    shown: number;
    candidates: SparkStateLargeArtifactCandidate[];
  };
  orphanBlobs: {
    count: number;
    shown: number;
    candidates: SparkStateOrphanBlobCandidate[];
  };
  notes: {
    count: number;
    shown: number;
    candidates: SparkStateProtectedFileCandidate[];
  };
  roleReports: {
    count: number;
    shown: number;
    candidates: SparkStateProtectedFileCandidate[];
  };
  doctor: {
    count: number;
    shown: number;
    findings: SparkStateDoctorFinding[];
  };
}

export const SPARK_STATE_DIAGNOSTIC_ITEM_LIMIT = 20;
export const SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES = 64 * 1024;

export async function collectSparkStateDiagnostics(
  cwd: string,
  graph: TaskGraph,
): Promise<SparkStateDiagnosticsSummary> {
  const root = join(cwd, ".spark");
  const artifactRoot = join(root, "artifacts");
  const allTerminalProjects = graph
    .projects()
    .map((project) => {
      const tasks = graph.tasks(project.ref);
      const unfinishedTasks = tasks.filter((task) => isUnfinishedTaskStatus(task.status)).length;
      return {
        ref: project.ref,
        title: project.title,
        tasks: tasks.length,
        unfinishedTasks,
        updatedAt: project.updatedAt,
      };
    })
    .filter((project) => project.unfinishedTasks === 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const workflowRunSnapshot = await defaultSparkWorkflowRunStore(cwd).load();
  const allInactiveWorkflowRuns = workflowRunSnapshot.runs
    .filter((run) => run.status !== "running")
    .map((run) => ({
      ref: run.ref,
      projectRef: run.projectRef,
      status: run.status,
      scheduled: run.scheduled,
      completed: run.completed,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
      acknowledgedAt: run.acknowledgedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const artifactInventory = await collectSparkArtifactDiagnostics(cwd, artifactRoot);
  const noteCandidates = await protectedFileDiagnostics(cwd, join(root, "notes"));
  const roleReportCandidates = await protectedFileDiagnostics(cwd, join(root, "role-reports"));
  const doctorFindings = await collectStoreV2DoctorFindings(cwd, root, graph);

  return {
    root: relative(cwd, root) || ".spark",
    generatedAt: nowIso(),
    boundedLimit: SPARK_STATE_DIAGNOSTIC_ITEM_LIMIT,
    largeArtifactThresholdBytes: SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES,
    terminalProjects: boundedDiagnostics(allTerminalProjects),
    inactiveWorkflowRuns: boundedDiagnostics(allInactiveWorkflowRuns),
    largeArtifacts: boundedDiagnostics(artifactInventory.largeArtifacts),
    orphanBlobs: boundedDiagnostics(artifactInventory.orphanBlobs),
    notes: boundedDiagnostics(noteCandidates),
    roleReports: boundedDiagnostics(roleReportCandidates),
    doctor: boundedDoctorFindings(doctorFindings),
  };
}

function boundedDoctorFindings(findings: SparkStateDoctorFinding[]): {
  count: number;
  shown: number;
  findings: SparkStateDoctorFinding[];
} {
  const visible = findings.slice(0, SPARK_STATE_DIAGNOSTIC_ITEM_LIMIT);
  return { count: findings.length, shown: visible.length, findings: visible };
}

function boundedDiagnostics<T>(candidates: T[]): { count: number; shown: number; candidates: T[] } {
  const visible = candidates.slice(0, SPARK_STATE_DIAGNOSTIC_ITEM_LIMIT);
  return { count: candidates.length, shown: visible.length, candidates: visible };
}

async function collectStoreV2DoctorFindings(
  cwd: string,
  root: string,
  graph: TaskGraph,
): Promise<SparkStateDoctorFinding[]> {
  const findings: SparkStateDoctorFinding[] = [];
  for (const legacy of await existingLegacyImportOnlyPaths(cwd)) {
    findings.push({
      code: "STORE_V2_LEGACY_IMPORT_ONLY_PRESENT",
      severity: "warning",
      path: legacy,
      message: `Legacy import-only store is still present after V2 cutover: ${legacy}`,
      repair:
        "Run the migration/doctor apply path after backup verification, or explicitly archive the legacy store once V2 invariants pass.",
    });
  }

  if (
    (await hasChildDirectory(join(root, "projects"))) &&
    !(await statIfPresent(join(root, "projects", "index.json")))
  ) {
    findings.push({
      code: "STORE_V2_PROJECT_INDEX_MISSING",
      severity: "warning",
      path: ".spark/projects/index.json",
      message: "Project owner files exist but the rebuildable project index is missing.",
      repair:
        "Reload and save the task graph or run the migration/doctor repair path to rebuild `.spark/projects/index.json` from owner files.",
    });
  }
  if (
    (await hasChildDirectory(join(root, "sessions"))) &&
    !(await statIfPresent(join(root, "sessions", "index.json")))
  ) {
    findings.push({
      code: "STORE_V2_SESSION_INDEX_MISSING",
      severity: "warning",
      path: ".spark/sessions/index.json",
      message: "Session owner directories exist but the rebuildable session index is missing.",
      repair: "Run the session index rebuild path before considering migration complete.",
    });
  }

  const projectRefs = new Set(graph.projects().map((project) => project.ref));
  const taskRefs = new Set(graph.tasks().map((task) => task.ref));
  for (const stateFile of (await listSparkStateFiles(join(root, "sessions"), true)).filter(
    (file) => file.name === "state.json",
  )) {
    const state = await readJsonObject(stateFile.path);
    const path = relative(cwd, stateFile.path);
    const projectRef = typeof state?.projectRef === "string" ? state.projectRef : undefined;
    const taskRef = typeof state?.currentTaskRef === "string" ? state.currentTaskRef : undefined;
    if (projectRef && !projectRefs.has(projectRef as ProjectRef))
      findings.push({
        code: "STORE_V2_DANGLING_CURRENT_PROJECT_REF",
        severity: "error",
        path,
        message: `Session state points at missing project ${projectRef}.`,
        repair:
          "Clear or repoint the session current-project state after verifying the intended project owner file.",
      });
    if (taskRef && !taskRefs.has(taskRef as TaskRef))
      findings.push({
        code: "STORE_V2_DANGLING_CURRENT_TASK_REF",
        severity: "error",
        path,
        message: `Session state points at missing task ${taskRef}.`,
        repair:
          "Clear the current task pointer or restore the missing task owner file before completing migration.",
      });
  }

  for (const reviewDir of await subjectReviewDirectories(root)) {
    const files = (await listSparkStateFiles(reviewDir)).filter(
      (file) => file.name.endsWith(".json") && file.name !== "index.json",
    );
    if (files.length > 0 && !(await statIfPresent(join(reviewDir, "index.json"))))
      findings.push({
        code: "STORE_V2_REVIEW_INDEX_MISSING",
        severity: "warning",
        path: relative(cwd, reviewDir),
        message: "Subject-owned review records exist but their rebuildable index is missing.",
        repair: "Run the review index rebuild path for the subject directory.",
      });
    for (const file of files) {
      const record = await readJsonObject(file.path);
      const kind = typeof record?.subjectKind === "string" ? record.subjectKind : undefined;
      const subjectRef = typeof record?.subjectRef === "string" ? record.subjectRef : undefined;
      if (!kind || !subjectRef) {
        findings.push({
          code: "STORE_V2_REVIEW_SUBJECT_INVALID",
          severity: "error",
          path: relative(cwd, file.path),
          message: "Subject-owned review record is missing subjectKind or subjectRef.",
          repair:
            "Recreate the review record from the review artifact or move it to legacy import quarantine.",
        });
        continue;
      }
      if (kind === "task" && !taskRefs.has(subjectRef as TaskRef))
        findings.push({
          code: "STORE_V2_REVIEW_SUBJECT_MISSING_TASK",
          severity: "error",
          path: relative(cwd, file.path),
          message: `Task review record points at missing task ${subjectRef}.`,
          repair:
            "Restore the task owner file or quarantine the dangling review record before cutover.",
        });
    }
  }

  return findings.sort((left, right) => left.code.localeCompare(right.code));
}

async function hasChildDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function subjectReviewDirectories(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for (const file of await listSparkStateFiles(root, true)) {
    if (!file.name.endsWith(".json") || file.name === "index.json") continue;
    const path = file.path;
    const reviewMarker = `${root.includes("/") ? "/" : ""}reviews`;
    if (path.includes("/reviews/") || path.includes("/goal-reviews/")) {
      const directory = path.slice(0, path.lastIndexOf("/"));
      if (directory.includes(reviewMarker) || directory.includes("/goal-reviews/"))
        dirs.push(directory);
    }
  }
  return [...new Set(dirs)].sort();
}

async function collectSparkArtifactDiagnostics(
  cwd: string,
  artifactRoot: string,
): Promise<{
  largeArtifacts: SparkStateLargeArtifactCandidate[];
  orphanBlobs: SparkStateOrphanBlobCandidate[];
}> {
  const metadataFiles = (await listSparkStateFiles(artifactRoot)).filter((file) =>
    file.name.endsWith(".json"),
  );
  const referencedBlobPaths = new Set<string>();
  const largeArtifacts: SparkStateLargeArtifactCandidate[] = [];

  for (const file of metadataFiles) {
    const raw = await readJsonObject(file.path);
    if (!raw) continue;
    const blobPath = typeof raw.blobPath === "string" ? raw.blobPath : undefined;
    const resolvedBlobPath = blobPath ? resolveArtifactBlobPath(artifactRoot, blobPath) : undefined;
    if (resolvedBlobPath) referencedBlobPaths.add(resolvedBlobPath);
    const bodySize =
      typeof raw.bodySize === "number" && Number.isFinite(raw.bodySize) ? raw.bodySize : undefined;
    const blobInfo =
      bodySize === undefined && resolvedBlobPath
        ? await statIfPresent(resolvedBlobPath)
        : undefined;
    const blobBytes = blobInfo?.isFile() ? blobInfo.size : undefined;
    const bytes = bodySize ?? blobBytes ?? file.bytes;
    if (bytes < SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES) continue;
    const provenance =
      raw.provenance && typeof raw.provenance === "object"
        ? (raw.provenance as Record<string, unknown>)
        : undefined;
    largeArtifacts.push({
      ref: (typeof raw.ref === "string" ? raw.ref : basename(file.name, ".json")) as ArtifactRef,
      kind: (typeof raw.kind === "string" ? raw.kind : "document") as ArtifactKind,
      title: typeof raw.title === "string" ? raw.title : undefined,
      format: typeof raw.format === "string" ? raw.format : undefined,
      bytes,
      metadataBytes: file.bytes,
      producer: typeof provenance?.producer === "string" ? provenance.producer : undefined,
      projectRef: typeof provenance?.projectRef === "string" ? provenance.projectRef : undefined,
      taskRef: typeof provenance?.taskRef === "string" ? provenance.taskRef : undefined,
      roleRef: typeof provenance?.roleRef === "string" ? provenance.roleRef : undefined,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
      blobPath: resolvedBlobPath ? relative(cwd, resolvedBlobPath) : undefined,
    });
  }

  const blobFiles = await listSparkStateFiles(join(artifactRoot, "blobs"), true);
  const orphanBlobs = blobFiles
    .filter((file) => !referencedBlobPaths.has(resolve(file.path)))
    .map((file) => ({
      path: relative(cwd, file.path),
      bytes: file.bytes,
      mtime: new Date(file.mtimeMs).toISOString(),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

  return {
    largeArtifacts: largeArtifacts.sort(
      (a, b) => b.bytes - a.bytes || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    ),
    orphanBlobs,
  };
}

async function protectedFileDiagnostics(
  cwd: string,
  path: string,
): Promise<SparkStateProtectedFileCandidate[]> {
  return (await listSparkStateFiles(path, true))
    .map((file) => ({
      path: relative(cwd, file.path),
      bytes: file.bytes,
      mtime: new Date(file.mtimeMs).toISOString(),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}
