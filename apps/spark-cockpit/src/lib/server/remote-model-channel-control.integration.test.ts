import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { test } from "vitest";

import { FakeChannelTransport } from "@zendev-lab/spark-channels";
import {
  createId,
  runtimeProtocolVersion,
  type SparkAuthFlow,
  type SparkModelControlSnapshot,
  type SparkModelRef,
  type SparkSessionRegistryRecord,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths, writePrivateFile } from "@zendev-lab/spark-system";

import {
  handleServerMessage,
  sparkDaemonSupportedFeatures,
  type MessageContext,
} from "../../../../spark-daemon/src/daemon.ts";
import { createDaemonChannelIngressRuntime } from "../../../../spark-daemon/src/channels/ingress.ts";
import type { SparkDaemonModelControl } from "../../../../spark-daemon/src/model-control.ts";
import { acknowledgeRuntimeCommandTerminal } from "../../../../spark-daemon/src/runtime-command-receipts.ts";
import { createDaemonSessionRegistry } from "../../../../spark-daemon/src/session-registry.ts";
import { openSparkDaemonDatabase } from "../../../../spark-daemon/src/store/schema.ts";
import { registerWorkspace } from "../../../../spark-daemon/src/store/workspaces.ts";
import { createWorkspaceWithOwnerBinding } from "../../../../../packages/spark-coordination/src/projection-services.ts";
import {
  attachRuntimeWebSocket,
  authenticateRuntimeToken,
} from "../../../../../packages/spark-coordination/src/runtime-ws.ts";
import { hashSecret } from "../../../../../packages/spark-coordination/src/security.ts";
import { migrate, openMemoryDatabase } from "../../../../../packages/spark-db/src/index.ts";
import { createOwnerSession, getCurrentUserId } from "./auth.ts";
import { createCockpitRuntimeModelChannelClient } from "./cockpit-runtime-model-channel-client.ts";
import { createCockpitRuntimeSessionClient } from "./cockpit-runtime-session-client.ts";

const now = "2026-07-15T00:00:00.000Z";
const secretMarker = "SPARK_SECRET_MARKER_4bc6f451_model_oauth_channel";
const model: SparkModelRef = {
  providerName: "fixture",
  modelId: "fixture-model",
  providerLabel: "Fixture",
  modelLabel: "Fixture model",
};

