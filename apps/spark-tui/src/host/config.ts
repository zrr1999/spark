/**
 * SparkConfig — the on-disk schema for `~/.spark/config.json`.
 *
 * Two parallel plugin lists:
 *   - `extensions[]` — module specifiers loaded as ExtensionAPI plugins
 *   - `providers[]`  — additional module specifiers loaded as
 *                      ProviderRegistrationAPI plugins. Spark always merges
 *                      its bundled Baidu OneAPI and OpenAI Codex adapters.
 *
 * Both lists are loaded by the same `loadPlugins(...)` helper in
 * `plugin-loader.ts`, but the runtime API surface they receive differs.
 *
 * The schema tracks `activeModelId` so the spark-tui boot path can re-select
 * the user's last picked Spark model without prompting. Deprecated
 * `activeProvider` / `activeModel` pairs are still read for migration.
 *
 * Persistence:
 *   - Read with `loadSparkConfig(path?)`. Missing or malformed files fall
 *     back to defaults — never throw on a fresh user box.
 *   - Write with `saveSparkConfig(config, path?)`. Writes use atomic temp +
 *     rename via `node:fs/promises`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_SPARK_PROVIDER_SPECS,
  mergeSparkProviderSpecs,
} from "@zendev-lab/spark-ai/control";
import { DEFAULT_SPARK_EXTENSION_SPECS } from "./extension-specs.ts";

export interface SparkConfig {
  extensions: string[];
  /** Version of the bundled extension profile last reconciled with this config. */
  extensionProfileVersion?: number;
  providers: string[];
  skills?: string[];
  promptTemplates?: string[];
  themes?: string[];
  contextFiles?: string[];
  trustedWorkspaces?: string[];
  activeTheme?: string;
  activeModelId?: string;
  /** @deprecated Use activeModelId. */
  activeProvider?: string;
  /** @deprecated Use activeModelId. */
  activeModel?: string;
  activeThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export const CURRENT_SPARK_EXTENSION_PROFILE_VERSION = 1;

const LEGACY_SPARK_EXTENSION_FACADE = "@zendev-lab/spark-extension/extension";
const CURRENT_SPARK_EXTENSION_FACADE = "@zendev-lab/pi-extension/extension";
const LEGACY_DEFAULT_EXTENSION_CORE = [
  "@zendev-lab/spark-ask/extension",
  "@zendev-lab/spark-cue/extension",
  "@zendev-lab/spark-files/extension",
  "@zendev-lab/spark-ai/models-extension",
  "@zendev-lab/spark-roles/extension",
] as const;

export const DEFAULT_SPARK_CONFIG: SparkConfig = {
  extensions: [...DEFAULT_SPARK_EXTENSION_SPECS],
  extensionProfileVersion: CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
  providers: [...DEFAULT_SPARK_PROVIDER_SPECS],
  skills: [],
  promptTemplates: [],
  themes: [],
  contextFiles: [],
  trustedWorkspaces: [],
};

export function defaultSparkConfigPath(): string {
  const root = process.env.SPARK_HOME ?? join(homedir(), ".spark");
  return join(root, "config.json");
}

export async function loadSparkConfig(
  path: string = defaultSparkConfigPath(),
): Promise<SparkConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return cloneDefault();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cloneDefault();
  }
  return mergeWithDefault(parsed);
}

export async function saveSparkConfig(
  config: SparkConfig,
  path: string = defaultSparkConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export function mergeWithDefault(raw: unknown): SparkConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cloneDefault();
  const fields = raw as Partial<Record<keyof SparkConfig, unknown>>;
  return {
    extensions: migrateSparkExtensionProfile(
      stringArray(fields.extensions, DEFAULT_SPARK_CONFIG.extensions),
      fields.extensionProfileVersion,
    ),
    extensionProfileVersion: CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
    providers: mergeSparkProviderSpecs(stringArray(fields.providers, [])),
    skills: stringArray(fields.skills, DEFAULT_SPARK_CONFIG.skills ?? []),
    promptTemplates: stringArray(
      fields.promptTemplates,
      DEFAULT_SPARK_CONFIG.promptTemplates ?? [],
    ),
    themes: stringArray(fields.themes, DEFAULT_SPARK_CONFIG.themes ?? []),
    contextFiles: stringArray(fields.contextFiles, DEFAULT_SPARK_CONFIG.contextFiles ?? []),
    trustedWorkspaces: stringArray(
      fields.trustedWorkspaces,
      DEFAULT_SPARK_CONFIG.trustedWorkspaces ?? [],
    ),
    activeTheme: typeof fields.activeTheme === "string" ? fields.activeTheme : undefined,
    activeModelId: parseActiveModelId(fields),
    activeProvider: typeof fields.activeProvider === "string" ? fields.activeProvider : undefined,
    activeModel: typeof fields.activeModel === "string" ? fields.activeModel : undefined,
    activeThinkingLevel: parseThinkingLevel(fields.activeThinkingLevel),
  };
}

