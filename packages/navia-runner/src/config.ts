import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { writePrivateFile, type NaviaPaths } from "@navia-dev/system";

export interface RunnerConfig {
  installationId: string;
  displayName: string;
  serverUrl?: string;
  runtimeId?: string;
  runtimeToken?: string;
  runtimeTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  webSocketUrl?: string;
}

export function defaultRunnerConfig(): RunnerConfig {
  return {
    installationId: `navia-runner-${randomUUID()}`,
    displayName: hostname() || "Navia runner",
  };
}

export function readRunnerConfig(paths: NaviaPaths): RunnerConfig {
  if (!existsSync(paths.configFile)) {
    return defaultRunnerConfig();
  }

  return { ...defaultRunnerConfig(), ...parseTomlSubset(readFileSync(paths.configFile, "utf8")) };
}

export function writeRunnerConfig(paths: NaviaPaths, config: RunnerConfig): void {
  writePrivateFile(paths.configFile, serializeTomlSubset(config));
}

function parseTomlSubset(contents: string): Partial<RunnerConfig> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*"((?:\\"|[^"])*)"\s*$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (key && value !== undefined) {
      values[key] = value.replaceAll('\\"', '"');
    }
  }
  const config: Partial<RunnerConfig> = {};
  if (values.installationId) config.installationId = values.installationId;
  if (values.displayName) config.displayName = values.displayName;
  if (values.serverUrl) config.serverUrl = values.serverUrl;
  if (values.runtimeId) config.runtimeId = values.runtimeId;
  if (values.runtimeToken) config.runtimeToken = values.runtimeToken;
  if (values.runtimeTokenExpiresAt) config.runtimeTokenExpiresAt = values.runtimeTokenExpiresAt;
  if (values.refreshToken) config.refreshToken = values.refreshToken;
  if (values.refreshTokenExpiresAt) config.refreshTokenExpiresAt = values.refreshTokenExpiresAt;
  if (values.webSocketUrl) config.webSocketUrl = values.webSocketUrl;
  return config;
}

function serializeTomlSubset(config: RunnerConfig): string {
  return [
    `installationId = "${escapeTomlString(config.installationId)}"`,
    `displayName = "${escapeTomlString(config.displayName)}"`,
    config.serverUrl ? `serverUrl = "${escapeTomlString(config.serverUrl)}"` : undefined,
    config.runtimeId ? `runtimeId = "${escapeTomlString(config.runtimeId)}"` : undefined,
    config.runtimeToken ? `runtimeToken = "${escapeTomlString(config.runtimeToken)}"` : undefined,
    config.runtimeTokenExpiresAt
      ? `runtimeTokenExpiresAt = "${escapeTomlString(config.runtimeTokenExpiresAt)}"`
      : undefined,
    config.refreshToken ? `refreshToken = "${escapeTomlString(config.refreshToken)}"` : undefined,
    config.refreshTokenExpiresAt
      ? `refreshTokenExpiresAt = "${escapeTomlString(config.refreshTokenExpiresAt)}"`
      : undefined,
    config.webSocketUrl ? `webSocketUrl = "${escapeTomlString(config.webSocketUrl)}"` : undefined,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function escapeTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
