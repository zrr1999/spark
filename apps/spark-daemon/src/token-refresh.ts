import { runtimeTokenRefreshResponseSchema } from "@zendev-lab/navia-protocol";
import type { NaviaPaths } from "@zendev-lab/navia-system";
import { readSparkDaemonConfig, writeSparkDaemonConfig, type SparkDaemonConfig } from "./config.js";

const refreshLeadMs = 5 * 60 * 1000;
const refreshRetryMs = 60 * 1000;

export function shouldRefreshSparkDaemonToken(
  config: SparkDaemonConfig,
  now = new Date(),
): boolean {
  if (!config.refreshToken) {
    return false;
  }

  if (!config.runtimeToken || !config.runtimeTokenExpiresAt) {
    return true;
  }

  const expiresAt = Date.parse(config.runtimeTokenExpiresAt);
  return Number.isNaN(expiresAt) || expiresAt - now.getTime() <= refreshLeadMs;
}

export function nextSparkDaemonTokenRefreshDelayMs(
  config: SparkDaemonConfig,
  now = new Date(),
): number | undefined {
  if (!config.refreshToken) {
    return undefined;
  }

  if (!config.runtimeTokenExpiresAt) {
    return 0;
  }

  const expiresAt = Date.parse(config.runtimeTokenExpiresAt);
  if (Number.isNaN(expiresAt)) {
    return 0;
  }

  return Math.max(0, expiresAt - now.getTime() - refreshLeadMs);
}

export async function refreshSparkDaemonCredentials(options: {
  paths: NaviaPaths;
  config: SparkDaemonConfig;
  fetchFn?: typeof fetch;
}): Promise<SparkDaemonConfig> {
  const runtimeId = requireConfig(options.config.runtimeId, "runtimeId");
  const refreshToken = requireConfig(options.config.refreshToken, "refreshToken");
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(
    new URL(
      `/api/v1/runtime/runtimes/${runtimeId}/token/refresh`,
      resolveServerUrl(options.config),
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Runtime token refresh failed: HTTP ${response.status} ${await response.text()}`,
    );
  }

  const refreshed = runtimeTokenRefreshResponseSchema.parse(await response.json());
  const current = readSparkDaemonConfig(options.paths);
  const next = {
    ...current,
    runtimeId: refreshed.runtimeId,
    runtimeToken: refreshed.runtimeToken,
    runtimeTokenExpiresAt: refreshed.runtimeTokenExpiresAt,
    refreshToken: refreshed.refreshToken,
    refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
  };

  writeSparkDaemonConfig(options.paths, next);
  Object.assign(options.config, next);
  return next;
}

export function tokenRefreshRetryDelayMs(): number {
  return refreshRetryMs;
}

function resolveServerUrl(config: SparkDaemonConfig): string {
  if (config.serverUrl) {
    return config.serverUrl;
  }

  if (config.webSocketUrl) {
    const url = new URL(config.webSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  return requireConfig(config.serverUrl, "serverUrl");
}

function requireConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Spark daemon config is missing ${name}. Run spark daemon workspace register first.`,
    );
  }

  return value;
}
