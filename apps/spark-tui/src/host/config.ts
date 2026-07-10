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

export interface SparkConfig {
  extensions: string[];
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

export const DEFAULT_SPARK_CONFIG: SparkConfig = {
  extensions: [
    "@zendev-lab/spark-ask/extension",
    "@zendev-lab/spark-cue/extension",
    "@zendev-lab/spark-files/extension",
    "@zendev-lab/spark-ai/models-extension",
    "@zendev-lab/spark-roles/extension",
    "@zendev-lab/spark-graft/extension",
    "@zendev-lab/pi-extension/extension",
  ],
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
    extensions: stringArray(fields.extensions, DEFAULT_SPARK_CONFIG.extensions),
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
    providers: [...DEFAULT_SPARK_CONFIG.providers],
    skills: [...(DEFAULT_SPARK_CONFIG.skills ?? [])],
    promptTemplates: [...(DEFAULT_SPARK_CONFIG.promptTemplates ?? [])],
    themes: [...(DEFAULT_SPARK_CONFIG.themes ?? [])],
    contextFiles: [...(DEFAULT_SPARK_CONFIG.contextFiles ?? [])],
    trustedWorkspaces: [...(DEFAULT_SPARK_CONFIG.trustedWorkspaces ?? [])],
  };
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
