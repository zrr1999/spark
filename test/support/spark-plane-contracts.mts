export type ContractLevel = "pass" | "warn" | "fail";

export interface ContractDiagnostic {
  path: string;
  level: ContractLevel;
  message: string;
}

export interface DaemonInvocationCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface DaemonStatusContract {
  running?: boolean;
  identity?: string;
  observedAt?: string;
  workspaceCount?: number;
  serverUrl?: string;
  websocketState?: "connected" | "disconnected" | "missing";
  invocations?: DaemonInvocationCounts;
  invocationHealth?: { oldestQueuedAt?: string; oldestRunningAt?: string };
  diagnostics: ContractDiagnostic[];
}

export interface DaemonStabilityChecks {
  daemonRunningBefore: boolean;
  daemonRunningAfter: boolean;
  runtimeStable: boolean;
  workspaceCountStable: boolean;
  invocationTerminalCountsMonotonic: boolean;
  mismatches: string[];
}

export interface CockpitStatusContract {
  plane?: string;
  resource?: string;
  currentProjectRef?: string;
  projectCount?: number;
  taskCounts?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  diagnostics: ContractDiagnostic[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry));
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (/token|secret|key/iu.test(key)) {
      redacted[key] = "<redacted>";
      continue;
    }
    redacted[key] = redactSecrets(field);
  }
  return redacted;
}

export function extractDaemonStatusContract(statusInput: unknown): DaemonStatusContract {
  const diagnostics: ContractDiagnostic[] = [];
  const envelope = isRecord(statusInput) ? statusInput : undefined;
  const daemon = isRecord(envelope?.daemon) ? envelope.daemon : undefined;
  if (!daemon) {
    diagnostics.push({
      path: "daemon",
      level: "fail",
      message: "spark daemon status JSON must contain object field `daemon`.",
    });
    return { diagnostics };
  }

  const running = readBoolean(daemon, "running");
  if (running === undefined) {
    diagnostics.push({
      path: "daemon.running",
      level: "fail",
      message: "spark daemon status JSON must contain boolean field `daemon.running`.",
    });
  }

  const invocations = extractInvocationCounts(
    daemon.invocations,
    diagnostics,
    "daemon.invocations",
  );
  const invocationHealth = extractInvocationHealth(daemon.invocationHealth);
  const observedAt = readString(daemon, "observedAt");
  const servers = Array.isArray(daemon.servers) ? daemon.servers.filter(isRecord) : [];
  const workspaceCounts = servers
    .map((server) => readNumber(server, "workspaceCount"))
    .filter((value): value is number => value !== undefined);
  const workspaceCount =
    workspaceCounts.length > 0 ? workspaceCounts.reduce((sum, value) => sum + value, 0) : undefined;
  const serverUrl = servers
    .map((server) => readString(server, "url"))
    .find((url) => url?.startsWith("http"));
  const websocketState = deriveWebsocketState(servers);
  const identity = daemonIdentity(daemon);
  return {
    ...(running === undefined ? {} : { running }),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(invocations === undefined ? {} : { invocations }),
    ...(invocationHealth === undefined ? {} : { invocationHealth }),
    ...(workspaceCount === undefined ? {} : { workspaceCount }),
    ...(serverUrl === undefined ? {} : { serverUrl }),
    ...(websocketState === undefined ? {} : { websocketState }),
    ...(identity === undefined ? {} : { identity }),
    diagnostics,
  };
}

export function extractCockpitStatusContract(statusInput: unknown): CockpitStatusContract {
  const diagnostics: ContractDiagnostic[] = [];
  const envelope = isRecord(statusInput) ? statusInput : undefined;
  const result = isRecord(envelope?.result) ? envelope.result : undefined;
  if (!result) {
    diagnostics.push({
      path: "result",
      level: "fail",
      message: "spark cockpit status JSON must contain object field `result`.",
    });
    return { diagnostics };
  }
  const plane = readString(result, "plane");
  if (plane !== "cockpit") {
    diagnostics.push({
      path: "result.plane",
      level: "fail",
      message: "spark cockpit status JSON must report `result.plane` as `cockpit`.",
    });
  }
  const resource = readString(result, "resource");
  if (resource !== "status") {
    diagnostics.push({
      path: "result.resource",
      level: "fail",
      message: "spark cockpit status JSON must report `result.resource` as `status`.",
    });
  }
  const taskCounts = isRecord(result.taskCounts) ? result.taskCounts : undefined;
  if (!taskCounts) {
    diagnostics.push({
      path: "result.taskCounts",
      level: "fail",
      message: "spark cockpit status JSON must contain object field `result.taskCounts`.",
    });
  }
  const scope = isRecord(result.scope) ? result.scope : undefined;
  if (!scope) {
    diagnostics.push({
      path: "result.scope",
      level: "fail",
      message: "spark cockpit status JSON must contain object field `result.scope`.",
    });
  } else {
    for (const key of [
      "selectedWorkspace",
      "selectedSessionKey",
      "selectedProjectRef",
      "goalSource",
    ]) {
      if (!(key in scope)) {
        diagnostics.push({
          path: `result.scope.${key}`,
          level: "fail",
          message: `spark cockpit status JSON must contain field \`result.scope.${key}\`.`,
        });
      }
    }
  }
  const currentProjectRef = readString(result, "currentProjectRef");
  const projectCount = readNumber(result, "projectCount");
  return {
    ...(plane === undefined ? {} : { plane }),
    ...(resource === undefined ? {} : { resource }),
    ...(currentProjectRef === undefined ? {} : { currentProjectRef }),
    ...(projectCount === undefined ? {} : { projectCount }),
    ...(taskCounts === undefined ? {} : { taskCounts }),
    ...(scope === undefined ? {} : { scope }),
    diagnostics,
  };
}

