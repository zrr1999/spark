import type { DatabaseSync } from "node:sqlite";
import type {
  SparkSessionBindRequest,
  SparkSessionRegistryRecord,
  SparkSideThreadSnapshot,
} from "@zendev-lab/spark-protocol";
import {
  getRuntimeSessionProjection,
  listRuntimeSessionProjections,
  listRuntimeSessionRoutes,
} from "@zendev-lab/spark-cockpit-coordination/runtime-session-control";
import { RuntimeControlCommandError } from "@zendev-lab/spark-cockpit-coordination/runtime-control";
import { parseSessionSnapshotWindow, type SessionSnapshotWindow } from "../session-snapshot-window";

import {
  CockpitRuntimeSessionUnavailableError,
  createCockpitRuntimeSessionClient,
  isCockpitRuntimeSessionNotFoundError,
  type CockpitRuntimeSessionCreateRequest,
  type CockpitRuntimeSessionListResult,
  type CockpitRuntimeSessionListRequest,
  type CockpitRuntimeSessionSnapshotRequest,
} from "./cockpit-runtime-session-client";
import { getDatabase } from "./db";

export interface CockpitManagedSessionsClient {
  controlAvailable?(options?: CockpitRuntimeSessionListRequest): boolean;
  listWithControlState?(
    options?: CockpitRuntimeSessionListRequest,
  ): Promise<CockpitRuntimeSessionListResult>;
  list(options?: CockpitRuntimeSessionListRequest): Promise<SparkSessionRegistryRecord[]>;
  get(sessionId: string): Promise<SparkSessionRegistryRecord>;
  snapshot(
    sessionId: string,
    options?: CockpitRuntimeSessionSnapshotRequest,
  ): Promise<SessionSnapshotWindow>;
  sideThreadSnapshot?(
    parentSessionId: string,
    options?: { beforeExchangeId?: string; limit?: number },
  ): Promise<SparkSideThreadSnapshot>;
  ensureSideThread?(input: {
    parentSessionId: string;
    mode?: "contextual" | "tangent";
  }): Promise<SparkSideThreadSnapshot>;
  submitSideThread?(input: {
    parentSessionId: string;
    expectedGeneration: number;
    prompt: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  resetSideThread?(input: {
    parentSessionId: string;
    expectedGeneration: number;
    mode: "contextual" | "tangent";
  }): Promise<SparkSideThreadSnapshot>;
  configureSideThread?(input: {
    parentSessionId: string;
    expectedGeneration: number;
    modelOverride?: { providerName: string; modelId: string } | null;
    thinkingOverride?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  }): Promise<SparkSideThreadSnapshot>;
  handoffSideThread?(input: {
    parentSessionId: string;
    expectedGeneration: number;
    expectedHeadExchangeId: string;
    kind: "full" | "summary";
    instructions?: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  create(input: CockpitRuntimeSessionCreateRequest): Promise<SparkSessionRegistryRecord>;
  bind(input: SparkSessionBindRequest): Promise<SparkSessionRegistryRecord>;
  unbind(input: SparkSessionBindRequest): Promise<SparkSessionRegistryRecord>;
  archive(sessionId: string): Promise<SparkSessionRegistryRecord>;
}

const runtimeManagedSessionsClient = createCockpitRuntimeSessionClient();

export type CockpitManagedSessionsList = {
  available: boolean;
  controlAvailable: boolean;
  sessions: SparkSessionRegistryRecord[];
  error?: string;
};

/**
 * Local projection-only session rail. Used so workbench navigation can paint
 * before a live owner `session.list` round-trip finishes.
 */
export function listProjectedManagedSessionsForCockpit(
  options: { workspaceId: string; includeArchived?: boolean },
  database: DatabaseSync = getDatabase(),
): CockpitManagedSessionsList {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) {
    return { available: true, controlAvailable: false, sessions: [] };
  }
  const sessions = listRuntimeSessionProjections(database, {
    scope: "workspace",
    workspaceId,
    includeArchived: options.includeArchived,
  })
    .map((projection) => projection.session)
    .filter(isCockpitWorkspaceSession);
  const controlAvailable = listRuntimeSessionRoutes(database).some(
    (route) => route.scope === "workspace" && route.workspaceId === workspaceId,
  );
  return { available: true, controlAvailable, sessions };
}

export async function listManagedSessionsForCockpit(
  options: CockpitRuntimeSessionListRequest = {},
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<CockpitManagedSessionsList> {
  if (options.scope?.kind === "daemon") {
    return { available: true, controlAvailable: false, sessions: [] };
  }
  try {
    const listed = client.listWithControlState
      ? await client.listWithControlState(options)
      : {
          sessions: await client.list(options),
          controlAvailable: client.controlAvailable?.(options) ?? true,
        };
    return {
      available: true,
      controlAvailable: listed.controlAvailable,
      sessions: listed.sessions.filter(isCockpitWorkspaceSession),
    };
  } catch (error) {
    if (error instanceof CockpitRuntimeSessionUnavailableError) {
      return {
        available: false,
        controlAvailable: false,
        sessions: [],
        error: error.message,
      };
    }
    throw error;
  }
}

export async function getManagedSessionForCockpit(
  sessionId: string,
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionRegistryRecord | null> {
  try {
    return await getLiveManagedSessionForCockpit(sessionId, client);
  } catch (error) {
    // A disconnected owner or stale projection must not turn the workbench
    // layout or session page into a 500.
    if (error instanceof CockpitRuntimeSessionUnavailableError) return null;
    if (isCockpitRuntimeSessionNotFoundError(error)) return null;
    if (
      error instanceof RuntimeControlCommandError &&
      error.reasonCode === "COMMAND_RESULT_TIMEOUT"
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Read current owner state without collapsing transport failure into absence.
 * Authorization-sensitive routes use this variant so offline/timeout remains
 * distinguishable from a missing or foreign session.
 */
export async function getLiveManagedSessionForCockpit(
  sessionId: string,
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionRegistryRecord | null> {
  try {
    const session = await client.get(sessionId);
    return isCockpitWorkspaceSession(session) ? session : null;
  } catch (error) {
    if (isCockpitRuntimeSessionNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * Resolve an already projected conversation without requiring its owner to be
 * connected. Routing and non-authoritative mutation preflight use this local
 * view only to recover the Web workspace boundary; mutations still continue
 * through the runtime client, which owns current-state admission.
 */
export function getProjectedManagedSessionForCockpit(
  sessionId: string,
  database: DatabaseSync = getDatabase(),
): SparkSessionRegistryRecord | null {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return null;
  const session = getRuntimeSessionProjection(database, normalizedSessionId)?.session ?? null;
  return session && isCockpitWorkspaceSession(session) ? session : null;
}

/** Read the last projected conversation view without contacting its owner. */
export function getProjectedManagedSessionSnapshotForCockpit(
  sessionId: string,
  database: DatabaseSync = getDatabase(),
): SessionSnapshotWindow | null {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return null;
  const projection = getRuntimeSessionProjection(database, normalizedSessionId);
  if (
    !projection?.snapshot ||
    !projection.history ||
    !isCockpitWorkspaceSession(projection.session)
  ) {
    return null;
  }
  const earlierMessages = projection.history.hiddenMessages;
  const nextBeforeMessageId = projection.snapshot.messages[0]?.id;
  if (earlierMessages > 0 && !nextBeforeMessageId) return null;
  return parseSessionSnapshotWindow({
    snapshot: projection.snapshot,
    history: {
      ...projection.history,
      earlierMessages,
      laterMessages: 0,
      hasEarlierMessages: earlierMessages > 0,
      ...(earlierMessages > 0 ? { nextBeforeMessageId } : {}),
    },
  });
}

export async function getManagedSessionSnapshotForCockpit(
  sessionId: string,
  options: CockpitRuntimeSessionSnapshotRequest = {},
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SessionSnapshotWindow | null> {
  try {
    const session = await client.get(sessionId);
    if (!isCockpitWorkspaceSession(session)) return null;
    return await client.snapshot(sessionId, options);
  } catch (error) {
    // Snapshot is best-effort for the conversation pane; registry metadata is
    // enough to keep the page reachable while the runtime reconnects.
    if (error instanceof CockpitRuntimeSessionUnavailableError) return null;
    if (isCockpitRuntimeSessionNotFoundError(error)) return null;
    if (
      error instanceof RuntimeControlCommandError &&
      error.reasonCode === "COMMAND_RESULT_TIMEOUT"
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Load an already-created Side Thread for a workspace session. This is
 * deliberately read-only: the Cockpit must never materialize a child merely
 * because somebody visited a parent session page.
 */
export async function getManagedSideThreadSnapshotForCockpit(
  parentSessionId: string,
  options: { workspaceId?: string; beforeExchangeId?: string; limit?: number } = {},
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSideThreadSnapshot | null> {
  try {
    if (!client.sideThreadSnapshot) return null;
    const session = await client.get(parentSessionId);
    if (!isCockpitWorkspaceSession(session)) return null;
    if (options.workspaceId && session.scope.workspaceId !== options.workspaceId) return null;
    return await client.sideThreadSnapshot(parentSessionId, {
      ...(options.beforeExchangeId ? { beforeExchangeId: options.beforeExchangeId } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    });
  } catch (error) {
    if (isCockpitRuntimeSessionNotFoundError(error)) return null;
    if (
      error instanceof RuntimeControlCommandError &&
      (error.reasonCode === "side_thread_not_found" || error.reasonCode === "SIDE_THREAD_NOT_FOUND")
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Mutate a Side Thread only after authorizing the parent workspace session.
 * The command itself still goes to the daemon's single Side Thread controller.
 */
export async function controlManagedSideThreadForCockpit<T>(
  parentSessionId: string,
  workspaceId: string,
  command: (client: CockpitManagedSessionsClient) => Promise<T>,
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<T | null> {
  const session = await client.get(parentSessionId);
  if (!isCockpitWorkspaceSession(session) || session.scope.workspaceId !== workspaceId) return null;
  return await command(client);
}

export async function createManagedSessionForCockpit(
  input: CockpitRuntimeSessionCreateRequest,
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionRegistryRecord> {
  if (input.scope?.kind !== "workspace") {
    throw new Error("Cockpit can create workspace-scoped sessions only.");
  }
  return await client.create(input);
}

export async function bindManagedSessionForCockpit(
  input: SparkSessionBindRequest,
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionRegistryRecord> {
  return await client.bind(input);
}

export async function unbindManagedSessionForCockpit(
  input: SparkSessionBindRequest,
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionRegistryRecord> {
  return await client.unbind(input);
}

export async function archiveManagedSessionForCockpit(
  sessionId: string,
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionRegistryRecord> {
  return await client.archive(sessionId);
}

function isCockpitWorkspaceSession(
  session: SparkSessionRegistryRecord,
): session is SparkSessionRegistryRecord & { scope: { kind: "workspace"; workspaceId: string } } {
  // The daemon normally omits these from `session.list`, but keep the Cockpit
  // rail defensive when a stale projection or a diagnostic list response
  // contains a related child. Children are visible only through the parent
  // detail's nested Side Thread panel.
  return session.scope.kind === "workspace" && session.relation?.kind !== "side_thread";
}
