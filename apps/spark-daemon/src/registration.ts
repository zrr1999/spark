import {
  createId,
  runtimeRegistrationResponseSchema,
  runtimeProtocolVersion,
  serverHelloAckEnvelopeSchema,
  runtimeWorkspaceRegistrationResponseSchema,
  type RuntimeRegistrationResponse,
} from "@zendev-lab/navia-protocol";
import type { NaviaPaths } from "@zendev-lab/navia-system";
import WebSocket from "ws";
import { readSparkDaemonConfig, writeSparkDaemonConfig, type SparkDaemonConfig } from "./config.js";
import { sparkDaemonSupportedFeatures, sparkDaemonVersion } from "./daemon.js";
import { refreshSparkDaemonCredentials, shouldRefreshSparkDaemonToken } from "./token-refresh.js";

export class RegistrationGrantRefusedError extends Error {}

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
  registrationToken?: string;
  displayName?: string;
  installationId?: string;
  workspaceRegistration?: {
    localWorkspaceKey: string;
    displayName: string;
  };
}

export interface SparkDaemonRegistrationResult {
  config: SparkDaemonConfig;
  workspaceBinding?: RuntimeRegistrationResponse["workspaceBinding"];
}

export async function registerSparkDaemonWithToken(
  paths: NaviaPaths,
  input: SparkDaemonRegistrationInput & { registrationToken: string },
) {
  const current = readSparkDaemonConfig(paths);
  const serverUrl = validateRegistrationServerUrl(input.serverUrl);
  const displayName = input.displayName ?? current.displayName;
  const installationId = input.installationId ?? current.installationId;
  const registered = await requestSparkDaemonRegistration({
    serverUrl,
    registrationToken: input.registrationToken,
    displayName,
    installationId,
    ...(input.workspaceRegistration ? { workspaceRegistration: input.workspaceRegistration } : {}),
  });
  writeSparkDaemonConfig(paths, {
    ...current,
    installationId,
    displayName,
    serverUrl,
    runtimeId: registered.runtimeId,
    runtimeToken: registered.runtimeToken,
    runtimeTokenExpiresAt: registered.runtimeTokenExpiresAt,
    refreshToken: registered.refreshToken,
    refreshTokenExpiresAt: registered.refreshTokenExpiresAt,
    webSocketUrl: registered.webSocketUrl,
  });
  return registered;
}

export async function ensureSparkDaemonRegistrationForWorkspace(
  paths: NaviaPaths,
  input: SparkDaemonRegistrationInput,
): Promise<SparkDaemonRegistrationResult> {
  let current = readSparkDaemonConfig(paths);
  const serverUrl = validateRegistrationServerUrl(input.serverUrl);
  if (hasRunnableSparkDaemonCredentialsForServer(current, serverUrl)) {
    current = shouldRefreshSparkDaemonToken(current)
      ? await refreshSparkDaemonCredentials({ paths, config: current })
      : current;
    if (!input.registrationToken) {
      return { config: current };
    }
    if (!input.workspaceRegistration) {
      throw new Error("Workspace registration metadata is required.");
    }
    const registered = await registerWorkspaceGrantWithToken({
      serverUrl,
      runtimeId: current.runtimeId!,
      runtimeToken: current.runtimeToken!,
      registrationToken: input.registrationToken,
      workspaceRegistration: input.workspaceRegistration,
    });
    return {
      config: current,
      workspaceBinding: registered.workspaceBinding,
    };
  }

  if (!input.registrationToken) {
    throw new Error(
      "Missing workspace registration token. Pass --token <token>, --token -, or set NAVIA_WORKSPACE_REGISTRATION_TOKEN.",
    );
  }

  const registered = await registerSparkDaemonWithToken(paths, {
    ...input,
    serverUrl,
    registrationToken: input.registrationToken,
  });
  return {
    config: readSparkDaemonConfig(paths),
    ...(registered.workspaceBinding ? { workspaceBinding: registered.workspaceBinding } : {}),
  };
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
    configuredServerUrl(config) === validateRegistrationServerUrl(serverUrl),
  );
}

export function configuredServerUrl(config: SparkDaemonConfig): string | undefined {
  if (config.serverUrl) {
    return validateRegistrationServerUrl(config.serverUrl);
  }

  if (config.webSocketUrl) {
    return validateRegistrationServerUrl(serverUrlFromWebSocketUrl(config.webSocketUrl));
  }

  return undefined;
}

export function validateRegistrationServerUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
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
      `Registration secrets must not be embedded in --server-url (${[...found].join(", ")}). Pass the workspace registration token with --token <token>, --token -, or NAVIA_WORKSPACE_REGISTRATION_TOKEN.`,
    );
  }

  return parsed.toString();
}

export async function verifySparkDaemonWorkspaceConnection(input: {
  config: SparkDaemonConfig;
  workspaceBinding: NonNullable<RuntimeRegistrationResponse["workspaceBinding"]>;
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
      `Spark daemon config is missing ${name}. Run spark-daemon workspace register first.`,
    );
  }
  return value;
}

async function requestSparkDaemonRegistration(input: {
  serverUrl: string;
  registrationToken: string;
  displayName: string;
  installationId: string;
  workspaceRegistration?: {
    localWorkspaceKey: string;
    displayName: string;
  };
}) {
  const url = new URL("/api/v1/runtime/runtimes/register", input.serverUrl);
  const response = await fetch(url, {
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
    const message = `Workspace registration failed: HTTP ${response.status} ${await response.text()}`;
    if (response.status === 401 || response.status === 403) {
      throw new RegistrationGrantRefusedError(message);
    }
    throw new Error(message);
  }

  return runtimeRegistrationResponseSchema.parse(await response.json());
}

async function registerWorkspaceGrantWithToken(input: {
  serverUrl: string;
  runtimeId: string;
  runtimeToken: string;
  registrationToken: string;
  workspaceRegistration: {
    localWorkspaceKey: string;
    displayName: string;
  };
}) {
  const url = new URL(
    `/api/v1/runtime/runtimes/${encodeURIComponent(input.runtimeId)}/workspaces/register`,
    input.serverUrl,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.runtimeToken}`,
    },
    body: JSON.stringify({
      registrationToken: input.registrationToken,
      workspaceRegistration: input.workspaceRegistration,
    }),
  });

  if (!response.ok) {
    const message = `Workspace registration failed: HTTP ${response.status} ${await response.text()}`;
    if (response.status === 401 || response.status === 403) {
      throw new RegistrationGrantRefusedError(message);
    }
    throw new Error(message);
  }

  return runtimeWorkspaceRegistrationResponseSchema.parse(await response.json());
}
