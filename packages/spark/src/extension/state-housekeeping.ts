import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  contentHash,
  nowIso,
  refId,
  type ArtifactKind,
  type ArtifactRef,
  type ArtifactTranscriptRetention,
  type RoleRef,
  type RunRef,
  type Task,
  type TaskRef,
  type ThreadRef,
} from "spark-core";
import {
  defaultSparkDagRunStore,
  type SparkDagRunPruneResult,
  type SparkDagRunStatus,
} from "spark-orchestrator";
import { type RoleRunArtifactBody } from "spark-runtime";
import { isUnfinishedTaskStatus, type TaskGraph } from "spark-tasks";

export interface SparkStateSessionScopes {
  currentSessionScope: string;
  currentOwnerScope: string;
}

type SparkStateCacheKind =
  | "current-thread"
  | "task-todos"
  | "session-todos"
  | "todo-display-numbers"
  | "legacy-task-todos";

type SparkProtectedStoreReason =
  | "artifact-history"
  | "task-graph"
  | "notes"
  | "role-reports"
  | "review-gate"
  | "dag-runs";

interface SparkStateCacheSummary {
  path: string;
  kind: SparkStateCacheKind;
  files: number;
  bytes: number;
  staleFiles: number;
  brokenFiles: number;
  safeToDeleteFiles: number;
  activeFiles: number;
}

interface SparkProtectedStoreSummary {
  path: string;
  reason: SparkProtectedStoreReason;
  files: number;
  bytes: number;
}

interface SparkStateHousekeepingSummary {
  root: string;
  generatedAt: string;
  caches: SparkStateCacheSummary[];
  protectedStores: SparkProtectedStoreSummary[];
}

interface SparkStateTerminalThreadCandidate {
  ref: ThreadRef;
  title: string;
  status: string;
  tasks: number;
  unfinishedTasks: number;
  updatedAt: string;
}

interface SparkStateInactiveDagRunCandidate {
  ref: RunRef;
  threadRef?: ThreadRef;
  status: SparkDagRunStatus;
  scheduled: number;
  completed: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  acknowledgedAt?: string;
}

interface SparkStateLargeArtifactCandidate {
  ref: ArtifactRef;
  kind: ArtifactKind;
  title?: string;
  format?: string;
  bytes: number;
  metadataBytes: number;
  producer?: string;
  threadRef?: string;
  taskRef?: string;
  roleRef?: string;
  createdAt?: string;
  updatedAt?: string;
  blobPath?: string;
}

interface SparkStateOrphanBlobCandidate {
  path: string;
  bytes: number;
  mtime: string;
}

type RoleRunArtifactRetentionSkipReason =
  | "not_role_run_artifact"
  | "below_threshold"
  | "missing_blob_path"
  | "missing_blob"
  | "already_retained"
  | "unsupported_legacy_body";

interface RoleRunArtifactRetentionCandidate {
  ref: ArtifactRef;
  kind: string;
  title?: string;
  taskRef?: string;
  runRef?: string;
  roleRef?: string;
  runName?: string;
  status?: string;
  bytes: number;
  metadataBytes: number;
  blobPath: string;
  candidateReason: string;
  replacementSummary: string;
  transcriptTail: ArtifactTranscriptRetention["transcriptTail"];
  exportPath?: string;
  deleted?: boolean;
}

interface RoleRunArtifactRetentionSkipped {
  ref?: string;
  path: string;
  kind?: string;
  bytes?: number;
  reason: RoleRunArtifactRetentionSkipReason;
}

interface RoleRunArtifactRetentionPlan {
  root: string;
  generatedAt: string;
  dryRun: boolean;
  thresholdBytes: number;
  tailBytes: number;
  scanned: number;
  candidates: RoleRunArtifactRetentionCandidate[];
  skipped: RoleRunArtifactRetentionSkipped[];
  deleted: RoleRunArtifactRetentionCandidate[];
  exportDir?: string;
}

interface SparkStateProtectedFileCandidate {
  path: string;
  bytes: number;
  mtime: string;
}

