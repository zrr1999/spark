import type {
  SparkSessionBindRequest,
  SparkSessionRegistryRecord,
  SparkSessionView,
} from "@zendev-lab/spark-protocol";

import {
  CockpitRuntimeSessionUnavailableError,
  createCockpitRuntimeSessionClient,
  isCockpitRuntimeSessionNotFoundError,
  type CockpitRuntimeSessionCreateRequest,
  type CockpitRuntimeSessionListRequest,
} from "./cockpit-runtime-session-client";

export interface CockpitManagedSessionsClient {
  list(options?: CockpitRuntimeSessionListRequest): Promise<SparkSessionRegistryRecord[]>;
  get(sessionId: string): Promise<SparkSessionRegistryRecord>;
  snapshot(sessionId: string): Promise<SparkSessionView>;
  create(input: CockpitRuntimeSessionCreateRequest): Promise<SparkSessionRegistryRecord>;
  bind(input: SparkSessionBindRequest): Promise<SparkSessionRegistryRecord>;
  unbind(input: SparkSessionBindRequest): Promise<SparkSessionRegistryRecord>;
  archive(sessionId: string): Promise<SparkSessionRegistryRecord>;
}

const runtimeManagedSessionsClient = createCockpitRuntimeSessionClient();

export type CockpitManagedSessionsList = {
  available: boolean;
  sessions: SparkSessionRegistryRecord[];
  error?: string;
};

export async function listManagedSessionsForCockpit(
  options: CockpitRuntimeSessionListRequest = {},
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<CockpitManagedSessionsList> {
  if (options.scope?.kind === "daemon") return { available: true, sessions: [] };
  try {
    const sessions = await client.list(options);
    return {
      available: true,
      sessions: sessions.filter(isCockpitWorkspaceSession),
    };
  } catch (error) {
    if (error instanceof CockpitRuntimeSessionUnavailableError) {
      return {
        available: false,
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

export async function getManagedSessionSnapshotForCockpit(
  sessionId: string,
  client: CockpitManagedSessionsClient = runtimeManagedSessionsClient,
): Promise<SparkSessionView | null> {
  try {
    const session = await client.get(sessionId);
    if (!isCockpitWorkspaceSession(session)) return null;
    return await client.snapshot(sessionId);
  } catch (error) {
    // Snapshot is best-effort for the conversation pane; registry metadata is
    // enough to keep the page reachable while the runtime reconnects.
    if (error instanceof CockpitRuntimeSessionUnavailableError) return null;
    if (isCockpitRuntimeSessionNotFoundError(error)) return null;
    return null;
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
