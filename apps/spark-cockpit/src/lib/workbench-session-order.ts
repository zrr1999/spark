import { visibleConversationActivityStatus } from "./conversation-status";

export type WorkbenchSessionOrderLike = {
  sessionId: string;
  status: string;
  activityStatus?: string;
  activityUpdatedAt?: string;
  updatedAt: string;
};

/**
 * Keep sessions that need human attention ahead of ordinary recent history.
 * The individual attention states are peers; recency orders sessions inside
 * both the attention and ordinary-history buckets.
 */
export function orderWorkbenchSessionsByAttention<T extends WorkbenchSessionOrderLike>(
  sessions: readonly T[],
): T[] {
  return [...sessions].sort(compareWorkbenchSessionsByAttention);
}

export function workbenchSessionNeedsAttention(session: WorkbenchSessionOrderLike) {
  return visibleConversationActivityStatus(session.activityStatus ?? session.status) !== null;
}

function compareWorkbenchSessionsByAttention(
  left: WorkbenchSessionOrderLike,
  right: WorkbenchSessionOrderLike,
) {
  const attentionOrder =
    Number(workbenchSessionNeedsAttention(right)) - Number(workbenchSessionNeedsAttention(left));
  if (attentionOrder !== 0) return attentionOrder;

  const timeOrder = compareUpdatedAtDescending(left, right);
  return timeOrder || left.sessionId.localeCompare(right.sessionId);
}

function compareUpdatedAtDescending(
  left: WorkbenchSessionOrderLike,
  right: WorkbenchSessionOrderLike,
) {
  const leftUpdatedAt = effectiveUpdatedAt(left);
  const rightUpdatedAt = effectiveUpdatedAt(right);
  const leftTime = Date.parse(leftUpdatedAt);
  const rightTime = Date.parse(rightUpdatedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
  if (Number.isFinite(leftTime)) return -1;
  if (Number.isFinite(rightTime)) return 1;
  return rightUpdatedAt.localeCompare(leftUpdatedAt);
}

function effectiveUpdatedAt(session: WorkbenchSessionOrderLike) {
  return session.activityUpdatedAt?.trim() || session.updatedAt;
}
