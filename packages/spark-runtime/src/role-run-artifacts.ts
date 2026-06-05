import { copyFile, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import type { RoleRunRecord, RoleRunStatus } from "pi-roles";
import { resolveArtifactBlobPath } from "pi-artifacts";
import type { ArtifactTranscriptRetention, Artifact } from "pi-artifacts";
import {
  contentHash,
  type ArtifactRef,
  isFileNotFoundError,
  nowIso,
  readJsonFileOptional,
  refId,
  type RoleRef,
  type RunRef,
  type TaskRef,
  writeJsonFileAtomic,
} from "pi-extension-api";

export const SPARK_ROLE_RUN_ARTIFACT_PREVIEW_METADATA_MAX_BYTES = 256 * 1024;

export interface RoleRunTextTail {
  bytes: number;
  tail: string;
  tailBytes: number;
  truncated: boolean;
}

export interface RoleRunJsonEventsTail {
  count: number;
  tail: string[];
  tailEventCount: number;
  truncated: boolean;
}

export interface RoleRunArtifactBody {
  schemaVersion: 1;
  runRef: RunRef;
  taskRef: TaskRef;
  roleRef: RoleRef;
  runName?: string;
  status: RoleRunStatus;
  startedAt?: string;
  finishedAt?: string;
  summary: string;
  transcriptRef?: ArtifactRef;
  record: Omit<RoleRunRecord, "instruction">;
  stdout: RoleRunTextTail;
  stderr: RoleRunTextTail;
  jsonEvents: RoleRunJsonEventsTail;
}

export interface RoleRunArtifactPreview {
  artifactRef: ArtifactRef;
  status?: string;
  summary?: string;
  transcriptRef?: ArtifactRef;
  stdout?: RoleRunTextTail;
  stderr?: RoleRunTextTail;
  jsonEvents?: RoleRunJsonEventsTail;
  bodySize?: number;
  bodyTruncated?: boolean;
  skippedReason?: string;
}

export function isRoleRunArtifactBody(value: unknown): value is RoleRunArtifactBody {
  const record = roleRunRetentionRecord(value);
  if (!record) return false;
  return (
    record.schemaVersion === 1 &&
    typeof record.runRef === "string" &&
    typeof record.taskRef === "string" &&
    typeof record.roleRef === "string" &&
    typeof record.status === "string" &&
    typeof record.summary === "string" &&
    isRoleRunTextTail(record.stdout) &&
    isRoleRunTextTail(record.stderr) &&
    isRoleRunJsonEventsTail(record.jsonEvents)
  );
}

export function isRoleRunTextTail(value: unknown): value is RoleRunTextTail {
  const record = roleRunRetentionRecord(value);
  if (!record) return false;
  return (
    typeof record.bytes === "number" &&
    typeof record.tail === "string" &&
    typeof record.tailBytes === "number" &&
    typeof record.truncated === "boolean"
  );
}

export function isRoleRunJsonEventsTail(value: unknown): value is RoleRunJsonEventsTail {
  const record = roleRunRetentionRecord(value);
  if (!record) return false;
  return (
    typeof record.count === "number" &&
    Array.isArray(record.tail) &&
    record.tail.every((entry) => typeof entry === "string") &&
    typeof record.tailEventCount === "number" &&
    typeof record.truncated === "boolean"
  );
}

export const SPARK_ROLE_RUN_RETENTION_TAIL_BYTES = 12 * 1024;

export async function readRoleRunArtifactPreview(
  cwd: string,
  artifactRef: ArtifactRef,
  options: { maxMetadataBytes?: number } = {},
): Promise<RoleRunArtifactPreview> {
  const metadataPath = join(cwd, ".spark", "artifacts", `${refId(artifactRef)}.json`);
  const metadataStat = await stat(metadataPath).catch((error: NodeJS.ErrnoException) => {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  });
  if (!metadataStat) {
    return {
      artifactRef,
      skippedReason: `metadata_unavailable: ${metadataPath} not found`,
    };
  }
  const maxMetadataBytes =
    options.maxMetadataBytes ?? SPARK_ROLE_RUN_ARTIFACT_PREVIEW_METADATA_MAX_BYTES;
  if (metadataStat.size > maxMetadataBytes) {
    return {
      artifactRef,
      bodySize: metadataStat.size,
      skippedReason: `metadata_too_large: ${metadataStat.size} bytes; full artifact not loaded`,
    };
  }
  const rawMetadata = await readFile(metadataPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  });
  if (rawMetadata === undefined) {
    return {
      artifactRef,
      skippedReason: `metadata_unavailable: ${metadataPath} not found`,
    };
  }

  let artifact: Artifact;
  try {
    artifact = JSON.parse(rawMetadata) as Artifact;
  } catch (error) {
    return {
      artifactRef,
      bodySize: metadataStat.size,
      skippedReason: `metadata_parse_failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (artifact.kind !== "role-run") {
    return {
      artifactRef,
      bodySize: artifact.bodySize,
      bodyTruncated: artifact.bodyTruncated,
      skippedReason: `not_role_run_artifact: ${artifact.kind}`,
    };
  }
  if (!isRoleRunArtifactBody(artifact.body)) {
    return {
      artifactRef,
      bodySize: artifact.bodySize,
      bodyTruncated: artifact.bodyTruncated,
      skippedReason: "unsupported_role_run_body: full artifact not loaded",
    };
  }
  return {
    artifactRef,
    status: artifact.body.status,
    summary: artifact.body.summary,
    transcriptRef: artifact.body.transcriptRef,
    stdout: artifact.body.stdout,
    stderr: artifact.body.stderr,
    jsonEvents: artifact.body.jsonEvents,
    bodySize: artifact.bodySize,
    bodyTruncated: artifact.bodyTruncated,
  };
}

export type RoleRunArtifactRetentionSkipReason =
  | "not_role_run_artifact"
  | "below_threshold"
  | "missing_blob_path"
  | "invalid_blob_path"
  | "missing_blob"
  | "invalid_json"
  | "already_retained";

export interface RoleRunArtifactRetentionCandidate {
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

export interface RoleRunArtifactRetentionSkipped {
  ref?: string;
  path: string;
  kind?: string;
  bytes?: number;
  reason: RoleRunArtifactRetentionSkipReason;
  message?: string;
}

export interface RoleRunArtifactRetentionPlan {
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

interface RoleRunArtifactMetadataFile {
  path: string;
  name: string;
  bytes: number;
}

type RoleRunArtifactMetadataReadResult =
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "missing" }
  | { status: "invalid"; message: string };

class RoleRunArtifactMetadataFormatError extends Error {
  constructor(filePath: string, message: string) {
    super(`${filePath}: ${message}`);
    this.name = "RoleRunArtifactMetadataFormatError";
  }
}

export async function collectRoleRunArtifactRetentionPlan(
  cwd: string,
  options: { dryRun: boolean; thresholdBytes: number; tailBytes: number; exportDir?: string },
): Promise<RoleRunArtifactRetentionPlan> {
  const artifactRoot = join(cwd, ".spark", "artifacts");
  const metadataFiles = await listRoleRunArtifactMetadataFiles(artifactRoot);
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
    exportDir: options.exportDir
      ? displayRoleRunRetentionPath(cwd, resolve(cwd, options.exportDir))
      : undefined,
  };

  for (const file of metadataFiles) {
    const readResult = await readRoleRunArtifactMetadataFile(file.path);
    if (readResult.status === "missing") continue;
    if (readResult.status === "invalid") {
      plan.skipped.push({
        path: relative(cwd, file.path),
        reason: "invalid_json",
        message: readResult.message,
      });
      continue;
    }
    const raw = readResult.value;
    const ref = roleRunArtifactRefFromMetadata(file, raw);
    const kind = typeof raw.kind === "string" ? raw.kind : undefined;
    const retention = roleRunRetentionRecord(raw.transcriptRetention);
    if (!isHistoricalRoleRunArtifactKind(kind)) {
      plan.skipped.push({
        ref,
        path: relative(cwd, file.path),
        kind,
        reason: "not_role_run_artifact",
      });
      continue;
    }
    if (typeof retention?.fullTranscriptDeletedAt === "string") {
      plan.skipped.push({ ref, path: relative(cwd, file.path), kind, reason: "already_retained" });
      continue;
    }
    const blobPath = typeof raw.blobPath === "string" ? raw.blobPath : undefined;
    if (!blobPath) {
      plan.skipped.push({ ref, path: relative(cwd, file.path), kind, reason: "missing_blob_path" });
      continue;
    }
    const blobAbsolutePath = resolveArtifactBlobPath(artifactRoot, blobPath);
    if (!blobAbsolutePath) {
      plan.skipped.push({
        ref,
        path: relative(cwd, file.path),
        kind,
        reason: "invalid_blob_path",
      });
      continue;
    }
    const blobInfo = await stat(blobAbsolutePath).catch((error: NodeJS.ErrnoException) => {
      if (isFileNotFoundError(error)) return undefined;
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
        ? displayRoleRunRetentionPath(
            cwd,
            roleRunTranscriptExportPath(cwd, options.exportDir, ref, raw),
          )
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
  file: RoleRunArtifactMetadataFile,
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
  await writeJsonFileAtomic(file.path, replacement);
  await rm(blobAbsolutePath, { force: true });
}

function compactRoleRunRetentionBody(
  raw: Record<string, unknown>,
  candidate: RoleRunArtifactRetentionCandidate,
): RoleRunArtifactBody & { transcriptRetention: ArtifactTranscriptRetention } {
  const now = nowIso();
  const provenance = roleRunRetentionRecord(raw.provenance);
  const runRef = (candidate.runRef ??
    roleRunRetentionProvenanceString(provenance, "runRef") ??
    `run:${refId(candidate.ref)}`) as RunRef;
  const taskRef = (candidate.taskRef ??
    roleRunRetentionProvenanceString(provenance, "taskRef") ??
    `task:${refId(candidate.ref)}`) as TaskRef;
  const roleRef = (candidate.roleRef ??
    roleRunRetentionProvenanceString(provenance, "roleRef") ??
    "role:unknown") as RoleRef;
  return {
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
  const provenance = roleRunRetentionRecord(raw.provenance);
  if (roleRunRetentionRecord(body)) {
    const bodyRecord = body as Record<string, unknown>;
    const nestedRecord = roleRunRetentionRecord(bodyRecord.record);
    return {
      runRef:
        roleRunRetentionString(bodyRecord.runRef) ?? roleRunRetentionString(nestedRecord?.ref),
      taskRef:
        roleRunRetentionString(bodyRecord.taskRef) ??
        roleRunRetentionProvenanceString(provenance, "taskRef"),
      roleRef:
        roleRunRetentionString(bodyRecord.roleRef) ??
        roleRunRetentionProvenanceString(provenance, "roleRef"),
      runName:
        roleRunRetentionString(bodyRecord.runName) ?? roleRunRetentionString(nestedRecord?.runName),
      status:
        roleRunRetentionString(bodyRecord.status) ?? roleRunRetentionString(nestedRecord?.status),
    };
  }
  const preview = roleRunArtifactPreviewText(raw);
  return {
    runRef: extractJsonStringField(preview, "ref"),
    taskRef: roleRunRetentionProvenanceString(provenance, "taskRef"),
    roleRef:
      extractJsonStringField(preview, "roleRef") ??
      roleRunRetentionProvenanceString(provenance, "roleRef"),
    runName: extractJsonStringField(preview, "runName"),
    status: extractJsonStringField(preview, "status"),
  };
}

function roleRunArtifactPreviewText(raw: Record<string, unknown>): string {
  if (typeof raw.bodyPreview === "string") return raw.bodyPreview;
  if (typeof raw.body === "string") return raw.body;
  if (roleRunRetentionRecord(raw.body)) return JSON.stringify(raw.body);
  return "";
}

function roleRunReplacementSummary(
  ref: ArtifactRef,
  info: ReturnType<typeof extractRoleRunArtifactBodyInfo>,
  bytes: number,
): string {
  const identity = info.runName ?? info.runRef ?? ref;
  const status = info.status ? ` with status ${info.status}` : "";
  return `Historical role-run transcript ${identity}${status} compacted from ${formatRoleRunRetentionByteSize(bytes)} full transcript blob; compact summary, serialized tail, and optional export path are retained in artifact metadata.`;
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
  const body = roleRunRetentionRecord(raw.body);
  const record = roleRunRetentionRecord(body?.record);
  return (
    roleRunRetentionString(body?.[key]) ??
    roleRunRetentionString(record?.[key]) ??
    extractJsonStringField(roleRunArtifactPreviewText(raw), key)
  );
}

function roleRunArtifactRefFromMetadata(
  file: RoleRunArtifactMetadataFile,
  raw: Record<string, unknown>,
): ArtifactRef {
  const ref = typeof raw.ref === "string" ? raw.ref : `artifact:${basename(file.name, ".json")}`;
  return ref.startsWith("artifact:") ? (ref as ArtifactRef) : (`artifact:${ref}` as ArtifactRef);
}

function isHistoricalRoleRunArtifactKind(kind: string | undefined): boolean {
  return kind === "role-run";
}

async function listRoleRunArtifactMetadataFiles(
  artifactRoot: string,
): Promise<RoleRunArtifactMetadataFile[]> {
  const rootInfo = await stat(artifactRoot).catch((error: NodeJS.ErrnoException) => {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  });
  if (!rootInfo?.isDirectory()) return [];
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  const files: RoleRunArtifactMetadataFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(artifactRoot, entry.name);
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (isFileNotFoundError(error)) return undefined;
      throw error;
    });
    if (info?.isFile()) files.push({ path, name: entry.name, bytes: info.size });
  }
  return files;
}

async function readRoleRunArtifactMetadataFile(
  path: string,
): Promise<RoleRunArtifactMetadataReadResult> {
  let raw: unknown;
  try {
    raw = await readJsonFileOptional(
      path,
      (filePath, message) => new RoleRunArtifactMetadataFormatError(filePath, message),
    );
  } catch (error) {
    if (error instanceof RoleRunArtifactMetadataFormatError)
      return { status: "invalid", message: error.message };
    throw error;
  }
  if (raw === undefined) return { status: "missing" };
  const record = roleRunRetentionRecord(raw);
  if (record) return { status: "ok", value: record };
  return { status: "invalid", message: "JSON root is not an object" };
}

function roleRunRetentionRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function roleRunRetentionString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function roleRunRetentionProvenanceString(
  provenance: Record<string, unknown> | undefined,
  key: "runRef" | "taskRef" | "roleRef",
): string | undefined {
  return roleRunRetentionString(provenance?.[key]);
}

function extractJsonStringField(text: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "u").exec(text);
  if (!match) return undefined;
  try {
    const value = JSON.parse(`"${match[1]}"`) as unknown;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function displayRoleRunRetentionPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !resolve(cwd, rel).startsWith(`${resolve(cwd)}..`)
    ? rel
    : path;
}

function formatRoleRunRetentionByteSize(bytes: number): string {
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
