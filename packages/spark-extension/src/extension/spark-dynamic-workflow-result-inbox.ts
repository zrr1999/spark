import type { RunRef } from "@zendev-lab/pi-extension-api";
import type { SparkDynamicWorkflowEventRunView } from "./spark-dynamic-workflow-event-store.ts";
import {
  projectSparkDynamicWorkflowRun,
  type SparkDynamicWorkflowProjectionStatus,
} from "./spark-dynamic-workflow-run-rendering.ts";

export interface SparkDynamicWorkflowResultDelivery {
  runRef: RunRef;
  status: Extract<SparkDynamicWorkflowProjectionStatus, "succeeded" | "failed">;
  name: string;
  sourceLabel: string;
  updatedAt: string;
  finishedAt?: string;
  resultPreview?: string;
  errorMessage?: string;
  acknowledgedAt?: string;
}

export function projectSparkDynamicWorkflowResultDeliveries(input: {
  runs: SparkDynamicWorkflowEventRunView[];
  includeAcknowledged?: boolean;
  limit?: number;
}): SparkDynamicWorkflowResultDelivery[] {
  return input.runs
    .map(projectSparkDynamicWorkflowResultDelivery)
    .filter((delivery): delivery is SparkDynamicWorkflowResultDelivery => Boolean(delivery))
    .filter((delivery) => input.includeAcknowledged || !delivery.acknowledgedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, input.limit ?? 5);
}

export function appendSparkDynamicWorkflowResultInboxLines(
  lines: string[],
  deliveries: SparkDynamicWorkflowResultDelivery[],
): void {
  if (deliveries.length === 0) return;
  lines.push(`Dynamic workflow result inbox: ${deliveries.length} undelivered`);
  for (const delivery of deliveries)
    lines.push(`  ${formatSparkDynamicWorkflowDeliveryLine(delivery)}`);
}

function projectSparkDynamicWorkflowResultDelivery(
  view: SparkDynamicWorkflowEventRunView,
): SparkDynamicWorkflowResultDelivery | undefined {
  const projection = projectSparkDynamicWorkflowRun(view);
  if (projection.status !== "succeeded" && projection.status !== "failed") return undefined;
  return {
    runRef: projection.ref,
    status: projection.status,
    name: projection.name,
    sourceLabel: projection.sourceLabel,
    updatedAt: projection.updatedAt,
    finishedAt: view.snapshot.finishedAt,
    resultPreview:
      projection.status === "succeeded" && view.snapshot.result !== undefined
        ? compact(formatUnknown(view.snapshot.result), 180)
        : undefined,
    errorMessage:
      projection.status === "failed" && view.snapshot.errorMessage
        ? compact(view.snapshot.errorMessage, 180)
        : undefined,
    acknowledgedAt: projection.acknowledgedAt,
  };
}

function formatSparkDynamicWorkflowDeliveryLine(
  delivery: SparkDynamicWorkflowResultDelivery,
): string {
  const label = delivery.status === "succeeded" ? "Result" : "Error";
  const payload =
    delivery.resultPreview ??
    delivery.errorMessage ??
    (delivery.status === "succeeded" ? "completed" : "failed");
  return `${label}: ${delivery.runRef} [${delivery.status}] ${delivery.name} · ${payload} · ack with task_read({ action: "run_status", runAction: "ack", runRef: "${delivery.runRef}" })`;
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}…` : normalized;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable workflow result]";
  }
}