interface SparkStateDiagnosticsSummary {
  root: string;
  generatedAt: string;
  boundedLimit: number;
  largeArtifactThresholdBytes: number;
  terminalThreads: {
    count: number;
    shown: number;
    candidates: SparkStateTerminalThreadCandidate[];
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

interface SparkStateFileInfo {
  path: string;
  name: string;
  bytes: number;
  mtimeMs: number;
}

type SparkStateCleanupReason =
  | "broken-json"
  | "missing-thread"
  | "done-thread"
  | "stale-current-thread"
  | "empty-task-todos"
  | "stale-terminal-task-todos"
  | "empty-session-todos"
  | "stale-terminal-session-todos"
  | "stale-display-numbers";

interface SparkStateCleanupCandidate {
  path: string;
  kind: SparkStateCacheKind;
  reason: SparkStateCleanupReason;
  bytes: number;
  stale: boolean;
}

interface SparkStateCleanupSkippedSummary {
  kind: SparkStateCacheKind;
  files: number;
}

interface SparkStateCleanupPlan {
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

export const SPARK_STATE_DIAGNOSTIC_ITEM_LIMIT = 20;
export const SPARK_STATE_LARGE_ARTIFACT_THRESHOLD_BYTES = 64 * 1024;
export const SPARK_ROLE_RUN_RETENTION_TAIL_BYTES = 12 * 1024;
export const SPARK_ROLE_RUN_RETENTION_RENDER_LIMIT = 20;

export async function collectSparkStateHousekeeping(
  cwd: string,
  scopes: SparkStateSessionScopes,
  graph: TaskGraph,
): Promise<SparkStateHousekeepingSummary> {
  const root = join(cwd, ".spark");
  const threadByRef = new Map(graph.threads().map((thread) => [thread.ref, thread]));
  const taskByRef = new Map(graph.tasks().map((task) => [task.ref, task]));
  const staleCutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  return {
    root: relative(cwd, root) || ".spark",
    generatedAt: nowIso(),
    caches: [
      await summarizeCurrentThreadCache(root, scopes.currentOwnerScope, threadByRef, staleCutoffMs),
      await summarizeTaskTodoCache(root, scopes.currentSessionScope, taskByRef, staleCutoffMs),
      await summarizeSessionTodoCache(root, scopes.currentSessionScope, staleCutoffMs),
      await summarizeTodoDisplayNumberCache(root, scopes.currentSessionScope, staleCutoffMs),
      await summarizeLegacyTaskTodoCache(root),
    ],
    protectedStores: [
      await summarizeProtectedSparkStore(root, "thread.json", "task-graph", false),
      await summarizeProtectedSparkStore(root, "artifacts", "artifact-history", true),
      await summarizeProtectedSparkStore(root, "notes", "notes", true),
      await summarizeProtectedSparkStore(root, "role-reports", "role-reports", true),
      await summarizeProtectedSparkStore(root, "dag-runs.json", "dag-runs", false),
      await summarizeProtectedSparkStore(root, "review-gate.json", "review-gate", false),
    ],
  };
}

export async function collectSparkStateDiagnostics(
  cwd: string,
  graph: TaskGraph,
): Promise<SparkStateDiagnosticsSummary> {
  const root = join(cwd, ".spark");
  const artifactRoot = join(root, "artifacts");
  const allTerminalThreads = graph
    .threads()
    .map((thread) => {
      const tasks = graph.tasks(thread.ref);
      const unfinishedTasks = tasks.filter((task) => isUnfinishedTaskStatus(task.status)).length;
      return {
        ref: thread.ref,
        title: thread.title,
        status: thread.status,
        tasks: tasks.length,
        unfinishedTasks,
        updatedAt: thread.updatedAt,
      };
    })
    .filter((thread) => thread.status === "done" || thread.unfinishedTasks === 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const dagSnapshot = await defaultSparkDagRunStore(cwd).load();
  const allInactiveDagRuns = dagSnapshot.runs
    .filter((run) => run.status !== "running")
    .map((run) => ({
      ref: run.ref,
      threadRef: run.threadRef,
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
    terminalThreads: boundedDiagnostics(allTerminalThreads),
    inactiveDagRuns: boundedDiagnostics(allInactiveDagRuns),
    largeArtifacts: boundedDiagnostics(artifactInventory.largeArtifacts),
    orphanBlobs: boundedDiagnostics(artifactInventory.orphanBlobs),
    notes: boundedDiagnostics(noteCandidates),
    roleReports: boundedDiagnostics(roleReportCandidates),
  };
}

export async function collectRoleRunArtifactRetentionPlan(
  cwd: string,
  options: { dryRun: boolean; thresholdBytes: number; tailBytes: number; exportDir?: string },
): Promise<RoleRunArtifactRetentionPlan> {
  const artifactRoot = join(cwd, ".spark", "artifacts");
  const metadataFiles = (await listSparkStateFiles(artifactRoot)).filter((file) =>
    file.name.endsWith(".json"),
  );
  const plan: RoleRunArtifactRetentionPlan = {
    root: relative(cwd, artifactRoot) || ".spark/artifacts",
    generatedAt: nowIso(),
    dryRun: options.dryRun,
    thresholdBytes: options.thresholdBytes,
    tailBytes: options.tailBytes,
    scanned: metadataFiles.length,
    candidates: [],
    skipped: [],
    deleted: [],
    exportDir: options.exportDir ? displayPath(cwd, resolve(cwd, options.exportDir)) : undefined,
  };

  for (const file of metadataFiles) {
    const raw = await readJsonObject(file.path);
    if (!raw) continue;
    const ref = artifactRefFromMetadata(file, raw);
    const kind = typeof raw.kind === "string" ? raw.kind : undefined;
    const retention = metadataRecord(raw.transcriptRetention);
    if (!isHistoricalRoleRunArtifactKind(kind)) {
      plan.skipped.push({
        ref,
        path: relative(cwd, file.path),
        kind,
        reason: "not_role_run_artifact",
      });
      continue;
    }
    const blobPath = typeof raw.blobPath === "string" ? raw.blobPath : undefined;
    if (!blobPath) {
      plan.skipped.push({ ref, path: relative(cwd, file.path), kind, reason: "missing_blob_path" });
      continue;
    }
    if (typeof retention?.fullTranscriptDeletedAt === "string") {
      plan.skipped.push({ ref, path: relative(cwd, file.path), kind, reason: "already_retained" });
      continue;
    }
    const blobAbsolutePath = resolve(artifactRoot, blobPath);
    const blobInfo = await stat(blobAbsolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!blobInfo?.isFile()) {
      plan.skipped.push({ ref, path: relative(cwd, file.path), kind, reason: "missing_blob" });
      continue;
    }
    const bytes = roleRunArtifactBodyBytes(raw, blobInfo.size);
    if (bytes < options.thresholdBytes) {
      plan.skipped.push({
        ref,
        path: relative(cwd, file.path),
        kind,
        bytes,
        reason: "below_threshold",
      });
      continue;
    }
    const bodyInfo = extractRoleRunArtifactBodyInfo(raw);
    const candidate: RoleRunArtifactRetentionCandidate = {
      ref,
      kind: kind ?? "role-run",
      title: typeof raw.title === "string" ? raw.title : undefined,
      taskRef: bodyInfo.taskRef,
      runRef: bodyInfo.runRef,
      roleRef: bodyInfo.roleRef,
      runName: bodyInfo.runName,
      status: bodyInfo.status,
      bytes,
      metadataBytes: file.bytes,
      blobPath: relative(cwd, blobAbsolutePath),
      candidateReason: `large_${kind}_transcript_blob`,
      replacementSummary: roleRunReplacementSummary(ref, bodyInfo, bytes),
      transcriptTail: await readSerializedTranscriptTail(
        blobAbsolutePath,
        blobInfo.size,
        options.tailBytes,
      ),
      exportPath: options.exportDir
        ? displayPath(cwd, roleRunTranscriptExportPath(cwd, options.exportDir, ref, raw))
        : undefined,
    };
    plan.candidates.push(candidate);
    if (!options.dryRun) {
      await applyRoleRunArtifactRetention(cwd, file, raw, candidate);
      candidate.deleted = true;
      plan.deleted.push(candidate);
    }
  }

  plan.candidates.sort((a, b) => b.bytes - a.bytes || a.ref.localeCompare(b.ref));
  plan.deleted.sort((a, b) => b.bytes - a.bytes || a.ref.localeCompare(b.ref));
  return plan;
}

async function applyRoleRunArtifactRetention(
  cwd: string,
  file: SparkStateFileInfo,
  raw: Record<string, unknown>,
  candidate: RoleRunArtifactRetentionCandidate,
): Promise<void> {
  const now = nowIso();
  const exportPath = candidate.exportPath ? resolve(cwd, candidate.exportPath) : undefined;
  const blobAbsolutePath = resolve(cwd, candidate.blobPath);
  if (exportPath) {
    await mkdir(dirname(exportPath), { recursive: true });
    await copyFile(blobAbsolutePath, exportPath);
  }
  const compactBody = compactRoleRunRetentionBody(raw, candidate);
  const serializedBody = JSON.stringify(compactBody, null, 2);
  const retention: ArtifactTranscriptRetention = {
    schemaVersion: 1,
    strategy: "role-run-compact-summary-tail",
    candidateReason: candidate.candidateReason,
    originalBlobPath: typeof raw.blobPath === "string" ? raw.blobPath : undefined,
    originalHash: typeof raw.hash === "string" ? raw.hash : undefined,
    originalBodySize: candidate.bytes,
    originalMetadataBytes: candidate.metadataBytes,
    replacementSummary: candidate.replacementSummary,
    transcriptTail: candidate.transcriptTail,
    exportPath: candidate.exportPath,
    compactedAt: now,
    fullTranscriptDeletedAt: now,
  };
  const replacement: Record<string, unknown> = {
    ...raw,
    body: compactBody,
    bodyPreview: serializedBody,
    bodySize: Buffer.byteLength(serializedBody, "utf8"),
    bodyTruncated: false,
    transcriptRetention: retention,
    hash: contentHash(serializedBody),
    updatedAt: now,
  };
  delete replacement.blobPath;
  const tmpPath = `${file.path}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
  await rename(tmpPath, file.path);
  await rm(blobAbsolutePath, { force: true });
}

function compactRoleRunRetentionBody(
  raw: Record<string, unknown>,
  candidate: RoleRunArtifactRetentionCandidate,
): RoleRunArtifactBody & { transcriptRetention: ArtifactTranscriptRetention } {
  const now = nowIso();
  const provenance = metadataRecord(raw.provenance);
  const runRef = (candidate.runRef ??
    provenanceString(provenance, "runRef") ??
    `run:${refId(candidate.ref)}`) as RunRef;
  const taskRef = (candidate.taskRef ??
    provenanceString(provenance, "taskRef") ??
    `task:${refId(candidate.ref)}`) as TaskRef;
  const roleRef = (candidate.roleRef ??
    provenanceString(provenance, "roleRef") ??
    "role:unknown") as RoleRef;
  const body: RoleRunArtifactBody & { transcriptRetention: ArtifactTranscriptRetention } = {
    schemaVersion: 1,
    runRef,
    taskRef,
    roleRef,
    runName: candidate.runName,
    status: (candidate.status ?? "unknown") as RoleRunArtifactBody["status"],
    summary: candidate.replacementSummary,
    record: {
      ref: runRef,
      roleRef,
      runName: candidate.runName,
      status: (candidate.status ?? "unknown") as RoleRunArtifactBody["status"],
      startedAt: roleRunDateFromRaw(raw, "startedAt"),
      finishedAt: roleRunDateFromRaw(raw, "finishedAt"),
    },
    stdout: {
      bytes: candidate.transcriptTail?.bytes ?? candidate.bytes,
      tail: candidate.transcriptTail?.tail ?? "",
      tailBytes: candidate.transcriptTail?.tailBytes ?? 0,
      truncated: candidate.transcriptTail?.truncated ?? true,
    },
    stderr: { bytes: 0, tail: "", tailBytes: 0, truncated: false },
    jsonEvents: { count: 0, tail: [], tailEventCount: 0, truncated: false },
    transcriptRetention: {
      schemaVersion: 1,
      strategy: "role-run-compact-summary-tail",
      candidateReason: candidate.candidateReason,
      originalBlobPath: typeof raw.blobPath === "string" ? raw.blobPath : undefined,
      originalHash: typeof raw.hash === "string" ? raw.hash : undefined,
      originalBodySize: candidate.bytes,
      originalMetadataBytes: candidate.metadataBytes,
      replacementSummary: candidate.replacementSummary,
      transcriptTail: candidate.transcriptTail,
      exportPath: candidate.exportPath,
      compactedAt: now,
      fullTranscriptDeletedAt: now,
    },
  };
  return body;
}

async function readSerializedTranscriptTail(
  path: string,
  bytes: number,
  tailBytes: number,
): Promise<ArtifactTranscriptRetention["transcriptTail"]> {
  const start = Math.max(0, bytes - tailBytes);
  const length = bytes - start;
  const buffer = Buffer.alloc(length);
  const handle = await open(path, "r");
  try {
    await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }
  const tail = buffer.toString("utf8");
  return {
    bytes,
    tail,
    tailBytes: Buffer.byteLength(tail, "utf8"),
    truncated: start > 0,
    source: "serialized-artifact-body-tail",
  };
}

function extractRoleRunArtifactBodyInfo(raw: Record<string, unknown>): {
  runRef?: string;
  taskRef?: string;
  roleRef?: string;
  runName?: string;
  status?: string;
} {
  const body = raw.body;
  const provenance = metadataRecord(raw.provenance);
  if (metadataRecord(body)) {
    const bodyRecord = body as Record<string, unknown>;
    const nestedRecord = metadataRecord(bodyRecord.record);
    return {
      runRef: metadataString(bodyRecord.runRef) ?? metadataString(nestedRecord?.ref),
      taskRef: metadataString(bodyRecord.taskRef) ?? provenanceString(provenance, "taskRef"),
      roleRef: metadataString(bodyRecord.roleRef) ?? provenanceString(provenance, "roleRef"),
      runName: metadataString(bodyRecord.runName) ?? metadataString(nestedRecord?.runName),
      status: metadataString(bodyRecord.status) ?? metadataString(nestedRecord?.status),
    };
  }
  const preview = roleRunArtifactPreviewText(raw);
  return {
    runRef: extractJsonStringField(preview, "ref"),
    taskRef: provenanceString(provenance, "taskRef"),
    roleRef: extractJsonStringField(preview, "roleRef") ?? provenanceString(provenance, "roleRef"),
    runName: extractJsonStringField(preview, "runName"),
    status: extractJsonStringField(preview, "status"),
  };
}

function roleRunArtifactPreviewText(raw: Record<string, unknown>): string {
  if (typeof raw.bodyPreview === "string") return raw.bodyPreview;
  if (typeof raw.body === "string") return raw.body;
  if (metadataRecord(raw.body)) return JSON.stringify(raw.body);
  return "";
}

function roleRunReplacementSummary(
  ref: ArtifactRef,
  info: ReturnType<typeof extractRoleRunArtifactBodyInfo>,
  bytes: number,
): string {
  const identity = info.runName ?? info.runRef ?? ref;
  const status = info.status ? ` with status ${info.status}` : "";
  return `Historical role-run transcript ${identity}${status} compacted from ${formatByteSize(bytes)} full transcript blob; compact summary, serialized tail, and optional export path are retained in artifact metadata.`;
}

function roleRunArtifactBodyBytes(raw: Record<string, unknown>, blobBytes: number): number {
  const bodySize = raw.bodySize;
  return typeof bodySize === "number" && Number.isFinite(bodySize) ? bodySize : blobBytes;
}

function roleRunTranscriptExportPath(
  cwd: string,
  exportDir: string,
  ref: ArtifactRef,
  raw: Record<string, unknown>,
): string {
  const absoluteDir = resolve(cwd, exportDir);
  const hash = typeof raw.hash === "string" ? raw.hash.slice(0, 12) : "nohash";
  return join(absoluteDir, `${refId(ref)}-${hash}.json`);
}

function roleRunDateFromRaw(
  raw: Record<string, unknown>,
  key: "startedAt" | "finishedAt",
): string | undefined {
  const body = metadataRecord(raw.body);
  const record = metadataRecord(body?.record);
  return (
    metadataString(body?.[key]) ??
    metadataString(record?.[key]) ??
    extractJsonStringField(roleRunArtifactPreviewText(raw), key)
  );
}

function artifactRefFromMetadata(
  file: SparkStateFileInfo,
  raw: Record<string, unknown>,
): ArtifactRef {
  const ref = typeof raw.ref === "string" ? raw.ref : `artifact:${basename(file.name, ".json")}`;
  return ref.startsWith("artifact:") ? (ref as ArtifactRef) : (`artifact:${ref}` as ArtifactRef);
}

function isHistoricalRoleRunArtifactKind(kind: string | undefined): boolean {
  return kind === "role-run" || kind === "agent-run";
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function provenanceString(
  provenance: Record<string, unknown> | undefined,
  key: "runRef" | "taskRef" | "roleRef",
): string | undefined {
  return metadataString(provenance?.[key]);
}

function extractJsonStringField(text: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u").exec(text);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !resolve(cwd, rel).startsWith(`${resolve(cwd)}..`)
    ? rel
    : path;
}

export async function collectSparkStateCleanupPlan(
  cwd: string,
  scopes: SparkStateSessionScopes,
  graph: TaskGraph,
  options: { dryRun: boolean; olderThanDays: number; includeBroken: boolean },
): Promise<SparkStateCleanupPlan> {
  const root = join(cwd, ".spark");
  const threadByRef = new Map(graph.threads().map((thread) => [thread.ref, thread]));
  const taskByRef = new Map(graph.tasks().map((task) => [task.ref, task]));
  const staleCutoffMs = Date.now() - options.olderThanDays * 24 * 60 * 60 * 1_000;
  const protectedStores = [
    await summarizeProtectedSparkStore(root, "thread.json", "task-graph", false),
    await summarizeProtectedSparkStore(root, "artifacts", "artifact-history", true),
    await summarizeProtectedSparkStore(root, "notes", "notes", true),
    await summarizeProtectedSparkStore(root, "role-reports", "role-reports", true),
    await summarizeProtectedSparkStore(root, "dag-runs.json", "dag-runs", false),
    await summarizeProtectedSparkStore(root, "review-gate.json", "review-gate", false),
  ];
  const candidates = [
    ...(await currentThreadCleanupCandidates(
      cwd,
      root,
      scopes.currentOwnerScope,
      threadByRef,
      staleCutoffMs,
      options.includeBroken,
    )),
    ...(await taskTodoCleanupCandidates(
      cwd,
      root,
      scopes.currentSessionScope,
      taskByRef,
      staleCutoffMs,
      options.includeBroken,
    )),
    ...(await sessionTodoCleanupCandidates(
      cwd,
      root,
      scopes.currentSessionScope,
      staleCutoffMs,
      options.includeBroken,
    )),
    ...(await todoDisplayNumberCleanupCandidates(
      cwd,
      root,
      scopes.currentSessionScope,
      staleCutoffMs,
      options.includeBroken,
    )),
  ];
  const caches = await Promise.all([
    summarizeCurrentThreadCache(root, scopes.currentOwnerScope, threadByRef, staleCutoffMs),
    summarizeTaskTodoCache(root, scopes.currentSessionScope, taskByRef, staleCutoffMs),
    summarizeSessionTodoCache(root, scopes.currentSessionScope, staleCutoffMs),
    summarizeTodoDisplayNumberCache(root, scopes.currentSessionScope, staleCutoffMs),
    summarizeLegacyTaskTodoCache(root),
  ]);
  const candidateCountByKind = new Map<SparkStateCacheKind, number>();
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

async function currentThreadCleanupCandidates(
  cwd: string,
  root: string,
  currentOwnerScope: string,
  threadByRef: Map<ThreadRef, ReturnType<TaskGraph["threads"]>[number]>,
  staleCutoffMs: number,
  includeBroken: boolean,
): Promise<SparkStateCleanupCandidate[]> {
  const candidates: SparkStateCleanupCandidate[] = [];
  for (const file of await listSparkStateFiles(join(root, "current-thread"))) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentOwnerScope;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      if (includeBroken)
        candidates.push(cleanupCandidate(cwd, file, "current-thread", "broken-json", stale));
      continue;
    }
    const threadRef = typeof raw.threadRef === "string" ? (raw.threadRef as ThreadRef) : undefined;
    const thread = threadRef ? threadByRef.get(threadRef) : undefined;
    if (!thread)
      candidates.push(cleanupCandidate(cwd, file, "current-thread", "missing-thread", stale));
    else if (thread.status === "done")
      candidates.push(cleanupCandidate(cwd, file, "current-thread", "done-thread", stale));
    else if (stale)
      candidates.push(cleanupCandidate(cwd, file, "current-thread", "stale-current-thread", stale));
  }
  return candidates;
}

async function taskTodoCleanupCandidates(
  cwd: string,
  root: string,
  currentSessionScope: string,
  taskByRef: Map<TaskRef, Task>,
  staleCutoffMs: number,
  includeBroken: boolean,
): Promise<SparkStateCleanupCandidate[]> {
  const candidates: SparkStateCleanupCandidate[] = [];
  for (const file of await listSparkStateFiles(join(root, "todos"))) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      if (includeBroken)
        candidates.push(cleanupCandidate(cwd, file, "task-todos", "broken-json", stale));
      continue;
    }
    const todos = Array.isArray(raw.todos) ? raw.todos : [];
    const allTerminalTodos = todos.every((todo) => isTerminalTodoStatus(todoStatus(todo)));
    const allTasksTerminalOrMissing = todos.every((todo) => {
      const taskRef =
        todo &&
        typeof todo === "object" &&
        typeof (todo as { taskRef?: unknown }).taskRef === "string"
          ? ((todo as { taskRef: string }).taskRef as TaskRef)
          : undefined;
      const task = taskRef ? taskByRef.get(taskRef) : undefined;
      return !task || !isUnfinishedTaskStatus(task.status);
    });
    if (fileScope(file) === currentSessionScope) continue;
    if (todos.length === 0)
      candidates.push(cleanupCandidate(cwd, file, "task-todos", "empty-task-todos", stale));
    else if (stale && allTerminalTodos && allTasksTerminalOrMissing)
      candidates.push(
        cleanupCandidate(cwd, file, "task-todos", "stale-terminal-task-todos", stale),
      );
  }
  return candidates;
}

async function sessionTodoCleanupCandidates(
  cwd: string,
  root: string,
  currentSessionScope: string,
  staleCutoffMs: number,
  includeBroken: boolean,
): Promise<SparkStateCleanupCandidate[]> {
  const candidates: SparkStateCleanupCandidate[] = [];
  for (const file of await listSparkStateFiles(join(root, "session-todos"))) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      if (includeBroken)
        candidates.push(cleanupCandidate(cwd, file, "session-todos", "broken-json", stale));
      continue;
    }
    const todos = Array.isArray(raw.todos) ? raw.todos : [];
    const allTerminalTodos = todos.every((todo) => isTerminalTodoStatus(todoStatus(todo)));
    if (fileScope(file) === currentSessionScope) continue;
    if (todos.length === 0)
      candidates.push(cleanupCandidate(cwd, file, "session-todos", "empty-session-todos", stale));
    else if (stale && allTerminalTodos)
      candidates.push(
        cleanupCandidate(cwd, file, "session-todos", "stale-terminal-session-todos", stale),
      );
  }
  return candidates;
}

async function todoDisplayNumberCleanupCandidates(
  cwd: string,
  root: string,
  currentSessionScope: string,
  staleCutoffMs: number,
  includeBroken: boolean,
): Promise<SparkStateCleanupCandidate[]> {
  const candidates: SparkStateCleanupCandidate[] = [];
  for (const file of await listSparkStateFiles(join(root, "todo-display-numbers"))) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      if (includeBroken)
        candidates.push(cleanupCandidate(cwd, file, "todo-display-numbers", "broken-json", stale));
      continue;
    }
    if (stale)
      candidates.push(
        cleanupCandidate(cwd, file, "todo-display-numbers", "stale-display-numbers", stale),
      );
  }
  return candidates;
}

function cleanupCandidate(
  cwd: string,
  file: SparkStateFileInfo,
  kind: SparkStateCacheKind,
  reason: SparkStateCleanupReason,
  stale: boolean,
): SparkStateCleanupCandidate {
  return { path: relative(cwd, file.path), kind, reason, bytes: file.bytes, stale };
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
    if (blobPath) referencedBlobPaths.add(resolve(artifactRoot, blobPath));
    const bodySize =
      typeof raw.bodySize === "number" && Number.isFinite(raw.bodySize) ? raw.bodySize : undefined;
    const blobBytes = blobPath
      ? await stat(resolve(artifactRoot, blobPath))
          .then((info) => (info.isFile() ? info.size : undefined))
          .catch(() => undefined)
      : undefined;
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
      threadRef: typeof provenance?.threadRef === "string" ? provenance.threadRef : undefined,
      taskRef: typeof provenance?.taskRef === "string" ? provenance.taskRef : undefined,
      roleRef: typeof provenance?.roleRef === "string" ? provenance.roleRef : undefined,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
      blobPath: blobPath ? relative(cwd, resolve(artifactRoot, blobPath)) : undefined,
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

async function summarizeCurrentThreadCache(
  root: string,
  currentOwnerScope: string,
  threadByRef: Map<ThreadRef, ReturnType<TaskGraph["threads"]>[number]>,
  staleCutoffMs: number,
): Promise<SparkStateCacheSummary> {
  const files = await listSparkStateFiles(join(root, "current-thread"));
  let staleFiles = 0;
  let brokenFiles = 0;
  let safeToDeleteFiles = 0;
  let activeFiles = 0;
  for (const file of files) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentOwnerScope;
    if (stale) staleFiles += 1;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      brokenFiles += 1;
      safeToDeleteFiles += 1;
      continue;
    }
    const threadRef = typeof raw.threadRef === "string" ? (raw.threadRef as ThreadRef) : undefined;
    const thread = threadRef ? threadByRef.get(threadRef) : undefined;
    const safe = !thread || thread.status === "done" || stale;
    if (safe) safeToDeleteFiles += 1;
    else activeFiles += 1;
  }
  return cacheSummary(root, "current-thread", "current-thread", files, {
    staleFiles,
    brokenFiles,
    safeToDeleteFiles,
    activeFiles,
  });
}

async function summarizeTaskTodoCache(
  root: string,
  currentSessionScope: string,
  taskByRef: Map<TaskRef, Task>,
  staleCutoffMs: number,
): Promise<SparkStateCacheSummary> {
  const files = await listSparkStateFiles(join(root, "todos"));
  let staleFiles = 0;
  let brokenFiles = 0;
  let safeToDeleteFiles = 0;
  let activeFiles = 0;
  for (const file of files) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    if (stale) staleFiles += 1;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      brokenFiles += 1;
      continue;
    }
    const todos = Array.isArray(raw.todos) ? raw.todos : [];
    const hasActiveTodo = todos.some((todo) => isActiveTodoStatus(todoStatus(todo)));
    const allTerminalTodos = todos.every((todo) => isTerminalTodoStatus(todoStatus(todo)));
    const allTasksTerminalOrMissing = todos.every((todo) => {
      const taskRef =
        todo &&
        typeof todo === "object" &&
        typeof (todo as { taskRef?: unknown }).taskRef === "string"
          ? ((todo as { taskRef: string }).taskRef as TaskRef)
          : undefined;
      const task = taskRef ? taskByRef.get(taskRef) : undefined;
      return !task || !isUnfinishedTaskStatus(task.status);
    });
    if (hasActiveTodo) activeFiles += 1;
    if (todos.length === 0 || (stale && allTerminalTodos && allTasksTerminalOrMissing))
      safeToDeleteFiles += 1;
  }
  return cacheSummary(root, "todos", "task-todos", files, {
    staleFiles,
    brokenFiles,
    safeToDeleteFiles,
    activeFiles,
  });
}

async function summarizeSessionTodoCache(
  root: string,
  currentSessionScope: string,
  staleCutoffMs: number,
): Promise<SparkStateCacheSummary> {
  const files = await listSparkStateFiles(join(root, "session-todos"));
  let staleFiles = 0;
  let brokenFiles = 0;
  let safeToDeleteFiles = 0;
  let activeFiles = 0;
  for (const file of files) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    if (stale) staleFiles += 1;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      brokenFiles += 1;
      continue;
    }
    const todos = Array.isArray(raw.todos) ? raw.todos : [];
    const hasActiveTodo = todos.some((todo) => isActiveTodoStatus(todoStatus(todo)));
    const allTerminalTodos = todos.every((todo) => isTerminalTodoStatus(todoStatus(todo)));
    if (hasActiveTodo) activeFiles += 1;
    if (todos.length === 0 || (stale && allTerminalTodos)) safeToDeleteFiles += 1;
  }
  return cacheSummary(root, "session-todos", "session-todos", files, {
    staleFiles,
    brokenFiles,
    safeToDeleteFiles,
    activeFiles,
  });
}

async function summarizeTodoDisplayNumberCache(
  root: string,
  currentSessionScope: string,
  staleCutoffMs: number,
): Promise<SparkStateCacheSummary> {
  const files = await listSparkStateFiles(join(root, "todo-display-numbers"));
  let staleFiles = 0;
  let brokenFiles = 0;
  let safeToDeleteFiles = 0;
  let activeFiles = 0;
  for (const file of files) {
    const stale = file.mtimeMs < staleCutoffMs && fileScope(file) !== currentSessionScope;
    if (stale) staleFiles += 1;
    const raw = await readJsonObject(file.path);
    if (!raw) {
      brokenFiles += 1;
      safeToDeleteFiles += 1;
      continue;
    }
    if (stale) safeToDeleteFiles += 1;
    else activeFiles += 1;
  }
  return cacheSummary(root, "todo-display-numbers", "todo-display-numbers", files, {
    staleFiles,
    brokenFiles,
    safeToDeleteFiles,
    activeFiles,
  });
}

async function summarizeLegacyTaskTodoCache(root: string): Promise<SparkStateCacheSummary> {
  const files = await listSparkStateFiles(root);
  const legacyFiles = files.filter((file) => file.name === "todos.json");
  return cacheSummary(root, "todos.json", "legacy-task-todos", legacyFiles, {
    staleFiles: 0,
    brokenFiles: 0,
    safeToDeleteFiles: 0,
    activeFiles: legacyFiles.length,
  });
}

async function summarizeProtectedSparkStore(
  root: string,
  child: string,
  reason: SparkProtectedStoreReason,
  recursive: boolean,
): Promise<SparkProtectedStoreSummary> {
  const files = await listSparkStateFiles(join(root, child), recursive);
  return {
    path: join(relative(dirname(root), root), child),
    reason,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function cacheSummary(
  root: string,
  child: string,
  kind: SparkStateCacheKind,
  files: SparkStateFileInfo[],
  counts: Omit<SparkStateCacheSummary, "path" | "kind" | "files" | "bytes">,
): SparkStateCacheSummary {
  return {
    path: join(relative(dirname(root), root), child),
    kind,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    ...counts,
  };
}

async function listSparkStateFiles(path: string, recursive = false): Promise<SparkStateFileInfo[]> {
  const rootInfo = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootInfo) return [];
  if (rootInfo.isFile())
    return [{ path, name: basename(path), bytes: rootInfo.size, mtimeMs: rootInfo.mtimeMs }];
  if (!rootInfo.isDirectory()) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const files: SparkStateFileInfo[] = [];
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      if (recursive) files.push(...(await listSparkStateFiles(entryPath, true)));
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(entryPath).catch(() => undefined);
    if (!info?.isFile()) continue;
    files.push({ path: entryPath, name: entry.name, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      return raw as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

function fileScope(file: SparkStateFileInfo): string {
  return file.name.replace(/\.json$/u, "");
}

function todoStatus(todo: unknown): string | undefined {
  return todo && typeof todo === "object" && "status" in todo
    ? String((todo as { status?: unknown }).status)
    : undefined;
}

function isActiveTodoStatus(status: string | undefined): boolean {
  return status === "pending" || status === "in_progress" || status === "blocked";
}

function isTerminalTodoStatus(status: string | undefined): boolean {
  return status === "done" || status === "cancelled" || status === "deleted";
}

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
  lines.push("Protected stores:");
  for (const store of summary.protectedStores) {
    lines.push(
      `  ${formatSparkProtectedStoreReason(store.reason)}: ${store.files} files, ${formatByteSize(store.bytes)} (${store.path})`,
    );
  }
}

export function appendSparkStateDiagnosticsLines(
  lines: string[],
  diagnostics: SparkStateDiagnosticsSummary,
): void {
  lines.push(
    `Bounded output: showing at most ${diagnostics.boundedLimit} item(s) per category; large artifact threshold=${formatByteSize(diagnostics.largeArtifactThresholdBytes)}.`,
  );
  appendTerminalThreadDiagnostics(lines, diagnostics.terminalThreads);
  appendInactiveDagRunDiagnostics(lines, diagnostics.inactiveDagRuns);
  appendLargeArtifactDiagnostics(lines, diagnostics.largeArtifacts);
  appendOrphanBlobDiagnostics(lines, diagnostics.orphanBlobs);
  appendProtectedFileDiagnostics(lines, "notes", diagnostics.notes);
  appendProtectedFileDiagnostics(lines, "role reports", diagnostics.roleReports);
  lines.push(
    "Protected-store diagnostics are read-only; no thread graph, artifact, note, role-report, DAG run, or review-gate files were deleted.",
  );
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
  const missingBlob = plan.skipped.filter(
    (item) => item.reason === "missing_blob" || item.reason === "missing_blob_path",
  ).length;
  lines.push(
    `Skipped: non-role-run=${keepCount}, below-threshold=${belowThreshold}, already-retained=${alreadyRetained}, missing-blob=${missingBlob}.`,
  );
  lines.push(
    plan.dryRun
      ? "Dry-run only: no metadata was rewritten and no full transcript blobs were deleted. Run with dryRun=false only after reviewing candidates and, if needed, setting exportDir."
      : "Apply complete: each deleted full transcript blob has replacement summary/tail metadata and optional export path recorded before deletion.",
  );
}

function appendTerminalThreadDiagnostics(
  lines: string[],
  summary: SparkStateDiagnosticsSummary["terminalThreads"],
): void {
  lines.push(
    `Terminal/no-unfinished threads: ${summary.count}${summary.shown < summary.count ? ` (showing ${summary.shown})` : ""}`,
  );
  for (const thread of summary.candidates)
    lines.push(
      `  - ${thread.ref} ${thread.status} tasks=${thread.tasks} unfinished=${thread.unfinishedTasks} updated=${thread.updatedAt} ${thread.title}`,
    );
}

function appendInactiveDagRunDiagnostics(
  lines: string[],
  summary: SparkStateDiagnosticsSummary["inactiveDagRuns"],
): void {
  lines.push(
    `Inactive DAG runs: ${summary.count}${summary.shown < summary.count ? ` (showing ${summary.shown})` : ""}`,
  );
  for (const run of summary.candidates)
    lines.push(
      `  - ${run.ref} ${run.status} scheduled=${run.scheduled} completed=${run.completed} updated=${run.updatedAt}${run.threadRef ? ` thread=${run.threadRef}` : ""}`,
    );
}

export function appendSparkDagRunPruneLines(lines: string[], prune: SparkDagRunPruneResult): void {
  lines.push(
    `Retention: olderThanDays=${prune.olderThanDays} cutoff=${prune.cutoffIso} keepRecent=${prune.keepRecent} keepRecentPerThread=${prune.keepRecentPerThread} before=${prune.before} after=${prune.after}`,
  );
  lines.push(
    `${prune.dryRun ? "Candidates" : "Deleted"}: ${prune.dryRun ? prune.candidates.length : prune.deleted.length}; kept=${prune.kept.length}`,
  );
  const visibleCandidates = (prune.dryRun ? prune.candidates : prune.deleted).slice(0, 20);
  for (const candidate of visibleCandidates)
    lines.push(
      `  - ${candidate.ref} ${candidate.status} reason=${candidate.reason} retentionDate=${candidate.retentionDate}${candidate.threadRef ? ` thread=${candidate.threadRef}` : ""}`,
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
      artifact.threadRef ? `thread=${artifact.threadRef}` : undefined,
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
    case "current-thread":
      return "current-thread";
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
      return "thread graph";
    case "notes":
      return "notes";
    case "role-reports":
      return "role reports";
    case "review-gate":
      return "review gate";
    case "dag-runs":
      return "dag runs";
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
