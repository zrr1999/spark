import type { DatabaseSync } from "node:sqlite";
import {
  getRuntimeChannelControlProjection,
  getRuntimeModelControlProjection,
  publicRuntimeObject,
  runRuntimeEphemeralSecretRequest,
  runRuntimeModelChannelControlCommand,
  runtimeChannelRouteForWorkspace,
  runtimeModelRouteForRuntime,
  runtimeModelRouteForSession,
  type RuntimeEphemeralSecretRequestContext,
} from "@zendev-lab/spark-coordination/runtime-model-channel-control";
import { RuntimeControlCommandError } from "@zendev-lab/spark-coordination/runtime-control";
import {
  parseSparkAuthFlow,
  parseSparkChannelControlSnapshot,
  parseSparkModelControlSnapshot,
  parseSparkSessionRegistryRecord,
  type RuntimeEphemeralSecretRequestPayload,
  type ServerCommandPayload,
  type SparkAuthFlow,
  type SparkChannelControlSnapshot,
  type SparkModelControlSnapshot,
  type SparkModelRef,
  type SparkSessionRegistryRecord,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import type { ChannelsConfig } from "@zendev-lab/spark-channels";
import { getDatabase } from "./db.ts";

export interface CockpitRuntimeModelChannelClient {
  catalog(input?: { runtimeId?: string; sessionId?: string }): Promise<SparkModelControlSnapshot>;
  setDefault(input: {
    runtimeId?: string;
    model: SparkModelRef;
    requestedByUserId?: string;
  }): Promise<SparkModelControlSnapshot>;
  setSessionModel(input: {
    sessionId: string;
    model: SparkModelRef;
    requestedByUserId?: string;
  }): Promise<SparkSessionRegistryRecord>;
  setSessionThinking(input: {
    sessionId: string;
    thinkingLevel: SparkThinkingLevel;
    requestedByUserId?: string;
  }): Promise<SparkSessionRegistryRecord>;
  logoutProvider(input: {
    runtimeId?: string;
    providerName: string;
    requestedByUserId?: string;
  }): Promise<{ removed: boolean; snapshot: SparkModelControlSnapshot }>;
  setProviderApiKey(input: {
    runtimeId?: string;
    providerName: string;
    apiKey: string;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  }): Promise<SparkModelControlSnapshot>;
  startOAuth(input: {
    runtimeId?: string;
    providerName: string;
    requestedByUserId?: string;
  }): Promise<SparkAuthFlow>;
  oauthStatus(input: { runtimeId?: string; flowId: string }): Promise<SparkAuthFlow>;
  respondOAuth(input: {
    runtimeId?: string;
    flowId: string;
    promptId: string;
    value: string;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  }): Promise<SparkAuthFlow>;
  cancelOAuth(input: {
    runtimeId?: string;
    flowId: string;
    requestedByUserId?: string;
  }): Promise<SparkAuthFlow>;
  channelStatus(workspaceId: string): Promise<SparkChannelControlSnapshot>;
  configureChannel(input: {
    workspaceId: string;
    config: ChannelsConfig;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  }): Promise<SparkChannelControlSnapshot>;
  reloadChannel(input: {
    workspaceId: string;
    requestedByUserId?: string;
  }): Promise<SparkChannelControlSnapshot>;
}

export function createCockpitRuntimeModelChannelClient(
  injectedDatabase?: DatabaseSync,
): CockpitRuntimeModelChannelClient {
  const database = () => injectedDatabase ?? getDatabase();
  return {
    catalog: async (input = {}) => await catalog(database(), input),
    setDefault: async (input) => await setDefault(database(), input),
    setSessionModel: async (input) => await setSessionModel(database(), input),
    setSessionThinking: async (input) => await setSessionThinking(database(), input),
    logoutProvider: async (input) => await logoutProvider(database(), input),
    setProviderApiKey: async (input) => await setProviderApiKey(database(), input),
    startOAuth: async (input) => await startOAuth(database(), input),
    oauthStatus: async (input) => await oauthStatus(database(), input),
    respondOAuth: async (input) => await respondOAuth(database(), input),
    cancelOAuth: async (input) => await cancelOAuth(database(), input),
    channelStatus: async (workspaceId) => await channelStatus(database(), workspaceId),
    configureChannel: async (input) => await configureChannel(database(), input),
    reloadChannel: async (input) => await reloadChannel(database(), input),
  };
}

async function catalog(
  db: DatabaseSync,
  input: { runtimeId?: string; sessionId?: string },
): Promise<SparkModelControlSnapshot> {
  const route = input.sessionId
    ? runtimeModelRouteForSession(db, input.sessionId)
    : runtimeModelRouteForRuntime(resolveRuntimeId(db, input.runtimeId));
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    sessionId: input.sessionId,
    payload: {
      kind: "model.catalog.request",
      payload: input.sessionId ? { sessionId: input.sessionId } : {},
    },
  });
  return (
    getRuntimeModelControlProjection(db, route.runtimeId) ??
    parseSparkModelControlSnapshot(result.snapshot)
  );
}

