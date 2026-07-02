import { describe, expect, it } from "vitest";
import {
  activityKind,
  buildCockpitChatTranscriptTurns,
  orderedAssistantOutput,
  orderedAssistantRenderSource,
  type CockpitChatCommand,
  type CockpitChatInvocation,
  type CockpitChatLogChunk,
} from "./cockpit-chat-transcript-view";

const labels = {
  waitingAnswer: "waiting",
  runningAnswer: "running",
  completedAnswer: "completed",
  errorAnswer: "error",
  cancelledAnswer: "cancelled",
  latestOutputPrefix: "latest:",
};

function command(overrides: Partial<CockpitChatCommand> = {}): CockpitChatCommand {
  return {
    id: "cmd-1",
    kind: "task.start.request",
    title: "Fallback title",
    payloadJson: JSON.stringify({
      payload: { prompt: "Summarize project", runtimeTaskId: "task-1" },
    }),
    status: "acked",
    deliveryStatus: "acked",
    createdAt: "2026-06-29T10:00:00.000Z",
    ...overrides,
  };
}

function invocation(overrides: Partial<CockpitChatInvocation> = {}): CockpitChatInvocation {
  return {
    id: "inv-row-1",
    runtimeInvocationId: "inv-1",
    taskRuntimeId: "task-1",
    agentName: "Spark",
    status: "running",
    updatedAt: "2026-06-29T10:01:00.000Z",
    ...overrides,
  };
}

function log(overrides: Partial<CockpitChatLogChunk> = {}): CockpitChatLogChunk {
  return {
    id: "log-1",
    runtimeInvocationId: "inv-1",
    agentName: "Spark",
    stream: "stdout",
    sequence: 1,
    content: "Planning next step",
    createdAt: "2026-06-29T10:01:01.000Z",
    ...overrides,
  };
}

describe("cockpit chat transcript view model", () => {
  it("renders assistant streaming as a running turn with latest readable output", () => {
    const turns = buildCockpitChatTranscriptTurns(
      [command()],
      [invocation({ status: "running" })],
      [log({ content: "Streaming assistant text\nwith another line" })],
      labels,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.prompt).toBe("Summarize project");
    expect(turns[0]?.status).toBe("running");
    expect(turns[0]?.answer).toContain("latest:\nStreaming assistant text");
    expect(turns[0]?.currentActivity).toBe("Streaming assistant text");
  });

  it("assembles assistant token chunks in sequence order", () => {
    const chunks = [
      log({ id: "log-3", stream: "assistant", sequence: 3, content: "!" }),
      log({ id: "log-1", stream: "assistant", sequence: 1, content: "Hello" }),
      log({ id: "log-2", stream: "assistant", sequence: 2, content: " world" }),
      log({ id: "log-system", stream: "system", sequence: 4, content: "done" }),
    ];
    const turns = buildCockpitChatTranscriptTurns(
      [command()],
      [invocation({ status: "running" })],
      chunks,
      labels,
    );

    expect(orderedAssistantOutput(chunks)).toBe("Hello world!");
    expect(orderedAssistantRenderSource(chunks)).toBe("Hello world!");
    expect(turns[0]?.answer).toBe("latest:\nHello world!");
    expect(turns[0]?.renderSource).toBe("Hello world!");
  });

  it("classifies completed tool success logs as successful run details", () => {
    const successLog = log({ content: "tests passed successfully" });
    const turns = buildCockpitChatTranscriptTurns(
      [command()],
      [invocation({ status: "completed" })],
      [successLog],
      labels,
    );

    expect(turns[0]?.status).toBe("completed");
    expect(activityKind(successLog)).toBe("success");
    expect(turns[0]?.logs).toEqual([successLog]);
  });

  it("promotes stderr/tool failure output to an actionable error card", () => {
    const errorLog = log({ stream: "stderr", content: "tool failed: missing config" });
    const turns = buildCockpitChatTranscriptTurns(
      [command()],
      [invocation({ status: "running" })],
      [errorLog],
      labels,
    );

    expect(turns[0]?.status).toBe("error");
    expect(turns[0]?.answer).toBe("error");
    expect(activityKind(errorLog)).toBe("error");
  });

  it("renders command rejection without logs as a system error card", () => {
    const turns = buildCockpitChatTranscriptTurns(
      [command({ status: "rejected", deliveryStatus: "rejected" })],
      [],
      [],
      labels,
    );

    expect(turns[0]?.status).toBe("error");
    expect(turns[0]?.answer).toBe("error");
  });

  it("preserves multiline markdown/html-like text as render source without executing it", () => {
    const markdown = "## Result\n- keep markdown literal\n<script>alert('x')</script>";
    const turns = buildCockpitChatTranscriptTurns(
      [command()],
      [invocation({ status: "completed" })],
      [log({ content: markdown })],
      labels,
    );

    expect(turns[0]?.answer).toBe(`latest:\n${markdown}`);
    expect(turns[0]?.renderSource).toBe(markdown);
  });

  it("keeps full assistant render source while bounding the compact answer", () => {
    const longMarkdown = `## Result\n${"a".repeat(700)}`;
    const turns = buildCockpitChatTranscriptTurns(
      [command()],
      [invocation({ status: "running" })],
      [log({ stream: "assistant", content: longMarkdown })],
      labels,
    );

    expect(turns[0]?.renderSource).toBe(longMarkdown);
    expect(turns[0]?.answer).toContain("…");
    expect(turns[0]?.answer.length).toBeLessThan(longMarkdown.length);
  });

  it("filters structured JSON control chunks out of assistant answer excerpts", () => {
    const turns = buildCockpitChatTranscriptTurns(
      [command()],
      [invocation({ status: "completed" })],
      [log({ content: JSON.stringify({ type: "tool", name: "read" }) })],
      labels,
    );

    expect(turns[0]?.answer).toBe("completed");
    expect(turns[0]?.renderSource).toBeNull();
    expect(turns[0]?.logs).toHaveLength(1);
  });

  it("extracts assistant text from serialized Spark JSON events", () => {
    const chunk = log({
      stream: "assistant",
      content: JSON.stringify({
        type: "stream_event",
        event: {
          type: "done",
          message: { role: "assistant", content: [{ type: "text", text: "JSON final" }] },
        },
      }),
    });
    const turns = buildCockpitChatTranscriptTurns(
      [command()],
      [invocation({ status: "completed" })],
      [chunk],
      labels,
    );

    expect(turns[0]?.answer).toBe("latest:\nJSON final");
    expect(turns[0]?.renderSource).toBe("JSON final");
  });

  it("does not show daemon startup boilerplate as assistant output", () => {
    const turns = buildCockpitChatTranscriptTurns(
      [command()],
      [invocation({ status: "completed" })],
      [log({ stream: "system", content: "Spark runtime role-run started." })],
      labels,
    );

    expect(turns[0]?.answer).toBe("completed");
    expect(turns[0]?.renderSource).toBeNull();
  });
});
