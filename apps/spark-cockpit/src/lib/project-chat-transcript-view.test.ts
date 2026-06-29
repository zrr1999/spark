import { describe, expect, it } from "vitest";
import {
  activityKind,
  buildProjectChatTranscriptTurns,
  type ProjectChatCommand,
  type ProjectChatInvocation,
  type ProjectChatLogChunk,
} from "./project-chat-transcript-view";

const labels = {
  waitingAnswer: "waiting",
  runningAnswer: "running",
  completedAnswer: "completed",
  errorAnswer: "error",
  cancelledAnswer: "cancelled",
  latestOutputPrefix: "latest:",
};

function command(overrides: Partial<ProjectChatCommand> = {}): ProjectChatCommand {
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

function invocation(overrides: Partial<ProjectChatInvocation> = {}): ProjectChatInvocation {
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

function log(overrides: Partial<ProjectChatLogChunk> = {}): ProjectChatLogChunk {
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

describe("project chat transcript view model", () => {
  it("renders assistant streaming as a running turn with latest readable output", () => {
    const turns = buildProjectChatTranscriptTurns(
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

  it("classifies completed tool success logs as successful run details", () => {
    const successLog = log({ content: "tests passed successfully" });
    const turns = buildProjectChatTranscriptTurns(
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
    const turns = buildProjectChatTranscriptTurns(
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
    const turns = buildProjectChatTranscriptTurns(
      [command({ status: "rejected", deliveryStatus: "rejected" })],
      [],
      [],
      labels,
    );

    expect(turns[0]?.status).toBe("error");
    expect(turns[0]?.answer).toBe("error");
  });

  it("preserves multiline markdown/html-like text as plain view-model text", () => {
    const markdown = "## Result\n- keep markdown literal\n<script>alert('x')</script>";
    const turns = buildProjectChatTranscriptTurns(
      [command()],
      [invocation({ status: "completed" })],
      [log({ content: markdown })],
      labels,
    );

    expect(turns[0]?.answer).toBe(`latest:\n${markdown}`);
  });

  it("filters structured JSON control chunks out of assistant answer excerpts", () => {
    const turns = buildProjectChatTranscriptTurns(
      [command()],
      [invocation({ status: "completed" })],
      [log({ content: JSON.stringify({ type: "tool", name: "read" }) })],
      labels,
    );

    expect(turns[0]?.answer).toBe("completed");
    expect(turns[0]?.logs).toHaveLength(1);
  });
});
