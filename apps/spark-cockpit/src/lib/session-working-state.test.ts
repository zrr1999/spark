import { parseSparkSessionView } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import {
  applySessionLiveEvent,
  createSessionLiveEventState,
  registerQueuedSessionTurn,
} from "./session-live-events";
import { sessionIsWorking } from "./session-working-state";

describe("session working state", () => {
  it("does not present an admitted turn as running before the daemon starts it", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      workspaceId: "ws_spore",
      view: parseSparkSessionView({ sessionId: "sess_current", status: "idle" }),
    });

    expect(
      sessionIsWorking({
        registryStatus: "idle",
        liveStatus: state.view?.status,
      }),
    ).toBe(false);

    registerQueuedSessionTurn(state, "inv_active", "2026-07-17T03:00:00.000Z");
    expect(
      sessionIsWorking({
        registryStatus: "idle",
        liveStatus: state.view?.status,
      }),
    ).toBe(false);
    expect(state.activeTurnId).toBeNull();
    expect(state.view?.status).toBe("idle");

    const terminal = applySessionLiveEvent(state, {
      id: "evt_terminal",
      sequence: null,
      workspaceId: "ws_spore",
      projectId: null,
      kind: "invocation.updated",
      subjectId: "inv_active",
      payload: {
        runtimeInvocationId: "inv_active",
        status: "failed",
        terminalReason: "Provider request failed",
      },
      createdAt: "2026-07-17T03:00:03.000Z",
    });

    expect(terminal).toEqual({ changed: false, refreshActivity: true });
    expect(state.activeTurnId).toBeNull();
    expect(state.view?.status).toBe("idle");
    expect(
      sessionIsWorking({
        // The server-rendered registry row can remain stale until invalidateAll
        // completes; the live daemon view remains authoritative.
        registryStatus: "running",
        liveStatus: state.view?.status,
      }),
    ).toBe(false);
  });

  it("shows running only from daemon status truth", () => {
    expect(sessionIsWorking({ registryStatus: "running" })).toBe(true);
    expect(sessionIsWorking({ registryStatus: "idle", liveStatus: "running" })).toBe(true);
    expect(sessionIsWorking({ registryStatus: "running", liveStatus: "idle" })).toBe(false);
  });
});
