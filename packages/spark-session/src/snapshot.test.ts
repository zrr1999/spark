import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { loadSparkSessionSnapshot } from "./snapshot.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadSparkSessionSnapshot", () => {
  it("projects ordered thinking and tool parts without leaking native tool payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-snapshot-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const entries = [
      {
        type: "session",
        version: 3,
        id: "sess_parts",
        timestamp: "2026-07-13T01:00:00.000Z",
        cwd: "/workspace/demo",
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-07-13T01:00:01.000Z",
        message: { role: "user", content: "Inspect the repository", timestamp: 1783904401000 },
      },
      {
        type: "message",
        id: "assistant-inactive",
        parentId: "user-1",
        timestamp: "2026-07-13T01:00:01.500Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret-inactive-thinking" },
            {
              type: "toolCall",
              id: "call-inactive",
              name: "inactive-tool",
              arguments: { token: "secret-inactive-argument" },
            },
          ],
          timestamp: 1783904401500,
        },
      },
      {
        type: "message",
        id: "assistant-tools",
        parentId: "user-1",
        timestamp: "2026-07-13T01:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Check the relevant files first." },
            { type: "text", text: "I will inspect the repository." },
            {
              type: "toolCall",
              id: "call-success",
              name: "read",
              arguments: { path: "secret-input.txt", token: "secret-token" },
            },
            {
              type: "toolCall",
              id: "call-failure",
              name: "exec",
              arguments: { command: "print-secret-input" },
            },
          ],
          timestamp: 1783904402000,
        },
      },
      {
        type: "message",
        id: "result-success",
        parentId: "assistant-tools",
        timestamp: "2026-07-13T01:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-success",
          toolName: "read",
          content: [{ type: "text", text: "secret-output" }],
          details: { token: "secret-details" },
          isError: false,
          timestamp: 1783904403000,
        },
      },
      {
        type: "message",
        id: "result-failure",
        parentId: "result-success",
        timestamp: "2026-07-13T01:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-failure",
          toolName: "exec",
          content: [{ type: "text", text: "secret-error-output" }],
          details: { stderr: "secret-error-details" },
          isError: true,
          timestamp: 1783904404000,
        },
      },
      {
        type: "message",
        id: "assistant-pending",
        parentId: "result-failure",
        timestamp: "2026-07-13T01:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "secret-redacted-thinking",
              thinkingSignature: "secret-signature",
              redacted: true,
            },
            {
              type: "toolCall",
              id: "call-pending",
              name: "search",
              arguments: { pattern: "secret-pattern" },
            },
            { type: "text", text: "The next check is pending." },
          ],
          timestamp: 1783904405000,
        },
      },
    ];
    await writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const session = parseSparkSessionRegistryRecord({
      sessionId: "sess_parts",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      status: "running",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-07-13T01:00:00.000Z",
      updatedAt: "2026-07-13T01:00:05.000Z",
    });

    const snapshot = await loadSparkSessionSnapshot({ sessionsRoot: root, session });

    expect(snapshot.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-tools",
      "result-success",
      "result-failure",
      "assistant-pending",
    ]);
    expect(snapshot.messages).toMatchObject([
      {
        id: "user-1",
        role: "user",
        text: "Inspect the repository",
        parts: [{ id: "user-1:part:0", type: "text", status: "complete" }],
      },
      {
        id: "assistant-tools",
        role: "assistant",
        text: "I will inspect the repository.",
        status: "done",
        parts: [
          {
            id: "assistant-tools:part:0",
            type: "thinking",
            status: "complete",
            text: "Check the relevant files first.",
          },
          { id: "assistant-tools:part:1", type: "text", status: "complete" },
          {
            id: "assistant-tools:part:2",
            type: "tool-call",
            toolCallId: "call-success",
            toolName: "read",
            status: "complete",
          },
          {
            id: "assistant-tools:part:3",
            type: "tool-call",
            toolCallId: "call-failure",
            toolName: "exec",
            status: "failed",
          },
        ],
      },
      {
        id: "result-success",
        role: "tool",
        text: "",
        status: "done",
        parts: [
          {
            id: "result-success:part:0",
            type: "tool-result",
            toolCallId: "call-success",
            status: "complete",
          },
        ],
      },
      {
        id: "result-failure",
        role: "tool",
        text: "",
        status: "error",
        parts: [
          {
            id: "result-failure:part:0",
            type: "tool-result",
            toolCallId: "call-failure",
            status: "failed",
          },
        ],
      },
      {
        id: "assistant-pending",
        role: "assistant",
        text: "The next check is pending.",
        parts: [
          {
            id: "assistant-pending:part:0",
            type: "thinking",
            text: "",
            redacted: true,
          },
          {
            id: "assistant-pending:part:1",
            type: "tool-call",
            toolCallId: "call-pending",
            status: "pending",
          },
          { id: "assistant-pending:part:2", type: "text" },
        ],
      },
    ]);
    expect(snapshot.tools).toMatchObject([
      { id: "call-success", name: "read", status: "succeeded" },
      { id: "call-failure", name: "exec", status: "failed" },
      { id: "call-pending", name: "search", status: "pending" },
    ]);
    expect(snapshot.tools.map((tool) => tool.id)).toEqual([
      "call-success",
      "call-failure",
      "call-pending",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /secret-input|secret-token|secret-output|secret-details|secret-pattern|secret-signature|secret-redacted-thinking|secret-inactive/u,
    );
  });
});
