export type ConversationActivityStatus =
  | "ready"
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed";

export type VisibleConversationActivityStatus = Exclude<
  ConversationActivityStatus,
  "ready" | "completed"
>;

/**
 * Collapse transport and runtime vocabulary into the latest conversation activity.
 * This does not describe whether the durable session can accept another turn.
 */
export function conversationActivityStatus(status: string): ConversationActivityStatus {
  const normalized = status.trim().toLowerCase().replaceAll("-", "_");
  if (
    ["failed", "error", "rejected", "lost", "timeout", "timed_out", "cancelled"].includes(
      normalized,
    )
  ) {
    return "failed";
  }
  if (
    ["blocked", "waiting", "needs_input", "awaiting_input", "approval_required", "paused"].includes(
      normalized,
    )
  ) {
    return "blocked";
  }
  if (["succeeded", "success", "completed", "done", "resolved"].includes(normalized)) {
    return "completed";
  }
  if (["running", "active", "started", "starting", "in_progress"].includes(normalized)) {
    return "running";
  }
  if (["queued", "pending", "sent", "delivered", "acked", "accepted"].includes(normalized)) {
    return "queued";
  }
  return "ready";
}

/** Only activity that still needs attention belongs beside a conversation title. */
export function visibleConversationActivityStatus(
  status: string,
): VisibleConversationActivityStatus | null {
  const activity = conversationActivityStatus(status);
  return activity === "ready" || activity === "completed" ? null : activity;
}

/** Idle/ready is the normal session state and should not be presented as a badge. */
export function visibleSessionStatus(status: string): "running" | "archived" | null {
  const normalized = status.trim().toLowerCase();
  return normalized === "running" || normalized === "archived" ? normalized : null;
}
