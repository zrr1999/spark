import type { Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export interface SparkStateFileInfo {
  path: string;
  name: string;
  bytes: number;
  mtimeMs: number;
}

type JsonObjectReadResult =
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "missing" }
  | { status: "invalid"; message: string };

export async function listSparkStateFiles(
  path: string,
  recursive = false,
): Promise<SparkStateFileInfo[]> {
  const rootInfo = await statIfPresent(path);
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
    const info = await statIfPresent(entryPath);
    if (!info?.isFile()) continue;
    files.push({ path: entryPath, name: entry.name, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

export async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  const result = await readJsonObjectFile(path);
  return result.status === "ok" ? result.value : undefined;
}

export function fileScope(file: SparkStateFileInfo): string {
  return file.name.replace(/\.json$/u, "");
}

async function readJsonObjectFile(path: string): Promise<JsonObjectReadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw error;
  }

  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      return { status: "ok", value: raw as Record<string, unknown> };
    return { status: "invalid", message: "JSON root is not an object" };
  } catch (error) {
    return { status: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function statIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
