import {
  createId,
  runtimeDeviceAuthorizationResponseSchema,
  runtimeRegistrationResponseSchema,
  runtimeProtocolVersion,
  serverHelloAckEnvelopeSchema,
  runtimeWorkspaceRegistrationResponseSchema,
  type RuntimeDeviceAuthorizationResponse,
  type RuntimeRegistrationResponse,
} from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-system";
import WebSocket from "ws";
import { readSparkDaemonConfig, writeSparkDaemonConfig, type SparkDaemonConfig } from "./config.js";
import { sparkDaemonSupportedFeatures, sparkDaemonVersion } from "./daemon.js";
import { fetchRegistrationEndpoint } from "./registration-http.js";
import {
  getSparkDaemonServerProfile,
  normalizeSparkDaemonServerUrl,
  sparkDaemonConfigForServerProfile,
  upsertSparkDaemonServerProfile,
} from "./server-profiles.js";
import { refreshSparkDaemonCredentials, shouldRefreshSparkDaemonToken } from "./token-refresh.js";

export class RegistrationGrantRefusedError extends Error {}

export class DeviceAuthorizationError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
  ) {
    super(message);
  }
}

type RegistrationWebSocket = {
  on(event: "open", listener: () => void): RegistrationWebSocket;
  on(event: "message", listener: (data: Buffer) => void): RegistrationWebSocket;
  on(event: "error", listener: (error: Error) => void): RegistrationWebSocket;
  on(event: "close", listener: () => void): RegistrationWebSocket;
  send(data: string): void;
  close(): void;
};

type RegistrationWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => RegistrationWebSocket;

export interface SparkDaemonRegistrationInput {
  serverUrl: string;
  allowInsecureHttp?: boolean;
  registrationToken?: string;
  displayName?: string;
  installationId?: string;
  workspaceRegistration?: {
    localWorkspaceKey: string;
    localPath?: string;
    displayName: string;
    workspaceName?: string;
    workspaceSlug?: string;
  };
}

export interface SparkDaemonRegistrationResult {
  config: SparkDaemonConfig;
  workspaceBinding?: RuntimeRegistrationResponse["workspaceBinding"];
}

export interface SparkDaemonWorkspaceUnbindResult {
  runtimeId: string;
  bindingId: string;
  workspaceIds: string[];
  unboundAt: string;
}

export interface SparkDaemonDeviceAuthorizationOptions {
  fetchFn?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
}

export async function registerSparkDaemonWithToken(
  paths: SparkPaths,
  input: SparkDaemonRegistrationInput & { registrationToken: string },
) {
  const current = readSparkDaemonConfig(paths);
  const serverUrl = validateRegistrationServerUrl(input.serverUrl, {
    allowInsecureHttp: input.allowInsecureHttp,
  });
  const displayName = input.displayName ?? current.displayName;
  const installationId = input.installationId ?? current.installationId;
  const registered = await requestSparkDaemonRegistration({
    serverUrl,
    registrationToken: input.registrationToken,
    displayName,
    installationId,
    ...(input.workspaceRegistration ? { workspaceRegistration: input.workspaceRegistration } : {}),
  });
  await persistSparkDaemonCredentials(paths, {
    serverUrl,
    displayName,
    installationId,
    registered,
  });
  return registered;
}

export async function startSparkDaemonDeviceAuthorization(
  paths: SparkPaths,
  input: Pick<
    SparkDaemonRegistrationInput,
    "serverUrl" | "displayName" | "installationId" | "allowInsecureHttp"
  >,
  options: Pick<SparkDaemonDeviceAuthorizationOptions, "fetchFn"> = {},
): Promise<RuntimeDeviceAuthorizationResponse> {
  const current = readSparkDaemonConfig(paths);
  const serverUrl = validateRegistrationServerUrl(input.serverUrl, {
    allowInsecureHttp: input.allowInsecureHttp,
  });
  const url = new URL("/api/v1/runtime/device-authorizations", serverUrl);
  const response = await fetchRegistrationEndpoint(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installationId: input.installationId ?? current.installationId,
        displayName: input.displayName ?? current.displayName,
        runtimeVersion: sparkDaemonVersion,
        supportedFeatures: sparkDaemonSupportedFeatures,
        labels: { source: "spark-monorepo", service: "spark-runtime-bridge" },
      }),
    },
    options.fetchFn,
  );

  if (!response.ok) {
    const failure = await readHttpFailure(response);
    throw new DeviceAuthorizationError(
      `Daemon authorization failed at ${url.toString()}: HTTP ${response.status} ${failure.message}`,
      failure.code,
    );
  }

  return runtimeDeviceAuthorizationResponseSchema.parse(await response.json());
}