export function evaluateDaemonStabilityChecks(
  beforeInput: unknown,
  afterInput: unknown,
): DaemonStabilityChecks {
  const before = extractDaemonStatusContract(beforeInput);
  const after = extractDaemonStatusContract(afterInput);
  const mismatches: string[] = [];
  const daemonRunningBefore = before.running === true;
  const daemonRunningAfter = after.running === true;
  const runtimeStable = Boolean(
    before.identity && after.identity && before.identity === after.identity,
  );
  const workspaceCountStable = before.workspaceCount === after.workspaceCount;
  const invocationTerminalCountsMonotonic = ["succeeded", "failed", "cancelled"].every((key) => {
    const beforeValue = before.invocations?.[key as keyof DaemonInvocationCounts];
    const afterValue = after.invocations?.[key as keyof DaemonInvocationCounts];
    return beforeValue !== undefined && afterValue !== undefined && afterValue >= beforeValue;
  });
  for (const diagnostic of before.diagnostics) {
    if (diagnostic.level === "fail")
      mismatches.push(`Before status invalid: ${diagnostic.message}`);
  }
  for (const diagnostic of after.diagnostics) {
    if (diagnostic.level === "fail") mismatches.push(`After status invalid: ${diagnostic.message}`);
  }
  if (!daemonRunningBefore) mismatches.push("Spark daemon was not running before the harness run.");
  if (!daemonRunningAfter) mismatches.push("Spark daemon was not running after the harness run.");
  if (!runtimeStable) mismatches.push("Spark daemon identity changed across the harness run.");
  if (!workspaceCountStable)
    mismatches.push("Spark daemon workspaceCount changed across the harness run.");
  if (!invocationTerminalCountsMonotonic) {
    mismatches.push(
      "Spark daemon terminal invocation counters were missing or decreased across the harness run.",
    );
  }
  return {
    daemonRunningBefore,
    daemonRunningAfter,
    runtimeStable,
    workspaceCountStable,
    invocationTerminalCountsMonotonic,
    mismatches,
  };
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function extractInvocationCounts(
  value: unknown,
  diagnostics: ContractDiagnostic[],
  path: string,
): DaemonInvocationCounts | undefined {
  if (!isRecord(value)) {
    diagnostics.push({
      path,
      level: "fail",
      message: "spark daemon status JSON must contain object field `daemon.invocations`.",
    });
    return undefined;
  }
  const queued = readNumber(value, "queued");
  const running = readNumber(value, "running");
  const succeeded = readNumber(value, "succeeded");
  const failed = readNumber(value, "failed");
  const cancelled = readNumber(value, "cancelled");
  const counts = { queued, running, succeeded, failed, cancelled };
  for (const [key, count] of Object.entries(counts)) {
    if (count === undefined) {
      diagnostics.push({
        path: `${path}.${key}`,
        level: "fail",
        message: `spark daemon status JSON must contain numeric field \`${path}.${key}\`.`,
      });
    }
  }
  if (Object.values(counts).some((count) => count === undefined)) return undefined;
  return counts as DaemonInvocationCounts;
}

function extractInvocationHealth(
  value: unknown,
): DaemonStatusContract["invocationHealth"] | undefined {
  if (!isRecord(value)) return undefined;
  const oldestQueuedAt = readString(value, "oldestQueuedAt");
  const oldestRunningAt = readString(value, "oldestRunningAt");
  return {
    ...(oldestQueuedAt ? { oldestQueuedAt } : {}),
    ...(oldestRunningAt ? { oldestRunningAt } : {}),
  };
}

function deriveWebsocketState(
  servers: Record<string, unknown>[],
): "connected" | "disconnected" | "missing" | undefined {
  if (servers.length === 0) return undefined;
  const states = servers
    .map((server) => server.wsConnected)
    .filter((value) => typeof value === "boolean");
  if (states.length === 0) return "missing";
  return states.some(Boolean) ? "connected" : "disconnected";
}

function daemonIdentity(daemon: Record<string, unknown>): string | undefined {
  const pid = readNumber(daemon, "pid");
  const startedAt = readString(daemon, "startedAt");
  const socketPath = readString(daemon, "socketPath");
  if (pid === undefined || !startedAt || !socketPath) return undefined;
  return `${pid}:${startedAt}:${socketPath}`;
}
