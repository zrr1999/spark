import type { DatabaseSync } from "node:sqlite";
import type {
  SparkSessionBindRequest,
  SparkSessionRegistryRecord,
} from "@zendev-lab/spark-protocol";
import { getRuntimeSessionProjection } from "@zendev-lab/spark-coordination/runtime-session-control";
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
    const session = await client.get(sessionId);
    return isCockpitWorkspaceSession(session) ? session : null;
  } catch (error) {
    // A disconnected owner or stale projection must not turn the workbench
    // layout or session page into a 500.
    if (error instanceof CockpitRuntimeSessionUnavailableError) return null;
    if (isCockpitRuntimeSessionNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * Resolve an already projected conversation without requiring its owner to be
 * connected. Layout routing uses this only to recover the workspace scope for
 * a direct conversation URL; mutations continue through the runtime client.
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
    throw error;
  }
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
  return session.scope.kind === "workspace";
}
