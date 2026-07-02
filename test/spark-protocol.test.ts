import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SPARK_PROTOCOL_VERSION,
  createBlockedInteractionResponse,
  parseSparkDaemonEvent,
  parseSparkInteractionRequest,
  parseSparkInteractionResponse,
  parseSparkSessionView,
  parseSparkViewModelEvent,
  invocationLogChunkPayloadSchema,
  sparkInteractionRequestSchema,
} from "@zendev-lab/spark-protocol";

void test("spark protocol validates core session/message/tool/run/task/artifact view models", () => {
  const session = parseSparkSessionView({
    sessionId: "native-session",
    status: "streaming",
    model: { providerName: "baidu-oneapi", modelId: "claude-opus-4.8" },
    messages: [
      { id: "m1", role: "user", text: "hello" },
      { id: "m2", role: "assistant", text: "hi", status: "streaming" },
    ],
    tools: [{ id: "tc1", name: "read", status: "running", input: { path: "README.md" } }],
    runs: [{ id: "run:1", kind: "task", status: "running", progress: 0.5 }],
    tasks: [{ ref: "task:1", title: "Implement", status: "running" }],
    artifacts: [{ ref: "artifact:1", title: "Evidence", kind: "record", format: "json" }],
  });

  assert.equal(session.version, SPARK_PROTOCOL_VERSION);
  assert.equal(session.messages[1]?.status, "streaming");
  assert.equal(session.tools[0]?.input && typeof session.tools[0].input, "object");
  assert.equal(session.runs[0]?.progress, 0.5);
});

void test("spark protocol validates interaction requests and typed responses", () => {
  const ask = parseSparkInteractionRequest({
    requestId: "req-ask",
    kind: "askFlow",
    title: "Choose plan",
    mode: "decision",
    questions: [
      {
        id: "plan",
        prompt: "Which plan?",
        type: "single",
        options: [{ value: "a", label: "Plan A" }],
      },
    ],
  });
  assert.equal(ask.kind, "askFlow");

  const model = parseSparkInteractionRequest({
    requestId: "req-model",
    kind: "modelSelect",
    title: "Model",
    options: [
      {
        value: "baidu-oneapi/claude-opus-4.8",
        providerName: "baidu-oneapi",
        modelId: "claude-opus-4.8",
        active: true,
      },
    ],
  });
  assert.equal(model.kind, "modelSelect");

  const approval = parseSparkInteractionRequest({
    requestId: "req-tool",
    kind: "toolApproval",
    title: "Run tool?",
    toolName: "edit",
    arguments: { path: "src/index.ts" },
  });
  const blocked = createBlockedInteractionResponse(approval, "no UI available");
  assert.deepEqual(blocked, {
    version: SPARK_PROTOCOL_VERSION,
    kind: "toolApproval",
    requestId: "req-tool",
    status: "blocked",
    approved: false,
    message: "no UI available",
    metadata: {},
  });

  const response = parseSparkInteractionResponse({
    requestId: "req-model",
    kind: "modelSelect",
    status: "answered",
    selection: { providerName: "baidu-oneapi", modelId: "claude-opus-4.8" },
  });
  assert.equal(response.status, "answered");
});

void test("spark protocol validates view model events", () => {
  const event = parseSparkViewModelEvent({
    type: "session.message",
    sessionId: "native-session",
    message: { id: "m1", role: "assistant", text: "stream", status: "streaming" },
  });

  assert.equal(event.version, SPARK_PROTOCOL_VERSION);
  assert.equal(event.type, "session.message");
});

void test("spark protocol accepts assistant token invocation chunks", () => {
  const chunk = invocationLogChunkPayloadSchema.parse({
    runtimeInvocationId: "inv_0123456789abcdef0123456789abcdef",
    stream: "assistant",
    sequence: 7,
    content: "delta",
    metadata: { source: "stream_event", delta: true },
  });

  assert.equal(chunk.stream, "assistant");
  assert.equal(chunk.content, "delta");
  assert.deepEqual(chunk.metadata, { source: "stream_event", delta: true });
});

void test("spark protocol validates daemon-routable view and interaction events", () => {
  const viewEvent = parseSparkDaemonEvent({
    type: "daemon.view_event",
    source: "daemon",
    sessionId: "session-daemon",
    invocationId: "inv:daemon",
    view: {
      type: "session.message",
      sessionId: "session-daemon",
      message: { id: "m1", role: "assistant", text: "hello", status: "done" },
    },
  });
  assert.equal(viewEvent.version, SPARK_PROTOCOL_VERSION);
  assert.equal(viewEvent.type, "daemon.view_event");
  assert.equal(viewEvent.view.type, "session.message");

  const requestEvent = parseSparkDaemonEvent({
    type: "daemon.interaction.request",
    source: "runtime",
    request: {
      requestId: "req-approval",
      kind: "toolApproval",
      title: "Approve edit?",
      toolName: "edit",
    },
  });
  assert.equal(requestEvent.type, "daemon.interaction.request");
  assert.equal(requestEvent.request.kind, "toolApproval");
});

void test("spark protocol rejects malformed interaction requests", () => {
  assert.throws(
    () => sparkInteractionRequestSchema.parse({ requestId: "bad", kind: "askFlow", title: "Bad" }),
    /questions/u,
  );
  assert.throws(
    () =>
      sparkInteractionRequestSchema.parse({
        requestId: "bad",
        kind: "toolApproval",
        title: "Bad",
      }),
    /toolName/u,
  );
});

void test("spark protocol source does not import concrete TUI implementations", async () => {
  const source = await readFile("packages/spark-protocol/src/index.ts", "utf8");
  assert.doesNotMatch(source, /@earendil-works\/pi-tui/u);
  assert.doesNotMatch(source, /@zendev-lab\/spark-tui/u);
  assert.doesNotMatch(source, /svelte|Component|TUI/u);
});
