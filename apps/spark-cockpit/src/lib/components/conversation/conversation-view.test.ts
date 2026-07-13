import type { SparkMessageView } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import { conversationPartsFromMessage } from "./conversation-view";

describe("Cockpit conversation view adapter", () => {
  it("keeps the legacy text field as a compatible presentation fallback", () => {
    const parts = conversationPartsFromMessage(message({ text: "Hello from Spark" }));

    expect(parts).toEqual([{ type: "text", text: "Hello from Spark", streaming: false }]);
  });

  it("maps structured Spark parts without exposing raw tool payload fields", () => {
    const parts = conversationPartsFromMessage(
      message({
        text: "",
        parts: [
          {
            id: "part-thinking",
            type: "thinking",
            status: "complete",
            text: "Checked the workspace boundary.",
            metadata: {},
          },
          {
            id: "part-call",
            type: "tool-call",
            status: "running",
            toolCallId: "call-1",
            toolName: "shell",
            summary: "Run focused checks",
            metadata: { rawArguments: "must-not-render" },
          },
          {
            id: "part-result",
            type: "tool-result",
            status: "complete",
            toolCallId: "call-1",
            toolName: "shell",
            summary: "Checks passed",
            metadata: { rawOutput: "must-not-render" },
          },
        ],
      }),
    );

    expect(parts).toEqual([
      {
        type: "reasoning",
        summary: "Checked the workspace boundary.",
        state: "complete",
        redacted: false,
      },
      {
        type: "tool",
        callId: "call-1",
        name: "shell",
        state: "completed",
        summary: "Checks passed",
      },
    ]);
    expect(JSON.stringify(parts)).not.toContain("must-not-render");
  });

  it("preserves the daemon order of thinking, text, and tool parts", () => {
    const parts = conversationPartsFromMessage(
      message({
        text: "",
        status: "streaming",
        parts: [
          {
            id: "thinking",
            type: "thinking",
            status: "streaming",
            text: "Inspecting the project",
            metadata: {},
          },
          {
            id: "text",
            type: "text",
            status: "streaming",
            text: "I found the relevant package.",
            metadata: {},
          },
          {
            id: "call",
            type: "tool-call",
            status: "running",
            toolCallId: "call-ordered",
            toolName: "read_file",
            metadata: {},
          },
        ],
      }),
    );

    expect(parts.map((part) => part.type)).toEqual(["reasoning", "text", "tool"]);
    expect(parts[0]).toMatchObject({ state: "streaming" });
    expect(parts[1]).toMatchObject({ streaming: true });
    expect(parts[2]).toMatchObject({ state: "running" });
  });

  it("honors redacted thinking without copying its text into component props", () => {
    const parts = conversationPartsFromMessage(
      message({
        text: "",
        parts: [
          {
            id: "part-thinking",
            type: "thinking",
            status: "complete",
            text: "private chain of thought",
            redacted: true,
            metadata: {},
          },
        ],
      }),
    );

    expect(parts).toEqual([{ type: "reasoning", summary: "", state: "complete", redacted: true }]);
  });

  it("maps host-neutral artifact and error parts without exposing unrelated fields", () => {
    const parts = conversationPartsFromMessage({
      ...message({ text: "" }),
      parts: [
        {
          type: "artifact",
          artifactRef: "artifact:art-1",
          title: "Focused check report",
          kind: "report",
          status: "completed",
          summary: "All focused checks passed.",
          rawPayload: "must-not-render",
        },
        {
          type: "error",
          title: "Run failed",
          message: "The daemon returned a terminal failure.",
          code: "DAEMON_RUN_FAILED",
          stack: "must-not-render",
        },
      ],
    } as unknown as SparkMessageView);

    expect(parts).toEqual([
      {
        type: "artifact",
        artifactRef: "artifact:art-1",
        title: "Focused check report",
        kind: "report",
        state: "completed",
        summary: "All focused checks passed.",
      },
      {
        type: "error",
        title: "Run failed",
        message: "The daemon returned a terminal failure.",
        code: "DAEMON_RUN_FAILED",
      },
    ]);
    expect(JSON.stringify(parts)).not.toContain("must-not-render");
  });
});

function message(
  overrides: Partial<SparkMessageView> & { parts?: SparkMessageView["parts"] } = {},
): SparkMessageView {
  return {
    version: 1,
    id: "message-1",
    role: "assistant",
    text: "",
    status: "done",
    metadata: {},
    ...overrides,
  };
}
