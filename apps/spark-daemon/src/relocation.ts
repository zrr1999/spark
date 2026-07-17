import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  cockpitRuntimeRelocationMetadataSchema,
  runtimeRelocationPreflightResponseSchema,
  type RuntimeRelocationPreflightResponse,
} from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-system";

import { configuredServerUrl, validateRegistrationServerUrl } from "./registration.ts";
import { fetchRegistrationEndpoint } from "./registration-http.ts";
import { readSparkDaemonConfig, writeSparkDaemonConfig, type SparkDaemonConfig } from "./config.ts";

export interface SparkDaemonRelocationRequest {
  fromServerUrl?: string;
  toServerUrl: string;
}

export interface SparkDaemonRelocationResult {
  relocated: true;
  instanceId: string;
  installationId: string;
  runtimeId: string;
  fromServerUrl: string;
  toServerUrl: string;
  webSocketUrl: string;
  workspaceBindingIds: string[];
  workspaceCount: number;
  relocatedAt: string;
}

export class SparkDaemonRelocationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface SparkDaemonRelocationOptions {
  fetchFn?: typeof fetch;
  now?: () => string;
  writeConfig?: typeof writeSparkDaemonConfig;
  beforeCommit?: () => void;
  onUplinkReconfigure?: () => void;
}

export async function relocateSparkDaemonCockpit(
  paths: SparkPaths,
  db: DatabaseSync,
  request: SparkDaemonRelocationRequest,
  options: SparkDaemonRelocationOptions = {},
): Promise<SparkDaemonRelocationResult> {
  const current = readSparkDaemonConfig(paths);
  const fromServerUrl = requireCurrentServerUrl(current, request.fromServerUrl);
  const toServerUrl = validateRelocationTarget(request.toServerUrl);
  if (fromServerUrl === toServerUrl) {
    throw new SparkDaemonRelocationError(
      "Relocation target is already the configured Cockpit origin.",
      "RELOCATION_TARGET_UNCHANGED",
    );
  }
  assertNoLocalTargetCollision(db, fromServerUrl, toServerUrl);
  const runtimeId = requireConfig(current.runtimeId, "runtimeId");
  const refreshToken = requireConfig(current.refreshToken, "refreshToken");

  const [sourceMetadata, targetMetadata] = await Promise.all([
    fetchRelocationMetadata(fromServerUrl, options.fetchFn),
    fetchRelocationMetadata(toServerUrl, options.fetchFn),
  ]);
  if (sourceMetadata.instanceId !== targetMetadata.instanceId) {
    throw new SparkDaemonRelocationError(
      "Source and target Cockpit instance identities do not match.",
      "RELOCATION_INSTANCE_MISMATCH",
    );
  }

  const preflight = await fetchTargetPreflight(
    toServerUrl,
    {
      sourceInstanceId: sourceMetadata.instanceId,
      runtimeId,
      installationId: current.installationId,
      refreshToken,
    },
    options.fetchFn,
  );
  if (preflight.instanceId !== sourceMetadata.instanceId) {
    throw new SparkDaemonRelocationError(
      "Target preflight returned a different Cockpit instance identity.",
      "RELOCATION_INSTANCE_MISMATCH",
    );
  }
  if (preflight.runtimeId !== runtimeId) {
    throw new SparkDaemonRelocationError(
      "Target preflight returned a different runtime identity.",
      "RELOCATION_RUNTIME_MISMATCH",
    );
  }
  const webSocketUrl = validateTargetWebSocketUrl(toServerUrl, preflight.webSocketUrl);
  assertConfigUnchanged(current, readSparkDaemonConfig(paths));

  const relocatedAt = options.now?.() ?? new Date().toISOString();
  const result = applyLocalRelocation(paths, db, current, preflight, {
    fromServerUrl,
    toServerUrl,
    webSocketUrl,
    instanceId: sourceMetadata.instanceId,
    relocatedAt,
    writeConfig: options.writeConfig ?? writeSparkDaemonConfig,
    beforeCommit: options.beforeCommit,
    onUplinkReconfigure: options.onUplinkReconfigure,
  });
  return result;
}

async function fetchRelocationMetadata(serverUrl: string, fetchFn?: typeof fetch) {
  const url = new URL("/api/v1/runtime/relocation/metadata", serverUrl);
  const response = await fetchRegistrationEndpoint(url, { method: "GET" }, fetchFn);
  if (!response.ok) {
    throw await relocationHttpError(response, url, "RELOCATION_METADATA_REJECTED");
  }
  return cockpitRuntimeRelocationMetadataSchema.parse(await response.json());
}