export async function completeSparkDaemonDeviceAuthorization(
  paths: SparkPaths,
  input: {
    serverUrl: string;
    authorization: RuntimeDeviceAuthorizationResponse;
    displayName?: string;
    installationId?: string;
    allowInsecureHttp?: boolean;
  },
  options: SparkDaemonDeviceAuthorizationOptions = {},
): Promise<RuntimeRegistrationResponse> {
  const current = readSparkDaemonConfig(paths);
  const serverUrl = validateRegistrationServerUrl(input.serverUrl, {
    allowInsecureHttp: input.allowInsecureHttp,
  });
  const displayName = input.displayName ?? current.displayName;
  const installationId = input.installationId ?? current.installationId;
  const url = new URL("/api/v1/runtime/device-authorizations/token", serverUrl);
  const sleep =
    options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const now = options.now ?? Date.now;
  const deadline = now() + input.authorization.expiresIn * 1_000;
  let pollDelayMs = input.authorization.interval * 1_000;

  while (now() < deadline) {
    await sleep(pollDelayMs);
    const response = await fetchRegistrationEndpoint(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: input.authorization.deviceCode }),
      },
      options.fetchFn,
    );

    if (response.status === 202) {
      await response.arrayBuffer();
      continue;
    }
    if (response.status === 429) {
      await response.arrayBuffer();
      pollDelayMs += 5_000;
      continue;
    }
    if (!response.ok) {
      const failure = await readHttpFailure(response);
      throw new DeviceAuthorizationError(
        `Daemon authorization failed at ${url.toString()}: HTTP ${response.status} ${failure.message}`,
        failure.code,
      );
    }

    const registered = runtimeRegistrationResponseSchema.parse(await response.json());
    await persistSparkDaemonCredentials(paths, {
      serverUrl,
      displayName,
      installationId,
      registered,
    });
    return registered;
  }

  throw new DeviceAuthorizationError(
    `Daemon authorization expired before approval at ${input.authorization.verificationUri}.`,
    "expired_token",
  );
}

export async function ensureSparkDaemonRegistrationForWorkspace(
  paths: SparkPaths,
  input: SparkDaemonRegistrationInput,
): Promise<SparkDaemonRegistrationResult> {
  const identity = readSparkDaemonConfig(paths);
  const serverUrl = validateRegistrationServerUrl(input.serverUrl, {
    allowInsecureHttp: input.allowInsecureHttp,
  });
  const existingProfile = getSparkDaemonServerProfile(paths, serverUrl);
  let current = existingProfile
    ? sparkDaemonConfigForServerProfile(identity, existingProfile)
    : identity;
  if (hasRunnableSparkDaemonCredentialsForServer(current, serverUrl)) {
    current = shouldRefreshSparkDaemonToken(current)
      ? await refreshSparkDaemonCredentials({ paths, config: current })
      : current;
    if (!input.workspaceRegistration) {
      throw new Error("Workspace registration metadata is required.");
    }
    const registered = await registerWorkspaceWithRuntime({
      serverUrl,
      runtimeId: current.runtimeId!,
      runtimeToken: current.runtimeToken!,
      ...(input.registrationToken ? { registrationToken: input.registrationToken } : {}),
      workspaceRegistration: input.workspaceRegistration,
    });
    return {
      config: current,
      workspaceBinding: registered.workspaceBinding,
    };
  }

  if (!input.registrationToken) {
    throw new Error(
      `Spark daemon is not authorized for ${serverUrl}. Run spark daemon login --server-url ${serverUrl} or pass --token <token>.`,
    );
  }

  const registered = await registerSparkDaemonWithToken(paths, {
    ...input,
    serverUrl,
    registrationToken: input.registrationToken,
  });
  return {
    config: configForRegisteredServer(paths, serverUrl),
    ...(registered.workspaceBinding ? { workspaceBinding: registered.workspaceBinding } : {}),
  };
}