async function setDefault(
  db: DatabaseSync,
  input: { runtimeId?: string; model: SparkModelRef; requestedByUserId?: string },
): Promise<SparkModelControlSnapshot> {
  const route = runtimeModelRouteForRuntime(resolveRuntimeId(db, input.runtimeId));
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    requestedByUserId: input.requestedByUserId,
    payload: { kind: "model.default.set.request", payload: publicRuntimeObject(input) },
  });
  return (
    getRuntimeModelControlProjection(db, route.runtimeId) ??
    parseSparkModelControlSnapshot(result.snapshot)
  );
}

async function setSessionModel(
  db: DatabaseSync,
  input: { sessionId: string; model: SparkModelRef; requestedByUserId?: string },
): Promise<SparkSessionRegistryRecord> {
  const route = runtimeModelRouteForSession(db, input.sessionId);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    sessionId: input.sessionId,
    requestedByUserId: input.requestedByUserId,
    payload: {
      kind: "session.model.set.request",
      payload: publicRuntimeObject({ sessionId: input.sessionId, model: input.model }),
    },
  });
  return parseSparkSessionRegistryRecord(result.session);
}

async function setSessionThinking(
  db: DatabaseSync,
  input: {
    sessionId: string;
    thinkingLevel: SparkThinkingLevel;
    requestedByUserId?: string;
  },
): Promise<SparkSessionRegistryRecord> {
  const route = runtimeModelRouteForSession(db, input.sessionId);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    sessionId: input.sessionId,
    requestedByUserId: input.requestedByUserId,
    payload: {
      kind: "session.thinking.set.request",
      payload: publicRuntimeObject({
        sessionId: input.sessionId,
        thinkingLevel: input.thinkingLevel,
      }),
    },
  });
  return parseSparkSessionRegistryRecord(result.session);
}

async function logoutProvider(
  db: DatabaseSync,
  input: { runtimeId?: string; providerName: string; requestedByUserId?: string },
): Promise<{ removed: boolean; snapshot: SparkModelControlSnapshot }> {
  const route = runtimeModelRouteForRuntime(resolveRuntimeId(db, input.runtimeId));
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    requestedByUserId: input.requestedByUserId,
    payload: {
      kind: "provider.auth.logout.request",
      payload: { providerName: input.providerName },
    },
  });
  return {
    removed: result.removed === true,
    snapshot:
      getRuntimeModelControlProjection(db, route.runtimeId) ??
      parseSparkModelControlSnapshot(result.snapshot),
  };
}

async function setProviderApiKey(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    providerName: string;
    apiKey: string;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  },
): Promise<SparkModelControlSnapshot> {
  const runtimeId = resolveRuntimeId(db, input.runtimeId);
  const result = await runRuntimeEphemeralSecretRequest(db, {
    route: runtimeModelRouteForRuntime(runtimeId),
    request: {
      operation: "provider.auth.api_key.set",
      providerName: input.providerName,
      apiKey: input.apiKey,
    },
    context: input.context,
    requestId: input.requestId,
  });
  return parseSparkModelControlSnapshot(result.result);
}

async function startOAuth(
  db: DatabaseSync,
  input: { runtimeId?: string; providerName: string; requestedByUserId?: string },
): Promise<SparkAuthFlow> {
  return await runOAuthPublicCommand(db, {
    runtimeId: input.runtimeId,
    requestedByUserId: input.requestedByUserId,
    payload: {
      kind: "provider.auth.login.start.request",
      payload: { providerName: input.providerName },
    },
  });
}