function cloneDefault(): SparkConfig {
  return {
    extensions: [...DEFAULT_SPARK_CONFIG.extensions],
    extensionProfileVersion: CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
    providers: [...DEFAULT_SPARK_CONFIG.providers],
    skills: [...(DEFAULT_SPARK_CONFIG.skills ?? [])],
    promptTemplates: [...(DEFAULT_SPARK_CONFIG.promptTemplates ?? [])],
    themes: [...(DEFAULT_SPARK_CONFIG.themes ?? [])],
    contextFiles: [...(DEFAULT_SPARK_CONFIG.contextFiles ?? [])],
    trustedWorkspaces: [...(DEFAULT_SPARK_CONFIG.trustedWorkspaces ?? [])],
  };
}

/**
 * Reconcile only known historical bundled profiles. Arbitrary subsets and
 * custom extensions stay explicit; a standalone Graft entry therefore remains
 * an opt-in. Old default profiles are upgraded to the current defaults so
 * removed defaults cannot silently resurrect from persisted config.
 */
export function migrateSparkExtensionProfile(
  extensions: readonly string[],
  rawVersion: unknown,
): string[] {
  const version = typeof rawVersion === "number" && Number.isInteger(rawVersion) ? rawVersion : 0;
  const normalized = dedupeStrings(
    extensions.map((specifier) =>
      specifier === LEGACY_SPARK_EXTENSION_FACADE ? CURRENT_SPARK_EXTENSION_FACADE : specifier,
    ),
  );
  if (version >= CURRENT_SPARK_EXTENSION_PROFILE_VERSION) return normalized;
  if (extensions.includes(LEGACY_SPARK_EXTENSION_FACADE)) {
    const historicalBundled = new Set<string>([
      ...LEGACY_DEFAULT_EXTENSION_CORE,
      "@zendev-lab/spark-memory/extension",
      "@zendev-lab/spark-session/extension",
      "@zendev-lab/spark-web/extension",
      "@zendev-lab/spark-graft/extension",
      CURRENT_SPARK_EXTENSION_FACADE,
    ]);
    const custom = normalized.filter((specifier) => !historicalBundled.has(specifier));
    return dedupeStrings([...DEFAULT_SPARK_EXTENSION_SPECS, ...custom]);
  }
  if (extensions.length === 1 && extensions[0] === CURRENT_SPARK_EXTENSION_FACADE) {
    return [...DEFAULT_SPARK_EXTENSION_SPECS];
  }

  const legacyDefault =
    LEGACY_DEFAULT_EXTENSION_CORE.every((specifier) => normalized.includes(specifier)) &&
    normalized.includes(CURRENT_SPARK_EXTENSION_FACADE) &&
    normalized.includes("@zendev-lab/spark-graft/extension");
  if (!legacyDefault) return normalized;

  const legacyBundled = new Set<string>([
    ...LEGACY_DEFAULT_EXTENSION_CORE,
    "@zendev-lab/spark-memory/extension",
    "@zendev-lab/spark-session/extension",
    "@zendev-lab/spark-web/extension",
    "@zendev-lab/spark-graft/extension",
    CURRENT_SPARK_EXTENSION_FACADE,
  ]);
  const custom = normalized.filter((specifier) => !legacyBundled.has(specifier));
  return dedupeStrings([...DEFAULT_SPARK_EXTENSION_SPECS, ...custom]);
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function parseActiveModelId(
  fields: Partial<Record<keyof SparkConfig, unknown>>,
): string | undefined {
  if (typeof fields.activeModelId === "string" && fields.activeModelId.trim()) {
    return fields.activeModelId;
  }
  if (
    typeof fields.activeProvider === "string" &&
    fields.activeProvider.trim() &&
    typeof fields.activeModel === "string" &&
    fields.activeModel.trim()
  ) {
    return `${fields.activeProvider}/${fields.activeModel}`;
  }
  if (typeof fields.activeModel === "string" && fields.activeModel.trim())
    return fields.activeModel;
  return undefined;
}

function parseThinkingLevel(value: unknown): SparkConfig["activeThinkingLevel"] {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}
