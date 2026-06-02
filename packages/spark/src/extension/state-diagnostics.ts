import { basename, join, relative, resolve } from "node:path";

import { resolveArtifactBlobPath } from "spark-core";
import {
  nowIso,
  type ArtifactKind,
  type ArtifactRef,
  type RunRef,
  type ProjectRef,
} from "spark-core";
import { defaultSparkDagRunStore, type SparkDagRunStatus } from "spark-workflows";
import { isUnfinishedTaskStatus, type TaskGraph } from "spark-tasks";
import { listSparkStateFiles, readJsonObject, statIfPresent } from "./state-housekeeping-files.ts";

export interface SparkStateTerminalProjectCandidate {
  ref: ProjectRef;
  title: string;
  status: string;
  tasks: number;
  unfinishedTasks: number;
  updatedAt: string;
}

export interface SparkStateInactiveDagRunCandidate {
  ref: RunRef;
  projectRef?: ProjectRef;
  status: SparkDagRunStatus;
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
  inactiveDagRuns: {
    count: number;
    shown: number;
    candidates: SparkStateInactiveDagRunCandidate[];
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
        status: project.status,
        tasks: tasks.length,
        unfinishedTasks,
        updatedAt: project.updatedAt,
      };
    })
    .filter((project) => project.status === "done" || project.unfinishedTasks === 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const dagSnapshot = await defaultSparkDagRunStore(cwd).load();
  const allInactiveDagRuns = dagSnapshot.runs
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

  return {
    root: relative(cwd, root) || ".spark",
    generatedAt: nowIso(),
    boundedLimit: SPARK_STATE_DIAGNOSTIC_ITEM_LIMIT,
    largeArtifactThresholdBytes: SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES,
    terminalProjects: boundedDiagnostics(allTerminalProjects),
    inactiveDagRuns: boundedDiagnostics(allInactiveDagRuns),
    largeArtifacts: boundedDiagnostics(artifactInventory.largeArtifacts),
    orphanBlobs: boundedDiagnostics(artifactInventory.orphanBlobs),
    notes: boundedDiagnostics(noteCandidates),
    roleReports: boundedDiagnostics(roleReportCandidates),
  };
}

function boundedDiagnostics<T>(candidates: T[]): { count: number; shown: number; candidates: T[] } {
  const visible = candidates.slice(0, SPARK_STATE_DIAGNOSTIC_ITEM_LIMIT);
  return { count: candidates.length, shown: visible.length, candidates: visible };
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
      kind: (typeof raw.kind === "string" ? raw.kind : "research") as ArtifactKind,
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
