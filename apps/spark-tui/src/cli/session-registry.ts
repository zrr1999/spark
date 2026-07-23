import {
  parseSparkSessionRegistryRecord,
  parseSparkSessionRegistryRecords,
  type SparkSessionBindRequest,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  type SparkSessionRegistryRecord,
  type SparkSessionUnbindRequest,
} from "@zendev-lab/spark-protocol";
import {
  requestSparkDaemonLocalRpc,
  type SparkDaemonLocalRpcClientOptions,
} from "@zendev-lab/spark-daemon-client/local-rpc";

export interface SparkDaemonManagedSessionsClient {
  create(input: SparkSessionCreateRequest): Promise<SparkSessionRegistryRecord>;
  list(options?: SparkSessionListRequest): Promise<SparkSessionRegistryRecord[]>;
  get(sessionId: string): Promise<SparkSessionRegistryRecord>;
  bind(sessionId: string, externalKey: string): Promise<SparkSessionRegistryRecord>;
  unbind(sessionId: string, externalKey: string): Promise<SparkSessionRegistryRecord>;
  archive(sessionId: string): Promise<SparkSessionRegistryRecord>;
}

/** Client-side adapter only. Session persistence and mutation stay behind the
 * daemon acknowledgement boundary. */
export function createDaemonManagedSessionsClient(
  options: SparkDaemonLocalRpcClientOptions = {},
): SparkDaemonManagedSessionsClient {
  const requestRecord = async (method: string, params: unknown) =>
    parseSparkSessionRegistryRecord(
      await requestSparkDaemonLocalRpc<unknown>(method, params, options),
    );
  return {
    create: async (input) => await requestRecord("session.create", input),
    list: async (params = {}) =>
      parseSparkSessionRegistryRecords(
        await requestSparkDaemonLocalRpc<unknown>("session.list", params, options),
      ),
    get: async (sessionId) => await requestRecord("session.get", { sessionId }),
    bind: async (sessionId, externalKey) =>
      await requestRecord("session.bind", {
        sessionId,
        externalKey,
      } satisfies SparkSessionBindRequest),
    unbind: async (sessionId, externalKey) =>
      await requestRecord("session.unbind", {
        sessionId,
        externalKey,
      } satisfies SparkSessionUnbindRequest),
    archive: async (sessionId) => await requestRecord("session.archive", { sessionId }),
  };
}

export function renderManagedSession(record: SparkSessionRegistryRecord): string {
  const bindings =
    record.bindings.length === 0
      ? "none"
      : record.bindings.map((binding) => binding.externalKey).join(", ");
  return `${record.sessionId} ${record.status} workspace=${record.workspaceId} bindings=${bindings}${
    record.title ? ` title=${JSON.stringify(record.title)}` : ""
  }\n`;
}
