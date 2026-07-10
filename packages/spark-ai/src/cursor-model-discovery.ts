import type { ModelListItem } from "@cursor/sdk";

import { FALLBACK_CURSOR_MODEL_ITEMS } from "./cursor-fallback-models.ts";
import { convertCursorModelItems } from "./cursor-model-catalog.ts";
import {
  fingerprintCursorApiKey,
  loadCursorModelCache,
  saveCursorModelCache,
} from "./cursor-model-cache.ts";
import type { ProviderModelDefinition } from "./provider-registry.ts";

export type CursorCatalogFallbackReason =
  | "missing-api-key"
  | "empty-model-list"
  | "discovery-failed"
  | "cached-after-error";

export interface CursorCatalogFallbackIssue {
  reason: CursorCatalogFallbackReason;
  message: string;
}

export interface DiscoverCursorModelsOptions {
  apiKey?: string;
  cachePath?: string;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  now?: number;
  loadModels?: (apiKey: string) => Promise<ModelListItem[]>;
  onFallback?: (issue: CursorCatalogFallbackIssue) => void;
}

export async function discoverCursorModels(
  options: DiscoverCursorModelsOptions = {},
): Promise<ProviderModelDefinition[]> {
  const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return fallbackModels(options, {
      reason: "missing-api-key",
      message:
        "Cursor model discovery requires CURSOR_API_KEY or a Spark-stored Cursor API key; using the bundled public fallback catalog.",
    });
  }

  const keyFingerprint = fingerprintCursorApiKey(apiKey);
  if (!options.forceRefresh) {
    const cached = await loadCursorModelCache({
      keyFingerprint,
      ...(options.cachePath ? { path: options.cachePath } : {}),
      ...(options.cacheTtlMs !== undefined ? { ttlMs: options.cacheTtlMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    if (cached?.models.length) return convertCursorModelItems(cached.models);
  }

  try {
    const items = await (options.loadModels ?? loadLiveCursorModels)(apiKey);
    if (items.length === 0) {
      return fallbackModels(options, {
        reason: "empty-model-list",
        message: "Cursor model discovery returned an empty catalog; using bundled fallback models.",
      });
    }
    await saveCursorModelCache({
      keyFingerprint,
      models: items,
      ...(options.cachePath ? { path: options.cachePath } : {}),
      ...(options.now !== undefined ? { now: new Date(options.now) } : {}),
    });
    return convertCursorModelItems(items);
  } catch (error) {
    const cached = await loadCursorModelCache({
      keyFingerprint,
      allowStale: true,
      ...(options.cachePath ? { path: options.cachePath } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    const detail = sanitizeCursorDiscoveryError(error, apiKey);
    if (cached?.models.length) {
      options.onFallback?.({
        reason: "cached-after-error",
        message: `Cursor model discovery failed; using cached public model metadata from ${cached.fetchedAt}.${detail ? ` ${detail}` : ""}`,
      });
      return convertCursorModelItems(cached.models);
    }
    return fallbackModels(options, {
      reason: "discovery-failed",
      message: `Cursor model discovery failed; using bundled fallback models.${detail ? ` ${detail}` : ""}`,
    });
  }
}

export function sanitizeCursorDiscoveryError(error: unknown, apiKey?: string): string {
  const original = error instanceof Error ? error.message : String(error);
  let result = original;
  if (apiKey) result = result.replaceAll(apiKey, "[redacted]");
  return result
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(
      /((?:authorization|api[_-]?key|apiKey|token|cookie|session(?:[_-]?id)?)['"]?\s*[:=]\s*['"]?)[^'"\s,;}]+/giu,
      "$1[redacted]",
    )
    .trim();
}

async function loadLiveCursorModels(apiKey: string): Promise<ModelListItem[]> {
  const { Cursor } = await import("@cursor/sdk");
  return Cursor.models.list({ apiKey });
}

function fallbackModels(
  options: DiscoverCursorModelsOptions,
  issue: CursorCatalogFallbackIssue,
): ProviderModelDefinition[] {
  options.onFallback?.(issue);
  return convertCursorModelItems(FALLBACK_CURSOR_MODEL_ITEMS);
}