export async function unbindSparkDaemonWorkspaceFromCockpit(
  paths: SparkPaths,
  input: { serverUrl: string; bindingId: string; allowInsecureHttp?: boolean },
): Promise<SparkDaemonWorkspaceUnbindResult> {
  const identity = readSparkDaemonConfig(paths);
  const serverUrl = validateRegistrationServerUrl(input.serverUrl, {
    allowInsecureHttp: input.allowInsecureHttp,
  });
  const profile = getSparkDaemonServerProfile(paths, serverUrl);
  if (!profile) {
    throw new Error(`Spark daemon has no credentials for ${serverUrl}.`);
  }
  let config = sparkDaemonConfigForServerProfile(identity, profile);
  config = shouldRefreshSparkDaemonToken(config)
    ? await refreshSparkDaemonCredentials({ paths, config })
    : config;
  const runtimeId = requireConfig(config.runtimeId, "runtimeId");
  const runtimeToken = requireConfig(config.runtimeToken, "runtimeToken");
  const url = new URL(
    `/api/v1/runtime/runtimes/${encodeURIComponent(runtimeId)}/workspaces/${encodeURIComponent(input.bindingId)}`,
    serverUrl,
  );
  const response = await fetchRegistrationEndpoint(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${runtimeToken}` },
  });
  if (!response.ok) {
    const failure = await readHttpFailure(response);
    throw new Error(
      `Workspace unbind failed at ${url.toString()}: HTTP ${response.status} ${failure.message}`,
    );
  }
  const value = (await response.json()) as Record<string, unknown>;
  if (
    value.runtimeId !== runtimeId ||
    value.bindingId !== input.bindingId ||
    !Array.isArray(value.workspaceIds) ||
    !value.workspaceIds.every((workspaceId) => typeof workspaceId === "string") ||
    typeof value.unboundAt !== "string"
  ) {
    throw new Error("Cockpit returned an invalid workspace unbind response.");
  }
  return value as unknown as SparkDaemonWorkspaceUnbindResult;
}

export function hasRunnableSparkDaemonCredentialsForServer(
  config: SparkDaemonConfig,
  serverUrl: string,
): boolean {
  return Boolean(
    config.runtimeId &&
    config.runtimeToken &&
    config.refreshToken &&
    (config.webSocketUrl || config.serverUrl) &&
    configuredServerUrl(config) === normalizeConfiguredServerUrl(serverUrl),
  );
}

export function configuredServerUrl(config: SparkDaemonConfig): string | undefined {
  if (config.serverUrl) {
    return normalizeConfiguredServerUrl(config.serverUrl);
  }

  if (config.webSocketUrl) {
    return normalizeConfiguredServerUrl(serverUrlFromWebSocketUrl(config.webSocketUrl));
  }

  return undefined;
}

export function validateRegistrationServerUrl(
  serverUrl: string,
  options: { allowInsecureHttp?: boolean } = {},
): string {
  const parsed = new URL(serverUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Cockpit server URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Cockpit credentials must not be embedded in --server-url.");
  }
  const forbiddenParams = ["token", "registration", "enrollment"];
  const found = new Set<string>();
  for (const key of parsed.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (forbiddenParams.includes(normalized)) {
      found.add(normalized);
    }
  }

  if (found.size > 0) {
    throw new Error(
      `Registration secrets must not be embedded in --server-url (${[...found].join(", ")}). Pass the workspace registration token with --token <token>, --token -, or SPARK_WORKSPACE_REGISTRATION_TOKEN.`,
    );
  }

  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Cockpit server URL must be an origin without a path, query, or fragment.");
  }

  if (
    parsed.protocol === "http:" &&
    !isLoopbackHostname(parsed.hostname) &&
    !options.allowInsecureHttp
  ) {
    throw new Error(
      `Refusing insecure Cockpit URL ${parsed.origin}: daemon credentials would cross the network over plaintext HTTP. Use HTTPS, or pass --allow-insecure-http only on a trusted private network.`,
    );
  }

  return `${parsed.origin}/`;
}

function normalizeConfiguredServerUrl(serverUrl: string): string {
  return normalizeSparkDaemonServerUrl(serverUrl);
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export async function verifySparkDaemonWorkspaceConnection(input: {
  config: SparkDaemonConfig;
  workspaceBinding: NonNullable<RuntimeRegistrationResponse["workspaceBinding"]>;
  localPath?: string;
  timeoutMs?: number;
  createWebSocket?: RegistrationWebSocketFactory;
}): Promise<void> {
  const runtimeId = requireConfig(input.config.runtimeId, "runtimeId");
  const runtimeToken = requireConfig(input.config.runtimeToken, "runtimeToken");
  const webSocketUrl = resolveWebSocketUrl(input.config);

  await new Promise<void>((resolve, reject) => {
    const createWebSocket =
      input.createWebSocket ??
      ((url: string, options: { headers: Record<string, string> }) =>
        new WebSocket(url, options) as RegistrationWebSocket);
    const ws = createWebSocket(webSocketUrl, {
      headers: { Authorization: `Bearer ${runtimeToken}` },
    });
    let settled = false;
    const timeout = setTimeout(() => {
      fail(
        new Error(
          `Workspace registration failed: Spark daemon could not confirm the server WebSocket within ${input.timeoutMs ?? 5_000}ms.`,
        ),
      );
    }, input.timeoutMs ?? 5_000);

    const finish = () => {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(timeout);
      ws.close();
      return true;
    };
    const fail = (error: Error) => {
      if (finish()) {
        reject(error);
      }
    };

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          protocolVersion: runtimeProtocolVersion,
          messageId: createId("msg"),
          type: "runtime.hello",
          sentAt: new Date().toISOString(),
          payload: {
            runtimeId,
            runtimeVersion: sparkDaemonVersion,
            supportedFeatures: sparkDaemonSupportedFeatures,
            workspaceBindings: [
              {
                bindingId: input.workspaceBinding.bindingId,
                localWorkspaceKey: input.workspaceBinding.localWorkspaceKey,
                ...(input.localPath ? { localPath: input.localPath } : {}),
                displayName: input.workspaceBinding.displayName,
                status: input.workspaceBinding.status,
                capabilities: {},
                diagnostics: {},
              },
            ],
          },
        }),
      );
    });

    ws.on("message", (data) => {
      let value: unknown;
      try {
        value = JSON.parse(data.toString("utf8")) as unknown;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const parsed = serverHelloAckEnvelopeSchema.safeParse(value);
      if (!parsed.success) {
        return;
      }
      if (finish()) {
        resolve();
      }
    });

    ws.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    ws.on("close", () => {
      if (!settled) {
        fail(new Error("Workspace registration failed: server WebSocket closed before hello ack."));
      }
    });
  });
}

function serverUrlFromWebSocketUrl(webSocketUrl: string): string {
  const parsed = new URL(webSocketUrl);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function validateRuntimeWebSocketUrl(serverUrl: string, webSocketUrl: string): string {
  const parsed = new URL(webSocketUrl, serverUrl);
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Cockpit runtime WebSocket URL must use ws:// or wss://.");
  }

  const expectedOrigin = new URL(serverUrl).origin;
  const actualOrigin = new URL(serverUrlFromWebSocketUrl(parsed.toString())).origin;
  if (actualOrigin !== expectedOrigin) {
    throw new Error(
      `Cockpit returned a cross-origin runtime WebSocket URL (${actualOrigin}); expected ${expectedOrigin}.`,
    );
  }
  return parsed.toString();
}

function resolveWebSocketUrl(config: SparkDaemonConfig): string {
  if (config.webSocketUrl) {
    return toWebSocketUrl(config.webSocketUrl);
  }
  const runtimeId = requireConfig(config.runtimeId, "runtimeId");
  const serverUrl = requireConfig(config.serverUrl, "serverUrl");
  return toWebSocketUrl(new URL(`/api/v1/runtime/runtimes/${runtimeId}/ws`, serverUrl).toString());
}

function toWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  return url.toString();
}

function requireConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Spark daemon config is missing ${name}. Run spark daemon workspace register first.`,
    );
  }
  return value;
}

