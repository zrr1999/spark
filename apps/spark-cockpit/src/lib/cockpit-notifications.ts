import type { SerializedEvent } from "@zendev-lab/spark-coordination/events";

export const notificationPreferenceStorageKey = "spark-cockpit:notifications:enabled";

export interface CockpitNotificationPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  kind: "task_terminal" | "blocker";
}

const terminalInvocationStatuses = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
]);

export function notificationFromCockpitEvent(
  event: Pick<SerializedEvent, "kind" | "subjectId" | "payload">,
): CockpitNotificationPayload | null {
  if (event.kind === "invocation.updated") {
    const payload = asRecord(event.payload);
    if (!payload) return null;
    const status = typeof payload.status === "string" ? payload.status : "";
    if (!terminalInvocationStatuses.has(status)) return null;
    const ok = status === "succeeded";
    return {
      title: ok ? "Spark task finished" : "Spark task needs attention",
      body: ok
        ? "A long-running Spark task completed. Open Cockpit to review the result."
        : "A long-running Spark task stopped or failed. Open Cockpit to review the status.",
      tag: `spark-invocation-${event.subjectId ?? stringField(payload, "runtimeInvocationId") ?? "terminal"}`,
      url: "/",
      kind: "task_terminal",
    };
  }

  if (event.kind === "human.request.created") {
    return {
      title: "Spark is waiting for you",
      body: "A blocker, approval, or review needs a response in Cockpit.",
      tag: `spark-blocker-${event.subjectId ?? "human-request"}`,
      url: "/",
      kind: "blocker",
    };
  }

  return null;
}

export function sanitizeNotificationPayload(value: unknown): CockpitNotificationPayload | null {
  const record = asRecord(value);
  if (!record) return null;
  const kind = record.kind === "blocker" ? "blocker" : "task_terminal";
  const title = safeText(
    record.title,
    kind === "blocker" ? "Spark is waiting for you" : "Spark update",
  );
  const body = safeText(record.body, "Open Cockpit to review.");
  const tag = safeText(record.tag, `spark-${kind}`);
  const url = safeUrl(record.url);
  return { title, body, tag, url, kind };
}

export function parseNotificationPreference(value: string | null | undefined): boolean {
  return value === "enabled";
}

export function serializeNotificationPreference(enabled: boolean): string {
  return enabled ? "enabled" : "disabled";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  if (!trimmed) return fallback;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function safeUrl(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
