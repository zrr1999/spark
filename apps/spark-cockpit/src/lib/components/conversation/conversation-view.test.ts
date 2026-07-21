import type { SparkMessageView } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import {
  conversationPartsFromMessage,
  groupThinkingChainParts,
  visibleConversationParts,
  visibleConversationPartText,
} from "./conversation-view";
import { visibleThinkingChainSteps } from "./thinking-chain-view";

describe("Cockpit conversation view adapter", () => {
  it("keeps the legacy text field as a compatible presentation fallback", () => {
    const parts = conversationPartsFromMessage(message({ text: "Hello from Spark" }));

    expect(parts).toEqual([{ type: "text", text: "Hello from Spark", streaming: false }]);
  });

  it("prepends a channel quote part above the user body", () => {
    const parts = conversationPartsFromMessage(
      message({
        role: "user",
        text: "请继续",
        metadata: {
          channel: {
            adapter: "qqbot",
            externalKey: "qqbot:c2c:u1",
            messageReference: {
              messageId: "m-source",
              preview: "被引用原文",
              senderName: "Alice",
              source: "embedded",
            },
          },
        },
      }),
    );

    expect(parts).toEqual([
      { type: "quote", text: "被引用原文", senderLabel: "Alice" },
      { type: "text", text: "请继续", streaming: false },
    ]);
  });

  it("turns a terminal message failure into a visible error part", () => {
    const parts = conversationPartsFromMessage(
      message({
        role: "system",
        text: "provider unavailable",
        status: "error",
        metadata: { errorTitle: "Session interrupted", terminalStatus: "lost" },
      }),
    );

    expect(parts).toEqual([
      { type: "error", title: "Session interrupted", message: "provider unavailable" },
    ]);
  });

  it("keeps a failed tool inside execution state without synthesizing a conversation error", () => {
    const parts = conversationPartsFromMessage(
      message({
        role: "tool",
        text: "cue-shell transport failed",
        status: "error",
        parts: [
          {
            id: "tool-failure",
            type: "tool-result",
            status: "failed",
            toolCallId: "call-cue",
            toolName: "cue_exec",
            summary: "cue_exec failed",
            metadata: {},
          },
        ],
      }),
    );

    expect(parts).toEqual([
      {
        type: "tool",
        callId: "call-cue",
        name: "cue_exec",
        state: "failed",
        summary: "cue_exec failed",
      },
    ]);
  });

  it("does not promote a structured cue transport failure into a terminal conversation error", () => {
    const transportError =
      "cue-shell error [TRANSPORT_RESOLVE_FAILED]: failed to resolve cue-shell client transport";
    const parts = conversationPartsFromMessage(
      message({
        role: "assistant",
        text: transportError,
        status: "error",
        parts: [
          {
            id: "tool-failure",
            type: "tool-result",
            status: "failed",
            toolCallId: "call-cue",
            toolName: "cue_exec",
            summary: transportError,
            metadata: {},
          },
        ],
      }),
    );

    expect(parts).toEqual([
      {
        type: "tool",
        callId: "call-cue",
        name: "cue_exec",
        state: "failed",
        summary: transportError,
      },
    ]);
    expect(parts.some((part) => part.type === "error")).toBe(false);
    const visible = visibleConversationParts(groupThinkingChainParts(parts));
    expect(visible).toEqual([
      {
        type: "chain",
        state: "complete",
        steps: [
          {
            type: "tool",
            callId: "call-cue",
            name: "cue_exec",
            state: "failed",
            summary: transportError,
          },
        ],
      },
    ]);
    const chain = visible[0];
    expect(chain?.type).toBe("chain");
    expect(
      JSON.stringify(chain?.type === "chain" ? visibleThinkingChainSteps(chain.steps) : []),
    ).not.toContain("TRANSPORT_RESOLVE_FAILED");
  });

  it("presents a roundtrip budget stop as incomplete work without exposing the guard text", () => {
    const parts = conversationPartsFromMessage(
      message({
        role: "assistant",
        text: "agent loop hit maxRoundtrips=16; stopping",
        status: "error",
        metadata: {
          errorMessage: "agent loop hit maxRoundtrips=16; stopping",
          outcomeStatus: "budget_exhausted",
        },
      }),
    );

    expect(parts).toEqual([{ type: "notice", kind: "budget_exhausted" }]);
    expect(visibleConversationPartText(parts)).toBe("");
  });

  it("maps structured Spark parts without exposing raw tool payload fields", () => {
    const parts = conversationPartsFromMessage(
      message({
        // Snapshot text may contain a display-safe tool summary. Structured
        // activity still owns it; it must not be reintroduced as answer prose.
        text: "command=pwd",
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

  it("groups reasoning and tools into one thinking chain for presentation", () => {
    const parts = groupThinkingChainParts([
      {
        type: "reasoning",
        summary: "Plan the listing",
        state: "complete",
      },
      {
        type: "text",
        text: "Listing now.",
        streaming: false,
      },
      {
        type: "tool",
        callId: "call-1",
        name: "cue_exec",
        state: "completed",
        summary: ".cursor/\nREADME.md",
      },
    ]);

    expect(parts.map((part) => part.type)).toEqual(["chain", "text"]);
    expect(parts[0]).toMatchObject({
      type: "chain",
      state: "complete",
      steps: [
        { type: "reasoning", summary: "Plan the listing" },
        { type: "tool", name: "cue_exec", summary: ".cursor/\nREADME.md" },
      ],
    });
  });

  it("retains completed execution for collapsed history without copying it", () => {
    const parts = groupThinkingChainParts([
      {
        type: "commentary",
        summary: "Inspect the workspace",
        state: "complete",
      },
      {
        type: "tool",
        callId: "call-success",
        name: "cue_exec",
        state: "completed",
        summary: "Checks passed",
      },
      {
        type: "text",
        text: "The workspace is ready.",
        streaming: false,
      },
    ]);

    expect(visibleConversationParts(parts).map((part) => part.type)).toEqual(["chain", "text"]);
    expect(visibleConversationPartText(parts)).toBe("The workspace is ready.");
  });

  it("retains a failed process step without copying internal output", () => {
    const parts = groupThinkingChainParts([
      {
        type: "tool",
        callId: "call-failed",
        name: "cue_exec",
        state: "failed",
        summary: "Execution failed",
      },
    ]);

    expect(visibleConversationParts(parts)).toMatchObject([
      { type: "chain", steps: [{ type: "tool", state: "failed" }] },
    ]);
    expect(visibleConversationPartText(parts)).toBe("");
  });

  it("keeps provider commentary inside the execution chain instead of answer prose", () => {
    const parts = conversationPartsFromMessage(
      message({
        text: "",
        parts: [
          {
            id: "commentary",
            type: "text",
            phase: "commentary",
            status: "complete",
            text: "确认当前目录。",
            metadata: {},
          },
          {
            id: "call",
            type: "tool-call",
            status: "complete",
            toolCallId: "call-pwd",
            toolName: "cue_exec",
            metadata: {},
          },
        ],
      }),
    );

    expect(parts).toEqual([
      { type: "commentary", summary: "确认当前目录。", state: "complete" },
      {
        type: "tool",
        callId: "call-pwd",
        name: "cue_exec",
        state: "completed",
      },
    ]);
    expect(groupThinkingChainParts(parts)).toMatchObject([
      {
        type: "chain",
        steps: [
          { type: "commentary", summary: "确认当前目录。" },
          { type: "tool", name: "cue_exec" },
        ],
      },
    ]);
  });

  it("keeps final-answer text as normal assistant prose", () => {
    const parts = conversationPartsFromMessage(
      message({
        text: "当前工作目录是 /workspace/spark。",
        parts: [
          {
            id: "answer",
            type: "text",
            phase: "final_answer",
            status: "complete",
            text: "当前工作目录是 /workspace/spark。",
            metadata: {},
          },
        ],
      }),
    );

    expect(parts).toEqual([
      { type: "text", text: "当前工作目录是 /workspace/spark。", streaming: false },
    ]);
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