async function fetchTargetPreflight(
  serverUrl: string,
  request: Record<string, string>,
  fetchFn?: typeof fetch,
): Promise<RuntimeRelocationPreflightResponse> {
  const url = new URL("/api/v1/runtime/relocation/preflight", serverUrl);
  const response = await fetchRegistrationEndpoint(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
    fetchFn,
  );
  if (!response.ok) {
    throw await relocationHttpError(response, url, "RELOCATION_PREFLIGHT_REJECTED");
  }
  return runtimeRelocationPreflightResponseSchema.parse(await response.json());
}

function applyLocalRelocation(
  paths: SparkPaths,
  db: DatabaseSync,
  current: SparkDaemonConfig,
  preflight: RuntimeRelocationPreflightResponse,
  input: {
    fromServerUrl: string;
    toServerUrl: string;
    webSocketUrl: string;
    instanceId: string;
    relocatedAt: string;
    writeConfig: typeof writeSparkDaemonConfig;
    beforeCommit?: () => void;
    onUplinkReconfigure?: () => void;
  },
): SparkDaemonRelocationResult {
  const sourceServer = db
    .prepare("SELECT id FROM daemon_servers WHERE server_url = ?")
    .get(input.fromServerUrl) as { id: string } | undefined;
  if (!sourceServer) {
    throw new SparkDaemonRelocationError(
      "Configured source Cockpit is not registered in daemon state.",
      "RELOCATION_SOURCE_NOT_FOUND",
    );
  }
  const workspaces = db
    .prepare(
      `SELECT w.id AS bindingId
       FROM workspaces w
       JOIN daemon_workspaces dw ON dw.id = w.id
       WHERE w.server_url = ? AND dw.server_id = ?
       ORDER BY w.id`,
    )
    .all(input.fromServerUrl, sourceServer.id) as Array<{ bindingId: string }>;
  const nextConfig: SparkDaemonConfig = {
    ...current,
    serverUrl: input.toServerUrl,
    runtimeId: preflight.runtimeId,
    runtimeToken: preflight.runtimeToken,
    runtimeTokenExpiresAt: preflight.runtimeTokenExpiresAt,
    refreshToken: preflight.refreshToken,
    refreshTokenExpiresAt: preflight.refreshTokenExpiresAt,
    webSocketUrl: input.webSocketUrl,
  };
  let configWritten = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    assertNoLocalTargetCollision(db, input.fromServerUrl, input.toServerUrl);
    db.prepare(
      `UPDATE daemon_servers
       SET server_url = ?, last_disconnect_reason = 'relocating'
       WHERE id = ?`,
    ).run(input.toServerUrl, sourceServer.id);
    db.prepare(
      `UPDATE workspaces
       SET server_url = ?, updated_at = ?
       WHERE server_url = ?`,
    ).run(input.toServerUrl, input.relocatedAt, input.fromServerUrl);
    const existingCredential = db
      .prepare(
        "SELECT id, created_at AS createdAt FROM daemon_server_credentials WHERE server_id = ?",
      )
      .get(sourceServer.id) as { id: string; createdAt: string } | undefined;
    db.prepare(
      `INSERT INTO daemon_server_credentials
        (id, server_id, runtime_id, runtime_token_hash, refresh_token_hash,
         runtime_token_expires_at, refresh_token_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         runtime_id = excluded.runtime_id,
         runtime_token_hash = excluded.runtime_token_hash,
         refresh_token_hash = excluded.refresh_token_hash,
         runtime_token_expires_at = excluded.runtime_token_expires_at,
         refresh_token_expires_at = excluded.refresh_token_expires_at,
         updated_at = excluded.updated_at`,
    ).run(
      existingCredential?.id ?? `rncred_${randomUUID().replaceAll("-", "")}`,
      sourceServer.id,
      preflight.runtimeId,
      hashSecret(preflight.runtimeToken),
      hashSecret(preflight.refreshToken),
      preflight.runtimeTokenExpiresAt,
      preflight.refreshTokenExpiresAt,
      existingCredential?.createdAt ?? input.relocatedAt,
      input.relocatedAt,
    );
    input.writeConfig(paths, nextConfig);
    configWritten = true;
    input.beforeCommit?.();
    db.prepare(
      `INSERT INTO daemon_relocation_audit
        (id, instance_id, runtime_id, from_server_url, to_server_url, workspace_count, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?)`,
    ).run(
      `reloc_${randomUUID().replaceAll("-", "")}`,
      input.instanceId,
      preflight.runtimeId,
      input.fromServerUrl,
      input.toServerUrl,
      workspaces.length,
      input.relocatedAt,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } finally {
      if (configWritten) input.writeConfig(paths, current);
    }
    throw error;
  }
  Object.assign(current, nextConfig);
  input.onUplinkReconfigure?.();
  return {
    relocated: true,
    instanceId: input.instanceId,
    installationId: current.installationId,
    runtimeId: preflight.runtimeId,
    fromServerUrl: input.fromServerUrl,
    toServerUrl: input.toServerUrl,
    webSocketUrl: input.webSocketUrl,
    workspaceBindingIds: workspaces.map(({ bindingId }) => bindingId),
    workspaceCount: workspaces.length,
    relocatedAt: input.relocatedAt,
  };
}

