import type { SparkInvocationStatus } from "@zendev-lab/spark-protocol";
import { loadInvocationDiagnosticsForCockpit } from "$lib/server/invocation-diagnostics";
import type { PageServerLoad } from "./$types";

const invocationStatuses = new Set<SparkInvocationStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const load: PageServerLoad = async ({ url }) => {
  const status = parseStatus(url.searchParams.get("status"));
  const sessionId = url.searchParams.get("session")?.trim() || undefined;
  const invocationId = url.searchParams.get("invocation")?.trim() || undefined;
  const offset = parseOffset(url.searchParams.get("offset"));
  const diagnostics = await loadInvocationDiagnosticsForCockpit({
    ...(status ? { status } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(invocationId ? { invocationId } : {}),
    limit: 50,
    offset,
  });
  return {
    diagnostics,
    filters: {
      status: status ?? "all",
      sessionId: sessionId ?? "",
      offset,
    },
  };
};

function parseStatus(value: string | null): SparkInvocationStatus | undefined {
  if (!value || value === "all") return undefined;
  return invocationStatuses.has(value as SparkInvocationStatus)
    ? (value as SparkInvocationStatus)
    : undefined;
}

function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
