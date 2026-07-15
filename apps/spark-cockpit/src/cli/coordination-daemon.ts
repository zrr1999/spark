import {
  parseSparkSessionRegistryRecord,
  sparkTurnSubmitResultSchema,
  type SparkAssignment,
  type SparkSessionRegistryRecord,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  requestSparkDaemonLocalRpc,
  type SparkDaemonLocalRpcClientOptions,
} from "@zendev-lab/spark-system/daemon-local-rpc";

export interface CockpitCoordinationDaemonClientOptions {
  runtimeDir?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  request?: typeof requestSparkDaemonLocalRpc;
}

export async function getManagedSession(
  sessionId: string,
  options: CockpitCoordinationDaemonClientOptions = {},
): Promise<SparkSessionRegistryRecord> {
  return parseSparkSessionRegistryRecord(
    await daemonRequest("session.get", { sessionId }, options),
  );
}

export async function submitAssignment(
  input: {
    sessionId: string;
    prompt: string;
    assignment: SparkAssignment;
  },
  options: CockpitCoordinationDaemonClientOptions = {},
): Promise<SparkTurnSubmitResult> {
  const result = await daemonRequest(
    "turn.submit",
    {
      sessionId: input.sessionId,
      prompt: input.prompt,
      assignment: input.assignment,
      messageMetadata: { origin: { kind: "cockpit", host: "cockpit", surface: "local" } },
    },
    options,
  );
  return sparkTurnSubmitResultSchema.parse(result);
}

async function daemonRequest<T>(
  method: string,
  params: unknown,
  options: CockpitCoordinationDaemonClientOptions,
): Promise<T> {
  const request = options.request ?? requestSparkDaemonLocalRpc;
  const rpcOptions: SparkDaemonLocalRpcClientOptions = {
    paths: {
      runtimeDir:
        options.runtimeDir ??
        resolveSparkPaths({ app: "daemon", cwd: options.cwd, env: options.env }).runtimeDir,
    },
    ...(options.env ? { env: options.env } : {}),
  };
  return await request<T>(method, params, rpcOptions);
}
