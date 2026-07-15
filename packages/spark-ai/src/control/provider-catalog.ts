import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { resolveSparkUserPaths } from "@zendev-lab/spark-system";
import { SparkProviderRegistry, type ProviderRegistrationAPI } from "../provider-registry.ts";
import registerBaiduOneApiProvider from "../baidu-oneapi-provider.ts";
import registerCursorProvider from "../cursor-provider.ts";
import registerOpenAiCodexProvider from "../openai-codex-provider.ts";
import { withPathMutation } from "./path-mutation.ts";

export const DEFAULT_SPARK_PROVIDER_SPECS = [
  "@zendev-lab/spark-ai/baidu-oneapi-provider",
  "@zendev-lab/spark-ai/openai-codex-provider",
] as const;

export type SparkProviderImporter = (specifier: string) => Promise<unknown>;

export interface SparkProviderLoadOutcome {
  specifier: string;
  ok: boolean;
  error?: string;
}

export interface LoadSparkProviderCatalogOptions {
  specifiers?: readonly string[];
  registry?: SparkProviderRegistry;
  importer?: SparkProviderImporter;
}

export interface SparkLoadedProviderCatalog {
  registry: SparkProviderRegistry;
  outcomes: SparkProviderLoadOutcome[];
}

export interface SparkProviderConfigState {
  path: string;
  raw: Record<string, unknown>;
  providerSpecs: string[];
  activeModelId?: string;
  loadError?: string;
}

export function defaultSparkProviderConfigPath(sparkHome?: string): string {
  return resolveSparkUserPaths({ sparkHome }).configFile;
}

export async function loadSparkProviderCatalog(
  options: LoadSparkProviderCatalogOptions = {},
): Promise<SparkLoadedProviderCatalog> {
  const registry = options.registry ?? new SparkProviderRegistry();
  const importer = options.importer ?? defaultImporter;
  const specifiers = options.specifiers ?? DEFAULT_SPARK_PROVIDER_SPECS;
  const outcomes: SparkProviderLoadOutcome[] = [];

  for (const specifier of specifiers) {
    try {
      const module = await importer(specifier);
      const factory = pickDefault(module);
      if (typeof factory !== "function") {
        throw new Error(
          `Provider plugin "${specifier}" must default-export a function(api: ProviderRegistrationAPI)`,
        );
      }
      await factory(registry as ProviderRegistrationAPI);
      outcomes.push({ specifier, ok: true });
    } catch (error) {
      outcomes.push({
        specifier,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { registry, outcomes };
}

export async function readSparkProviderConfig(
  path: string = defaultSparkProviderConfigPath(),
): Promise<SparkProviderConfigState> {
  const resolvedPath = resolve(path);
  let raw: Record<string, unknown> = {};
  let loadError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(resolvedPath, "utf8"));
    if (isRecord(parsed)) raw = parsed;
    else loadError = "Spark config root must be a JSON object";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A fresh Spark home intentionally starts from defaults.
    } else if (error instanceof SyntaxError)
      loadError = `Invalid Spark config JSON: ${error.message}`;
    else throw error;
  }
  const providerSpecs = mergeSparkProviderSpecs(stringArray(raw.providers));
  const activeModelId = readActiveModelId(raw);
  return {
    path: resolvedPath,
    raw: { ...raw },
    providerSpecs,
    ...(activeModelId ? { activeModelId } : {}),
    ...(loadError ? { loadError } : {}),
  };
}

/** Bundled providers are product capabilities; config.providers adds plugins. */
export function mergeSparkProviderSpecs(configured: readonly string[] | undefined): string[] {
  return [...new Set([...DEFAULT_SPARK_PROVIDER_SPECS, ...(configured ?? [])])];
}

export async function writeSparkDefaultModel(path: string, activeModelId: string): Promise<void> {
  await withPathMutation(path, async () => {
    const state = await readSparkProviderConfig(path);
    if (state.loadError) {
      throw new Error(`Refusing to overwrite unreadable Spark config: ${state.loadError}`);
    }
    const next: Record<string, unknown> = { ...state.raw, activeModelId };
    delete next.activeProvider;
    delete next.activeModel;
    await persistJson(path, next);
  });
}

function readActiveModelId(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.activeModelId === "string" && raw.activeModelId.trim()) {
    return raw.activeModelId.trim();
  }
  if (
    typeof raw.activeProvider === "string" &&
    raw.activeProvider.trim() &&
    typeof raw.activeModel === "string" &&
    raw.activeModel.trim()
  ) {
    return `${raw.activeProvider.trim()}/${raw.activeModel.trim()}`;
  }
  return undefined;
}

async function persistJson(path: string, value: Record<string, unknown>): Promise<void> {
  const resolvedPath = resolve(path);
  const directory = dirname(resolvedPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tmp = `${resolvedPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, resolvedPath);
  await chmod(resolvedPath, 0o600).catch(() => undefined);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function pickDefault(module: unknown): unknown {
  return module && typeof module === "object" && "default" in module
    ? (module as { default: unknown }).default
    : module;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultImporter(specifier: string): Promise<unknown> {
  // Keep product-bundled providers reachable through static imports. A built
  // daemon executes from apps/spark-daemon/dist, where importing this
  // workspace package by its public specifier would resolve to TypeScript
  // below node_modules. Node deliberately refuses to strip types there, so a
  // provider that works in the source/TUI host would silently disappear from
  // the production daemon model catalog.
  if (specifier === "@zendev-lab/spark-ai/baidu-oneapi-provider") {
    return { default: registerBaiduOneApiProvider };
  }
  if (specifier === "@zendev-lab/spark-ai/openai-codex-provider") {
    return { default: registerOpenAiCodexProvider };
  }
  if (specifier === "@zendev-lab/spark-ai/cursor-provider") {
    return { default: registerCursorProvider };
  }
  return import(specifier);
}
