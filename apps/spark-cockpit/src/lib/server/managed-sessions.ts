import {
  parseSparkSessionRegistryRecord,
  parseSparkSessionRegistryRecords,
  sparkSessionViewSchema,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  type SparkSessionRegistryRecord,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";
import {
  requestSparkDaemonLocalRpc,
  SparkDaemonLocalRpcUnavailableError,
} from "@zendev-lab/spark-system";

export interface CockpitManagedSessionsClient {
  list(options?: SparkSessionListRequest): Promise<SparkSessionRegistryRecord[]>;
  get(sessionId: string): Promise<SparkSessionRegistryRecord>;
  snapshot(sessionId: string): Promise<SparkSessionView>;
  create(input: SparkSessionCreateRequest): Promise<SparkSessionRegistryRecord>;
  archive(sessionId: string): Promise<SparkSessionRegistryRecord>;
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
  archive: async (sessionId) =>
    parseSparkSessionRegistryRecord(
      await requestSparkDaemonLocalRpc<unknown>("session.archive", { sessionId }),
    ),
};

export async function listManagedSessionsForCockpit(
  options: SparkSessionListRequest = {},
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<SparkSessionRegistryRecord[]> {
  try {
    return await client.list(options);
  } catch (error) {
    if (error instanceof SparkDaemonLocalRpcUnavailableError) return [];
    throw error;
  }
}

export async function getManagedSessionForCockpit(
  sessionId: string,
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<SparkSessionRegistryRecord> {
  return await client.get(sessionId);
}

export async function getManagedSessionSnapshotForCockpit(
  sessionId: string,
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<SparkSessionView> {
  return await client.snapshot(sessionId);
}

export async function createManagedSessionForCockpit(
  input: SparkSessionCreateRequest,
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<SparkSessionRegistryRecord> {
  return await client.create(input);
}

export async function archiveManagedSessionForCockpit(
  sessionId: string,
  client: CockpitManagedSessionsClient = daemonManagedSessionsClient,
): Promise<SparkSessionRegistryRecord> {
  return await client.archive(sessionId);
}
