/**
 * SparkConfig — the on-disk schema for `~/.spark/config.json`.
 *
 * Two parallel plugin lists:
 *   - `extensions[]` — module specifiers loaded as ExtensionAPI plugins
 *   - `providers[]`  — module specifiers loaded as ProviderRegistrationAPI
 *                      plugins. Default includes spark-cli's own
 *                      `baidu-oneapi-provider`.
 *
 * Both lists are loaded by the same `loadPlugins(...)` helper in
 * `plugin-loader.ts`, but the runtime API surface they receive differs.
 *
 * The schema also tracks `activeProvider` / `activeModel` so the spark-cli
 * boot path can re-select the user's last picked model without prompting.
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

export interface SparkModelSelectionConfig {
  provider: string;
  model: string;
}

export interface SparkFusionConfig {
  analysisModels?: SparkModelSelectionConfig[];
  judgeModel?: SparkModelSelectionConfig;
  panelSize?: number;
}

export interface SparkConfig {
  extensions: string[];
  providers: string[];
  activeProvider?: string;
  activeModel?: string;
  activeThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  fusion?: SparkFusionConfig;
}

export const DEFAULT_SPARK_CONFIG: SparkConfig = {
  extensions: [
    "@zendev-lab/pi-ask/extension",
    "@zendev-lab/pi-cue/extension",
    "@zendev-lab/pi-roles/extension",
    "@zendev-lab/pi-graft/extension",
    "@zendev-lab/spark/extension",
  ],
  providers: ["spark-cli/baidu-oneapi-provider"],
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
    providers: stringArray(fields.providers, DEFAULT_SPARK_CONFIG.providers),
    activeProvider: typeof fields.activeProvider === "string" ? fields.activeProvider : undefined,
    activeModel: typeof fields.activeModel === "string" ? fields.activeModel : undefined,
    activeThinkingLevel: parseThinkingLevel(fields.activeThinkingLevel),
    fusion: parseFusionConfig(fields.fusion),
  };
}

function cloneDefault(): SparkConfig {
  return {
    extensions: [...DEFAULT_SPARK_CONFIG.extensions],
    providers: [...DEFAULT_SPARK_CONFIG.providers],
  };
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
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

function parseFusionConfig(value: unknown): SparkFusionConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const analysisModels = Array.isArray(fields.analysisModels)
    ? fields.analysisModels.filter(isModelSelectionConfig)
    : undefined;
  const judgeModel = isModelSelectionConfig(fields.judgeModel) ? fields.judgeModel : undefined;
  const panelSize =
    typeof fields.panelSize === "number" && Number.isFinite(fields.panelSize)
      ? Math.min(Math.max(Math.floor(fields.panelSize), 1), 8)
      : undefined;
  if (!analysisModels && !judgeModel && panelSize === undefined) return undefined;
  return {
    ...(analysisModels ? { analysisModels } : {}),
    ...(judgeModel ? { judgeModel } : {}),
    ...(panelSize !== undefined ? { panelSize } : {}),
  };
}

function isModelSelectionConfig(value: unknown): value is SparkModelSelectionConfig {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as SparkModelSelectionConfig).provider === "string" &&
    typeof (value as SparkModelSelectionConfig).model === "string" &&
    (value as SparkModelSelectionConfig).provider.length > 0 &&
    (value as SparkModelSelectionConfig).model.length > 0
  );
}