async function requestSparkDaemonRegistration(input: {
  serverUrl: string;
  registrationToken: string;
  displayName: string;
  installationId: string;
  workspaceRegistration?: SparkDaemonRegistrationInput["workspaceRegistration"];
}) {
  const url = new URL("/api/v1/runtime/runtimes/register", input.serverUrl);
  const response = await fetchRegistrationEndpoint(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.registrationToken}`,
    },
    body: JSON.stringify({
      installationId: input.installationId,
      displayName: input.displayName,
      runtimeVersion: sparkDaemonVersion,
      supportedFeatures: sparkDaemonSupportedFeatures,
      labels: { source: "spark-monorepo", service: "spark-runtime-bridge" },
      ...(input.workspaceRegistration
        ? { workspaceRegistration: input.workspaceRegistration }
        : {}),
    }),
  });

  if (!response.ok) {
    const failure = await readHttpFailure(response);
    const message = `Workspace registration failed at ${url.toString()}: HTTP ${response.status} ${failure.message}`;
    if (response.status === 401 || response.status === 403) {
      throw new RegistrationGrantRefusedError(message);
    }
    throw new Error(message);
  }

  return runtimeRegistrationResponseSchema.parse(await response.json());
}

async function registerWorkspaceWithRuntime(input: {
  serverUrl: string;
  runtimeId: string;
  runtimeToken: string;
  registrationToken?: string;
  workspaceRegistration: NonNullable<SparkDaemonRegistrationInput["workspaceRegistration"]>;
}) {
  const url = new URL(
    `/api/v1/runtime/runtimes/${encodeURIComponent(input.runtimeId)}/workspaces/register`,
    input.serverUrl,
  );
  const response = await fetchRegistrationEndpoint(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.runtimeToken}`,
    },
    body: JSON.stringify({
      ...(input.registrationToken ? { registrationToken: input.registrationToken } : {}),
      workspaceRegistration: input.workspaceRegistration,
    }),
  });

  if (!response.ok) {
    const failure = await readHttpFailure(response);
    const message = `Workspace registration failed at ${url.toString()}: HTTP ${response.status} ${failure.message}`;
    if (response.status === 401 || response.status === 403) {
      throw new RegistrationGrantRefusedError(message);
    }
    throw new Error(message);
  }

  return runtimeWorkspaceRegistrationResponseSchema.parse(await response.json());
}

