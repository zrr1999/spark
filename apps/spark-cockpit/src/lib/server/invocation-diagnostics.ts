import {
  sparkInvocationListResultSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  type SparkInvocationListRequest,
  type SparkInvocationListResult,
  type SparkInvocationStatus,
  type SparkTurnStatusResult,
  type SparkTurnStreamPage,
} from "@zendev-lab/spark-protocol";
import {
  requestSparkDaemonLocalRpc,
  SparkDaemonLocalRpcUnavailableError,
} from "@zendev-lab/spark-system";

const DEFAULT_LIST_LIMIT = 50;
const MAX_DIAGNOSTIC_EVENTS = 100;

export interface CockpitInvocationDaemonStatus {
  invocations: Record<SparkInvocationStatus, number>;
  invocationHealth: { oldestQueuedAt?: string; oldestRunningAt?: string };
  observedAt: string;
}

export interface CockpitInvocationDiagnosticsClient {
  daemonStatus(): Promise<unknown>;
  list(input: SparkInvocationListRequest): Promise<unknown>;
  status(invocationId: string): Promise<unknown>;
  stream(invocationId: string, after: number, limit: number): Promise<unknown>;
}

export interface CockpitInvocationDiagnosticsSnapshot {
  available: boolean;
  daemon: CockpitInvocationDaemonStatus | null;
  list: SparkInvocationListResult;
  selected: {
    status: SparkTurnStatusResult;
    events: SparkTurnStreamPage;
  } | null;
  error?: string;
}

const daemonInvocationDiagnosticsClient: CockpitInvocationDiagnosticsClient = {
  daemonStatus: async () => await requestSparkDaemonLocalRpc("daemon.status"),
  list: async (input) => await requestSparkDaemonLocalRpc("invocation.list", input),
  status: async (invocationId) => await requestSparkDaemonLocalRpc("turn.status", { invocationId }),
  stream: async (invocationId, after, limit) =>
    await requestSparkDaemonLocalRpc("turn.stream", { invocationId, after, limit }),
};

export async function loadInvocationDiagnosticsForCockpit(
  input: {
    status?: SparkInvocationStatus;
    sessionId?: string;
    since?: string;
    limit?: number;
    offset?: number;
    invocationId?: string;
  } = {},
  client: CockpitInvocationDiagnosticsClient = daemonInvocationDiagnosticsClient,
): Promise<CockpitInvocationDiagnosticsSnapshot> {
  const request: SparkInvocationListRequest = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.sessionId?.trim() ? { sessionId: input.sessionId.trim() } : {}),
    ...(input.since?.trim() ? { since: input.since.trim() } : {}),
    limit: normalizeLimit(input.limit),
    offset: normalizeOffset(input.offset),
  };
  try {
    const [daemon, list] = await Promise.all([
      client.daemonStatus().then(parseDaemonStatus),
      client.list(request).then((value) => sparkInvocationListResultSchema.parse(value)),
    ]);
    const invocationId = input.invocationId?.trim();
    const selected = invocationId ? await loadSelectedInvocation(invocationId, client) : null;
    return { available: true, daemon, list, selected };
  } catch (error) {
    if (error instanceof SparkDaemonLocalRpcUnavailableError) {
      return {
        available: false,
        daemon: null,
        list: emptyInvocationList(request),
        selected: null,
        error: error.message,
      };
    }
    throw error;
  }
}

async function loadSelectedInvocation(
  invocationId: string,
  client: CockpitInvocationDiagnosticsClient,
): Promise<CockpitInvocationDiagnosticsSnapshot["selected"]> {
  const status = sparkTurnStatusResultSchema.parse(await client.status(invocationId));
  const after = Math.max(0, status.eventCursor - MAX_DIAGNOSTIC_EVENTS);
  const events = sparkTurnStreamPageSchema.parse(
    await client.stream(invocationId, after, MAX_DIAGNOSTIC_EVENTS),
  );
  return { status, events };
}

function parseDaemonStatus(value: unknown): CockpitInvocationDaemonStatus {
  if (!isRecord(value) || !isInvocationCounts(value.invocations)) {
    throw new Error("Spark daemon returned an invalid invocation status projection");
  }
  const health = isRecord(value.invocationHealth) ? value.invocationHealth : {};
  const observedAt = typeof value.observedAt === "string" ? value.observedAt : "";
  if (!observedAt) throw new Error("Spark daemon status is missing observedAt");
  return {
    invocations: value.invocations,
    invocationHealth: {
      ...(typeof health.oldestQueuedAt === "string"
        ? { oldestQueuedAt: health.oldestQueuedAt }
        : {}),
      ...(typeof health.oldestRunningAt === "string"
        ? { oldestRunningAt: health.oldestRunningAt }
        : {}),
    },
    observedAt,
  };
}

function emptyInvocationList(input: SparkInvocationListRequest): SparkInvocationListResult {
  return {
    invocations: [],
    total: 0,
    limit: input.limit,
    offset: input.offset,
    observedAt: new Date().toISOString(),
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function isInvocationCounts(value: unknown): value is Record<SparkInvocationStatus, number> {
  if (!isRecord(value)) return false;
  return ["queued", "running", "succeeded", "failed", "cancelled"].every(
    (status) => typeof value[status] === "number" && Number.isFinite(value[status]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
