import { runtimeTokenRefreshResponseSchema } from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { readSparkDaemonConfig, writeSparkDaemonConfig, type SparkDaemonConfig } from "./config.js";
import { fetchRegistrationEndpoint } from "./registration-http.js";
import {
  compareAndSwapSparkDaemonServerProfile,
  getSparkDaemonServerProfile,
  normalizeSparkDaemonServerUrl,
  replaceSparkDaemonConfigServerProfile,
  sparkDaemonConfigForServerProfile,
} from "./server-profiles.js";

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
  paths: SparkPaths;
  config: SparkDaemonConfig;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<SparkDaemonConfig> {
  throwIfRefreshAborted(options.signal);
  const serverUrl = normalizeSparkDaemonServerUrl(resolveServerUrl(options.config));
  const storedProfile = getSparkDaemonServerProfile(options.paths, serverUrl);
  const source = storedProfile
    ? sparkDaemonConfigForServerProfile(options.config, storedProfile)
    : options.config;
  const runtimeId = requireConfig(source.runtimeId, "runtimeId");
  const refreshToken = requireConfig(source.refreshToken, "refreshToken");
  const url = new URL(`/api/v1/runtime/runtimes/${runtimeId}/token/refresh`, serverUrl);
  let response: Response;
  try {
    response = await fetchRegistrationEndpoint(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.fetchFn,
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw refreshAbortError(options.signal, error);
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(
      `Runtime token refresh failed at ${url.toString()}: HTTP ${response.status} ${await response.text()}`,
    );
  }

  const refreshed = runtimeTokenRefreshResponseSchema.parse(await response.json());
  throwIfRefreshAborted(options.signal);
  const rotated = await compareAndSwapSparkDaemonServerProfile(
    options.paths,
    serverUrl,
    { runtimeId, refreshToken },
    (current) => ({
      ...current,
      runtimeId: refreshed.runtimeId,
      runtimeToken: refreshed.runtimeToken,
      runtimeTokenExpiresAt: refreshed.runtimeTokenExpiresAt,
      refreshToken: refreshed.refreshToken,
      refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
    }),
    { signal: options.signal },
  );
  if (!rotated.current) {
    throw new Error(
      `Spark daemon credentials for ${serverUrl} changed while its token was refreshing and no current profile remains.`,
    );
  }
  if (rotated.applied) {
    const identity = readSparkDaemonConfig(options.paths);
    writeSparkDaemonConfig(options.paths, {
      installationId: identity.installationId,
      displayName: identity.displayName,
    });
  }

  return replaceSparkDaemonConfigServerProfile(options.config, rotated.current);
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

function throwIfRefreshAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw refreshAbortError(signal);
  }
}

function refreshAbortError(signal: AbortSignal, cause?: unknown): Error {
  if (signal.reason instanceof Error && signal.reason.name === "AbortError") {
    return signal.reason;
  }
  const reason = signal.reason ?? cause;
  const message =
    reason instanceof Error ? reason.message : String(reason ?? "Token refresh aborted.");
  const error = new Error(message, reason instanceof Error ? { cause: reason } : undefined);
  error.name = "AbortError";
  return error;
}
