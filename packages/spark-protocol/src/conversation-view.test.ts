import { describe, expect, it } from "vitest";
import { parseSparkSessionView, sparkTextPhaseFromSignature } from "./index.ts";

describe("Spark conversation view protocol", () => {
  it("keeps legacy text-only snapshots compatible", () => {
    const parsed = parseSparkSessionView({
      sessionId: "sess_legacy",
      messages: [{ id: "message-1", role: "assistant", text: "legacy reply" }],
    });

    expect(parsed.messages[0]).toMatchObject({
      id: "message-1",
      role: "assistant",
      text: "legacy reply",
      status: "done",
    });
    expect(parsed.messages[0]).not.toHaveProperty("parts");
    expect(parsed.mailbox).toBeUndefined();
  });

  it("parses the display-safe session mailbox projection", () => {
    const parsed = parseSparkSessionView({
      sessionId: "sess_mailbox",
      mailbox: [
        {
          id: "mail:1",
          fromSessionId: "sess_sender",
          kind: "request",
          intent: "review.pull-request",
          subject: "Review PR #42",
          body: "Please review the pending change.",
          createdAt: "2026-07-14T03:00:00.000Z",
          readAt: null,
          ackedAt: null,
        },
      ],
    });

    expect(parsed.mailbox).toEqual([
      {
        id: "mail:1",
        fromSessionId: "sess_sender",
        kind: "request",
        intent: "review.pull-request",
        subject: "Review PR #42",
        body: "Please review the pending change.",
        createdAt: "2026-07-14T03:00:00.000Z",
        readAt: null,
        ackedAt: null,
      },
    ]);
  });

  it("parses question messages in the session mailbox projection", () => {
    const parsed = parseSparkSessionView({
      sessionId: "sess_target",
      mailbox: [
        {
          id: "mail:question",
          fromSessionId: "sess_sender",
          kind: "question",
          intent: "delegate.question",
          subject: null,
          body: "What changed?",
          createdAt: "2026-07-15T03:00:00.000Z",
          readAt: null,
          ackedAt: null,
        },
      ],
    });

    expect(parsed.mailbox?.[0]?.kind).toBe("question");
  });

  it("parses ordered host-neutral conversation parts", () => {
    const parsed = parseSparkSessionView({
      sessionId: "sess_parts",
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          text: "Done",
          parts: [
            {
              id: "assistant-1:part:0",
              type: "thinking",
              status: "complete",
              text: "Check the repository first.",
            },
            {
              id: "assistant-1:part:1",
              type: "tool-call",
              status: "complete",
              toolCallId: "call-1",
              toolName: "read",
            },
            {
              id: "assistant-1:part:2",
              type: "text",
              status: "complete",
              text: "Done",
              phase: "final_answer",
            },
            {
              id: "assistant-1:part:3",
              type: "text",
              status: "complete",
              text: "Checking one more thing.",
              phase: "commentary",
            },
          ],
        },
      ],
    });

    expect(parsed.messages[0]?.parts).toEqual([
      {
        id: "assistant-1:part:0",
        type: "thinking",
        status: "complete",
        text: "Check the repository first.",
        metadata: {},
      },
      {
        id: "assistant-1:part:1",
        type: "tool-call",
        status: "complete",
        toolCallId: "call-1",
        toolName: "read",
        metadata: {},
      },
      {
        id: "assistant-1:part:2",
        type: "text",
        status: "complete",
        text: "Done",
        phase: "final_answer",
        metadata: {},
      },
      {
        id: "assistant-1:part:3",
        type: "text",
        status: "complete",
        text: "Checking one more thing.",
        phase: "commentary",
        metadata: {},
      },
    ]);
  });

  it("extracts only known display phases from opaque text signatures", () => {
    expect(
      sparkTextPhaseFromSignature(
        JSON.stringify({ v: 1, phase: "commentary", secret: "must-not-project" }),
      ),
    ).toBe("commentary");
    expect(sparkTextPhaseFromSignature(JSON.stringify({ phase: "final_answer" }))).toBe(
      "final_answer",
    );
    expect(sparkTextPhaseFromSignature(JSON.stringify({ phase: "unknown" }))).toBeUndefined();
    expect(sparkTextPhaseFromSignature("not-json")).toBeUndefined();
    expect(sparkTextPhaseFromSignature({ phase: "commentary" })).toBeUndefined();
  });
});
