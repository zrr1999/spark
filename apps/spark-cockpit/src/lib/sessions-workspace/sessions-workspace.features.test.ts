import { describe, expect, it, vi } from "vitest";
import {
  applyCancelSubmitResult,
  applyDequeueSubmitResult,
  beginCancelSubmit,
  beginDequeueSubmit,
  resetCancelUiForActiveTurn,
  resetDequeueUiOnSessionChange,
} from "./cancel-dequeue";
import { connectionLabel, modelValue, queueRemoveFormId } from "./presentation";
import { resultMessage, resultModel, invocationStatusFromActionResult } from "./form-results";
import { slashActionAvailability, type SlashAvailabilityContext } from "./slash-availability";
import {
  bumpTimelineRenderLimit,
  clearLatestSessionTimelineCache,
  loadLatestSessionTimeline,
} from "./timeline-window";
import { adoptQueuedTurnIntoLiveState, adoptCancelledTurnIntoLiveState } from "./turn-adoption";
import { createSessionLiveEventState } from "$lib/session-live-events";
import { SESSION_TIMELINE_PAGE_SIZE } from "$lib/session-timeline";
import { parseSparkSessionView, type SparkActionView } from "@zendev-lab/spark-protocol";

const reasons = {
  ownerOffline: "owner offline",
  noModel: "no model",
  modelUpdating: "model updating",
  thinkingUpdating: "thinking updating",
  sessionRequired: "session required",
  noSessions: "no sessions",
  workspaceRequired: "workspace required",
  queueEmpty: "queue empty",
  noActiveTurn: "no active turn",
  retryUnavailable: "retry unavailable",
  retryInProgress: "retry in progress",
  hotkeysUnavailable: "hotkeys unavailable",
  daemonExecutorUnavailable: "daemon unavailable",
} as const;

function baseSlashCtx(overrides: Partial<SlashAvailabilityContext> = {}): SlashAvailabilityContext {
  return {
    surface: "session",
    hasSelectedSession: true,
    canAssign: true,
    sessionsCount: 2,
    hasActiveWorkspace: true,
    modelProvidersCount: 1,
    modelState: "idle",
    thinkingState: "idle",
    queueItemCount: 0,
    conversationBusy: false,
    hasActiveTurn: false,
    cancelState: "idle",
    hasRetryPrompt: false,
    modelReady: true,
    retryState: "idle",
    reasons,
    ...overrides,
  };
}

function action(intent: SparkActionView["intent"]): SparkActionView {
  return {
    id: intent,
    intent,
    label: intent,
    payload: {},
  };
}

function emptyView(sessionId: string) {
  return parseSparkSessionView({
    sessionId,
    status: "idle",
    updatedAt: "2026-07-21T00:00:00.000Z",
    messages: [],
  });
}

