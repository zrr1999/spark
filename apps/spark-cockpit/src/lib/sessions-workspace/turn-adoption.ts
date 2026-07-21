import {
  cancelledTurnIdFromActionResult,
  queuedTurnIdFromActionResult,
} from "$lib/session-action-result";
import {
  registerQueuedSessionTurn,
  settleCancelledSessionTurn,
  type SessionLiveEventState,
} from "$lib/session-live-events";
import { invocationStatusFromActionResult } from "./form-results";

export function adoptQueuedTurnIntoLiveState(
  result: unknown,
  liveEventState: SessionLiveEventState | null,
  liveSessionId: string,
): SessionLiveEventState | null {
  const turnId = queuedTurnIdFromActionResult(result);
  if (!turnId || !liveEventState || liveEventState.sessionId !== liveSessionId) {
    return null;
  }
  if (!registerQueuedSessionTurn(liveEventState, turnId)) return null;
  return liveEventState;
}

export function adoptCancelledTurnIntoLiveState(
  result: unknown,
  liveEventState: SessionLiveEventState | null,
  liveSessionId: string,
): SessionLiveEventState | null {
  const turnId = cancelledTurnIdFromActionResult(result);
  if (!turnId || !liveEventState || liveEventState.sessionId !== liveSessionId) {
    return null;
  }
  const status = invocationStatusFromActionResult(result) ?? "cancelled";
  if (!settleCancelledSessionTurn(liveEventState, turnId, status)) return null;
  return liveEventState;
}
