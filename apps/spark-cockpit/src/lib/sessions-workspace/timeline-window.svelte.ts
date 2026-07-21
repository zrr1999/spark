import { untrack } from "svelte";
import type { LoadEarlierOutcome } from "$lib/components/conversation/types";
import {
  SESSION_CONVERSATION_ANCHOR_BATCH,
  sessionConversationAnchorCount,
  type SessionSnapshotHistory,
  type SessionSnapshotWindow,
} from "$lib/session-snapshot-window";
import { SESSION_TIMELINE_PAGE_SIZE } from "$lib/session-timeline";
import type { SparkSessionView } from "@zendev-lab/spark-protocol";
import type { SessionLiveEventState } from "$lib/session-live-events";
import { bumpTimelineRenderLimit, loadEarlierSessionTimeline } from "./timeline-window";

export type TimelineWindowSources = {
  getSelectedSessionId: () => string | null;
  getLiveSessionId: () => string;
  getLiveSessionView: () => SparkSessionView | null;
  getLiveSessionHistory: () => SessionSnapshotHistory | null;
  setLiveSessionView: (view: SparkSessionView | null) => void;
  setLiveSessionHistory: (history: SessionSnapshotHistory | null) => void;
  getLiveEventState: () => SessionLiveEventState | null;
};

export function createTimelineWindowController(sources: TimelineWindowSources) {
  let historyLoadState = $state<"idle" | "loading">("idle");
  let timelineRenderLimit = $state(SESSION_TIMELINE_PAGE_SIZE);
  let timelineRenderSessionId = $state("");
  let automaticHistorySessionId = $state("");

  let effectiveTimelineRenderLimit = $derived(
    sources.getSelectedSessionId() === timelineRenderSessionId
      ? timelineRenderLimit
      : SESSION_TIMELINE_PAGE_SIZE,
  );

  $effect(() => {
    const nextSessionId = sources.getSelectedSessionId() ?? "";
    if (nextSessionId === timelineRenderSessionId) return;
    timelineRenderSessionId = nextSessionId;
    timelineRenderLimit = SESSION_TIMELINE_PAGE_SIZE;
    historyLoadState = "idle";
  });

  $effect(() => {
    const sessionId = sources.getSelectedSessionId();
    const snapshot = sources.getLiveSessionView();
    const history = sources.getLiveSessionHistory();
    if (
      !sessionId ||
      sessionId !== sources.getLiveSessionId() ||
      !snapshot ||
      !history ||
      automaticHistorySessionId === sessionId
    ) {
      return;
    }

    const window: SessionSnapshotWindow = { snapshot, history };
    automaticHistorySessionId = sessionId;
    if (
      history.hasEarlierMessages &&
      sessionConversationAnchorCount(window) < SESSION_CONVERSATION_ANCHOR_BATCH
    ) {
      void loadEarlierTimeline(SESSION_CONVERSATION_ANCHOR_BATCH);
    }
  });

  async function showEarlierTimeline(): Promise<LoadEarlierOutcome> {
    if (historyLoadState === "loading") return "busy";
    const history = sources.getLiveSessionHistory();
    const snapshot = sources.getLiveSessionView();
    if (!history || !snapshot || !history.hasEarlierMessages) {
      timelineRenderLimit = bumpTimelineRenderLimit(timelineRenderLimit);
      historyLoadState = "idle";
      return "loaded";
    }

    const window: SessionSnapshotWindow = { snapshot, history };
    return await loadEarlierTimeline(
      sessionConversationAnchorCount(window) + SESSION_CONVERSATION_ANCHOR_BATCH,
    );
  }

  async function loadEarlierTimeline(minimumAnchors: number): Promise<LoadEarlierOutcome> {
    if (historyLoadState === "loading") return "busy";
    const sessionId = sources.getSelectedSessionId();
    const history = sources.getLiveSessionHistory();
    const initialSnapshot = sources.getLiveSessionView();
    if (!sessionId || !history || !initialSnapshot || !history.hasEarlierMessages) {
      return "exhausted";
    }

    historyLoadState = "loading";
    const result = await loadEarlierSessionTimeline({
      sessionId,
      selectedSessionId: sources.getSelectedSessionId(),
      history,
      initialSnapshot,
      minimumAnchors,
      getCurrentWindow: () => {
        const currentSnapshot = untrack(() => sources.getLiveSessionView());
        const currentHistory = untrack(() => sources.getLiveSessionHistory());
        if (!currentSnapshot || !currentHistory) return null;
        return { snapshot: currentSnapshot, history: currentHistory };
      },
    });

    if (result.outcome === "loaded" && result.window) {
      sources.setLiveSessionView(result.window.snapshot);
      const liveEventState = sources.getLiveEventState();
      if (liveEventState?.sessionId === sessionId) {
        liveEventState.view = result.window.snapshot;
      }
      sources.setLiveSessionHistory(result.window.history);
      if (result.timelineRenderLimitDelta) {
        timelineRenderLimit += result.timelineRenderLimitDelta;
      }
    }
    historyLoadState = "idle";
    return result.outcome;
  }

  return {
    get historyLoadState() {
      return historyLoadState;
    },
    set historyLoadState(value: "idle" | "loading") {
      historyLoadState = value;
    },
    get timelineRenderLimit() {
      return timelineRenderLimit;
    },
    get effectiveTimelineRenderLimit() {
      return effectiveTimelineRenderLimit;
    },
    showEarlierTimeline,
    loadEarlierTimeline,
  };
}

export type TimelineWindowController = ReturnType<typeof createTimelineWindowController>;
