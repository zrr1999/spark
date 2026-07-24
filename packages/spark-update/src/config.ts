import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  SparkUpdateChannel,
  SparkUpdateConfig,
  SparkUpdatePaths,
  SparkUpdatePolicy,
} from "./types.ts";

export const DEFAULT_SPARK_UPDATE_CONFIG: SparkUpdateConfig = {
  policy: "notify",
  channel: "latest",
  checkIntervalHours: 6,
};

export async function readSparkUpdateConfig(
  paths: Pick<SparkUpdatePaths, "configFile">,
  env: Record<string, string | undefined> = process.env,
): Promise<SparkUpdateConfig> {
  let fileConfig: Partial<SparkUpdateConfig> = {};
  try {
    fileConfig = parseUpdateToml(await readFile(paths.configFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const environmentPolicy = env.SPARK_UPDATE_POLICY?.trim();
  const environmentChannel = env.SPARK_UPDATE_CHANNEL?.trim();
  const policy = environmentPolicy ? parsePolicy(environmentPolicy) : fileConfig.policy;
  const channel = environmentChannel ? parseChannel(environmentChannel) : fileConfig.channel;
  if (environmentPolicy && !policy) {
    throw new Error(`Invalid SPARK_UPDATE_POLICY: ${environmentPolicy}`);
  }
  if (environmentChannel && !channel) {
    throw new Error(`Invalid SPARK_UPDATE_CHANNEL: ${environmentChannel}`);
  }
  return {
    policy: policy ?? DEFAULT_SPARK_UPDATE_CONFIG.policy,
    channel: channel ?? DEFAULT_SPARK_UPDATE_CONFIG.channel,
    checkIntervalHours: normalizeInterval(
      fileConfig.checkIntervalHours ?? DEFAULT_SPARK_UPDATE_CONFIG.checkIntervalHours,
    ),
  };
}

export async function writeSparkUpdateConfig(
  paths: Pick<SparkUpdatePaths, "configFile">,
  config: SparkUpdateConfig,
): Promise<void> {
  const normalized = {
    policy: requirePolicy(config.policy),
    channel: requireChannel(config.channel),
    checkIntervalHours: normalizeInterval(config.checkIntervalHours),
  };
  await mkdir(dirname(paths.configFile), { recursive: true });
  const temporary = `${paths.configFile}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `policy = "${normalized.policy}"\nchannel = "${normalized.channel}"\ncheckIntervalHours = ${normalized.checkIntervalHours}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, paths.configFile);
}

export function parseUpdateToml(source: string): Partial<SparkUpdateConfig> {
  const result: Partial<SparkUpdateConfig> = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").trim();
    if (!line) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.+)$/u.exec(line);
    if (!match) throw new Error(`Invalid update.toml line: ${rawLine}`);
    const [, key, rawValue] = match;
    if (key === "policy") result.policy = requirePolicy(unquote(rawValue!));
    else if (key === "channel") result.channel = requireChannel(unquote(rawValue!));
    else if (key === "checkIntervalHours") {
      result.checkIntervalHours = normalizeInterval(Number(rawValue));
    } else {
      throw new Error(`Unknown update.toml setting: ${key}`);
    }
  }
  return result;
}

function unquote(value: string): string {
  const match = /^"([^"]*)"$/u.exec(value.trim());
  if (!match) throw new Error(`Expected a quoted TOML string, received: ${value}`);
  return match[1]!;
}

export function parsePolicy(value: string | undefined): SparkUpdatePolicy | undefined {
  return value === "manual" || value === "notify" || value === "auto" ? value : undefined;
}

export function parseChannel(value: string | undefined): SparkUpdateChannel | undefined {
  return value === "latest" || value === "next" ? value : undefined;
}

function requirePolicy(value: string): SparkUpdatePolicy {
  const parsed = parsePolicy(value);
  if (!parsed) throw new Error(`Invalid update policy: ${value}`);
  return parsed;
}

function requireChannel(value: string): SparkUpdateChannel {
  const parsed = parseChannel(value);
  if (!parsed) throw new Error(`Invalid update channel: ${value}`);
  return parsed;
}

function normalizeInterval(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 168) {
    throw new Error("checkIntervalHours must be between 1 and 168");
  }
  return Math.round(value);
}
