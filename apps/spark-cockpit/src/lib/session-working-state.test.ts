import { parseSparkSessionView } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import {
  applySessionLiveEvent,
  createSessionLiveEventState,
  registerQueuedSessionTurn,
} from "./session-live-events";
import { sessionIsWorking } from "./session-working-state";

describe("session working state", () => {
  it("follows a turn from its queue receipt through a terminal event without waiting for registry refresh", () => {
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
    ).toBe(true);

    const terminal = applySessionLiveEvent(state, {
      id: "evt_terminal",
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

    expect(terminal.changed).toBe(true);
    expect(state.view?.status).toBe("idle");
    expect(
      sessionIsWorking({
        // The server-rendered registry row can remain stale until invalidateAll
        // completes; the terminal live view must hide the indicator immediately.
        registryStatus: "running",
        liveStatus: state.view?.status,
      }),
    ).toBe(false);
  });
});