test("HTTPS Cockpit controls models and channels over WSS without a daemon socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-remote-model-channel-"));
  const daemonHome = join(root, "daemon-home");
  const cockpitCache = join(root, "cockpit-cache");
  const cockpitArtifacts = join(root, "cockpit-artifacts");
  const nonexistentSocket = join(root, "cockpit-host", "daemon.sock");
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "daemon-data"),
      cacheDir: join(root, "daemon-cache"),
      stateDir: join(root, "daemon-state"),
      runtimeDir: join(root, "daemon-runtime"),
    },
  });
  const cockpitDb = openMemoryDatabase();
  const daemonDb = openSparkDaemonDatabase(paths);
  let wss: WebSocketServer | undefined;
  let daemonWs: WebSocket | undefined;
  let httpsServer: ReturnType<typeof createHttpsServer> | undefined;
  try {
    await Promise.all([
      mkdir(daemonHome, { recursive: true }),
      mkdir(cockpitCache, { recursive: true }),
      mkdir(cockpitArtifacts, { recursive: true }),
    ]);
    migrate(cockpitDb);
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    const installationId = "install-remote-model-channel";
    const runtimeToken = `runtime-${createId("msg")}`;
    cockpitDb
      .prepare(
        `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
         created_at, updated_at)
       VALUES (?, ?, 'Remote model daemon', 'offline', ?, '{}', '{}', ?, ?)`,
      )
      .run(runtimeId, installationId, runtimeProtocolVersion, now, now);
    cockpitDb
      .prepare(
        `INSERT INTO runtime_tokens
        (id, runtime_id, token_hash, label, scopes_json, created_at)
       VALUES (?, ?, ?, 'runtime access token', '["runtime:connect"]', ?)`,
      )
      .run(createId("rttok"), runtimeId, hashSecret(runtimeToken), now);
    cockpitDb
      .prepare(
        `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, local_path, display_name, status,
         capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'remote-model', ?, 'Remote model workspace', 'available', '{}', '{}', ?, ?)`,
      )
      .run(bindingId, runtimeId, root, now, now);
    const cockpitWorkspace = createWorkspaceWithOwnerBinding(cockpitDb, {
      slug: "remote-model",
      name: "Remote model workspace",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });
    registerWorkspace(daemonDb, {
      serverUrl: "https://127.0.0.1/",
      localPath: root,
      serverBindingId: bindingId,
      serverWorkspaceId: cockpitWorkspace.id,
      serverStatus: "available",
      localWorkspaceKey: "remote-model",
      displayName: "Remote model workspace",
      workspaceName: "Remote model workspace",
      workspaceSlug: "remote-model",
      now,
    });
    const owner = createOwnerSession(cockpitDb, "Owner", null);
    const registry = createDaemonSessionRegistry(daemonHome, {
      daemonId: installationId,
      daemonCwd: root,
      resolveWorkspaceCwd: (workspaceId) =>
        workspaceId === cockpitWorkspace.id ? root : undefined,
    });
    const credentialTargets = {
      provider: join(daemonHome, "credentials", "provider.key"),
      oauth: join(daemonHome, "credentials", "oauth.response"),
      channel: join(daemonHome, "workspaces", cockpitWorkspace.id, "channels", "config.json"),
    };
    const modelControl = new FixtureModelControl(registry, credentialTargets);
    const channelIngress = createDaemonChannelIngressRuntime({
      sparkHome: daemonHome,
      workspaceId: cockpitWorkspace.id,
      hooks: { onAssignment: async () => {} },
      sessionRegistry: registry,
      createTransport: () => new FakeChannelTransport(),
      now: () => new Date(now),
    });
    const capturedErrors: string[] = [];
    const daemonContext: MessageContext = {
      paths,
      config: { installationId, displayName: "Remote model daemon", runtimeId },
      db: daemonDb,
      runtimeId,
      sparkHome: daemonHome,
      runtimeSessionId: undefined,
      setRuntimeSessionId(value) {
        this.runtimeSessionId = value;
      },
      ensureHeartbeat() {},
      runSparkCommand: async () => {
        throw new Error("generic command bridge must not execute model/channel control");
      },
      cancelSparkInvocation: async ({ invocationId }) => ({
        invocationId,
        cancelled: false,
        message: "generic cancellation bridge was not used",
      }),
      modelControl,
      channelIngress,
      sessionRegistry: registry,
      onIngestAck: (ackOf) => acknowledgeRuntimeCommandTerminal(daemonDb, ackOf, now),
    };

    const client = createCockpitRuntimeModelChannelClient(cockpitDb);
    const tls = createTestCertificate(root);
    const requestHandler = createControlRequestHandler(cockpitDb, client, {
      runtimeId,
      workspaceId: cockpitWorkspace.id,
      capturedErrors,
    });
    httpsServer = createHttpsServer(tls, requestHandler);
    wss = new WebSocketServer({ noServer: true });
    httpsServer.on("upgrade", (request, socket, head) => {
      const tokenId = authenticateRuntimeToken(cockpitDb, runtimeId, request.headers.authorization);
      if (!tokenId) {
        socket.destroy();
        return;
      }
      wss!.handleUpgrade(request, socket, head, (ws) => {
        attachRuntimeWebSocket(ws, {
          db: cockpitDb,
          runtimeId,
          secureTransport: true,
          remoteAddress: request.socket.remoteAddress,
        });
      });
    });
    httpsServer.listen(0, "127.0.0.1");
    await once(httpsServer, "listening");
    const port = (httpsServer.address() as AddressInfo).port;
    const origin = `https://127.0.0.1:${port}`;
    daemonWs = new WebSocket(`wss://127.0.0.1:${port}/runtime`, {
      rejectUnauthorized: false,
      headers: { Authorization: `Bearer ${runtimeToken}` },
    });
    daemonWs.on("message", (data: RawData) => {
      void handleServerMessage(daemonWs!, rawDataText(data), daemonContext).catch((error) => {
        capturedErrors.push(error instanceof Error ? error.message : String(error));
      });
    });
    await once(daemonWs, "open");
    daemonWs.send(
      JSON.stringify({
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "runtime.hello",
        sentAt: now,
        payload: {
          runtimeId,
          runtimeVersion: "0.1.0-e2e",
          supportedFeatures: sparkDaemonSupportedFeatures,
          workspaceBindings: [
            {
              bindingId,
              localWorkspaceKey: "remote-model",
              localPath: root,
              displayName: "Remote model workspace",
              status: "available",
              capabilities: {},
              diagnostics: {},
            },
          ],
        },
      }),
    );
    await waitFor(() => connectedRuntimeSessions(cockpitDb, runtimeId) === 1);

    const workspaceSessionId = createId("sess");
    await createCockpitRuntimeSessionClient(cockpitDb).create({
      sessionId: workspaceSessionId,
      scope: { kind: "workspace", workspaceId: cockpitWorkspace.id },
      workspaceId: cockpitWorkspace.id,
      title: "Remote model session",
    });
    const action = async (payload: Record<string, unknown>) =>
      await httpsJson(`${origin}/control`, payload, {
        origin,
        sessionToken: owner.sessionToken,
      });

    await action({ action: "catalog" });
    await action({ action: "setDefault" });
    await action({ action: "setSessionModel", sessionId: workspaceSessionId });
    await action({ action: "setThinking", sessionId: workspaceSessionId });
    await action({ action: "setApiKey", apiKey: secretMarker });
    await action({ action: "logout" });
    await action({ action: "setApiKey", apiKey: secretMarker });
    const firstFlow = (await action({ action: "oauthStart" })) as { id: string };
    await action({ action: "oauthStatus", flowId: firstFlow.id });
    await action({
      action: "oauthRespond",
      flowId: firstFlow.id,
      promptId: "prompt-1",
      value: secretMarker,
    });
    const secondFlow = (await action({ action: "oauthStart" })) as { id: string };
    await action({ action: "oauthCancel", flowId: secondFlow.id });
    await action({ action: "channelStatus" });
    await action({ action: "channelConfigure", credential: secretMarker });
    await action({ action: "channelReload" });
    const finalCatalog = (await action({ action: "catalog" })) as SparkModelControlSnapshot;
    const finalChannel = (await action({ action: "channelStatus" })) as {
      configured: boolean;
      configuration: { infoflow?: Record<string, unknown> };
    };
    const finalSession = await registry.get(workspaceSessionId);
    assert.equal(finalCatalog.defaultModel?.modelId, model.modelId);
    assert.equal(finalCatalog.providers[0]?.auth.configured, true);
    assert.equal(finalSession?.model?.modelId, model.modelId);
    assert.equal(finalSession?.thinkingLevel, "high");
    assert.equal(finalChannel.configured, true);
    assert.deepEqual(finalChannel.configuration.infoflow, {
      endpoint: "https://api.im.baidu.com",
      appKeySet: true,
      appAgentId: "43163",
      appSecretSet: true,
      allowedUserIds: [],
      groupPolicy: "disabled",
      groupTrigger: "mention",
      allowedGroupIds: [],
      systemPrompt: "",
    });

    assert.equal(databaseText(cockpitDb).includes(secretMarker), false);
    assert.equal(databaseText(daemonDb).includes(secretMarker), false);
    assert.equal(directoryText(cockpitCache).includes(secretMarker), false);
    assert.equal(directoryText(cockpitArtifacts).includes(secretMarker), false);
    assert.equal(JSON.stringify(capturedErrors).includes(secretMarker), false);
    assert.equal(readFileSync(credentialTargets.provider, "utf8"), secretMarker);
    assert.equal(readFileSync(credentialTargets.oauth, "utf8"), secretMarker);
    assert.equal(readFileSync(credentialTargets.channel, "utf8").includes(secretMarker), true);
    assert.equal(existsSync(nonexistentSocket), false);
    assert.equal(modelControl.apiKeySetCount, 2);
    assert.equal(modelControl.logoutCount, 1);
    assert.equal(modelControl.oauthResponseCount, 1);
    assert.equal(modelControl.oauthCancelCount, 1);
    assert.equal(
      Number(
        cockpitDb.prepare("SELECT COUNT(*) AS count FROM runtime_ephemeral_secret_audit").get()!
          .count,
      ),
      4,
    );
    const commandKinds = cockpitDb
      .prepare("SELECT DISTINCT kind FROM runtime_control_commands ORDER BY kind")
      .all() as Array<{ kind: string }>;
    assert.equal(
      commandKinds.some(({ kind }) => kind.includes("api_key")),
      false,
    );
    assert.equal(
      commandKinds.some(({ kind }) => kind === "channel.configure.request"),
      false,
    );

    console.log(
      "SPARK_REMOTE_MODEL_CHANNEL_CONTROL_TRANSCRIPT",
      JSON.stringify({
        transport: { page: "https", runtime: "wss" },
        runtimeId,
        workspaceId: cockpitWorkspace.id,
        sessionId: workspaceSessionId,
        model: finalCatalog.defaultModel,
        thinkingLevel: finalSession?.thinkingLevel,
        providerConfigured: finalCatalog.providers[0]?.auth.configured,
        channelConfigured: finalChannel.configured,
        credentialFlags: finalChannel.configuration.infoflow,
        apiKeySetCount: modelControl.apiKeySetCount,
        logoutCount: modelControl.logoutCount,
        oauthResponseCount: modelControl.oauthResponseCount,
        oauthCancelCount: modelControl.oauthCancelCount,
        secretAuditCount: 4,
        cockpitDbMatchCount: 0,
        daemonDbMatchCount: 0,
        cockpitCacheMatchCount: 0,
        artifactMatchCount: 0,
        capturedLogMatchCount: 0,
        daemonCredentialTargetMatchCount: 3,
        daemonSocketUsed: false,
      }),
    );
  } finally {
    await closeRuntimeSocket(daemonWs);
    await closeWebSocketServer(wss);
    await closeHttpsServer(httpsServer);
    cockpitDb.close();
    daemonDb.close();
    await rm(root, { recursive: true, force: true });
  }
});

