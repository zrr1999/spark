import type { LoadEarlierOutcome } from "$lib/components/conversation/types";
import {
  hydrateSessionConversationWindow,
  mergeEarlierSessionSnapshotWindow,
  parseSessionSnapshotWindow,
  SESSION_SNAPSHOT_PAGE_SIZE,
  type SessionSnapshotHistory,
  type SessionSnapshotWindow,
} from "$lib/session-snapshot-window";
import type { SparkSessionView } from "@zendev-lab/spark-protocol";
import { SESSION_TIMELINE_PAGE_SIZE } from "$lib/session-timeline";

export type TimelineHistoryLoadInput = {
  sessionId: string;
  selectedSessionId: string | null;
  history: SessionSnapshotHistory;
  initialSnapshot: SparkSessionView;
  minimumAnchors: number;
  getCurrentWindow: () => SessionSnapshotWindow | null;
};

export type TimelineHistoryLoadResult = {
  outcome: LoadEarlierOutcome;
  window?: SessionSnapshotWindow;
  timelineRenderLimitDelta?: number;
};

type LatestTimelineCacheEntry = {
  storedAt: number;
  window: SessionSnapshotWindow;
};

const latestTimelineCacheTtlMs = 15_000;
const latestTimelineCacheCapacity = 8;
const latestTimelineCache = new Map<string, LatestTimelineCacheEntry>();
const latestTimelineRequests = new Map<string, Promise<SessionSnapshotWindow | null>>();

export type LatestSessionTimelineOptions = {
  /**
   * A server-projected revision fence. Cached snapshots are reusable only when
   * they are at least this recent; callers without a fence always revalidate.
   */
  minimumUpdatedAt?: string | null;
};

/** Refresh the canonical transcript tail after the projected first paint. */
export async function loadLatestSessionTimeline(
  sessionId: string,
  options: LatestSessionTimelineOptions = {},
): Promise<SessionSnapshotWindow | null> {
  const cached = readLatestTimelineCache(sessionId, options.minimumUpdatedAt);
  if (cached) return cached;

  const pending = latestTimelineRequests.get(sessionId);
  if (pending) {
    const window = await pending;
    return timelineSatisfiesRevisionFence(window, options.minimumUpdatedAt) ? window : null;
  }

  const request = (async () => {
    const query = new URLSearchParams({ limit: String(SESSION_SNAPSHOT_PAGE_SIZE) });
    const response = await fetch(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot?${query}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const window = parseSessionSnapshotWindow(await response.json());
    if (window.snapshot.sessionId !== sessionId || window.history.laterMessages !== 0) return null;
    writeLatestTimelineCache(sessionId, window);
    return window;
  })()
    .catch(() => null)
    .finally(() => {
      latestTimelineRequests.delete(sessionId);
    });
  latestTimelineRequests.set(sessionId, request);
  const window = await request;
  return timelineSatisfiesRevisionFence(window, options.minimumUpdatedAt) ? window : null;
}

export function invalidateLatestSessionTimelineCache(sessionId: string): void {
  latestTimelineCache.delete(sessionId);
}

export function clearLatestSessionTimelineCache(): void {
  latestTimelineCache.clear();
  latestTimelineRequests.clear();
}

/**
 * Fetch older snapshot pages until the conversation window has enough anchors.
 * Pure of Svelte state: callers supply getters and apply the returned window.
 */
export async function loadEarlierSessionTimeline(
  input: TimelineHistoryLoadInput,
): Promise<TimelineHistoryLoadResult> {
  const { sessionId, history, initialSnapshot, minimumAnchors } = input;
  if (!history.hasEarlierMessages) {
    return { outcome: "exhausted" };
  }
  const beforeMessageId = history.nextBeforeMessageId;
  if (!beforeMessageId) {
    return { outcome: "error" };
  }

  try {
    const initialWindow: SessionSnapshotWindow = {
      snapshot: initialSnapshot,
      history,
    };
    const loadedPages: SessionSnapshotWindow[] = [];
    await hydrateSessionConversationWindow(initialWindow, {
      minimumAnchors,
      loadEarlier: async (cursor) => {
        const query = new URLSearchParams({
          limit: String(SESSION_SNAPSHOT_PAGE_SIZE),
          before: cursor,
        });
        const response = await fetch(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot?${query}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          throw new Error(`session history request failed: ${response.status}`);
        }
        const earlierPage = parseSessionSnapshotWindow(await response.json());
        if (earlierPage.snapshot.sessionId !== sessionId || input.selectedSessionId !== sessionId) {
          throw new Error("session changed while loading history");
        }
        loadedPages.push(earlierPage);
        return earlierPage;
      },
    });

    const current = input.getCurrentWindow();
    if (!current || input.selectedSessionId !== sessionId) {
      return { outcome: "busy" };
    }
    if (current.history.nextBeforeMessageId !== beforeMessageId) {
      return { outcome: "busy" };
    }
    if (loadedPages.length === 0) {
      return {
        outcome: current.history.hasEarlierMessages ? "busy" : "exhausted",
      };
    }
    let window: SessionSnapshotWindow = current;
    for (const earlierPage of loadedPages) {
      window = mergeEarlierSessionSnapshotWindow(window, earlierPage);
    }
    return {
      outcome: "loaded",
      window,
      timelineRenderLimitDelta: SESSION_TIMELINE_PAGE_SIZE,
    };
  } catch {
    return {
      outcome: input.selectedSessionId === sessionId ? "error" : "busy",
    };
  }
}

export function bumpTimelineRenderLimit(current: number): number {
  return current + SESSION_TIMELINE_PAGE_SIZE;
}

function readLatestTimelineCache(
  sessionId: string,
  minimumUpdatedAt: string | null | undefined,
): SessionSnapshotWindow | null {
  if (!minimumUpdatedAt) return null;
  const entry = latestTimelineCache.get(sessionId);
  if (!entry) return null;
  if (
    Date.now() - entry.storedAt > latestTimelineCacheTtlMs ||
    !timelineSatisfiesRevisionFence(entry.window, minimumUpdatedAt)
  ) {
    latestTimelineCache.delete(sessionId);
    return null;
  }
  latestTimelineCache.delete(sessionId);
  latestTimelineCache.set(sessionId, entry);
  return entry.window;
}

function timelineSatisfiesRevisionFence(
  window: SessionSnapshotWindow | null,
  minimumUpdatedAt: string | null | undefined,
): window is SessionSnapshotWindow {
  if (!window) return false;
  if (!minimumUpdatedAt) return true;
  return Boolean(window.snapshot.updatedAt && window.snapshot.updatedAt >= minimumUpdatedAt);
}

function writeLatestTimelineCache(sessionId: string, window: SessionSnapshotWindow): void {
  latestTimelineCache.delete(sessionId);
  latestTimelineCache.set(sessionId, { storedAt: Date.now(), window });
  while (latestTimelineCache.size > latestTimelineCacheCapacity) {
    const oldestKey = latestTimelineCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    latestTimelineCache.delete(oldestKey);
  }
}
