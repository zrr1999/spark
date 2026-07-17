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
  it("projects lifetime usage, current context, runtime selection, and daemon-local branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-usage-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const entries = [
      {
        type: "session",
        version: 3,
        id: "sess_usage",
        timestamp: "2026-07-17T01:00:00.000Z",
        cwd: "/workspace/demo",
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-07-17T01:00:01.000Z",
        message: { role: "user", content: "first" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-07-17T01:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
          api: "openai-responses",
          provider: "baidu-oneapi",
          model: "gpt-5.6-sol",
          stopReason: "stop",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 50,
            cacheWrite: 10,
            totalTokens: 180,
            cost: { input: 0.02, output: 0.03, cacheRead: 0.01, cacheWrite: 0.04, total: 0.1 },
            providerSecret: "must-not-project",
          },
          providerSecret: "must-not-project",
        },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "assistant-1",
        timestamp: "2026-07-17T01:00:03.000Z",
      },
      {
        type: "message",
        id: "user-2",
        parentId: "compact-1",
        timestamp: "2026-07-17T01:00:04.000Z",
        message: { role: "user", content: "second" },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "user-2",
        timestamp: "2026-07-17T01:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second response" }],
          api: "openai-responses",
          provider: "baidu-oneapi",
          model: "gpt-5.6-sol",
          stopReason: "stop",
          usage: {
            input: 40,
            output: 10,
            cacheRead: 160,
            cacheWrite: 0,
            totalTokens: 210,
            cost: { input: 0.04, output: 0.06, cacheRead: 0.1, cacheWrite: 0, total: 0.2 },
          },
        },
      },
    ];
    await writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const session = parseSparkSessionRegistryRecord({
      sessionId: "sess_usage",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      status: "ready",
      sessionPath: transcriptPath,
      model: { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" },
      thinkingLevel: "xhigh",
      bindings: [],
      createdAt: "2026-07-17T01:00:00.000Z",
      updatedAt: "2026-07-17T01:00:05.000Z",
    });

    const snapshot = await loadSparkSessionSnapshot({
      sessionsRoot: root,
      session,
      resolveGitBranch: async (cwd) => (cwd === "/workspace/demo" ? "main" : undefined),
    });

    expect(snapshot).toMatchObject({
      cwd: "/workspace/demo",
      gitBranch: "main",
      model: { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" },
      thinkingLevel: "xhigh",
      usage: {
        inputTokens: 140,
        outputTokens: 30,
        cacheReadTokens: 210,
        cacheWriteTokens: 10,
        costUsd: expect.closeTo(0.3, 10),
        latestCacheHitPercent: 80,
        contextTokens: 210,
      },
    });
    expect(snapshot.messages.find((message) => message.id === "assistant-2")?.metadata).toEqual({
      api: "openai-responses",
      provider: "baidu-oneapi",
      model: "gpt-5.6-sol",
      stopReason: "stop",
      usage: {
        input: 40,
        output: 10,
        cacheRead: 160,
        cacheWrite: 0,
        totalTokens: 210,
        cost: { input: 0.04, output: 0.06, cacheRead: 0.1, cacheWrite: 0, total: 0.2 },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-project");
  });

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
        message: {
          role: "user",
          content: "Inspect the repository",
          timestamp: 1783904401000,
          metadata: {
            channel: {
              adapter: "infoflow",
              externalKey: "infoflow:group:10838226",
              senderId: "xuxiaojian",
              senderName: "徐晓健",
              messageId: "1870315656716618699",
              contentType: "mixed",
              attachments: [
                { kind: "file", name: "plan.pdf", reference: "fid-plan" },
                { kind: "unknown", url: "https://signed.invalid" },
              ],
              secret: "must-not-project",
            },
            raw: { token: "must-not-project" },
          },
        },
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
              arguments: { path: "README.md", token: "secret-token" },
            },
            {
              type: "toolCall",
              id: "call-failure",
              name: "exec",
              arguments: { command: "pnpm test" },
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
          content: [{ type: "text", text: "safe-output" }],
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
          content: [
            {
              type: "text",
              text: "503 command failed<html><body><svg>unsafe-tool-error</svg></body></html>",
            },
          ],
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
              arguments: { pattern: "TODO" },
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
        metadata: {
          channel: {
            adapter: "infoflow",
            externalKey: "infoflow:group:10838226",
            senderId: "xuxiaojian",
            senderName: "徐晓健",
            messageId: "1870315656716618699",
            contentType: "mixed",
            attachments: [{ kind: "file", name: "plan.pdf", reference: "fid-plan" }],
          },
        },
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
        text: "safe-output",
        status: "done",
        parts: [
          {
            id: "result-success:part:0",
            type: "tool-result",
            toolCallId: "call-success",
            status: "complete",
            summary: "safe-output",
          },
        ],
      },
      {
        id: "result-failure",
        role: "tool",
        text: "503 command failed",
        status: "done",
        parts: [
          {
            id: "result-failure:part:0",
            type: "tool-result",
            toolCallId: "call-failure",
            status: "failed",
            summary: "503 command failed",
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
      /secret-token|secret-details|secret-signature|secret-redacted-thinking|secret-inactive|must-not-project|unsafe-tool-error/u,
    );
  });

  it("keeps text phases without projecting commentary as assistant prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-text-phase-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const entries = [
      {
        type: "session",
        version: 3,
        id: "sess_text_phase",
        timestamp: "2026-07-13T02:00:00.000Z",
        cwd: "/workspace/demo",
      },
      {
        type: "message",
        id: "user-phase",
        parentId: null,
        timestamp: "2026-07-13T02:00:01.000Z",
        message: { role: "user", content: "Run the check", timestamp: 1783908001000 },
      },
      {
        type: "message",
        id: "assistant-phase",
        parentId: "user-phase",
        timestamp: "2026-07-13T02:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Checking the repository.",
              textSignature: JSON.stringify({
                v: 1,
                phase: "commentary",
                providerSecret: "commentary-signature-secret",
              }),
            },
            {
              type: "text",
              text: "The check passed.",
              textSignature: JSON.stringify({
                phase: "final_answer",
                providerSecret: "final-signature-secret",
              }),
            },
            { type: "text", text: "Legacy detail." },
            {
              type: "text",
              text: "Unknown phase stays visible.",
              textSignature: JSON.stringify({ phase: "future_phase" }),
            },
            {
              type: "text",
              text: "Malformed signature stays visible.",
              textSignature: "not-json-signature-secret",
            },
          ],
          timestamp: 1783908002000,
        },
      },
    ];
    await writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const session = parseSparkSessionRegistryRecord({
      sessionId: "sess_text_phase",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      status: "ready",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-07-13T02:00:00.000Z",
      updatedAt: "2026-07-13T02:00:02.000Z",
    });

    const snapshot = await loadSparkSessionSnapshot({ sessionsRoot: root, session });
    const assistant = snapshot.messages.find((message) => message.id === "assistant-phase");

    expect(assistant?.text).toBe(
      "The check passed.\nLegacy detail.\nUnknown phase stays visible.\nMalformed signature stays visible.",
    );
    expect(assistant?.parts).toMatchObject([
      { type: "text", text: "Checking the repository.", phase: "commentary" },
      { type: "text", text: "The check passed.", phase: "final_answer" },
      { type: "text", text: "Legacy detail." },
      { type: "text", text: "Unknown phase stays visible." },
      { type: "text", text: "Malformed signature stays visible." },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /commentary-signature-secret|final-signature-secret|not-json-signature-secret/u,
    );
  });

  it("projects an empty-content provider failure as a bounded readable error", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-provider-error-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const gatewayPage = [
      "504 upstream request failed",
      "<!doctype html><html><head><title>504 Gateway Time-out</title>",
      `<style>${"unsafe-style".repeat(2_000)}</style></head>`,
      `<body><svg>${"unsafe-svg".repeat(2_000)}</svg><script>secret()</script></body></html>`,
    ].join("\n");
    await writeFile(
      transcriptPath,
      `${[
        {
          type: "session",
          version: 3,
          id: "sess_provider_error",
          timestamp: "2026-07-13T03:00:00.000Z",
          cwd: "/workspace/demo",
        },
        {
          type: "message",
          id: "user-error",
          parentId: null,
          timestamp: "2026-07-13T03:00:01.000Z",
          message: { role: "user", content: "Continue the task" },
        },
        {
          type: "message",
          id: "assistant-error",
          parentId: "user-error",
          timestamp: "2026-07-13T03:00:02.000Z",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: gatewayPage,
          },
        },
        {
          type: "message",
          id: "assistant-error-without-detail",
          parentId: "assistant-error",
          timestamp: "2026-07-13T03:00:03.000Z",
          message: { role: "assistant", content: [], stopReason: "error" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8",
    );
    const session = parseSparkSessionRegistryRecord({
      sessionId: "sess_provider_error",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      status: "ready",
      sessionPath: transcriptPath,
      bindings: [],
      createdAt: "2026-07-13T03:00:00.000Z",
      updatedAt: "2026-07-13T03:00:02.000Z",
    });

    const snapshot = await loadSparkSessionSnapshot({ sessionsRoot: root, session });
    const failure = snapshot.messages.find((message) => message.id === "assistant-error");
    const serialized = JSON.stringify(snapshot);

    expect(failure).toMatchObject({
      id: "assistant-error",
      role: "assistant",
      status: "error",
      text: "504 upstream request failed — 504 Gateway Time-out",
      metadata: {
        stopReason: "error",
        errorMessage: "504 upstream request failed — 504 Gateway Time-out",
      },
      parts: [
        {
          type: "text",
          status: "failed",
          text: "504 upstream request failed — 504 Gateway Time-out",
        },
      ],
    });
    expect(serialized.length).toBeLessThan(5_000);
    expect(serialized).not.toMatch(/<!doctype|<html|<svg|<script|unsafe-style|unsafe-svg/iu);
    expect(snapshot.messages.at(-1)).toMatchObject({
      id: "assistant-error-without-detail",
      status: "error",
      text: "The provider request failed without additional details.",
    });
  });

  it("backfills a settled tool-ended branch with an interruption error but leaves a running turn open", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-missing-final-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    await writeFile(
      transcriptPath,
      `${[
        {
          type: "session",
          version: 3,
          id: "sess_missing_final",
          timestamp: "2026-07-13T04:00:00.000Z",
          cwd: "/workspace/demo",
        },
        {
          type: "message",
          id: "user-missing-final",
          parentId: null,
          timestamp: "2026-07-13T04:00:01.000Z",
          message: { role: "user", content: "Run the check" },
        },
        {
          type: "message",
          id: "assistant-tool-call",
          parentId: "user-missing-final",
          timestamp: "2026-07-13T04:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-check", name: "exec", arguments: {} }],
          },
        },
        {
          type: "message",
          id: "tool-result-final-leaf",
          parentId: "assistant-tool-call",
          timestamp: "2026-07-13T04:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-check",
            toolName: "exec",
            content: [{ type: "text", text: "tests passed" }],
            isError: false,
          },
        },
        {
          type: "compaction",
          id: "compaction-after-tool-result",
          parentId: "tool-result-final-leaf",
          timestamp: "2026-07-13T04:00:04.000Z",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8",
    );
    const record = (status: "ready" | "running") =>
      parseSparkSessionRegistryRecord({
        sessionId: "sess_missing_final",
        scope: { kind: "workspace", workspaceId: "ws_demo" },
        status,
        sessionPath: transcriptPath,
        bindings: [],
        createdAt: "2026-07-13T04:00:00.000Z",
        updatedAt: "2026-07-13T04:00:03.000Z",
      });

    const settled = await loadSparkSessionSnapshot({
      sessionsRoot: root,
      session: record("ready"),
    });
    const running = await loadSparkSessionSnapshot({
      sessionsRoot: root,
      session: record("running"),
    });

    expect(settled.messages.at(-1)).toMatchObject({
      id: "tool-result-final-leaf:missing-final-response",
      role: "system",
      status: "error",
      text: expect.stringContaining("before a final response"),
      metadata: { kind: "missing_final_response", errorTitle: "Session interrupted" },
    });
    expect(running.messages.at(-1)).toMatchObject({
      id: "tool-result-final-leaf",
      role: "tool",
    });
  });
});