describe("sessions-workspace feature safety net", () => {
  it("renders connection labels for the stage header (list/selection chrome)", () => {
    const copy = {
      live: "Connected",
      connecting: "Connecting",
      reconnecting: "Reconnecting",
      offline: "Offline",
    };
    expect(connectionLabel("live", copy)).toBe("Connected");
    expect(connectionLabel("offline", copy)).toBe("Offline");
    expect(connectionLabel("reconnecting", copy)).toBe("Reconnecting");
    expect(modelValue({ providerName: "openai", modelId: "gpt" })).toBe("openai/gpt");
    expect(queueRemoveFormId("turn/abc 1")).toBe("queue-remove-turn-abc-1");
  });

  it("adopts a queued turn into live event state after composer submit", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_1",
      workspaceId: "ws_1",
      view: emptyView("sess_1"),
      commandIds: [],
      invocationIds: [],
      cursor: null,
    });
    const adopted = adoptQueuedTurnIntoLiveState(
      { type: "success", data: { queuedTurnId: "inv_queued" } },
      state,
      "sess_1",
    );
    expect(adopted).toBe(state);
    expect(state.invocationIds.has("inv_queued")).toBe(true);
  });

  it("converges cancel UI when the active turn changes and on submit success", () => {
    let cancel = beginCancelSubmit({
      cancelState: "idle",
      cancelFeedback: "stale",
      cancelledTurnId: null,
    });
    expect(cancel.cancelState).toBe("submitting");
    cancel = applyCancelSubmitResult(cancel, {
      resultType: "success",
      confirmedCancelledTurnId: "inv_1",
      errorMessage: "failed",
    });
    expect(cancel).toEqual({
      cancelState: "success",
      cancelledTurnId: "inv_1",
      cancelFeedback: null,
    });

    cancel = resetCancelUiForActiveTurn(
      { cancelState: "success", cancelFeedback: null, cancelledTurnId: "inv_1" },
      "inv_2",
    );
    expect(cancel.cancelState).toBe("idle");
  });

  it("converges dequeue UI on session change and submit outcomes", () => {
    let dequeue = beginDequeueSubmit(
      { dequeueState: "idle", dequeueFeedback: null, dequeuingTurnId: null },
      "inv_q",
    );
    expect(dequeue.dequeuingTurnId).toBe("inv_q");
    dequeue = applyDequeueSubmitResult(dequeue, {
      resultType: "success",
      successMessage: "removed",
      errorMessage: "failed",
    });
    expect(dequeue).toEqual({
      dequeueState: "success",
      dequeueFeedback: "removed",
      dequeuingTurnId: null,
    });
    expect(resetDequeueUiOnSessionChange()).toEqual({
      dequeueState: "idle",
      dequeueFeedback: null,
      dequeuingTurnId: null,
    });
  });

  it("settles a cancelled turn into live event state", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_1",
      workspaceId: "ws_1",
      view: parseSparkSessionView({
        sessionId: "sess_1",
        status: "running",
        updatedAt: "2026-07-21T00:00:00.000Z",
        messages: [],
        pendingTurns: [
          {
            invocationId: "inv_run",
            prompt: "hello",
            status: "running",
            createdAt: "2026-07-21T00:00:00.000Z",
          },
        ],
      }),
      commandIds: [],
      invocationIds: ["inv_run"],
      cursor: null,
    });
    expect(state.activeTurnId).toBe("inv_run");
    const settled = adoptCancelledTurnIntoLiveState(
      {
        type: "success",
        data: { cancelledTurnId: "inv_run", invocationStatus: "cancelled" },
      },
      state,
      "sess_1",
    );
    expect(settled).toBe(state);
    expect(state.activeTurnId).toBeNull();
  });

  it("gates slash turn.stop / turn.retry and parses form action results", () => {
    expect(
      slashActionAvailability(
        action("turn.stop"),
        baseSlashCtx({ conversationBusy: true, hasActiveTurn: true }),
      ).enabled,
    ).toBe(true);
    expect(slashActionAvailability(action("turn.stop"), baseSlashCtx()).enabled).toBe(false);
    expect(
      slashActionAvailability(action("turn.retry"), baseSlashCtx({ hasRetryPrompt: true })).enabled,
    ).toBe(true);

    expect(resultMessage({ data: { message: "ok" } }, "fallback")).toBe("ok");
    expect(resultModel({ data: { model: "openai/gpt" } })).toBe("openai/gpt");
    expect(invocationStatusFromActionResult({ data: { invocationStatus: "cancelled" } })).toBe(
      "cancelled",
    );
    expect(bumpTimelineRenderLimit(SESSION_TIMELINE_PAGE_SIZE)).toBe(
      SESSION_TIMELINE_PAGE_SIZE * 2,
    );
  });

  it("refreshes the canonical latest transcript window without a cursor", async () => {
    clearLatestSessionTimelineCache();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          snapshot: {
            version: 1,
            sessionId: "sess_latest",
            status: "idle",
            messages: [],
            tools: [],
            runs: [],
            tasks: [],
            artifacts: [],
            metadata: {},
          },
          history: {
            totalMessages: 0,
            loadedMessages: 0,
            hiddenMessages: 0,
            earlierMessages: 0,
            laterMessages: 0,
            hasEarlierMessages: false,
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await expect(loadLatestSessionTimeline("sess_latest")).resolves.toMatchObject({
      snapshot: { sessionId: "sess_latest" },
      history: { laterMessages: 0 },
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/v1/sessions/sess_latest/snapshot?limit=32", {
      cache: "no-store",
    });
    fetchSpy.mockRestore();
  });

  it("reuses a recent canonical snapshot behind the server revision fence", async () => {
    clearLatestSessionTimelineCache();
    const updatedAt = "2026-07-24T00:00:00.000Z";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          snapshot: {
            version: 1,
            sessionId: "sess_cached",
            status: "idle",
            updatedAt,
            messages: [],
            tools: [],
            runs: [],
            tasks: [],
            artifacts: [],
            metadata: {},
          },
          history: {
            totalMessages: 0,
            loadedMessages: 0,
            hiddenMessages: 0,
            earlierMessages: 0,
            laterMessages: 0,
            hasEarlierMessages: false,
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      loadLatestSessionTimeline("sess_cached", { minimumUpdatedAt: updatedAt }),
    ).resolves.toMatchObject({ snapshot: { sessionId: "sess_cached" } });
    await expect(
      loadLatestSessionTimeline("sess_cached", { minimumUpdatedAt: updatedAt }),
    ).resolves.toMatchObject({ snapshot: { sessionId: "sess_cached" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
    clearLatestSessionTimelineCache();
  });
});

describe("sessions-workspace live connection attach contract", () => {
  it("wires EventSource open/error and applies live events", () => {
    const listeners = new Map<string, Set<() => void>>();
    const state = createSessionLiveEventState({
      sessionId: "sess_live",
      workspaceId: "ws_1",
      view: emptyView("sess_live"),
      commandIds: [],
      invocationIds: [],
      cursor: null,
    });

    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      url: string;
      constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, handler: (message: MessageEvent<string>) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(handler as unknown as () => void);
        listeners.set(type, set);
        this._handlers = this._handlers ?? new Map();
        this._handlers.set(type, handler);
      }
      _handlers?: Map<string, (message: MessageEvent<string>) => void>;
      close = vi.fn();
      emit(type: string, data: string) {
        this._handlers?.get(type)?.({ data } as MessageEvent<string>);
      }
    }

    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    });
    vi.stubGlobal("window", {
      location: { origin: "http://localhost" },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const connections: string[] = [];
    const views: unknown[] = [];
    let refreshCount = 0;

    return import("./live-connection").then(({ attachSessionLiveEventSource }) => {
      const cleanup = attachSessionLiveEventSource("sess_live", {
        getLiveEventState: () => state,
        setLiveConnection: (value) => {
          connections.push(value);
        },
        getLiveConnection: () => "connecting",
        onViewChanged: (view) => {
          views.push(view);
        },
        onRefreshActivity: () => {
          refreshCount += 1;
        },
      });

      const source = FakeEventSource.instances.at(-1);
      expect(source).toBeTruthy();
      source?.onopen?.();
      expect(connections.at(-1)).toBe("live");

      cleanup();
      expect(source?.close).toHaveBeenCalled();
      vi.unstubAllGlobals();
      expect(refreshCount).toBe(0);
      expect(views).toEqual([]);
    });
  });
});