async function oauthStatus(
  db: DatabaseSync,
  input: { runtimeId?: string; flowId: string },
): Promise<SparkAuthFlow> {
  return await runOAuthPublicCommand(db, {
    runtimeId: input.runtimeId,
    payload: { kind: "provider.auth.login.status.request", payload: { flowId: input.flowId } },
  });
}

async function respondOAuth(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    flowId: string;
    promptId: string;
    value: string;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  },
): Promise<SparkAuthFlow> {
  const result = await runRuntimeEphemeralSecretRequest(db, {
    route: runtimeModelRouteForRuntime(resolveRuntimeId(db, input.runtimeId)),
    request: {
      operation: "provider.auth.login.respond",
      flowId: input.flowId,
      promptId: input.promptId,
      value: input.value,
    },
    context: input.context,
    requestId: input.requestId,
  });
  return parseSparkAuthFlow(result.result);
}

async function cancelOAuth(
  db: DatabaseSync,
  input: { runtimeId?: string; flowId: string; requestedByUserId?: string },
): Promise<SparkAuthFlow> {
  return await runOAuthPublicCommand(db, {
    runtimeId: input.runtimeId,
    requestedByUserId: input.requestedByUserId,
    payload: { kind: "provider.auth.login.cancel.request", payload: { flowId: input.flowId } },
  });
}

async function runOAuthPublicCommand(
  db: DatabaseSync,
  input: {
    runtimeId?: string;
    requestedByUserId?: string;
    payload: ServerCommandPayload;
  },
): Promise<SparkAuthFlow> {
  const result = await runRuntimeModelChannelControlCommand(db, {
    route: runtimeModelRouteForRuntime(resolveRuntimeId(db, input.runtimeId)),
    requestedByUserId: input.requestedByUserId,
    payload: input.payload,
  });
  return parseSparkAuthFlow(result.flow);
}

async function channelStatus(
  db: DatabaseSync,
  workspaceId: string,
): Promise<SparkChannelControlSnapshot> {
  const route = runtimeChannelRouteForWorkspace(db, workspaceId);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    payload: { kind: "channel.status.request", payload: { workspaceId } },
  });
  return (
    getRuntimeChannelControlProjection(db, workspaceId) ??
    parseSparkChannelControlSnapshot(result.snapshot)
  );
}

async function configureChannel(
  db: DatabaseSync,
  input: {
    workspaceId: string;
    config: ChannelsConfig;
    context: RuntimeEphemeralSecretRequestContext;
    requestId?: string;
  },
): Promise<SparkChannelControlSnapshot> {
  const route = runtimeChannelRouteForWorkspace(db, input.workspaceId);
  const result = await runRuntimeEphemeralSecretRequest(db, {
    route,
    request: {
      operation: "channel.configure",
      workspaceId: input.workspaceId,
      config: publicRuntimeObject(input.config),
    },
    context: input.context,
    requestId: input.requestId,
  });
  return parseSparkChannelControlSnapshot(result.result);
}

async function reloadChannel(
  db: DatabaseSync,
  input: { workspaceId: string; requestedByUserId?: string },
): Promise<SparkChannelControlSnapshot> {
  const route = runtimeChannelRouteForWorkspace(db, input.workspaceId);
  const result = await runRuntimeModelChannelControlCommand(db, {
    route,
    requestedByUserId: input.requestedByUserId,
    payload: { kind: "channel.reload.request", payload: { workspaceId: input.workspaceId } },
  });
  return (
    getRuntimeChannelControlProjection(db, input.workspaceId) ??
    parseSparkChannelControlSnapshot(result.snapshot)
  );
}

function resolveRuntimeId(db: DatabaseSync, requested?: string): string {
  if (requested?.trim()) return requested.trim();
  const rows = db
    .prepare(
      `SELECT DISTINCT rc.id AS runtimeId
       FROM runtime_connections rc
       JOIN runtime_sessions rs ON rs.runtime_id = rc.id
       WHERE rc.status = 'online' AND rs.status = 'connected'
       ORDER BY rc.id
       LIMIT 2`,
    )
    .all() as Array<{ runtimeId: string }>;
  if (rows.length !== 1) {
    throw new RuntimeControlCommandError(
      rows.length === 0
        ? "No connected Spark daemon runtime is available."
        : "Select a Spark daemon runtime for model control.",
      rows.length === 0 ? "RUNTIME_UNAVAILABLE" : "RUNTIME_ROUTE_AMBIGUOUS",
    );
  }
  return rows[0]!.runtimeId;
}
