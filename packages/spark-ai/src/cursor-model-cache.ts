import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ModelListItem } from "@cursor/sdk";

const CURSOR_MODEL_CACHE_VERSION = 1;
export const DEFAULT_CURSOR_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CursorModelCacheFile {
  version: typeof CURSOR_MODEL_CACHE_VERSION;
  keyFingerprint: string;
  fetchedAt: string;
  models: ModelListItem[];
}

export function defaultCursorModelCachePath(): string {
  return join(process.env.SPARK_HOME ?? join(homedir(), ".spark"), "cursor-sdk-model-list.json");
}

export function fingerprintCursorApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export async function loadCursorModelCache(options: {
  path?: string;
  keyFingerprint: string;
  ttlMs?: number;
  now?: number;
  allowStale?: boolean;
}): Promise<{ models: ModelListItem[]; fetchedAt: string } | undefined> {
  const path = options.path ?? defaultCursorModelCachePath();
  try {
    const parsed = parseCursorModelCache(JSON.parse(await readFile(path, "utf8")));
    if (!parsed || parsed.keyFingerprint !== options.keyFingerprint) return undefined;
    const age = (options.now ?? Date.now()) - Date.parse(parsed.fetchedAt);
    if (!options.allowStale && age > (options.ttlMs ?? DEFAULT_CURSOR_MODEL_CACHE_TTL_MS)) {
      return undefined;
    }
    return { models: parsed.models, fetchedAt: parsed.fetchedAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function saveCursorModelCache(options: {
  path?: string;
  keyFingerprint: string;
  models: ModelListItem[];
  now?: Date;
}): Promise<void> {
  const path = options.path ?? defaultCursorModelCachePath();
  const value: CursorModelCacheFile = {
    version: CURSOR_MODEL_CACHE_VERSION,
    keyFingerprint: options.keyFingerprint,
    fetchedAt: (options.now ?? new Date()).toISOString(),
    models: options.models,
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function parseCursorModelCache(value: unknown): CursorModelCacheFile | undefined {
  if (!isRecord(value) || value.version !== CURSOR_MODEL_CACHE_VERSION) return undefined;
  if (typeof value.keyFingerprint !== "string" || typeof value.fetchedAt !== "string") {
    return undefined;
  }
  if (!Array.isArray(value.models) || !value.models.every(isModelListItem)) return undefined;
  return value as unknown as CursorModelCacheFile;
}

function isModelListItem(value: unknown): value is ModelListItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.displayName === "string" &&
    (value.aliases === undefined ||
      (Array.isArray(value.aliases) && value.aliases.every((item) => typeof item === "string")))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
