import {
  parseSparkSessionRegistryRecord,
  parseSparkSessionRegistryRecords,
  sparkSessionViewSchema,
  type SparkSessionBindRequest,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  type SparkSessionRegistryRecord,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";
import {
  requestSparkDaemonLocalRpc,
  SparkDaemonLocalRpcRemoteError,
  SparkDaemonLocalRpcUnavailableError,
} from "@zendev-lab/spark-system";

export interface CockpitManagedSessionsClient {
  list(options?: SparkSessionListRequest): Promise<SparkSessionRegistryRecord[]>;
  get(sessionId: string): Promise<SparkSessionRegistryRecord>;
  snapshot(sessionId: string): Promise<SparkSessionView>;
  create(input: SparkSessionCreateRequest): Promise<SparkSessionRegistryRecord>;
  bind(input: SparkSessionBindRequest): Promise<SparkSessionRegistryRecord>;
  archive(sessionId: string): Promise<SparkSessionRegistryRecord>;
}

function isSessionNotFoundError(error: unknown): boolean {
  if (!(error instanceof SparkDaemonLocalRpcRemoteError)) return false;
  const payload = error.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  return (payload as { code?: unknown }).code === "session_not_found";
}

const daemonManagedSessionsClient: CockpitManagedSessionsClient = {
  list: async (params = {}) =>
    parseSparkSessionRegistryRecords(
      await requestSparkDaemonLocalRpc<unknown>("session.list", params),
    ),
  get: async (sessionId) =>
    parseSparkSessionRegistryRecord(
      await requestSparkDaemonLocalRpc<unknown>("session.get", { sessionId }),
    ),
  snapshot: async (sessionId) =>
    sparkSessionViewSchema.parse(
      await requestSparkDaemonLocalRpc<unknown>("session.snapshot", { sessionId }),
    ),
  create: async (input) =>
    parseSparkSessionRegistryRecord(
      await requestSparkDaemonLocalRpc<unknown>("session.create", input),
    ),
  bind: async (input) =>
    parseSparkSessionRegistryRecord(
      await requestSparkDaemonLocalRpc<unknown>("session.bind", input),
    ),
  archive: async (sessionId) =>
    parseSparkSessionRegistryRecord(
      await requestSparkDaemonLocalRpc<unknown>("session.archive", { sessionId }),
    ),
};

export type CockpitManagedSessionsList = {
  available: boolean;
  sessions: SparkSessionRegistryRecord[];
  error?: string;
};

export async function listManagedSessionsForCockpit(
  options: SparkSessionListRequest = {},
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<CockpitManagedSessionsList> {
  try {
    return { available: true, sessions: await client.list(options) };
  } catch (error) {
    if (error instanceof SparkDaemonLocalRpcUnavailableError) {
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
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<SparkSessionRegistryRecord | null> {
  try {
    return await client.get(sessionId);
  } catch (error) {
    // Match listManagedSessionsForCockpit: daemon restart / missing session
    // must not turn the workbench layout or session page into a 500.
    if (error instanceof SparkDaemonLocalRpcUnavailableError) return null;
    if (isSessionNotFoundError(error)) return null;
    throw error;
  }
}

export async function getManagedSessionSnapshotForCockpit(
  sessionId: string,
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<SparkSessionView | null> {
  try {
    return await client.snapshot(sessionId);
  } catch (error) {
    // Snapshot is best-effort for the conversation pane; registry metadata is
    // enough to keep the page reachable when the daemon is mid-restart or the
    // projected view fails validation.
    if (error instanceof SparkDaemonLocalRpcUnavailableError) return null;
    if (isSessionNotFoundError(error)) return null;
    return null;
  }
}

export async function createManagedSessionForCockpit(
  input: SparkSessionCreateRequest,
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<SparkSessionRegistryRecord> {
  return await client.create(input);
}

export async function bindManagedSessionForCockpit(
  input: SparkSessionBindRequest,
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<SparkSessionRegistryRecord> {
  return await client.bind(input);
}

export async function archiveManagedSessionForCockpit(
  sessionId: string,
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<SparkSessionRegistryRecord> {
  return await client.archive(sessionId);
}
