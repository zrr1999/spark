import { describe, expect, it } from "vitest";
import {
  applySessionLiveEvent,
  beginSessionActivityRefresh,
  canStartSessionActivityRefresh,
  createSessionActivityRefreshState,
  createSessionLiveEventState,
  finishSessionActivityRefresh,
  parseSessionSerializedEvent,
  reconcileSessionLiveEventState,
  registerQueuedSessionTurn,
  requestSessionActivityRefresh,
  sessionEventCursorStorageKey,
  sessionViewRevisionKey,
  shouldAdoptSessionHistory,
  type SessionSerializedEvent,
} from "./session-live-events";
import { parseSparkSessionView } from "@zendev-lab/spark-protocol";

const baseEvent = {
  sequence: null,
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
      status: "idle",
      messages: [{ id: "msg_1", text: "Working" }],
      tasks: [{ ref: "task:1", title: "Inspect UI" }],
      evidence: [{ ref: "artifact:1", title: "UI diff" }],
    });
    expect(state.cursor).toBe("2026-07-13T08:00:00.000Z|evt_artifact");
  });

  it("persists the database ingest sequence in reconnect cursors", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });
    applySessionLiveEvent(
      state,
      event({
        id: "evt_sequenced",
        sequence: 42,
        kind: "daemon.task.lifecycle",
        payload: {
          type: "daemon.task.lifecycle",
          sessionId: "sess_current",
          taskType: "session.run",
          status: "running",
        },
      }),
    );

    expect(state.cursor).toBe("42|2026-07-13T08:00:00.000Z|evt_sequenced");
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

  it("does not redraw an identical cumulative message snapshot with a new event id", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });
    const payload = {
      type: "daemon.view_event",
      sessionId: "sess_current",
      view: {
        type: "session.message",
        sessionId: "sess_current",
        message: {
          id: "msg_stream",
          role: "assistant",
          text: "Same cumulative text",
          status: "streaming",
          parts: [
            { id: "part_stream", type: "text", text: "Same cumulative text", status: "running" },
          ],
        },
      },
    };

    expect(
      applySessionLiveEvent(
        state,
        event({ id: "evt_message_first", kind: "daemon.view_event", payload }),
      ),
    ).toEqual({ changed: true, refreshActivity: false });
    const firstView = state.view;
    expect(
      applySessionLiveEvent(
        state,
        event({ id: "evt_message_duplicate", kind: "daemon.view_event", payload }),
      ),
    ).toEqual({ changed: false, refreshActivity: false });
    expect(state.view).toBe(firstView);
  });

  it("reconciles a refreshed server snapshot without discarding newer live text or replay fences", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      workspaceId: "ws_spore",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        title: "Before refresh",
        updatedAt: "2026-07-13T08:00:00.000Z",
        messages: [{ id: "msg_stream", role: "assistant", text: "Hel", status: "streaming" }],
      }),
      cursor: "40|2026-07-13T08:00:00.000Z|evt_before",
    });
    applySessionLiveEvent(
      state,
      event({
        id: "evt_live_message",
        sequence: 41,
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "session.message",
            sessionId: "sess_current",
            message: {
              id: "msg_stream",
              role: "assistant",
              text: "Hello from the live stream",
              status: "streaming",
            },
          },
        },
      }),
    );

    const processedIds = state.processedEventIds;
    const cursor = state.cursor;
    const changed = reconcileSessionLiveEventState(state, {
      workspaceId: "ws_spore",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        title: "After refresh",
        updatedAt: "2026-07-13T08:00:01.000Z",
        messages: [{ id: "msg_stream", role: "assistant", text: "Hello", status: "streaming" }],
      }),
      commandIds: ["cmd_after_refresh"],
      invocationIds: ["inv_after_refresh"],
    });

    expect(changed).toBe(true);
    expect(state.view).toMatchObject({
      title: "After refresh",
      messages: [{ id: "msg_stream", text: "Hello from the live stream" }],
    });
    expect(state.processedEventIds).toBe(processedIds);
    expect(state.processedEventIds.has("evt_live_message")).toBe(true);
    expect(state.cursor).toBe(cursor);
    expect(state.commandIds.has("cmd_after_refresh")).toBe(true);
    expect(state.invocationIds.has("inv_after_refresh")).toBe(true);
  });

  it("drops only the rolled-off latest-page prefix while retaining a live suffix", () => {
    const currentView = parseSparkSessionView({
      sessionId: "sess_current",
      messages: [
        { id: "msg_old", role: "user", text: "Rolled off" },
        { id: "msg_shared_1", role: "assistant", text: "Shared one" },
        { id: "msg_shared_2", role: "user", text: "Shared two" },
        { id: "msg_live", role: "assistant", text: "Not committed yet", status: "streaming" },
      ],
    });
    const serverView = parseSparkSessionView({
      sessionId: "sess_current",
      messages: [
        { id: "msg_shared_1", role: "assistant", text: "Shared one" },
        { id: "msg_shared_2", role: "user", text: "Shared two" },
      ],
    });
    const latestPageState = createSessionLiveEventState({
      sessionId: "sess_current",
      view: currentView,
    });
    const expandedHistoryState = createSessionLiveEventState({
      sessionId: "sess_current",
      view: currentView,
    });

    reconcileSessionLiveEventState(latestPageState, { view: serverView });
    reconcileSessionLiveEventState(expandedHistoryState, {
      view: serverView,
      preserveCurrentHistory: true,
    });

    expect(latestPageState.view?.messages.map((message) => message.id)).toEqual([
      "msg_shared_1",
      "msg_shared_2",
      "msg_live",
    ]);
    expect(expandedHistoryState.view?.messages.map((message) => message.id)).toEqual([
      "msg_old",
      "msg_shared_1",
      "msg_shared_2",
      "msg_live",
    ]);
  });

  it("inserts a missed middle message in canonical snapshot order", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        messages: [
          { id: "msg_1", role: "user", text: "One" },
          { id: "msg_3", role: "assistant", text: "Three" },
        ],
      }),
    });

    reconcileSessionLiveEventState(state, {
      preserveCurrentHistory: true,
      view: parseSparkSessionView({
        sessionId: "sess_current",
        messages: [
          { id: "msg_1", role: "user", text: "One" },
          { id: "msg_2", role: "assistant", text: "Two" },
          { id: "msg_3", role: "assistant", text: "Three" },
        ],
      }),
    });

    expect(state.view?.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_3"]);
  });

  it("does not let an older refresh regress terminal live state", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "idle",
        updatedAt: "2026-07-13T08:00:02.000Z",
        messages: [{ id: "msg_final", role: "assistant", text: "Done", status: "done" }],
        runs: [
          {
            id: "run_1",
            kind: "session",
            status: "succeeded",
            completedAt: "2026-07-13T08:00:02.000Z",
          },
        ],
        tasks: [{ ref: "task:1", title: "Task", status: "done" }],
      }),
    });

    reconcileSessionLiveEventState(state, {
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "running",
        updatedAt: "2026-07-13T08:00:01.000Z",
        messages: [
          { id: "msg_final", role: "assistant", text: "Still working", status: "streaming" },
        ],
        runs: [
          {
            id: "run_1",
            kind: "session",
            status: "running",
            startedAt: "2026-07-13T08:00:00.000Z",
          },
        ],
        tasks: [{ ref: "task:1", title: "Task", status: "in_progress" }],
      }),
    });

    expect(state.view).toMatchObject({
      status: "idle",
      messages: [{ id: "msg_final", text: "Done", status: "done" }],
      runs: [{ id: "run_1", status: "succeeded" }],
      tasks: [{ ref: "task:1", status: "done" }],
      updatedAt: "2026-07-13T08:00:02.000Z",
    });
  });

  it("does not let an unversioned refresh replace newer live shell state", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({ sessionId: "sess_current", status: "idle" }),
    });
    applySessionLiveEvent(
      state,
      event({
        id: "evt_live_status",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "session.status",
            sessionId: "sess_current",
            status: "idle",
          },
        },
      }),
    );

    reconcileSessionLiveEventState(state, {
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "running",
        pendingTurns: [
          {
            id: "turn_stale",
            invocationId: "inv_stale",
            status: "running",
            prompt: "stale",
            createdAt: "2026-07-13T08:00:00.000Z",
          },
        ],
      }),
    });

    expect(state.view).toMatchObject({ status: "idle" });
    expect(state.view?.pendingTurns ?? []).toEqual([]);
  });

  it("does not let an older terminal task override a newer resumed task", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        updatedAt: "2026-07-13T08:00:02.000Z",
        tasks: [{ ref: "task:1", title: "Task", status: "in_progress" }],
      }),
    });

    reconcileSessionLiveEventState(state, {
      view: parseSparkSessionView({
        sessionId: "sess_current",
        updatedAt: "2026-07-13T08:00:01.000Z",
        tasks: [{ ref: "task:1", title: "Task", status: "done" }],
      }),
    });

    expect(state.view?.tasks).toMatchObject([{ ref: "task:1", status: "in_progress" }]);
  });

  it("allows a blocked task to resume in a newer snapshot", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        updatedAt: "2026-07-13T08:00:00.000Z",
        tasks: [{ ref: "task:1", title: "Task", status: "blocked" }],
      }),
    });

    reconcileSessionLiveEventState(state, {
      view: parseSparkSessionView({
        sessionId: "sess_current",
        updatedAt: "2026-07-13T08:00:01.000Z",
        tasks: [{ ref: "task:1", title: "Task", status: "in_progress" }],
      }),
    });

    expect(state.view?.tasks).toMatchObject([{ ref: "task:1", status: "in_progress" }]);
  });

  it("accepts an ordered streaming revision even when its projection is shorter", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });
    for (const [id, text] of [
      ["evt_stream_long", "temporary cumulative placeholder"],
      ["evt_stream_short", "corrected"],
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
              message: { id: "msg_stream", role: "assistant", text, status: "streaming" },
            },
          },
        }),
      );
    }

    expect(state.view?.messages).toMatchObject([
      { id: "msg_stream", text: "corrected", status: "streaming" },
    ]);
  });

  it("compares timestamp offsets by instant instead of source text", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        title: "Current",
        updatedAt: "2026-07-13T08:00:00.000Z",
      }),
    });

    reconcileSessionLiveEventState(state, {
      view: parseSparkSessionView({
        sessionId: "sess_current",
        title: "Older despite local clock text",
        updatedAt: "2026-07-13T09:00:00.000+02:00",
      }),
    });

    expect(state.view?.title).toBe("Current");
  });

  it("accepts a later terminal correction even when its payload is shorter", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });
    for (const [id, text, status] of [
      ["evt_terminal_done", "A longer successful response", "done"],
      ["evt_terminal_error", "Failed", "error"],
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
              message: { id: "msg_terminal", role: "assistant", text, status },
            },
          },
        }),
      );
    }

    expect(state.view?.messages).toMatchObject([
      { id: "msg_terminal", text: "Failed", status: "error" },
    ]);
  });

  it("adopts equal-size history metadata updates but never rolls back loaded pages", () => {
    const current = {
      totalMessages: 64,
      loadedMessages: 32,
      hiddenMessages: 32,
      earlierMessages: 32,
      laterMessages: 0,
      hasEarlierMessages: true,
      nextBeforeMessageId: "msg_33",
    };

    expect(
      shouldAdoptSessionHistory(current, {
        ...current,
        earlierMessages: 0,
        laterMessages: 32,
        hasEarlierMessages: false,
        nextBeforeMessageId: undefined,
      }),
    ).toBe(true);
    expect(
      shouldAdoptSessionHistory(current, {
        ...current,
        loadedMessages: 16,
        hiddenMessages: 48,
        earlierMessages: 48,
      }),
    ).toBe(false);
    expect(
      shouldAdoptSessionHistory(
        {
          ...current,
          earlierMessages: 0,
          laterMessages: 32,
          hasEarlierMessages: false,
          nextBeforeMessageId: undefined,
        },
        current,
      ),
    ).toBe(false);
    expect(
      shouldAdoptSessionHistory(current, {
        ...current,
        totalMessages: 63,
      }),
    ).toBe(false);
  });

  it("keeps the canonical user message when a correlated live projection arrives", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        messages: [
          {
            id: "native-user-1",
            role: "user",
            text: "Try again",
            metadata: { invocationId: "inv_one" },
          },
        ],
      }),
    });

    applySessionLiveEvent(
      state,
      event({
        id: "evt_same_invocation",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          invocationId: "inv_one",
          view: {
            type: "session.message",
            sessionId: "sess_current",
            message: {
              id: "sess_current:message:user:live:1",
              role: "user",
              text: "Try again",
            },
          },
        },
      }),
    );
    applySessionLiveEvent(
      state,
      event({
        id: "evt_same_text_new_invocation",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          invocationId: "inv_two",
          view: {
            type: "session.message",
            sessionId: "sess_current",
            message: {
              id: "sess_current:message:user:live:2",
              role: "user",
              text: "Try again",
            },
          },
        },
      }),
    );

    expect(
      state.view?.messages.map((message) => [message.id, message.metadata.invocationId]),
    ).toEqual([
      ["native-user-1", "inv_one"],
      ["sess_current:message:user:live:2", "inv_two"],
    ]);
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

  it("keeps a direct admitted turn queued until daemon truth reports running", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });

    expect(registerQueuedSessionTurn(state, " inv_direct ", "2026-07-13T08:00:00.000Z")).toBe(true);
    expect(state.activeTurnId).toBeNull();
    expect(state.view).toBeNull();

    const result = applySessionLiveEvent(
      state,
      event({
        id: "evt_direct_failed",
        kind: "invocation.updated",
        subjectId: "inv_direct",
        payload: {
          runtimeInvocationId: "inv_direct",
          status: "failed",
          terminalReason: "provider unavailable",
        },
      }),
    );

    expect(result).toEqual({ changed: false, refreshActivity: true });
    expect(state.activeTurnId).toBeNull();
    expect(state.view).toBeNull();
  });

  it("does not promote the conversation to running from a nested run projection", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      workspaceId: "ws_spore",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "idle",
        pendingTurns: [],
      }),
    });

    const result = applySessionLiveEvent(
      state,
      event({
        id: "evt_nested_run",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "run.update",
            sessionId: "sess_current",
            run: {
              id: "run_nested",
              kind: "workflow",
              title: "Background verification",
              status: "running",
            },
          },
        },
      }),
    );

    expect(result).toEqual({ changed: true, refreshActivity: false });
    expect(state.view).toMatchObject({
      status: "idle",
      pendingTurns: [],
      runs: [{ id: "run_nested", status: "running" }],
    });
    expect(state.activeTurnId).toBeNull();
  });

  it("does not promote a settled conversation from a late streaming message", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "idle",
        pendingTurns: [],
      }),
    });

    const result = applySessionLiveEvent(
      state,
      event({
        id: "evt_late_stream",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "session.message",
            sessionId: "sess_current",
            message: {
              id: "msg_late_stream",
              role: "assistant",
              text: "Late chunk",
              status: "streaming",
            },
          },
        },
      }),
    );

    expect(result).toEqual({ changed: true, refreshActivity: false });
    expect(state.view).toMatchObject({
      status: "idle",
      pendingTurns: [],
      messages: [{ id: "msg_late_stream", status: "streaming" }],
    });
    expect(state.activeTurnId).toBeNull();
  });

  it("keeps the running cancellation target when later follow-ups are queued", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });

    expect(registerQueuedSessionTurn(state, "inv_running")).toBe(true);
    applySessionLiveEvent(
      state,
      event({
        id: "evt_running_started",
        kind: "invocation.updated",
        subjectId: "inv_running",
        payload: { runtimeInvocationId: "inv_running", status: "running" },
      }),
    );
    expect(registerQueuedSessionTurn(state, "inv_follow_up")).toBe(true);
    expect(state.activeTurnId).toBe("inv_running");

    applySessionLiveEvent(
      state,
      event({
        id: "evt_follow_up_queued",
        kind: "invocation.updated",
        subjectId: "inv_follow_up",
        payload: { runtimeInvocationId: "inv_follow_up", status: "queued" },
      }),
    );
    expect(state.activeTurnId).toBe("inv_running");

    applySessionLiveEvent(
      state,
      event({
        id: "evt_follow_up_running",
        kind: "invocation.updated",
        subjectId: "inv_follow_up",
        payload: { runtimeInvocationId: "inv_follow_up", status: "running" },
      }),
    );
    expect(state.activeTurnId).toBe("inv_follow_up");
  });

  it("clears cancellation for a lost turn without inventing failure messages from projection events", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });
    registerQueuedSessionTurn(state, "inv_lost", "2026-07-13T08:00:00.000Z");
    const gatewayPage = `<!doctype html><html><head><title>504 Gateway Time-out</title></head><body><svg>${"noise".repeat(
      5_000,
    )}</svg></body></html>`;

    const result = applySessionLiveEvent(
      state,
      event({
        id: "evt_direct_lost",
        kind: "invocation.updated",
        subjectId: "inv_lost",
        payload: {
          runtimeInvocationId: "inv_lost",
          status: "lost",
          terminalReason: gatewayPage,
        },
      }),
    );

    expect(result).toEqual({ changed: false, refreshActivity: true });
    expect(state.activeTurnId).toBeNull();
    expect(state.view).toBeNull();
  });

  it("keeps a failed tool result structured while sanitizing its live error text", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });
    registerQueuedSessionTurn(state, "inv_tool", "2026-07-13T08:00:00.000Z");
    applySessionLiveEvent(
      state,
      event({
        id: "evt_tool_running",
        kind: "invocation.updated",
        subjectId: "inv_tool",
        payload: { runtimeInvocationId: "inv_tool", status: "running" },
      }),
    );
    applySessionLiveEvent(
      state,
      event({
        id: "evt_failed_tool",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "session.message",
            sessionId: "sess_current",
            message: {
              id: "tool-result-failed",
              role: "tool",
              text: "503 upstream failure<html><body>unsafe body</body></html>",
              status: "error",
              parts: [
                {
                  id: "tool-result-failed:part:0",
                  type: "tool-result",
                  toolCallId: "call-failed",
                  toolName: "exec",
                  summary: "503 tool failed<html><body>unsafe summary</body></html>",
                  status: "failed",
                },
                {
                  id: "tool-result-failed:part:1",
                  type: "tool-result",
                  toolCallId: "call-safe-html",
                  toolName: "read",
                  summary: "<html>literal fixture</html>",
                  status: "complete",
                },
              ],
            },
          },
        },
      }),
    );

    expect(state.view?.messages[0]).toMatchObject({
      id: "tool-result-failed",
      text: "503 upstream failure",
      status: "error",
      parts: [
        {
          type: "tool-result",
          toolCallId: "call-failed",
          status: "failed",
          summary: "503 tool failed",
        },
        {
          type: "tool-result",
          toolCallId: "call-safe-html",
          status: "complete",
          summary: "<html>literal fixture</html>",
        },
      ],
    });
    expect(state.view?.status).toBe("idle");
    expect(state.activeTurnId).toBe("inv_tool");

    applySessionLiveEvent(
      state,
      event({
        id: "evt_failed_tool_terminal",
        kind: "invocation.updated",
        subjectId: "inv_tool",
        payload: { runtimeInvocationId: "inv_tool", status: "succeeded" },
      }),
    );
    expect(state.activeTurnId).toBeNull();
    // Status stays until a daemon snapshot / view event rewrites it.
    expect(state.view?.status).toBe("idle");
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

  it("tracks running lifecycle truth and settles a legacy view immediately", () => {
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
            metadata: {
              source: "daemon.invocation",
              invocationId: "inv_1",
              invocationStatus: "running",
            },
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
    expect(state.view?.status).toBe("running");

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
    expect(state.view?.status).toBe("idle");
  });

  it("advances pending turns only when each lifecycle actually starts", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "queued",
        pendingTurns: [
          {
            invocationId: "inv_active",
            prompt: "Inspect the queue",
            status: "queued",
            createdAt: "2026-07-13T08:00:00.000Z",
          },
          {
            invocationId: "inv_next",
            prompt: "Run the tests",
            status: "queued",
            createdAt: "2026-07-13T08:00:01.000Z",
          },
        ],
      }),
    });

    const running = applySessionLiveEvent(
      state,
      event({
        id: "evt_active_running",
        kind: "daemon.task.lifecycle",
        payload: {
          type: "daemon.task.lifecycle",
          sessionId: "sess_current",
          taskType: "session.run",
          invocationId: "inv_active",
          status: "running",
          emittedAt: "2026-07-13T08:00:02.000Z",
        },
      }),
    );

    expect(running).toEqual({ changed: true, refreshActivity: true });
    expect(state.activeTurnId).toBe("inv_active");
    expect(state.view?.pendingTurns).toMatchObject([
      {
        invocationId: "inv_active",
        status: "running",
        startedAt: "2026-07-13T08:00:02.000Z",
      },
      { invocationId: "inv_next", status: "queued" },
    ]);

    const activeDone = applySessionLiveEvent(
      state,
      event({
        id: "evt_active_done",
        kind: "daemon.task.lifecycle",
        payload: {
          type: "daemon.task.lifecycle",
          sessionId: "sess_current",
          taskType: "session.run",
          invocationId: "inv_active",
          status: "succeeded",
          emittedAt: "2026-07-13T08:00:03.000Z",
        },
      }),
    );

    expect(activeDone).toEqual({ changed: true, refreshActivity: true });
    expect(state.activeTurnId).toBeNull();
    expect(state.view).toMatchObject({
      status: "queued",
      pendingTurns: [{ invocationId: "inv_next", status: "queued" }],
    });

    applySessionLiveEvent(
      state,
      event({
        id: "evt_queue_snapshot",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "session.snapshot",
            session: parseSparkSessionView({
              sessionId: "sess_current",
              status: "running",
              pendingTurns: [
                {
                  invocationId: "inv_next",
                  prompt: "Run the tests",
                  status: "running",
                  createdAt: "2026-07-13T08:00:01.000Z",
                  startedAt: "2026-07-13T08:00:04.000Z",
                },
              ],
            }),
          },
        },
      }),
    );
    expect(state.activeTurnId).toBe("inv_next");
    expect(state.view).toMatchObject({
      status: "running",
      pendingTurns: [{ invocationId: "inv_next", status: "running" }],
    });

    applySessionLiveEvent(
      state,
      event({
        id: "evt_next_done",
        kind: "invocation.updated",
        subjectId: "inv_next",
        payload: { runtimeInvocationId: "inv_next", status: "succeeded" },
      }),
    );
    expect(state.activeTurnId).toBeNull();
    expect(state.view).toMatchObject({ status: "idle", pendingTurns: [] });

    applySessionLiveEvent(
      state,
      event({
        id: "evt_idle_snapshot",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "session.snapshot",
            session: parseSparkSessionView({
              sessionId: "sess_current",
              status: "idle",
              pendingTurns: [],
            }),
          },
        },
      }),
    );
    expect(state.activeTurnId).toBeNull();
    expect(state.view).toMatchObject({ status: "idle", pendingTurns: [] });
  });

  it("ignores unknown and regressive running lifecycle events", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "queued",
        pendingTurns: [
          {
            invocationId: "inv_known",
            prompt: "Known pending work",
            status: "queued",
            createdAt: "2026-07-13T08:00:00.000Z",
          },
        ],
      }),
    });

    const unknown = applySessionLiveEvent(
      state,
      event({
        id: "evt_unknown_running",
        kind: "daemon.task.lifecycle",
        payload: {
          type: "daemon.task.lifecycle",
          sessionId: "sess_current",
          taskType: "session.run",
          invocationId: "inv_historical",
          status: "running",
        },
      }),
    );
    expect(unknown).toEqual({ changed: false, refreshActivity: true });
    expect(state.view).toMatchObject({
      status: "queued",
      pendingTurns: [{ invocationId: "inv_known", status: "queued" }],
    });
    expect(state.activeTurnId).toBeNull();

    for (const [id, status] of [
      ["evt_known_running", "running"],
      ["evt_known_done", "succeeded"],
      ["evt_late_running", "running"],
    ] as const) {
      applySessionLiveEvent(
        state,
        event({
          id,
          kind: "daemon.task.lifecycle",
          payload: {
            type: "daemon.task.lifecycle",
            sessionId: "sess_current",
            taskType: "session.run",
            invocationId: "inv_known",
            status,
          },
        }),
      );
    }

    expect(state.view).toMatchObject({ status: "idle", pendingTurns: [] });
    expect(state.activeTurnId).toBeNull();
    expect(state.invocationPhases.get("inv_known")).toBe("succeeded");
  });

  it("does not regress a running invocation when a stale queued snapshot arrives later", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "queued",
        pendingTurns: [
          {
            invocationId: "inv_running",
            prompt: "Keep running",
            status: "queued",
            createdAt: "2026-07-13T08:00:00.000Z",
          },
        ],
      }),
    });
    applySessionLiveEvent(
      state,
      event({
        id: "evt_running_before_snapshot",
        kind: "daemon.task.lifecycle",
        payload: {
          type: "daemon.task.lifecycle",
          sessionId: "sess_current",
          taskType: "session.run",
          invocationId: "inv_running",
          status: "running",
          emittedAt: "2026-07-13T08:00:02.000Z",
        },
      }),
    );

    applySessionLiveEvent(
      state,
      event({
        id: "evt_stale_queued_snapshot",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "session.snapshot",
            session: parseSparkSessionView({
              sessionId: "sess_current",
              status: "queued",
              pendingTurns: [
                {
                  invocationId: "inv_running",
                  prompt: "Keep running",
                  status: "queued",
                  createdAt: "2026-07-13T08:00:00.000Z",
                },
              ],
            }),
          },
        },
      }),
    );

    expect(state.view).toMatchObject({
      status: "running",
      pendingTurns: [{ invocationId: "inv_running", status: "running" }],
    });
    expect(state.invocationPhases.get("inv_running")).toBe("running");
    expect(state.activeTurnId).toBe("inv_running");
  });

  it("does not resurrect a terminal Stop target from historical invocation messages", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "idle",
        pendingTurns: [],
        messages: [
          {
            id: "invocation:inv_terminal",
            role: "user",
            text: "Historical request",
            status: "done",
            metadata: {
              source: "daemon.invocation",
              invocationId: "inv_terminal",
              invocationStatus: "running",
            },
          },
        ],
      }),
    });

    expect(state.activeTurnId).toBeNull();
    expect(
      applySessionLiveEvent(
        state,
        event({
          id: "evt_terminal_replayed",
          kind: "invocation.updated",
          subjectId: "inv_terminal",
          payload: { runtimeInvocationId: "inv_terminal", status: "succeeded" },
        }),
      ),
    ).toEqual({ changed: false, refreshActivity: false });
    expect(state.activeTurnId).toBeNull();
  });

  it("clears cancellation after reload without inventing failure messages from projection events", () => {
    const state = createSessionLiveEventState({
      sessionId: "sess_current",
      view: parseSparkSessionView({
        sessionId: "sess_current",
        status: "running",
        messages: [
          {
            id: "invocation:inv_reloaded",
            role: "user",
            text: "Continue after reload",
            status: "done",
            metadata: {
              source: "daemon.invocation",
              invocationId: "inv_reloaded",
              invocationStatus: "running",
            },
          },
        ],
      }),
    });

    const result = applySessionLiveEvent(
      state,
      event({
        id: "evt_reloaded_lost",
        kind: "invocation.updated",
        subjectId: "inv_reloaded",
        payload: { runtimeInvocationId: "inv_reloaded", status: "lost" },
      }),
    );

    expect(result).toEqual({ changed: true, refreshActivity: true });
    expect(state.activeTurnId).toBeNull();
    expect(state.view).toMatchObject({
      status: "idle",
      messages: [{ id: "invocation:inv_reloaded", role: "user" }],
    });
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

  it("applies sanitized failure messages only through daemon view events", () => {
    const state = createSessionLiveEventState({ sessionId: "sess_current" });
    const gatewayPage = `<!doctype html><html><head><title>504 Gateway Time-out</title></head><body><svg>${"noise".repeat(
      5_000,
    )}</svg></body></html>`;

    applySessionLiveEvent(
      state,
      event({
        id: "evt_failure_message",
        kind: "daemon.view_event",
        payload: {
          type: "daemon.view_event",
          sessionId: "sess_current",
          view: {
            type: "session.message",
            sessionId: "sess_current",
            message: {
              id: "invocation:inv_lost:failure",
              role: "system",
              text: gatewayPage,
              status: "error",
              metadata: {
                source: "daemon.invocation",
                invocationId: "inv_lost",
                kind: "invocation_failure",
                terminalStatus: "lost",
                errorTitle: "Session interrupted",
                errorMessage: gatewayPage,
              },
            },
          },
        },
      }),
    );

    expect(state.view?.messages[0]).toMatchObject({
      id: "invocation:inv_lost:failure",
      role: "system",
      status: "error",
      text: "504 Gateway Time-out",
    });
    expect(JSON.stringify(state.view)).not.toMatch(/<!doctype|<html|<svg|noise/iu);
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
    const queuedView = parseSparkSessionView({
      ...view,
      pendingTurns: [
        {
          invocationId: "inv_queued",
          prompt: "Continue",
          status: "queued",
          createdAt: "2026-07-13T08:00:00.000Z",
        },
      ],
    });
    const runningView = parseSparkSessionView({
      ...queuedView,
      pendingTurns: [
        {
          ...queuedView.pendingTurns?.[0],
          status: "running",
          startedAt: "2026-07-13T08:00:01.000Z",
        },
      ],
    });
    const settledView = parseSparkSessionView({ ...queuedView, pendingTurns: [] });
    expect(new Set([queuedView, runningView, settledView].map(sessionViewRevisionKey)).size).toBe(
      3,
    );
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