class FixtureModelControl implements SparkDaemonModelControl {
  apiKeySetCount = 0;
  logoutCount = 0;
  oauthResponseCount = 0;
  oauthCancelCount = 0;
  private apiKeyConfigured = false;
  private defaultModel: SparkModelRef | undefined;
  private readonly flows = new Map<string, SparkAuthFlow>();

  constructor(
    private readonly registry: ReturnType<typeof createDaemonSessionRegistry>,
    private readonly targets: { provider: string; oauth: string },
  ) {}

  async snapshot(sessionId?: string): Promise<SparkModelControlSnapshot> {
    const session = sessionId ? await this.registry.get(sessionId) : undefined;
    return {
      providers: [
        {
          providerName: "fixture",
          label: "Fixture",
          auth: {
            providerName: "fixture",
            kind: "api_key",
            configured: this.apiKeyConfigured,
            ...(this.apiKeyConfigured ? { source: "stored" as const } : {}),
          },
          models: [
            {
              model,
              reasoning: true,
              input: ["text"],
              available: true,
            },
          ],
        },
      ],
      ...(this.defaultModel ? { defaultModel: this.defaultModel } : {}),
      ...(sessionId
        ? {
            session: {
              sessionId,
              ...(session?.model ? { model: session.model } : {}),
              ...(session?.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
            },
          }
        : {}),
      diagnostics: [],
    };
  }

  async setDefaultModel(selected: SparkModelRef): Promise<SparkModelControlSnapshot> {
    this.defaultModel = selected;
    return await this.snapshot();
  }

  async setSessionModel(
    sessionId: string,
    selected: SparkModelRef,
  ): Promise<SparkSessionRegistryRecord> {
    return await this.registry.setModel(sessionId, selected);
  }

  async setSessionThinkingLevel(
    sessionId: string,
    thinkingLevel: SparkThinkingLevel,
  ): Promise<SparkSessionRegistryRecord> {
    return await this.registry.setThinkingLevel(sessionId, thinkingLevel);
  }

  async setApiKey(_providerName: string, apiKey: string): Promise<SparkModelControlSnapshot> {
    this.apiKeySetCount += 1;
    this.apiKeyConfigured = true;
    writePrivateFile(this.targets.provider, apiKey);
    return await this.snapshot();
  }

  async logout(): Promise<{ removed: boolean; snapshot: SparkModelControlSnapshot }> {
    this.logoutCount += 1;
    const removed = this.apiKeyConfigured;
    this.apiKeyConfigured = false;
    return { removed, snapshot: await this.snapshot() };
  }

  async startOAuth(providerName: string): Promise<SparkAuthFlow> {
    const id = `flow-${this.flows.size + 1}`;
    const flow: SparkAuthFlow = {
      id,
      providerName,
      providerLabel: "Fixture",
      status: "waiting_for_user",
      createdAt: now,
      updatedAt: now,
      authorization: { url: "https://provider.example.test/authorize" },
      prompt: { id: "prompt-1", kind: "manual_code", message: "Enter code" },
      progress: [],
    };
    this.flows.set(id, flow);
    return flow;
  }

  async oauthStatus(flowId: string): Promise<SparkAuthFlow> {
    return this.requireFlow(flowId);
  }

  async respondOAuth(flowId: string, _promptId: string, value: string): Promise<SparkAuthFlow> {
    this.oauthResponseCount += 1;
    writePrivateFile(this.targets.oauth, value);
    const flow = {
      ...this.requireFlow(flowId),
      status: "succeeded" as const,
      updatedAt: now,
    };
    this.flows.set(flowId, flow);
    return flow;
  }

  async cancelOAuth(flowId: string): Promise<SparkAuthFlow> {
    this.oauthCancelCount += 1;
    const flow = {
      ...this.requireFlow(flowId),
      status: "cancelled" as const,
      updatedAt: now,
    };
    this.flows.set(flowId, flow);
    return flow;
  }

  async effectiveModel(sessionId?: string): Promise<SparkModelRef> {
    return (
      (sessionId ? (await this.registry.get(sessionId))?.model : undefined) ??
      this.defaultModel ??
      model
    );
  }

  async effectiveThinkingLevel(sessionId?: string): Promise<SparkThinkingLevel | undefined> {
    return sessionId ? (await this.registry.get(sessionId))?.thinkingLevel : undefined;
  }

  async prepareModel(): Promise<void> {}

  private requireFlow(flowId: string): SparkAuthFlow {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error("unknown flow");
    return flow;
  }
}

function createControlRequestHandler(
  db: DatabaseSync,
  client: ReturnType<typeof createCockpitRuntimeModelChannelClient>,
  route: {
    runtimeId: string;
    workspaceId: string;
    capturedErrors: string[];
  },
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      if (request.url !== "/control" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const actorUserId = getCurrentUserId(
        db,
        request.headers["x-session-token"]?.toString() ?? null,
      );
      const origin = request.headers.origin;
      const expectedOrigin = `https://${request.headers.host}`;
      if (!actorUserId || origin !== expectedOrigin) {
        response.writeHead(403).end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      const input = JSON.parse(await requestBody(request)) as Record<string, unknown>;
      const result = await runControlAction(client, input, {
        runtimeId: route.runtimeId,
        workspaceId: route.workspaceId,
        context: {
          actorUserId,
          browserRequestId: createId("msg"),
          csrfVerified: true,
          pageProtocol: "https:",
        },
      });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      route.capturedErrors.push(message);
      response
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: message }));
    }
  };
}

