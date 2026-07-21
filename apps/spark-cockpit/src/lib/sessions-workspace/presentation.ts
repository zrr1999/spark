import { visibleConversationPartText } from "$lib/components/conversation/conversation-view";
import type { SessionTimelineItem } from "$lib/session-timeline";
import type { SessionEventConnectionState } from "$lib/session-event-connection";
import type { SparkMessageView, SparkModelRef } from "@zendev-lab/spark-protocol";
import type { SessionsWorkbenchCopy } from "./types";

export function modelValue(model: SparkModelRef | undefined): string {
  return model ? `${model.providerName}/${model.modelId}` : "";
}

export function queueRemoveFormId(turnId: string): string {
  return `queue-remove-${turnId.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}

export function sessionMessageInvocationId(entry: SparkMessageView): string | null {
  const metadata = entry.metadata;
  if (!metadata || metadata.source !== "daemon.invocation") return null;
  const invocationId = metadata.invocationId;
  return typeof invocationId === "string" && invocationId.trim() ? invocationId.trim() : null;
}

export function navigationSummary(item: SessionTimelineItem): string {
  const summary = (visibleConversationPartText(item.parts) || item.title || item.body)
    .trim()
    .replace(/\s+/gu, " ");
  return summary.length <= 160 ? summary : `${summary.slice(0, 159)}…`;
}

export function isNavigationTurn(
  item: SessionTimelineItem,
): item is SessionTimelineItem & { actor: "user" | "session" } {
  return item.actor !== "spark";
}

export function connectionLabel(
  liveConnection: SessionEventConnectionState,
  copy: Pick<SessionsWorkbenchCopy, "live" | "connecting" | "reconnecting" | "offline">,
): string {
  if (liveConnection === "live") return copy.live;
  if (liveConnection === "connecting") return copy.connecting;
  if (liveConnection === "reconnecting") return copy.reconnecting;
  return copy.offline;
}

export function compactWorkingDirectory(value: string | undefined): string {
  const path = value?.trim() ?? "";
  if (!path) return "";
  const home = /^\/(?:Users|home)\/[^/]+(?=\/|$)|^\/root(?=\/|$)/u.exec(path)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}
