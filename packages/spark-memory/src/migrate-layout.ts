import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { resolveSparkUserPaths, type ResolveSparkHomeOptions } from "@zendev-lab/spark-system";

export type MemoryMigrationStatus = "moved" | "copied" | "merged" | "skipped" | "absent";

export interface MemoryMigrationOp {
  status: MemoryMigrationStatus;
  from: string;
  to: string;
  reason?: string;
}

export interface MemoryMigrationReport {
  ops: MemoryMigrationOp[];
}

export interface MigrateSparkMemoryLayoutOptions extends ResolveSparkHomeOptions {
  /** Workspace/repo root whose `.learnings` / `.spark` trees should migrate. */
  cwd?: string;
  /** Skip user-tree migration (dataRoot memory/). */
  skipUser?: boolean;
  /** Skip workspace-tree migration. */
  skipWorkspace?: boolean;
}

const migratedKeys = new Set<string>();

/** Idempotent layout migration for user + workspace memory trees. */
export async function migrateSparkMemoryLayout(
  options: MigrateSparkMemoryLayoutOptions = {},
): Promise<MemoryMigrationReport> {
  const cwd = options.cwd ?? process.cwd();
  const user = resolveSparkUserPaths(options);
  const key = `${user.dataRoot}::${cwd}`;
  if (migratedKeys.has(key)) return { ops: [] };

  const ops: MemoryMigrationOp[] = [];
  if (!options.skipUser) {
    ops.push(
      ...(await migratePath(join(user.dataRoot, "learnings"), join(user.memoryDir, "learnings"))),
      ...(await migratePath(
        join(user.dataRoot, "recall-candidates.json"),
        join(user.memoryDir, "recall-candidates.json"),
      )),
    );
  }
  if (!options.skipWorkspace) {
    const sparkDir = join(cwd, ".spark");
    const memoryDir = join(sparkDir, "memory");
    ops.push(
      ...(await migratePath(join(cwd, ".learnings"), join(memoryDir, "learnings"))),
      ...(await migratePath(
        join(sparkDir, "recall-candidates.json"),
        join(memoryDir, "recall-candidates.json"),
      )),
      ...(await migratePath(join(sparkDir, "reflections"), join(memoryDir, "reflections"))),
    );
  }

  migratedKeys.add(key);
  return { ops };
}

/** Test helper: clear the once-per-roots migration cache. */
export function resetSparkMemoryLayoutMigrationCache(): void {
  migratedKeys.clear();
}

async function migratePath(from: string, to: string): Promise<MemoryMigrationOp[]> {
  if (!(await pathExists(from))) {
    return [{ status: "absent", from, to, reason: "source missing" }];
  }
  // Never move a path onto itself (e.g. already under memory/).
  if (from === to) {
    return [{ status: "skipped", from, to, reason: "source and target are identical" }];
  }

  const targetExists = await pathExists(to);
  if (!targetExists) {
    await mkdir(dirname(to), { recursive: true });
    const moved = await renameOrCopy(from, to);
    return [{ status: moved, from, to }];
  }

  if (await isEmptyDir(to)) {
    await rm(to, { recursive: true, force: true });
    const moved = await renameOrCopy(from, to);
    return [{ status: moved, from, to, reason: "replaced empty target" }];
  }

  const fromStat = await lstat(from);
  const toStat = await lstat(to);
  if (fromStat.isFile() && toStat.isFile()) {
    return [{ status: "skipped", from, to, reason: "target file already exists" }];
  }
  if (fromStat.isDirectory() && toStat.isDirectory()) {
    await mergeDirectory(from, to);
    await rm(from, { recursive: true, force: true });
    return [{ status: "merged", from, to }];
  }
  return [{ status: "skipped", from, to, reason: "incompatible source/target types" }];
}

async function renameOrCopy(from: string, to: string): Promise<"moved" | "copied"> {
  try {
    await rename(from, to);
    return "moved";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const fromStat = await lstat(from);
    if (fromStat.isDirectory()) {
      await cp(from, to, { recursive: true, errorOnExist: true });
      await verifyDirectoryCopy(from, to);
      await rm(from, { recursive: true, force: true });
    } else {
      await copyFile(from, to);
      await verifyFileCopy(from, to);
      await unlink(from);
    }
    return "copied";
  }
}

async function mergeDirectory(from: string, to: string): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (await pathExists(target)) {
      if (entry.isDirectory() && (await lstat(target)).isDirectory()) {
        await mergeDirectory(source, target);
        continue;
      }
      // Skip conflicting leaf names; keep the target as the survivor.
      continue;
    }
    await renameOrCopy(source, target);
  }
}

async function verifyFileCopy(from: string, to: string): Promise<void> {
  const [left, right] = await Promise.all([fileDigest(from), fileDigest(to)]);
  if (left !== right) {
    throw new Error(`memory layout copy verify failed for ${basename(from)}`);
  }
}

async function verifyDirectoryCopy(from: string, to: string): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await verifyDirectoryCopy(source, target);
    } else if (entry.isFile()) {
      await verifyFileCopy(source, target);
    }
  }
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isEmptyDir(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) return false;
    return (await readdir(path)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