async function runControlAction(
  client: ReturnType<typeof createCockpitRuntimeModelChannelClient>,
  input: Record<string, unknown>,
  route: {
    runtimeId: string;
    workspaceId: string;
    context: {
      actorUserId: string;
      browserRequestId: string;
      csrfVerified: true;
      pageProtocol: "https:";
    };
  },
): Promise<unknown> {
  switch (input.action) {
    case "catalog":
      return await client.catalog({ runtimeId: route.runtimeId });
    case "setDefault":
      return await client.setDefault({ runtimeId: route.runtimeId, model });
    case "setSessionModel":
      return await client.setSessionModel({ sessionId: String(input.sessionId), model });
    case "setThinking":
      return await client.setSessionThinking({
        sessionId: String(input.sessionId),
        thinkingLevel: "high",
      });
    case "setApiKey":
      return await client.setProviderApiKey({
        runtimeId: route.runtimeId,
        providerName: "fixture",
        apiKey: String(input.apiKey),
        context: route.context,
      });
    case "logout":
      return await client.logoutProvider({
        runtimeId: route.runtimeId,
        providerName: "fixture",
      });
    case "oauthStart":
      return await client.startOAuth({
        runtimeId: route.runtimeId,
        providerName: "fixture",
      });
    case "oauthStatus":
      return await client.oauthStatus({
        runtimeId: route.runtimeId,
        flowId: String(input.flowId),
      });
    case "oauthRespond":
      return await client.respondOAuth({
        runtimeId: route.runtimeId,
        flowId: String(input.flowId),
        promptId: String(input.promptId),
        value: String(input.value),
        context: route.context,
      });
    case "oauthCancel":
      return await client.cancelOAuth({
        runtimeId: route.runtimeId,
        flowId: String(input.flowId),
      });
    case "channelStatus":
      return await client.channelStatus(route.workspaceId);
    case "channelConfigure":
      return await client.configureChannel({
        workspaceId: route.workspaceId,
        config: {
          adapters: {
            infoflow: {
              type: "infoflow",
              endpoint: "https://api.im.baidu.com",
              app_key: String(input.credential),
              app_secret: String(input.credential),
              app_agent_id: "43163",
              connection_mode: "websocket",
              group_policy: "disabled",
              group_trigger: "mention",
            },
          },
          routes: {},
          ingress: { enabled: true, on_unbound: "create" },
        },
        context: route.context,
      });
    case "channelReload":
      return await client.reloadChannel({ workspaceId: route.workspaceId });
    default:
      throw new Error(`unknown control action: ${String(input.action)}`);
  }
}

