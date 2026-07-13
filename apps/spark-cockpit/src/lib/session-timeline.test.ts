import { describe, expect, it } from "vitest";
import type { SparkJsonObject } from "@zendev-lab/spark-protocol";
import { buildSessionTimeline } from "./session-timeline";

describe("session timeline", () => {
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

  it("keeps only the latest stable run, task, and artifact projections", () => {
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

    expect(timeline).toHaveLength(3);
    expect(timeline.map((item) => item.body)).toEqual([
      "Latest projection.",
      "Latest projection.",
      "Latest projection.",
    ]);
    expect(new Set(timeline.map((item) => item.id)).size).toBe(3);
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
        type: "tool",
        callId: "call-1",
        name: "shell",
        state: "completed",
        summary: "Tests passed",
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
        type: "tool",
        callId: "call-secret",
        name: "shell",
        state: "running",
        summary: "Run checks",
      },
    ]);
    expect(JSON.stringify(timeline)).not.toContain("super-secret");
  });

  it("projects artifact reports as navigable artifact parts", () => {
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
      ],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      id: "report:art-focused-report",
      body: "All focused checks passed.",
      title: null,
      parts: [
        {
          type: "artifact",
          artifactRef: "artifact:art-focused-report",
          title: "Focused check report",
          kind: "report",
          state: "completed",
          summary: "All focused checks passed.",
        },
      ],
    });
  });

  it("projects reload-safe task and artifact updates as structured cards", () => {
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
      {
        type: "artifact",
        artifactRef: "artifact:check-report",
        title: "Focused check report",
        kind: "artifact",
        state: "completed",
        summary: "All checks passed.",
      },
    ]);
  });

  it("merges an interaction request and response without calling an answer approved", () => {
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
        type: "approval",
        requestId: "ask-1",
        title: "Choose the next step",
        state: "resolved",
        kind: "askFlow",
        summary: "Continue with the focused fix?",
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
});

function message(
  id: string,
  role: "user" | "assistant",
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
