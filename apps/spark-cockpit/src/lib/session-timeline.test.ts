import { describe, expect, it } from "vitest";
import type { SparkJsonObject } from "@zendev-lab/spark-protocol";
import { visibleConversationParts } from "./components/conversation/conversation-view";
import { visibleThinkingChainSteps } from "./components/conversation/thinking-chain-view";
import {
  activeSessionTimelineProcessItemId,
  buildSessionTimeline,
  latestSessionRetryCandidate,
  latestSessionRetryPrompt,
  sessionTimelineWindow,
  type SessionTimelineItem,
} from "./session-timeline";

describe("session timeline", () => {
  it("windows historical rendering without splitting a user and assistant turn", () => {
    const items = [
      timelineItem("u1", "user"),
      timelineItem("a1", "spark"),
      timelineItem("u2", "user"),
      timelineItem("a2", "spark"),
      timelineItem("u3", "user"),
      timelineItem("a3", "spark"),
    ];

    expect(sessionTimelineWindow(items, 3)).toMatchObject({
      hiddenCount: 2,
      items: [{ id: "u2" }, { id: "a2" }, { id: "u3" }, { id: "a3" }],
    });
    expect(sessionTimelineWindow(items, 20)).toMatchObject({ hiddenCount: 0, items });
  });

  it("marks only a streaming chain as the active process item", () => {
    const completed = timelineItem("completed", "spark");
    completed.parts = [{ type: "chain", state: "complete", steps: [] }];
    const streaming = timelineItem("streaming", "spark");
    streaming.parts = [{ type: "chain", state: "streaming", steps: [] }];

    expect(activeSessionTimelineProcessItemId([streaming, completed], true)).toBe("streaming");
    expect(activeSessionTimelineProcessItemId([streaming, completed], false)).toBeNull();
    expect(activeSessionTimelineProcessItemId([completed], true)).toBeNull();
  });

  it("uses the daemon transcript as conversation truth and keeps run-only projections", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        message("u1", "user", "Infoflow question", "2026-07-10T00:00:01.000Z"),
        message("a1", "assistant", "First answer", "2026-07-10T00:00:01.000Z"),
        message("u2", "user", "Web follow-up", "2026-07-10T00:00:03.000Z"),
        message("a2", "assistant", "Second answer", "2026-07-10T00:00:04.000Z"),
      ],
      commands: [
        {
          id: "cmd_web",
          title: "Web follow-up",
          goal: "Web follow-up",
          status: "acked",
          deliveryStatus: "acked",
          invocationStatus: "succeeded",
          createdAt: "2026-07-10T00:00:03.000Z",
        },
      ],
      reports: [
        {
          id: "message:a2",
          kind: "session.message",
          title: "assistant message",
          text: "Second answer",
          role: "assistant",
          status: "done",
          createdAt: "2026-07-10T00:00:04.000Z",
        },
        {
          id: "run_update",
          kind: "run.update",
          title: "Internal run",
          text: "Run succeeded.",
          role: null,
          status: "succeeded",
          createdAt: "2026-07-10T00:00:05.000Z",
        },
      ],
    });

    expect(timeline.map((item) => [item.id, item.body])).toEqual([
      ["message:u1", "Infoflow question"],
      ["message:a1", "First answer"],
      ["message:u2", "Web follow-up"],
      ["message:a2", "Second answer"],
      ["report:run_update", "Run succeeded."],
    ]);
    expect(timeline.at(-1)?.parts).toEqual([
      {
        type: "task",
        taskRef: "run_update",
        title: "Internal run",
        state: "completed",
        summary: "Run succeeded.",
      },
    ]);
  });

  it("keeps top-level session run status in the inspector instead of duplicating the reply", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        message("u1", "user", "Check the task", "2026-07-10T00:00:01.000Z"),
        message("a1", "assistant", "The task is complete.", "2026-07-10T00:00:02.000Z"),
      ],
      commands: [],
      reports: [
        {
          id: "sess_current:run:1",
          kind: "run.update",
          runKind: "session",
          title: "sess_current:run:1",
          text: "Run succeeded.",
          role: null,
          status: "succeeded",
          createdAt: "2026-07-10T00:00:03.000Z",
        },
      ],
    });

    expect(timeline.map((item) => item.id)).toEqual(["message:u1", "message:a1"]);
  });

  it("shows terminal system failures while keeping ordinary system messages hidden", () => {
    const internalTransportFailure =
      "cue-shell error [TRANSPORT_RESOLVE_FAILED]: failed to resolve cue-shell client transport";
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        message("system-hidden", "system", "internal context", "2026-07-10T00:00:01.000Z"),
        {
          ...message(
            "system-failed",
            "system",
            "provider unavailable",
            "2026-07-10T00:00:02.000Z",
            {
              conversationVisible: true,
              errorTitle: "Session interrupted",
              terminalStatus: "lost",
            },
          ),
          status: "error",
        },
      ],
      commands: [],
      reports: [
        {
          id: "internal-run",
          kind: "run.update",
          title: "Spark",
          text: internalTransportFailure,
          role: null,
          status: "failed",
          createdAt: "2026-07-10T00:00:03.000Z",
        },
      ],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      id: "message:system-failed",
      actor: "spark",
      status: null,
      parts: [{ type: "error", title: "Session interrupted", message: "provider unavailable" }],
    });
    expect(JSON.stringify(timeline)).not.toContain(internalTransportFailure);
  });

  it("selects the latest canonical failed turn for session-level retry", () => {
    const messages = [
      message(
        "user-empty-response",
        "user",
        "Finish the Cockpit retry flow",
        "2026-07-10T00:00:01.000Z",
        { source: "daemon.invocation", invocationId: "inv_empty_response" },
      ),
      {
        ...message(
          "empty-response-error",
          "system",
          "model completed without a displayable response",
          "2026-07-10T00:00:02.000Z",
          {
            source: "daemon.invocation",
            invocationId: "inv_empty_response",
            conversationVisible: true,
            errorTitle: "Spark",
          },
        ),
        status: "error" as const,
      },
    ];
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages,
      commands: [],
      reports: [],
    });

    expect(timeline.at(-1)).toMatchObject({
      id: "message:empty-response-error",
      parts: [
        {
          type: "error",
          title: "Spark",
          message: "model completed without a displayable response",
        },
      ],
    });
    expect(latestSessionRetryCandidate(messages)).toEqual({
      prompt: "Finish the Cockpit retry flow",
      failureMessageId: "empty-response-error",
    });
    expect(latestSessionRetryPrompt(messages)).toBe("Finish the Cockpit retry flow");
  });

  it("invalidates retry after a newer user turn or final answer", () => {
    const failedTurn = retryableFailure("first", "Retry this request", 1);
    const newerUser = message(
      "newer-user",
      "user",
      "Use a different approach",
      "2026-07-10T00:00:03.000Z",
      { invocationId: "inv_newer" },
    );
    const newerAnswer = message(
      "newer-answer",
      "assistant",
      "Done with the different approach.",
      "2026-07-10T00:00:04.000Z",
      { invocationId: "inv_newer" },
    );

    expect(latestSessionRetryPrompt(failedTurn)).toBe("Retry this request");
    expect(latestSessionRetryPrompt([...failedTurn, newerUser])).toBeNull();
    expect(latestSessionRetryPrompt([...failedTurn, newerAnswer])).toBeNull();
  });

  it("chooses the newest failed turn and ignores non-conversation reports", () => {
    const first = retryableFailure("first", "First prompt", 1);
    const second = retryableFailure("second", "Second prompt", 3);
    const messages = [...first, ...second];
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages,
      commands: [],
      reports: [
        {
          id: "task-after-failure",
          kind: "task.update",
          title: "Background task",
          text: "Task projection arrived later.",
          role: null,
          status: "completed",
          createdAt: "2026-07-10T00:00:05.000Z",
        },
      ],
    });

    expect(timeline.at(-1)?.id).toBe("report:task-after-failure");
    expect(latestSessionRetryCandidate(messages)).toEqual({
      prompt: "Second prompt",
      failureMessageId: "second-failure",
    });
  });

  it("does not turn hidden diagnostics or tool failures into session retry", () => {
    const user = message("u", "user", "Run the tool", "2026-07-10T00:00:01.000Z", {
      invocationId: "inv_tool",
    });
    const hiddenDiagnostic = {
      ...message("hidden", "system", "internal transport detail", "2026-07-10T00:00:02.000Z", {
        invocationId: "inv_tool",
      }),
      status: "error" as const,
    };
    const toolFailure = {
      version: 1 as const,
      id: "tool-failure",
      role: "tool" as const,
      text: "tool failed",
      status: "error" as const,
      toolCallId: "call-1",
      toolName: "read",
      createdAt: "2026-07-10T00:00:03.000Z",
      metadata: { invocationId: "inv_tool" },
    };

    expect(latestSessionRetryCandidate([user, hiddenDiagnostic])).toBeNull();
    expect(latestSessionRetryCandidate([user, toolFailure])).toBeNull();
  });

  it("keeps failed cue execution without exposing raw transport diagnostics", () => {
    const transportError =
      "cue-shell error [TRANSPORT_RESOLVE_FAILED]: failed to resolve cue-shell client transport";
    const budgetError = "agent loop hit maxRoundtrips=16; stopping";
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        message("u1", "user", "检查 delegated session", "2026-07-10T00:00:01.000Z"),
        {
          ...message("a-call", "assistant", "", "2026-07-10T00:00:02.000Z"),
          parts: [
            {
              id: "a-call:tool",
              type: "tool-call" as const,
              status: "complete" as const,
              toolCallId: "call-cue",
              toolName: "cue_exec",
              summary: "检查 delegated session",
              metadata: {},
            },
          ],
        },
        {
          version: 1 as const,
          id: "tool-result:call-cue",
          role: "tool" as const,
          text: transportError,
          status: "error" as const,
          toolCallId: "call-cue",
          toolName: "cue_exec",
          createdAt: "2026-07-10T00:00:03.000Z",
          parts: [
            {
              id: "tool-result:call-cue:part",
              type: "tool-result" as const,
              status: "failed" as const,
              toolCallId: "call-cue",
              toolName: "cue_exec",
              summary: transportError,
              metadata: {},
            },
          ],
          metadata: {},
        },
        message("a-final", "assistant", "已改用本地回退。", "2026-07-10T00:00:04.000Z"),
        {
          ...message(
            "internal-system-error",
            "system",
            "internal transport diagnostic",
            "2026-07-10T00:00:05.000Z",
          ),
          status: "error" as const,
        },
        message("u2", "user", "继续", "2026-07-10T00:00:06.000Z"),
        {
          ...message("budget-exhausted", "assistant", budgetError, "2026-07-10T00:00:07.000Z", {
            outcomeStatus: "budget_exhausted",
          }),
          status: "error" as const,
        },
      ],
      commands: [],
      reports: [],
    });

    const processTurn = timeline.find((item) => item.id === "message:a-call");
    expect(processTurn).toMatchObject({ status: null });
    expect(processTurn?.parts.some((part) => part.type === "error")).toBe(false);
    const visibleParts = visibleConversationParts(processTurn?.parts ?? []);
    expect(visibleParts.map((part) => part.type)).toEqual(["chain", "text"]);
    const processChain = visibleParts.find((part) => part.type === "chain");
    expect(
      processChain?.type === "chain" ? visibleThinkingChainSteps(processChain.steps) : [],
    ).toEqual([{ type: "tool", callId: "call-cue", name: "cue_exec", state: "failed" }]);
    expect(visibleParts.at(-1)).toEqual({
      type: "text",
      text: "已改用本地回退。",
      streaming: false,
    });

    expect(timeline.some((item) => item.id === "message:internal-system-error")).toBe(false);
    const budgetNotice = timeline.find((item) => item.id === "message:budget-exhausted");
    expect(budgetNotice).toMatchObject({
      status: null,
      parts: [{ type: "notice", kind: "budget_exhausted" }],
    });
    expect(timeline.every((item) => item.status !== "error")).toBe(true);
  });

  it("keeps only the latest stable run and task projections", () => {
    const reports = [
      ["run.update", "run:one"],
      ["task.update", "task:one"],
      ["artifact.update", "artifact:one"],
    ].flatMap(([kind, id]) => [
      {
        id,
        kind,
        title: `Latest ${kind}`,
        text: "Latest projection.",
        role: null,
        status: "completed",
        createdAt: "2026-07-10T00:00:02.000Z",
      },
      {
        id,
        kind,
        title: `Older ${kind}`,
        text: "Older projection.",
        role: null,
        status: "running",
        createdAt: "2026-07-10T00:00:01.000Z",
      },
    ]) as Parameters<typeof buildSessionTimeline>[0]["reports"];

    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [],
      commands: [],
      reports,
    });

    // Artifact activity reports stay in the inspector/evidence lanes, not chat.
    expect(timeline).toHaveLength(2);
    expect(timeline.map((item) => item.body)).toEqual(["Latest projection.", "Latest projection."]);
    expect(timeline.map((item) => item.id)).toEqual(["report:run:one", "report:task:one"]);
  });

  it("preserves repeated canonical messages by source ID instead of display text", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        message("u1", "user", "Try again", "2026-07-10T00:00:01.000Z"),
        message("a1", "assistant", "Same result", "2026-07-10T00:00:02.000Z"),
        message("u2", "user", "Try again", "2026-07-10T00:00:03.000Z"),
        message("a2", "assistant", "Same result", "2026-07-10T00:00:04.000Z"),
      ],
      commands: [],
      reports: [],
    });

    expect(timeline.map((item) => [item.id, item.body])).toEqual([
      ["message:u1", "Try again"],
      ["message:a1", "Same result"],
      ["message:u2", "Try again"],
      ["message:a2", "Same result"],
    ]);
  });

  it("reconciles a live user projection with its canonical message by invocation", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        message("native-u1", "user", "Try again", "2026-07-10T00:00:01.000Z", {
          invocationId: "inv_one",
        }),
      ],
      commands: [],
      reports: [
        {
          id: "message:sess_demo:message:user:live:1",
          kind: "session.message",
          title: "user message",
          text: "Try again",
          role: "user",
          status: "done",
          createdAt: "2026-07-10T00:00:01.000Z",
          message: message(
            "sess_demo:message:user:live:1",
            "user",
            "Try again",
            "2026-07-10T00:00:01.000Z",
            { invocationId: "inv_one" },
          ),
        },
        {
          id: "message:sess_demo:message:user:live:2",
          kind: "session.message",
          title: "user message",
          text: "Try again",
          role: "user",
          status: "done",
          createdAt: "2026-07-10T00:00:02.000Z",
          message: message(
            "sess_demo:message:user:live:2",
            "user",
            "Try again",
            "2026-07-10T00:00:02.000Z",
            { invocationId: "inv_two" },
          ),
        },
      ],
    });

    expect(timeline.map((item) => [item.id, item.body])).toEqual([
      ["message:native-u1", "Try again"],
      ["message:sess_demo:message:user:live:2", "Try again"],
    ]);
  });

  it("count-matches durable direct-turn prompts against canonical transcript messages", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [message("u1", "user", "Try again", "2026-07-10T00:00:01.000Z")],
      commands: [],
      reports: [
        {
          id: "turn-submit:one:prompt",
          kind: "turn.submit.prompt",
          title: "User message",
          text: "Try again",
          role: "user",
          status: null,
          createdAt: "2026-07-10T00:00:01.000Z",
        },
        {
          id: "turn-submit:two:prompt",
          kind: "turn.submit.prompt",
          title: "User message",
          text: "Try again",
          role: "user",
          status: null,
          createdAt: "2026-07-10T00:00:02.000Z",
        },
      ],
    });

    expect(timeline.map((item) => [item.id, item.body])).toEqual([
      ["message:u1", "Try again"],
      ["report:turn-submit:two:prompt", "Try again"],
    ]);
  });

  it("labels channel users from platform metadata and leaves local turns unlabeled", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        message("u-name", "user", "from group", "2026-07-10T00:00:01.000Z", {
          channel: { senderName: "徐晓健", senderId: "xuxiaojian" },
        }),
        message("u-id", "user", "from direct", "2026-07-10T00:00:02.000Z", {
          channel: { senderId: "zhanrongrui" },
        }),
        message("u-local", "user", "from web", "2026-07-10T00:00:03.000Z"),
      ],
      commands: [],
      reports: [],
    });

    expect(timeline.map((item) => item.senderLabel)).toEqual(["徐晓健", "zhanrongrui", null]);
  });

  it("projects cross-session turns as their originating agent instead of the user", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        message("u-local", "user", "local prompt", "2026-07-10T00:00:01.000Z"),
        message("a-local", "assistant", "local answer", "2026-07-10T00:00:02.000Z"),
        message("u-agent", "user", "delegated request", "2026-07-10T00:00:03.000Z", {
          origin: {
            kind: "session",
            sessionId: "session:worker-a",
            host: "session",
            surface: "local",
          },
          sessionMail: {
            messageId: "mail:request-1",
            kind: "request",
            fromSessionId: "session:worker-a",
            toSessionId: "session:target",
          },
        }),
      ],
      commands: [],
      reports: [],
    });

    expect(timeline.map((item) => [item.actor, item.senderLabel])).toEqual([
      ["user", null],
      ["spark", null],
      ["session", "worker-a"],
    ]);
  });

  it("shortens opaque QQ openids when senderName is missing", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        message("u-qq", "user", "hello", "2026-07-10T00:00:01.000Z", {
          channel: { senderId: "398418FB5E7F1C597DFFD117597D6500" },
        }),
      ],
      commands: [],
      reports: [],
    });

    expect(timeline.map((item) => item.senderLabel)).toEqual(["398418FB…"]);
  });

  it("projects legacy Infoflow envelopes as the human message body", () => {
    const legacyEnvelope = [
      "You are handling an Infoflow (如流) channel conversation.",
      "Use platform sender metadata for identity; do not infer identity from writing style.",
      "",
      "Channel:",
      '- externalKey: "infoflow:group:10838226"',
      "",
      "Message:",
      "@神经蛙 你叫什么名字",
    ].join("\n");
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        {
          ...message("u1", "user", legacyEnvelope, "2026-07-10T00:00:01.000Z"),
          parts: [
            {
              id: "legacy-text",
              type: "text" as const,
              status: "complete" as const,
              text: legacyEnvelope,
              metadata: {},
            },
          ],
        },
      ],
      commands: [],
      reports: [],
    });

    expect(timeline[0]?.body).toBe("@神经蛙 你叫什么名字");
  });

  it("reconciles session-message projections by source ID and keeps equal text from new IDs", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [message("a1", "assistant", "Same result", "2026-07-10T00:00:02.000Z")],
      commands: [],
      reports: [
        {
          id: "message:a1",
          kind: "session.message",
          title: "assistant message",
          text: "Older streaming text",
          role: "assistant",
          status: "streaming",
          createdAt: "2026-07-10T00:00:01.000Z",
        },
        {
          id: "message:a2",
          kind: "session.message",
          title: "assistant message",
          text: "Same result",
          role: "assistant",
          status: "done",
          createdAt: "2026-07-10T00:00:03.000Z",
        },
      ],
    });

    expect(timeline.map((item) => [item.id, item.body])).toEqual([
      ["message:a1", "Same result"],
      ["message:a2", "Same result"],
    ]);
  });

  it("preserves commentary and tool structure in the activity-report fallback", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [],
      commands: [],
      reports: [
        {
          id: "message:a-fallback",
          kind: "session.message",
          title: "assistant message",
          text: "The check passed.",
          role: "assistant",
          status: "done",
          createdAt: "2026-07-10T00:00:03.000Z",
          message: {
            version: 1,
            id: "a-fallback",
            role: "assistant",
            text: "The check passed.",
            status: "done",
            createdAt: "2026-07-10T00:00:03.000Z",
            parts: [
              {
                id: "a-fallback:commentary",
                type: "text",
                text: "Checking the repository.",
                phase: "commentary",
                status: "complete",
                metadata: {},
              },
              {
                id: "a-fallback:tool",
                type: "tool-call",
                toolCallId: "call-fallback",
                toolName: "cue_exec",
                status: "complete",
                summary: "command=pwd",
                metadata: {},
              },
              {
                id: "a-fallback:answer",
                type: "text",
                text: "The check passed.",
                phase: "final_answer",
                status: "complete",
                metadata: {},
              },
            ],
            metadata: {},
          },
        },
      ],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.id).toBe("message:a-fallback");
    expect(timeline[0]?.parts).toEqual([
      {
        type: "chain",
        state: "complete",
        steps: [
          {
            type: "commentary",
            summary: "Checking the repository.",
            state: "complete",
          },
          {
            type: "tool",
            callId: "call-fallback",
            name: "cue_exec",
            state: "completed",
            summary: "command=pwd",
          },
        ],
      },
      { type: "text", text: "The check passed.", streaming: false },
    ]);
  });

  it("uses assignment commands only while no canonical transcript is available", () => {
    const command = {
      id: "cmd_legacy",
      title: "Legacy prompt",
      goal: "Legacy prompt",
      status: "acked",
      deliveryStatus: "acked",
      invocationStatus: "succeeded",
      createdAt: "2026-07-10T00:00:01.000Z",
    };

    const fallback = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [],
      commands: [command],
      reports: [],
    });
    const canonical = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [message("u1", "user", "Legacy prompt", "2026-07-10T00:00:01.000Z")],
      commands: [command],
      reports: [],
    });

    expect(fallback.map((item) => item.id)).toEqual(["command:cmd_legacy"]);
    expect(canonical.map((item) => item.id)).toEqual(["message:u1"]);
  });

  it("merges tool call and result messages into one evolving tool card", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        {
          ...message("call-message", "assistant", "", "2026-07-10T00:00:01.000Z"),
          parts: [
            {
              id: "call-part",
              type: "tool-call" as const,
              status: "running" as const,
              toolCallId: "call-1",
              toolName: "shell",
              summary: "Run tests",
              metadata: {},
            },
          ],
        },
        {
          ...message("result-message", "assistant", "", "2026-07-10T00:00:02.000Z"),
          parts: [
            {
              id: "result-part",
              type: "tool-result" as const,
              status: "complete" as const,
              toolCallId: "call-1",
              toolName: "shell",
              summary: "Tests passed",
              metadata: {},
            },
          ],
        },
      ],
      commands: [],
      reports: [],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.id).toBe("message:call-message");
    expect(timeline[0]?.parts).toEqual([
      {
        type: "chain",
        state: "complete",
        steps: [
          {
            type: "tool",
            callId: "call-1",
            name: "shell",
            state: "completed",
            summary: "Tests passed",
          },
        ],
      },
    ]);
    expect(JSON.stringify(timeline)).not.toContain("rawOutput");
  });

  it("never projects secret tool metadata into the timeline", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        {
          ...message("tool-message", "assistant", "", "2026-07-10T00:00:01.000Z"),
          parts: [
            {
              id: "tool-part",
              type: "tool-call" as const,
              status: "running" as const,
              toolCallId: "call-secret",
              toolName: "shell",
              summary: "Run checks",
              metadata: { arguments: "token=super-secret" },
            },
          ],
        },
      ],
      commands: [],
      reports: [],
    });

    expect(timeline[0]?.parts).toEqual([
      {
        type: "chain",
        state: "streaming",
        steps: [
          {
            type: "tool",
            callId: "call-secret",
            name: "shell",
            state: "running",
            summary: "Run checks",
          },
        ],
      },
    ]);
    expect(JSON.stringify(timeline)).not.toContain("super-secret");
  });

  it("keeps artifact and evidence activity reports out of the conversation timeline", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [],
      commands: [],
      reports: [
        {
          id: "art-focused-report",
          kind: "artifact.report",
          title: "Focused check report",
          text: "All focused checks passed.",
          role: "assistant",
          status: "completed",
          createdAt: "2026-07-10T00:00:01.000Z",
        },
        {
          id: "artifact:tool-side-channel",
          kind: "evidence.update",
          title: "artifact:tool-side-channel",
          text: "Evidence succeeded.",
          role: "assistant",
          status: "succeeded",
          createdAt: "2026-07-10T00:00:02.000Z",
        },
      ],
    });

    expect(timeline).toEqual([]);
  });

  it("projects reload-safe task updates as structured cards without artifact bubbles", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [],
      commands: [],
      reports: [
        {
          id: "task:review",
          kind: "task.update",
          title: "Review implementation",
          text: "Check focused tests.",
          role: null,
          status: "claimed",
          createdAt: "2026-07-10T00:00:01.000Z",
        },
        {
          id: "artifact:check-report",
          kind: "artifact.update",
          title: "Focused check report",
          text: "All checks passed.",
          role: "assistant",
          status: "completed",
          createdAt: "2026-07-10T00:00:02.000Z",
        },
      ],
    });

    expect(timeline.map((item) => item.parts[0])).toEqual([
      {
        type: "task",
        taskRef: "task:review",
        title: "Review implementation",
        state: "running",
        summary: "Check focused tests.",
      },
    ]);
  });

  it("merges an ask interaction request and response as an ask tool part", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [],
      commands: [],
      reports: [
        {
          id: "interaction-request-event",
          kind: "daemon.interaction.request",
          title: "Choose the next step",
          text: "Continue with the focused fix?",
          role: null,
          status: null,
          createdAt: "2026-07-10T00:00:01.000Z",
          interaction: { requestId: "ask-1", kind: "askFlow" },
        },
        {
          id: "interaction-response-event",
          kind: "daemon.interaction.response",
          title: "Interaction response",
          text: "Operator response recorded.",
          role: null,
          status: "answered",
          createdAt: "2026-07-10T00:00:02.000Z",
          interaction: { requestId: "ask-1", kind: "askFlow" },
        },
      ],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.parts).toEqual([
      {
        type: "chain",
        state: "complete",
        steps: [
          {
            type: "tool",
            callId: "ask-1",
            name: "ask",
            state: "completed",
            summary: "Operator response recorded.",
          },
        ],
      },
    ]);
  });

  it("projects failed terminal reports as error parts", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [],
      commands: [],
      reports: [
        {
          id: "run-failed",
          kind: "run.update",
          title: "Coding run failed",
          text: "The daemon lost the worker process.",
          role: null,
          status: "failed",
          createdAt: "2026-07-10T00:00:01.000Z",
        },
      ],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      id: "report:run-failed",
      body: "The daemon lost the worker process.",
      title: null,
      parts: [
        {
          type: "error",
          title: "Coding run failed",
          message: "The daemon lost the worker process.",
        },
      ],
    });
  });

  it("merges consecutive spark tool turns into one thinking chain with result text", () => {
    const timeline = buildSessionTimeline({
      fallbackTimestamp: "2026-07-10T00:00:00.000Z",
      messages: [
        {
          version: 1 as const,
          id: "a1",
          role: "assistant",
          text: "我来列一下目录。",
          status: "done",
          createdAt: "2026-07-10T00:00:01.000Z",
          parts: [
            {
              id: "a1:thinking",
              type: "thinking",
              status: "complete",
              text: "用 cue_exec 列目录",
              metadata: {},
            },
            {
              id: "a1:text",
              type: "text",
              status: "complete",
              text: "我来列一下目录。",
              metadata: {},
            },
            {
              id: "a1:call",
              type: "tool-call",
              status: "pending",
              toolCallId: "call-1",
              toolName: "cue_exec",
              summary: "command=ls",
              metadata: {},
            },
          ],
          metadata: {},
        },
        {
          version: 1 as const,
          id: "tool-result:call-1",
          role: "tool",
          text: ".cursor/\n.github/\nREADME.md",
          status: "done",
          toolCallId: "call-1",
          toolName: "cue_exec",
          createdAt: "2026-07-10T00:00:02.000Z",
          parts: [
            {
              id: "tool-result:call-1:part",
              type: "tool-result",
              status: "complete",
              toolCallId: "call-1",
              toolName: "cue_exec",
              summary: ".cursor/\n.github/\nREADME.md",
              metadata: {},
            },
          ],
          metadata: {},
        },
        {
          version: 1 as const,
          id: "a2",
          role: "assistant",
          text: "当前目录内容如上。",
          status: "done",
          createdAt: "2026-07-10T00:00:03.000Z",
          parts: [
            {
              id: "a2:text",
              type: "text",
              status: "complete",
              text: "当前目录内容如上。",
              metadata: {},
            },
          ],
          metadata: {},
        },
      ],
      commands: [],
      reports: [],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.parts.map((part) => part.type)).toEqual(["chain", "text", "text"]);
    const chain = timeline[0]?.parts[0];
    expect(chain).toMatchObject({ type: "chain", state: "complete" });
    if (chain?.type !== "chain") throw new Error("expected chain part");
    expect(chain.steps).toEqual([
      {
        type: "reasoning",
        summary: "用 cue_exec 列目录",
        state: "complete",
        redacted: false,
      },
      {
        type: "tool",
        callId: "call-1",
        name: "cue_exec",
        state: "completed",
        summary: ".cursor/\n.github/\nREADME.md",
      },
    ]);
    expect(JSON.stringify(timeline[0]?.parts)).not.toMatch(/call-1\|/);
  });
});

function timelineItem(id: string, actor: "user" | "spark" | "session"): SessionTimelineItem {
  return {
    id,
    actor,
    body: id,
    title: null,
    status: null,
    timestamp: "2026-07-10T00:00:00.000Z",
    meta: null,
    senderLabel: null,
    order: 0,
    parts: [{ type: "text", text: id, streaming: false }],
  };
}

function message(
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  createdAt: string,
  metadata: SparkJsonObject = {},
) {
  return {
    version: 1 as const,
    id,
    role,
    text,
    status: "done" as const,
    createdAt,
    metadata,
  };
}

function retryableFailure(prefix: string, prompt: string, second: number) {
  const invocationId = `inv_${prefix}`;
  return [
    message(`${prefix}-user`, "user", prompt, `2026-07-10T00:00:0${second}.000Z`, { invocationId }),
    {
      ...message(
        `${prefix}-failure`,
        "system",
        `${prefix} failed`,
        `2026-07-10T00:00:0${second + 1}.000Z`,
        { invocationId, conversationVisible: true, errorTitle: "Spark" },
      ),
      status: "error" as const,
    },
  ];
}
