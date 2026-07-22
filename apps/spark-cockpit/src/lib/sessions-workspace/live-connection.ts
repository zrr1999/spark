import {
  applySessionLiveEvent,
  parseSessionSerializedEvent,
  sessionEventCursorStorageKey,
  type SessionLiveEventState,
} from "$lib/session-live-events";
import {
  openingSessionEventConnectionState,
  type SessionEventConnectionState,
} from "$lib/session-event-connection";

export type SessionLiveConnectionHandlers = {
  getLiveEventState: () => SessionLiveEventState | null;
  setLiveConnection: (state: SessionEventConnectionState) => void;
  getLiveConnection: () => SessionEventConnectionState;
  onViewChanged: (view: SessionLiveEventState["view"]) => void;
  onRefreshActivity: () => void;
};

/**
 * Attach an EventSource live feed for one session id. Returns a cleanup that
 * closes the socket and removes online/offline listeners.
 */
export function attachSessionLiveEventSource(
  streamSessionId: string,
  handlers: SessionLiveConnectionHandlers,
): () => void {
  let closed = false;
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const storageKey = sessionEventCursorStorageKey(streamSessionId);

  const state = handlers.getLiveEventState();
  if (storageKey && state && !state.cursor) {
    state.cursor = window.sessionStorage.getItem(storageKey);
  }

  const connect = () => {
    if (closed) return;
    if (!navigator.onLine) {
      handlers.setLiveConnection("offline");
      return;
    }
    const nextState = handlers.getLiveEventState();
    if (!nextState || nextState.sessionId !== streamSessionId) return;
    handlers.setLiveConnection(openingSessionEventConnectionState(handlers.getLiveConnection()));
    const url = new URL("/api/v1/events", window.location.origin);
    if (nextState.cursor) url.searchParams.set("cursor", nextState.cursor);
    eventSource = new EventSource(url);
    eventSource.onopen = () => {
      reconnectAttempt = 0;
      handlers.setLiveConnection("live");
    };
    eventSource.addEventListener("spark-cockpit.event", (message) => {
      const event = parseSessionSerializedEvent((message as MessageEvent<string>).data);
      const liveState = handlers.getLiveEventState();
      if (!event || !liveState || liveState.sessionId !== streamSessionId) return;
      const result = applySessionLiveEvent(liveState, event);
      if (storageKey && liveState.cursor) {
        window.sessionStorage.setItem(storageKey, liveState.cursor);
      }
      if (result.changed) {
        handlers.onViewChanged(liveState.view);
      }
      if (result.refreshActivity) handlers.onRefreshActivity();
    });
    eventSource.onerror = () => {
      eventSource?.close();
      eventSource = null;
      handlers.setLiveConnection(navigator.onLine ? "reconnecting" : "offline");
      if (!closed && navigator.onLine && !reconnectTimer) {
        const delay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      }
    };
  };

  const handleOnline = () => {
    if (closed || eventSource) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connect();
  };
  const handleOffline = () => {
    handlers.setLiveConnection("offline");
    eventSource?.close();
    eventSource = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  connect();
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);

  return () => {
    closed = true;
    eventSource?.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
  };
}

export type SessionStatusProbeHandlers = {
  getLiveEventState: () => SessionLiveEventState | null;
  onConverged: (state: SessionLiveEventState) => void;
  invalidateAll: () => Promise<void>;
  convergeFromRegistryStatus: (state: SessionLiveEventState, status: string) => boolean;
};

/**
 * While a turn looks active, probe the lightweight registry status so a dropped
 * terminal projection cannot leave the UI stuck in "running".
 */
export function attachSessionStatusProbe(
  sessionId: string,
  handlers: SessionStatusProbeHandlers,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;

  const schedule = (delay = 3_000) => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void probeStatus();
    }, delay);
  };

  const probeStatus = async () => {
    if (stopped || refreshing) return;
    if (document.visibilityState === "hidden") {
      schedule();
      return;
    }
    refreshing = true;
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/status`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const result = (await response.json()) as { sessionId?: unknown; status?: unknown };
      if (
        result.sessionId === sessionId &&
        typeof result.status === "string" &&
        result.status !== "running"
      ) {
        const state = handlers.getLiveEventState();
        if (
          state &&
          state.sessionId === sessionId &&
          handlers.convergeFromRegistryStatus(state, result.status)
        ) {
          handlers.onConverged(state);
        }
        await handlers.invalidateAll();
      }
    } finally {
      refreshing = false;
      schedule();
    }
  };

  schedule(1_500);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
