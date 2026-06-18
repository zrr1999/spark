/** File lock for the Spark CLI daemon. */

import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { defaultSparkDaemonRuntimeDir } from "./paths.ts";

export interface SparkDaemonLockRecord {
  pid: number;
  startedAt: string;
  cwd?: string;
}

export interface SparkDaemonLockOptions {
  sparkHome?: string;
  runtimeDir?: string;
  cwd?: string;
  kind?: "daemon";
}

export interface SparkDaemonLockHandle {
  path: string;
  record: SparkDaemonLockRecord;
  release(): Promise<void>;
}

export async function acquireSparkDaemonLock(
  options: SparkDaemonLockOptions = {},
): Promise<SparkDaemonLockHandle> {
  const runtimeDir = options.runtimeDir ?? defaultSparkDaemonRuntimeDir(options.sparkHome);
  const kind = options.kind ?? "daemon";
  const lockPath = join(runtimeDir, `${kind}.lock`);
  await mkdir(runtimeDir, { recursive: true });

  const record: SparkDaemonLockRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
  const payload = `${JSON.stringify(record, null, 2)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(payload, "utf8");
      } finally {
        await handle.close();
      }
      return createLockHandle(lockPath, record);
    } catch {
      const existing = await readSparkDaemonLock(lockPath);
      if (!existing || !isProcessAlive(existing.pid)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      throw new Error(
        `another Spark daemon is already running (pid=${existing.pid}, startedAt=${existing.startedAt})`,
      );
    }
  }

  throw new Error("failed to acquire Spark daemon lock");
}

export async function readSparkDaemonLock(path: string): Promise<SparkDaemonLockRecord | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SparkDaemonLockRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
    };
  } catch {
    return null;
  }
}

function createLockHandle(path: string, record: SparkDaemonLockRecord): SparkDaemonLockHandle {
  let released = false;
  return {
    path,
    record,
    async release() {
      if (released) return;
      released = true;
      const current = await readSparkDaemonLock(path);
      if (current?.pid === process.pid) await unlink(path).catch(() => undefined);
    },
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}
