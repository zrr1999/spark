import { describe, expect, it } from "vitest";
import {
  applySessionLiveEvent,
  beginSessionActivityRefresh,
  canStartSessionActivityRefresh,
  createSessionActivityRefreshState,
  createSessionLiveEventState,
  finishSessionActivityRefresh,
  parseSessionSerializedEvent,
  requestSessionActivityRefresh,
  sessionEventCursorStorageKey,
  sessionViewRevisionKey,
  type SessionSerializedEvent,
} from "./session-live-events";
import { parseSparkSessionView } from "@zendev-lab/spark-protocol";

const baseEvent = {
  workspaceId: "ws_spore",
  projectId: null,
  subjectId: "sess_current",
  createdAt: "2026-07-13T08:00:00.000Z",
};

function event(
  input: Partial<SessionSerializedEvent> & Pick<SessionSerializedEvent, "id" | "kind">,
) {
  return { ...baseEvent, payload: {}, ...input } as SessionSerializedEvent;
}

describe("session live events", () => {
  it("applies a post-commit session title event and requests a sidebar refresh", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      workspaceId: "ws_spore",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        title: "New conversation",
        status: "idle",
      }),
    });

    const result = applySessionLiveEvent(
      state,
      event({
        id: "evt_session_title",
        kind: "daemon.session.updated",
        payload: {
          type: "daemon.session.updated",
          source: "daemon",
          sessionId: "sess_current",
          title: "Diagnose daemon startup",
          emittedAt: "2026-07-13T08:00:01.000Z",
        },
      }),
    );

    expect(result).toEqual({ changed: true, refreshActivity: true });
    expect(state.view).toMatchObject({
      title: "Diagnose daemon startup",
      updatedAt: "2026-07-13T08:00:01.000Z",
    });
  });

  it("reduces selected-session messages and structured work without a reload", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      workspaceId: "ws_spore",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "idle",
        messages: [],
      }),
    });
    const message = applySessionLiveEvent(
      state,
      event({
        id: "evt_message",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "session.message",
            sessionId: "sess_current",
            message: { id: "msg_1", role: "assistant", text: "Working", status: "streaming" },
          },
        },
      }),
    );
    const task = applySessionLiveEvent(
      state,
      event({
        id: "evt_task",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "task.update",
            task: { ref: "task:1", title: "Inspect UI", status: "running" },
          },
        },
      }),
    );
    const artifact = applySessionLiveEvent(
      state,
      event({
        id: "evt_artifact",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "artifact.update",
            artifact: {
              ref: "artifact:1",
              title: "UI diff",
              kind: "document",
              format: "markdown",
            },
          },
        },
      }),
    );

    expect(message).toEqual({ changed: true, refreshActivity: false });
    expect(task.changed).toBe(true);
    expect(artifact.changed).toBe(true);
    expect(state.view).toMatchObject({
      status: "running",
      messages: [{ id: "msg_1", text: "Working" }],
      tasks: [{ ref: "task:1", title: "Inspect UI" }],
      artifacts: [{ ref: "artifact:1", title: "UI diff" }],
    });
    expect(state.cursor).toBe("2026-07-13T08:00:00.000Z|evt_artifact");
  });

  it("reconciles streaming messages by canonical id and ignores other sessions", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });
    for (const [id, text, status] of [
      ["evt_1", "Hel", "streaming"],
      ["evt_2", "Hello", "done"],
    ] as const) {
      applySessionLiveEvent(
        state,
        event({
          id,
          kind: "daemon.view_event",
          payload: {
            type: "daemon.view_event",
            sessionId: "sess_current",
            view: {
              type: "session.message",
              sessionId: "sess_current",
              message: { id: "msg_same", role: "assistant", text, status },
            },
          },
        }),
      );
    }
    const ignored = applySessionLiveEvent(
      state,
      event({
        id: "evt_other",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_other",
          view: {
            type: "session.message",
            sessionId: "sess_other",
            message: { id: "msg_other", role: "assistant", text: "No" },
          },
        },
      }),
    );

    expect(state.view?.messages).toHaveLength(1);
    expect(state.view?.messages[0]).toMatchObject({
      id: "msg_same",
      text: "Hello",
      status: "done",
    });
    expect(ignored).toEqual({ changed: false, refreshActivity: false });
  });

  it("keeps the daemon-projected mailbox across native session snapshots", () => {
    const mailbox = [
      {
        id: "mail:1",
        fromSessionId: "sess_sender",
        kind: "request" as const,
        intent: "review.request",
        subject: null,
        body: "Review the patch",
        createdAt: "2026-07-13T08:00:00.000Z",
        readAt: null,
        ackedAt: null,
      },
    ];
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({ sessionId: "sess_current", mailbox }),
    });

    applySessionLiveEvent(
      state,
      event({
        id: "evt_snapshot",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "session.snapshot",
            session: parseSparkSessionView({
              sessionId: "sess_current",
              messages: [{ id: "msg_1", role: "assistant", text: "Done" }],
            }),
          },
        },
      }),
    );

    expect(state.view?.mailbox).toEqual(mailbox);
    expect(state.view?.messages).toMatchObject([{ id: "msg_1", text: "Done" }]);
  });

  it("tracks only command and invocation activity belonging to the conversation", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      workspaceId: "ws_spore",
    });
    expect(
      applySessionLiveEvent(
        state,
        event({
          id: "evt_command",
          kind: "command.queued",
          subjectId: "cmd_1",
          payload: {
            command: {
              id: "cmd_1",
              payload: { payload: { target: { sessionId: "sess_current" } } },
            },
          },
        }),
      ).refreshActivity,
    ).toBe(true);
    expect(
      applySessionLiveEvent(
        state,
        event({
          id: "evt_invocation",
          kind: "invocation.updated",
          subjectId: "inv_1",
          payload: { commandId: "cmd_1", runtimeInvocationId: "inv_1" },
        }),
      ).refreshActivity,
    ).toBe(true);
    expect(
      applySessionLiveEvent(
        state,
        event({
          id: "evt_log",
          kind: "invocation.log_chunk",
          subjectId: "inv_1",
          payload: { runtimeInvocationId: "inv_1", content: "working" },
        }),
      ).refreshActivity,
    ).toBe(true);
    expect(
      applySessionLiveEvent(
        state,
        event({
          id: "evt_other_command",
          kind: "command.acked",
          subjectId: "cmd_other",
        }),
      ).refreshActivity,
    ).toBe(false);
  });

  it("deduplicates replayed cursor events", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });
    const lifecycle = event({
      id: "evt_lifecycle",
      kind: "daemon.task.lifecycle",
      payload: {
        type: "daemon.task.lifecycle",
        sessionId: "sess_current",
        taskType: "session.run",
        status: "running",
      },
    });
    expect(applySessionLiveEvent(state, lifecycle).refreshActivity).toBe(true);
    expect(applySessionLiveEvent(state, lifecycle)).toEqual({
      changed: false,
      refreshActivity: false,
    });
  });

  it("bounds replay deduplication state on a long-lived global stream", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });
    for (let index = 0; index < 700; index += 1) {
      applySessionLiveEvent(
        state,
        event({
          id: `evt_unrelated_${index}`,
          kind: "command.acked",
          subjectId: `cmd_unrelated_${index}`,
        }),
      );
    }

    expect(state.processedEventIds.size).toBe(512);
    expect(state.processedEventIds.has("evt_unrelated_0")).toBe(false);
    expect(state.processedEventIds.has("evt_unrelated_699")).toBe(true);
  });

  it("tracks the durable invocation id across lifecycle events", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "running",
        messages: [
          {
            id: "invocation:inv_1",
            role: "user",
            text: "Inspect the UI",
            status: "done",
            metadata: { source: "daemon.invocation", invocationId: "inv_1" },
          },
        ],
      }),
    });
    expect(state.activeTurnId).toBe("inv_1");

    applySessionLiveEvent(
      state,
      event({
        id: "evt_running",
        kind: "daemon.task.lifecycle",
        payload: {
          type: "daemon.task.lifecycle",
          sessionId: "sess_current",
          taskType: "session.run",
          invocationId: "inv_1",
          status: "running",
        },
      }),
    );
    expect(state.activeTurnId).toBe("inv_1");

    applySessionLiveEvent(
      state,
      event({
        id: "evt_done",
        kind: "daemon.task.lifecycle",
        payload: {
          type: "daemon.task.lifecycle",
          sessionId: "sess_current",
          taskType: "session.run",
          invocationId: "inv_1",
          status: "succeeded",
        },
      }),
    );
    expect(state.activeTurnId).toBeNull();
  });

  it("does not treat arbitrary message metadata as a cancellable daemon turn", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "running",
        messages: [
          {
            id: "msg_pending",
            role: "user",
            text: "Not a daemon invocation projection",
            status: "pending",
            metadata: { invocationId: "inv_spoofed" },
          },
        ],
      }),
    });

    expect(state.activeTurnId).toBeNull();
  });

  it("parses serialized events defensively and keys server snapshots", () => {
    expect(
      parseSessionSerializedEvent(
        JSON.stringify({
          id: "evt_1",
          workspaceId: null,
          projectId: null,
          kind: "daemon.view_event",
          subjectId: "sess_current",
          payload: {},
          createdAt: "2026-07-13T08:00:00.000Z",
        }),
      ),
    ).toMatchObject({ id: "evt_1", kind: "daemon.view_event" });
    expect(parseSessionSerializedEvent("not json")).toBeNull();
    expect(parseSessionSerializedEvent(JSON.stringify({ id: "evt_1" }))).toBeNull();

    const view = parseSparkSessionView({
      sessionId: "sess_current",
      status: "idle",
      messages: [{ id: "msg_1", role: "assistant", text: "Done", status: "done" }],
    });
    expect(sessionViewRevisionKey(view)).toContain("msg_1:done:Done");
    expect(sessionViewRevisionKey(null)).toBe("none");
  });

  it("keeps event cursors isolated by selected session", () => {
    expect(sessionEventCursorStorageKey(" sess_a ")).toBe(
      "spark-cockpit:session:sess_a:events-cursor",
    );
    expect(sessionEventCursorStorageKey("sess_b")).toBe(
      "spark-cockpit:session:sess_b:events-cursor",
    );
    expect(sessionEventCursorStorageKey("   ")).toBeNull();
  });

  it("retains a hidden activity refresh until the page can refresh", () => {
    const state = createSessionActivityRefreshState();
    requestSessionActivityRefresh(state);

    expect(beginSessionActivityRefresh(state, false)).toBe(false);
    expect(state).toEqual({ pending: true, refreshing: false });
    expect(beginSessionActivityRefresh(state, true)).toBe(true);
    expect(state).toEqual({ pending: false, refreshing: true });

    finishSessionActivityRefresh(state);
    expect(state).toEqual({ pending: false, refreshing: false });
  });

  it("coalesces activity received during an in-flight refresh", () => {
    const state = createSessionActivityRefreshState();
    requestSessionActivityRefresh(state);
    expect(beginSessionActivityRefresh(state, true)).toBe(true);

    requestSessionActivityRefresh(state);
    expect(canStartSessionActivityRefresh(state, true)).toBe(false);
    expect(beginSessionActivityRefresh(state, true)).toBe(false);
    expect(state).toEqual({ pending: true, refreshing: true });

    finishSessionActivityRefresh(state);
    expect(canStartSessionActivityRefresh(state, true)).toBe(true);
    expect(beginSessionActivityRefresh(state, true)).toBe(true);
  });
});
