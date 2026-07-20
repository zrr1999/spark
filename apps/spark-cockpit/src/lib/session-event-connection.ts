export type SessionEventConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export function initialSessionEventConnectionState(
  sessionId: string | null | undefined,
): SessionEventConnectionState {
  return sessionId ? "live" : "offline";
}

export function openingSessionEventConnectionState(
  current: SessionEventConnectionState,
): SessionEventConnectionState {
  return current === "live" || current === "reconnecting" ? current : "connecting";
}