function createTestCertificate(root: string): { key: Buffer; cert: Buffer } {
  const keyPath = join(root, "tls.key");
  const certPath = join(root, "tls.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

async function httpsJson(
  url: string,
  body: Record<string, unknown>,
  headers: { origin: string; sessionToken: string },
): Promise<unknown> {
  const encoded = JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(encoded),
          origin: headers.origin,
          "x-session-token": headers.sessionToken,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200) {
            reject(new Error(`HTTPS control failed (${response.statusCode}): ${text}`));
            return;
          }
          resolve(JSON.parse(text) as unknown);
        });
      },
    );
    request.on("error", reject);
    request.end(encoded);
  });
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function connectedRuntimeSessions(db: DatabaseSync, runtimeId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM runtime_sessions
       WHERE runtime_id = ? AND status = 'connected'`,
    )
    .get(runtimeId) as { count: number | bigint };
  return Number(row.count);
}

function databaseText(db: DatabaseSync): string {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  const values: string[] = [];
  for (const { name } of tables) {
    if (!/^[A-Za-z0-9_]+$/u.test(name)) throw new Error(`Unsafe SQLite table name: ${name}`);
    const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") values.push(value);
        if (value instanceof Uint8Array) values.push(Buffer.from(value).toString("utf8"));
      }
    }
  }
  return values.join("\n");
}

function directoryText(root: string): string {
  if (!existsSync(root)) return "";
  const values: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) values.push(directoryText(path));
    else values.push(readFileSync(path).toString("utf8"));
  }
  return values.join("\n");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for secure runtime state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function closeRuntimeSocket(socket: WebSocket | undefined): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

async function closeWebSocketServer(server: WebSocketServer | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function closeHttpsServer(
  server: ReturnType<typeof createHttpsServer> | undefined,
): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
