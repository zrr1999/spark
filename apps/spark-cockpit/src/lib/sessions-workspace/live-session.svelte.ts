import { untrack } from "svelte";
import {
  createSessionLiveEventState,
  reconcileSessionLiveEventState,
  shouldAdoptSessionHistory,
  sessionViewRevisionKey,
  convergeSessionLiveEventStateFromRegistryStatus,
  type SessionLiveEventState,
} from "$lib/session-live-events";
import {
  initialSessionEventConnectionState,
  type SessionEventConnectionState,
} from "$lib/session-event-connection";
import {
  sessionActivityNeedsStatusProbe,
  type SessionActivityState,
} from "$lib/session-activity-state";
import type { SessionSnapshotHistory } from "$lib/session-snapshot-window";
import type { SparkSessionView } from "@zendev-lab/spark-protocol";
import { attachSessionLiveEventSource, attachSessionStatusProbe } from "./live-connection";
import { resetDequeueUiOnSessionChange, type DequeueTurnUiState } from "./cancel-dequeue";
import { invalidateLatestSessionTimelineCache, loadLatestSessionTimeline } from "./timeline-window";

export type LiveSessionSources = {
  getSelectedSessionId: () => string | null | undefined;
  getSelectedWorkspaceId: () => string | null;
  getSessionView: () => SparkSessionView | null | undefined;
  getSessionHistory: () => SessionSnapshotHistory | null | undefined;
  getInitialEventCursor: () => string | null | undefined;
  getActivityCommandIds: () => string[];
  getActivityInvocationIds: () => string[];
  getSessionActivityState: () => SessionActivityState;
  invalidateAll: () => Promise<void>;
  onRefreshActivity: () => void;
  onDequeueReset: (next: DequeueTurnUiState) => void;
};

export function createLiveSessionController(sources: LiveSessionSources) {
  let liveSessionView = $state<SparkSessionView | null>(
    untrack(() => sources.getSessionView() ?? null),
  );
  let liveSessionHistory = $state<SessionSnapshotHistory | null>(
    untrack(() => sources.getSessionHistory() ?? null),
  );
  let liveEventState = $state<SessionLiveEventState | null>(null);
  let liveSessionId = $state("");
  let lastServerViewKey = $state("");
  let liveConnection = $state<SessionEventConnectionState>(
    untrack(() => initialSessionEventConnectionState(sources.getSelectedSessionId())),
  );

  $effect(() => {
    const sessionId = sources.getSelectedSessionId() ?? "";
    const sessionView = sources.getSessionView() ?? null;
    const sessionHistory = sources.getSessionHistory() ?? null;
    const selectedWorkspaceId = sources.getSelectedWorkspaceId();
    const activityCommands = sources.getActivityCommandIds();
    const activityInvocations = sources.getActivityInvocationIds();
    const initialEventCursor = sources.getInitialEventCursor() ?? null;

    if (!sessionId) {
      liveSessionId = "";
      liveEventState = null;
      liveSessionView = null;
      lastServerViewKey = "";
      return;
    }

    const nextServerViewKey = sessionViewRevisionKey(sessionView);
    if (sessionId !== liveSessionId) {
      sources.onDequeueReset(resetDequeueUiOnSessionChange());
      liveSessionId = sessionId;
      lastServerViewKey = nextServerViewKey;
      liveEventState = createSessionLiveEventState({
        sessionId,
        workspaceId: selectedWorkspaceId,
        view: sessionView,
        commandIds: activityCommands,
        invocationIds: activityInvocations,
        cursor: initialEventCursor,
      });
      liveSessionView = liveEventState.view;
      liveSessionHistory = sessionHistory;
      void refreshLatestWindow(sessionId);
      return;
    }

    const currentHistory = untrack(() => liveSessionHistory);
    const preserveCurrentHistory = Boolean(
      currentHistory &&
      sessionHistory &&
      currentHistory.loadedMessages > sessionHistory.loadedMessages,
    );
    if (nextServerViewKey !== lastServerViewKey) {
      lastServerViewKey = nextServerViewKey;
      const state = untrack(() => liveEventState);
      if (
        state &&
        reconcileSessionLiveEventState(state, {
          workspaceId: selectedWorkspaceId,
          view: sessionView,
          commandIds: activityCommands,
          invocationIds: activityInvocations,
          preserveCurrentHistory,
        })
      ) {
        liveSessionView = state.view;
      }
    }
    if (shouldAdoptSessionHistory(currentHistory, sessionHistory)) {
      liveSessionHistory = sessionHistory;
    }

    for (const commandId of activityCommands) {
      liveEventState?.commandIds.add(commandId);
    }
    for (const invocationId of activityInvocations) {
      liveEventState?.invocationIds.add(invocationId);
    }
  });

  async function refreshLatestWindow(sessionId: string): Promise<void> {
    const window = await loadLatestSessionTimeline(sessionId, {
      minimumUpdatedAt: untrack(() => liveSessionView?.updatedAt),
    });
    if (!window || untrack(() => liveSessionId) !== sessionId) return;
    const state = untrack(() => liveEventState);
    if (!state || state.sessionId !== sessionId) return;
    if (
      reconcileSessionLiveEventState(state, {
        workspaceId: sources.getSelectedWorkspaceId(),
        view: window.snapshot,
        preserveCurrentHistory: true,
      })
    ) {
      liveSessionView = state.view;
    }
    const currentHistory = untrack(() => liveSessionHistory);
    if (shouldAdoptSessionHistory(currentHistory, window.history)) {
      liveSessionHistory = window.history;
    }
  }

  $effect(() => {
    const streamSessionId = liveSessionId;
    const streamState = liveEventState;
    if (!streamSessionId || !streamState || streamState.sessionId !== streamSessionId) {
      liveConnection = "offline";
      return;
    }

    return attachSessionLiveEventSource(streamSessionId, {
      getLiveEventState: () => untrack(() => liveEventState),
      setLiveConnection: (next) => {
        liveConnection = next;
      },
      getLiveConnection: () => untrack(() => liveConnection),
      onViewChanged: (view) => {
        invalidateLatestSessionTimelineCache(streamSessionId);
        liveSessionView = view;
      },
      onRefreshActivity: () => sources.onRefreshActivity(),
    });
  });

  $effect(() => {
    const sessionId = liveSessionId;
    const watchTerminalState = sessionActivityNeedsStatusProbe(sources.getSessionActivityState());
    if (!sessionId || !watchTerminalState) return;

    return attachSessionStatusProbe(sessionId, {
      getLiveEventState: () => untrack(() => liveEventState),
      convergeFromRegistryStatus: convergeSessionLiveEventStateFromRegistryStatus,
      onConverged: (state) => {
        liveEventState = state;
        liveSessionView = state.view;
      },
      invalidateAll: sources.invalidateAll,
    });
  });

  return {
    get liveSessionView() {
      return liveSessionView;
    },
    set liveSessionView(value: SparkSessionView | null) {
      liveSessionView = value;
    },
    get liveSessionHistory() {
      return liveSessionHistory;
    },
    set liveSessionHistory(value: SessionSnapshotHistory | null) {
      liveSessionHistory = value;
    },
    get liveEventState() {
      return liveEventState;
    },
    set liveEventState(value: SessionLiveEventState | null) {
      liveEventState = value;
    },
    get liveSessionId() {
      return liveSessionId;
    },
    get liveConnection() {
      return liveConnection;
    },
  };
}

export type LiveSessionController = ReturnType<typeof createLiveSessionController>;