function assertNoLocalTargetCollision(
  db: DatabaseSync,
  fromServerUrl: string,
  toServerUrl: string,
): void {
  const collision = db
    .prepare("SELECT id FROM daemon_servers WHERE server_url = ? LIMIT 1")
    .get(toServerUrl) as { id: string } | undefined;
  if (collision && fromServerUrl !== toServerUrl) {
    throw new SparkDaemonRelocationError(
      "Relocation target is already registered as another Cockpit origin.",
      "RELOCATION_TARGET_COLLISION",
    );
  }
}

function requireCurrentServerUrl(config: SparkDaemonConfig, requested?: string): string {
  const configured = configuredServerUrl(config);
  if (!configured) {
    throw new SparkDaemonRelocationError(
      "Spark daemon has no configured Cockpit origin.",
      "RELOCATION_SOURCE_NOT_CONFIGURED",
    );
  }
  if (requested) {
    const normalized = validateRegistrationServerUrl(requested, { allowInsecureHttp: true });
    if (normalized !== configured) {
      throw new SparkDaemonRelocationError(
        "Requested source origin does not match daemon config.",
        "RELOCATION_SOURCE_MISMATCH",
      );
    }
  }
  return configured;
}

function validateRelocationTarget(serverUrl: string): string {
  const normalized = validateRegistrationServerUrl(serverUrl);
  if (new URL(normalized).protocol !== "https:") {
    throw new SparkDaemonRelocationError(
      "Cockpit relocation target must use HTTPS.",
      "RELOCATION_HTTPS_REQUIRED",
    );
  }
  return normalized;
}

function validateTargetWebSocketUrl(serverUrl: string, value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "wss:" ||
    url.origin.replace(/^wss:/u, "https:") !== new URL(serverUrl).origin
  ) {
    throw new SparkDaemonRelocationError(
      "Target returned an invalid or cross-origin runtime WebSocket URL.",
      "RELOCATION_WEBSOCKET_INVALID",
    );
  }
  return url.toString();
}

async function relocationHttpError(
  response: Response,
  url: URL,
  fallbackCode: string,
): Promise<SparkDaemonRelocationError> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  const record = isRecord(parsed) ? parsed : undefined;
  const nested = record && isRecord(record.error) ? record.error : undefined;
  const code = stringValue(nested?.code) ?? stringValue(record?.code) ?? fallbackCode;
  const message =
    stringValue(nested?.message) ??
    stringValue(record?.message) ??
    `Cockpit relocation request failed with HTTP ${response.status}.`;
  return new SparkDaemonRelocationError(`${message} (${url.origin})`, code.toUpperCase());
}

function assertConfigUnchanged(before: SparkDaemonConfig, after: SparkDaemonConfig): void {
  if (configDigest(before) !== configDigest(after)) {
    throw new SparkDaemonRelocationError(
      "Daemon config changed while relocation preflight was running.",
      "RELOCATION_CONFIG_CHANGED",
    );
  }
}

function configDigest(config: SparkDaemonConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function hashSecret(secret: string): string {
  return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

function requireConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new SparkDaemonRelocationError(
      `Spark daemon config is missing ${name}.`,
      "RELOCATION_CONFIG_INCOMPLETE",
    );
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
