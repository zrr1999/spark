import { copyFile, mkdir, unlink } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  SparkSessionStore,
  type SparkSessionEntry,
  type SparkSessionRecord,
} from "@zendev-lab/spark-host/session-store";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import type { DaemonSessionRegistry } from "./session-registry.ts";

export interface UnifyDaemonSessionTranscriptsInput {
  registry: Pick<DaemonSessionRegistry, "list" | "relocateTranscriptPath">;
  transcriptSparkHome: string;
  backupRoot: string;
  apply?: boolean;
}

export interface UnifiedDaemonSessionTranscript {
  sessionId: string;
  sourcePaths: string[];
  targetPath: string;
  entryCount: number;
  changed: boolean;
}

export interface UnifyDaemonSessionTranscriptsResult {
  backupRoot: string;
  sessions: UnifiedDaemonSessionTranscript[];
}

/**
 * Consolidate every ordinary daemon session into its stable workspace path.
 *
 * Applying a change always follows backup -> write/verify -> registry CAS ->
 * source removal. Re-running after success is a no-op.
 */
export async function unifyDaemonSessionTranscripts(
  input: UnifyDaemonSessionTranscriptsInput,
): Promise<UnifyDaemonSessionTranscriptsResult> {
  const sessions = await input.registry.list({
    includeArchived: true,
    includeSideThreads: true,
  });
  const results: UnifiedDaemonSessionTranscript[] = [];

  for (const session of sessions) {
    if (session.relation?.kind === "side_thread" || !session.cwd?.trim()) continue;
    const result = await unifySessionTranscript(input, session);
    if (result) results.push(result);
  }

  return { backupRoot: input.backupRoot, sessions: results };
}

async function unifySessionTranscript(
  input: UnifyDaemonSessionTranscriptsInput,
  session: SparkSessionRegistryRecord,
): Promise<UnifiedDaemonSessionTranscript | undefined> {
  const store = new SparkSessionStore({
    cwd: session.cwd!,
    sparkHome: input.transcriptSparkHome,
  });
  const records = await store.findAllById(session.sessionId);
  if (
    session.sessionPath &&
    !records.some((record) => resolve(record.path) === resolve(session.sessionPath!))
  ) {
    records.push(await store.load(session.sessionPath));
  }
  if (records.length === 0) {
    if (session.sessionPath) {
      throw new Error(`registered transcript is missing for ${session.sessionId}`);
    }
    return undefined;
  }

  const sources = records
    .map((record) => validateSourceRecord(store, session, record))
    .sort(compareTranscriptRecords);
  const targetPath = store.canonicalSessionPath(session.sessionId);
  const sourcePaths = sources.map((record) => resolve(record.path));
  const changed =
    sourcePaths.length !== 1 ||
    sourcePaths[0] !== resolve(targetPath) ||
    resolve(session.sessionPath ?? "") !== resolve(targetPath);
  const merged = mergeTranscriptRecords(sources, targetPath);
  const result: UnifiedDaemonSessionTranscript = {
    sessionId: session.sessionId,
    sourcePaths,
    targetPath,
    entryCount: merged.entries.length,
    changed,
  };
  if (!changed || input.apply !== true) return result;

  const backupDir = join(input.backupRoot, encodeURIComponent(session.sessionId));
  await mkdir(backupDir, { recursive: true });
  for (const sourcePath of sourcePaths) {
    await copyFile(sourcePath, join(backupDir, basename(sourcePath)));
  }

  await store.save(merged);
  const verified = await store.load(targetPath);
  if (
    verified.header.id !== session.sessionId ||
    verified.entries.length !== merged.entries.length
  ) {
    throw new Error(`failed to verify unified transcript for ${session.sessionId}`);
  }
  await input.registry.relocateTranscriptPath({
    sessionId: session.sessionId,
    ...(session.sessionPath ? { expectedSessionPath: session.sessionPath } : {}),
    sessionPath: targetPath,
  });
  for (const sourcePath of sourcePaths) {
    if (sourcePath !== resolve(targetPath)) await unlink(sourcePath);
  }
  return result;
}

function validateSourceRecord(
  store: SparkSessionStore,
  session: SparkSessionRegistryRecord,
  record: SparkSessionRecord,
): SparkSessionRecord {
  const path = resolve(record.path);
  const fromStore = relative(store.sessionDir, path);
  if (
    !fromStore ||
    fromStore === ".." ||
    fromStore.startsWith(`..${sep}`) ||
    fromStore.includes(sep)
  ) {
    throw new Error(`transcript for ${session.sessionId} is outside its daemon workspace store`);
  }
  if (record.header.id !== session.sessionId) {
    throw new Error(`transcript ${path} belongs to ${record.header.id}, not ${session.sessionId}`);
  }
  if (resolve(record.header.cwd) !== resolve(session.cwd!)) {
    throw new Error(`transcript ${path} belongs to another workspace`);
  }
  return record;
}

function compareTranscriptRecords(left: SparkSessionRecord, right: SparkSessionRecord): number {
  return (
    left.header.timestamp.localeCompare(right.header.timestamp) ||
    left.path.localeCompare(right.path)
  );
}

function mergeTranscriptRecords(
  records: SparkSessionRecord[],
  targetPath: string,
): SparkSessionRecord {
  const [first, ...rest] = records;
  if (!first) throw new Error("at least one transcript record is required");
  const entries = first.entries.map(cloneEntry);
  const entryIds = new Set(entries.map((entry) => entry.id));
  assertSingleRoot(first);

  for (const record of rest) {
    assertSingleRoot(record);
    const fragment = record.entries.map(cloneEntry);
    for (const entry of fragment) {
      if (entryIds.has(entry.id)) {
        throw new Error(`duplicate transcript entry id ${entry.id} in ${record.path}`);
      }
      entryIds.add(entry.id);
    }
    const root = fragment.find((entry) => entry.parentId === null);
    const previousLeaf = entries.at(-1);
    if (root && previousLeaf) root.parentId = previousLeaf.id;
    entries.push(...fragment);
  }

  return {
    path: targetPath,
    header: { ...first.header },
    entries,
  };
}

function assertSingleRoot(record: SparkSessionRecord): void {
  const roots = record.entries.filter((entry) => entry.parentId === null);
  if (record.entries.length > 0 && roots.length !== 1) {
    throw new Error(`transcript ${record.path} has ${roots.length} roots`);
  }
}

function cloneEntry(entry: SparkSessionEntry): SparkSessionEntry {
  return structuredClone(entry);
}