async function persistSparkDaemonCredentials(
  paths: SparkPaths,
  input: {
    serverUrl: string;
    displayName: string;
    installationId: string;
    registered: RuntimeRegistrationResponse;
  },
): Promise<void> {
  const webSocketUrl = validateRuntimeWebSocketUrl(input.serverUrl, input.registered.webSocketUrl);
  await upsertSparkDaemonServerProfile(paths, {
    serverUrl: input.serverUrl,
    runtimeId: input.registered.runtimeId,
    runtimeToken: input.registered.runtimeToken,
    runtimeTokenExpiresAt: input.registered.runtimeTokenExpiresAt,
    refreshToken: input.registered.refreshToken,
    refreshTokenExpiresAt: input.registered.refreshTokenExpiresAt,
    webSocketUrl,
  });
  // The upsert migrates any legacy tuple before daemon.toml is reduced to the
  // stable daemon identity. Do not select the newly registered Cockpit globally.
  writeSparkDaemonConfig(paths, {
    installationId: input.installationId,
    displayName: input.displayName,
  });
}

function configForRegisteredServer(paths: SparkPaths, serverUrl: string): SparkDaemonConfig {
  const profile = getSparkDaemonServerProfile(paths, serverUrl);
  if (!profile) {
    throw new Error(`Spark daemon credentials were not persisted for ${serverUrl}.`);
  }
  return sparkDaemonConfigForServerProfile(readSparkDaemonConfig(paths), profile);
}

async function readHttpFailure(response: Response): Promise<{ code: string; message: string }> {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    value = undefined;
  }
  if (isRecord(value)) {
    const nestedError = isRecord(value.error) ? value.error : undefined;
    const code =
      (nestedError ? stringProperty(nestedError, "code") : undefined) ??
      stringProperty(value, "error") ??
      stringProperty(value, "code") ??
      "request_failed";
    const message =
      (nestedError ? stringProperty(nestedError, "message") : undefined) ??
      stringProperty(value, "message") ??
      code;
    return { code, message };
  }
  return {
    code: "request_failed",
    message: text.trim() || response.statusText || "request failed",
  };
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
