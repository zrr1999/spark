import assert from "node:assert/strict";
import test from "node:test";

import {
  SparkAgentLoop,
  SparkHostRuntime,
  type SparkAgentLoopEvent,
  type SparkAgentStreamFunction,
} from "../apps/spark-tui/src/host/index.ts";

type AssistantMessage = any;
type AssistantMessageEvent = any;
type Context = any;
type Model = any;
type Message = any;
type ToolCall = any;

const TEST_MODEL: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8000,
  maxTokens: 4000,
};

interface FakeStreamPlan {
  /** Each entry is one round-trip's events. The loop enqueues another round whenever
   *  the produced AssistantMessage has stopReason "toolUse" with toolCalls. */
  rounds: AssistantMessageEvent[][];
}

function buildAssistant(
  parts: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: parts,
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function makeFakeStream(plan: FakeStreamPlan): SparkAgentStreamFunction {
  let round = 0;
  const fake: SparkAgentStreamFunction = (_model: Model, _context: Context) => {
    const events = plan.rounds[round] ?? [];
    round += 1;
    let resolveResult: (value: AssistantMessage) => void = () => undefined;
    const resultPromise = new Promise<AssistantMessage>((resolve) => {
      resolveResult = resolve;
    });
    const iterable: AsyncIterable<AssistantMessageEvent> & {
      result(): Promise<AssistantMessage>;
    } = {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
          if (event.type === "done") resolveResult(event.message);
          if (event.type === "error") resolveResult(event.error);
        }
      },
      result: () => resultPromise,
    };
    return iterable;
  };
  return fake;
}

void test("SparkAgentLoop runs a single-turn stop with one streamed text chunk", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  const events: SparkAgentLoopEvent[] = [];
  const finalMessage = buildAssistant([{ type: "text", text: "hello world" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: finalMessage },
        { type: "text_delta", contentIndex: 0, delta: "hello world", partial: finalMessage },
        { type: "done", reason: "stop", message: finalMessage },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  loop.onEvent((event) => events.push(event));

  const result = await loop.submit("hi");
  assert.equal(result?.stopReason, "stop");
  assert.equal(loop.getState(), "idle");
  assert.equal(host.isIdle(), true);
  assert.equal(loop.getMessages().length, 2, "user + assistant");
  const types = events.filter((event) => event.type !== "view_event").map((event) => event.type);
  assert.deepEqual(types.slice(0, 2), ["user_message", "stream_event"]);
  assert.equal(events.find((event) => event.type === "turn_complete") !== undefined, true);
});

void test("SparkAgentLoop times out a never-resolving model stream", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-stream-timeout-test" });
  const agentEndEvents: unknown[] = [];
  host.on("agent_end", (event) => agentEndEvents.push(event));
  const fake: SparkAgentStreamFunction = () =>
    ({
      async *[Symbol.asyncIterator]() {
        await new Promise<never>(() => undefined);
      },
      result: async () => await new Promise<never>(() => undefined),
    }) as ReturnType<SparkAgentStreamFunction>;
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    streamTimeoutMs: 10,
  });

  await loop.submit("hang stream");

  assert.equal(loop.getState(), "idle");
  assert.match(
    (agentEndEvents[0] as { errorMessage?: string }).errorMessage ?? "",
    /Spark agent model stream timed out after 10ms/u,
  );
});

void test("SparkAgentLoop projects user, streaming, final, and run updates to view-model events", async () => {
  const viewEvents: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-view-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const events: SparkAgentLoopEvent[] = [];
  const finalMessage = buildAssistant([{ type: "text", text: "hello protocol" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: finalMessage },
        { type: "text_delta", contentIndex: 0, delta: "hello protocol", partial: finalMessage },
        { type: "done", reason: "stop", message: finalMessage },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  loop.setViewSessionId("session-view-loop");
  loop.onEvent((event) => events.push(event));

  await loop.submit("hi");

  const protocolEvents = events.filter((event) => event.type === "view_event");
  assert.equal(protocolEvents.length, viewEvents.length);
  assert.equal(
    viewEvents.some((event: any) => event.type === "run.update" && event.run.status === "running"),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event: any) => event.type === "run.update" && event.run.status === "succeeded",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "session.message" &&
        event.sessionId === "session-view-loop" &&
        event.message.role === "assistant" &&
        event.message.status === "done" &&
        event.message.text === "hello protocol",
    ),
    true,
  );
});

void test("SparkAgentLoop emits exactly one agent_end for terminal outcomes", async () => {
  const stopAssistant = buildAssistant([{ type: "text", text: "done" }]);
  const toolUseAssistant = buildAssistant(
    [{ type: "toolCall", id: "tc-max", name: "missing", arguments: {} }],
    "toolUse",
  );
  const cases: Array<{
    name: string;
    streamFunction: SparkAgentStreamFunction;
    maxRoundtrips?: number;
    expectedError?: RegExp;
  }> = [
    {
      name: "normal stop",
      streamFunction: makeFakeStream({
        rounds: [[{ type: "done", reason: "stop", message: stopAssistant }]],
      }),
    },
    {
      name: "stream throws",
      streamFunction: () =>
        ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new Error("stream boom");
              },
            };
          },
          result: async () => stopAssistant,
        }) as ReturnType<SparkAgentStreamFunction>,
      expectedError: /stream boom/,
    },
    {
      name: "no assistant",
      streamFunction: () =>
        ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({ done: true, value: undefined as AssistantMessageEvent }),
            };
          },
          result: async () => undefined as AssistantMessage,
        }) as ReturnType<SparkAgentStreamFunction>,
      expectedError: /stream produced no assistant message/,
    },
    {
      name: "max roundtrips",
      streamFunction: makeFakeStream({
        rounds: [[{ type: "done", reason: "toolUse", message: toolUseAssistant }]],
      }),
      maxRoundtrips: 1,
    },
  ];

  for (const entry of cases) {
    const host = new SparkHostRuntime({ cwd: `/tmp/spark-agent-loop-test-${entry.name}` });
    const agentEndEvents: unknown[] = [];
    host.on("agent_end", (event) => agentEndEvents.push(event));
    const loop = new SparkAgentLoop({
      host,
      streamFunction: entry.streamFunction,
      getModel: () => TEST_MODEL,
      maxRoundtrips: entry.maxRoundtrips,
    });

    await loop.submit(entry.name);

    assert.equal(agentEndEvents.length, 1, `${entry.name} should emit agent_end exactly once`);
    assert.equal(loop.getState(), "idle", `${entry.name} should leave the loop idle`);
    if (entry.expectedError) {
      assert.match(
        (agentEndEvents[0] as { errorMessage?: string }).errorMessage ?? "",
        entry.expectedError,
        `${entry.name} should expose the terminal error on agent_end`,
      );
    }
  }
});

void test("SparkAgentLoop dispatches tool calls and feeds tool results back into the next turn", async () => {
  const viewEvents: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "echo",
    description: "echo input",
    parameters: { type: "object" },
    async execute(_id, params) {
      toolCalls += 1;
      return {
        content: [{ type: "text", text: `echoed:${(params as { x?: string }).x ?? ""}` }],
        details: {
          task: {
            ref: "task:echo-1",
            title: "Echo task",
            status: "running",
            projectRef: "proj:echo",
            outputArtifacts: ["artifact:echo-1"],
          },
          artifact: {
            ref: "artifact:echo-1",
            title: "Echo artifact",
            kind: "record",
            format: "json",
            producer: "task",
          },
        },
      };
    },
  });

  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-1",
    name: "echo",
    arguments: { x: "ping" },
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after echo" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: firstAssistant },
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: toolCallEnvelope,
          partial: firstAssistant,
        },
        { type: "done", reason: "toolUse", message: firstAssistant },
      ],
      [
        { type: "start", partial: finalAssistant },
        { type: "done", reason: "stop", message: finalAssistant },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const events: SparkAgentLoopEvent[] = [];
  loop.onEvent((event) => events.push(event));

  await loop.submit("call the echo tool");
  assert.equal(toolCalls, 1);
  const messages = loop.getMessages();
  assert.equal(messages.length, 4, "user + asst toolUse + toolResult + asst stop");
  assert.equal(messages[2]!.role, "toolResult");
  assert.equal((messages[2] as { isError?: boolean }).isError, false);
  assert.equal(loop.getState(), "idle");
  const toolResultEvent = events.find((event) => event.type === "tool_result");
  assert.equal(toolResultEvent !== undefined, true);
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "session.message" &&
        event.message.role === "tool" &&
        event.message.status === "pending" &&
        event.message.toolName === "echo",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "session.message" &&
        event.message.role === "tool" &&
        event.message.status === "done" &&
        event.message.toolName === "echo",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "task.update" &&
        event.task.ref === "task:echo-1" &&
        event.task.status === "running" &&
        event.task.artifactRefs.includes("artifact:echo-1") &&
        event.task.metadata.sourceTool === "echo",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event: any) =>
        event.type === "artifact.update" &&
        event.artifact.ref === "artifact:echo-1" &&
        event.artifact.kind === "record" &&
        event.artifact.metadata.sourceTool === "echo",
    ),
    true,
  );
});

void test("SparkAgentLoop times out a never-resolving tool execution", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-tool-timeout-test" });
  host.registerTool({
    name: "hang_tool",
    description: "never returns",
    parameters: { type: "object" },
    async execute() {
      return await new Promise<never>(() => undefined);
    },
  });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-tool-timeout",
    name: "hang_tool",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after timeout" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    toolTimeoutMs: 10,
  });

  await loop.submit("call hanging tool");

  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.equal(
    (toolResult as { content: Array<{ text?: string }> }).content[0]?.text,
    'Spark tool "hang_tool" timed out after 10ms',
  );
  assert.equal(loop.getState(), "idle");
});

void test("SparkAgentLoop times out a never-resolving tool approval interaction", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-timeout-test",
    ui: {
      interaction: async () => await new Promise<never>(() => undefined),
    },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "approval_hang",
    description: "requires approval that never arrives",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-timeout",
    name: "approval_hang",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after approval timeout" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    interactionTimeoutMs: 10,
  });

  await loop.submit("call approval hanging tool");

  assert.equal(toolCalls, 0);
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.equal(
    (toolResult as { content: Array<{ text?: string }> }).content[0]?.text,
    'Spark tool approval for "approval_hang" timed out after 10ms',
  );
  assert.equal(loop.getState(), "idle");
});

void test("SparkAgentLoop blocks approval-required tools without explicit approval", async () => {
  const interactionRequests: unknown[] = [];
  const daemonEvents: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: 1,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "blocked",
          approved: false,
          message: "approval unavailable",
          metadata: {},
        };
      },
    },
  });
  host.onDaemonEvent((event) => daemonEvents.push(event));
  let toolCalls = 0;
  host.registerTool({
    name: "dangerous",
    description: "requires approval",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    },
  } as never);

  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval",
    name: "dangerous",
    arguments: { path: "important.txt" },
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after blocked tool" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });

  await loop.submit("try dangerous tool");

  assert.equal(toolCalls, 0);
  assert.equal((interactionRequests[0] as { kind?: string }).kind, "toolApproval");
  assert.equal(
    daemonEvents.some(
      (event: any) =>
        event.type === "daemon.interaction.request" &&
        event.request.kind === "toolApproval" &&
        event.request.toolName === "dangerous",
    ),
    true,
  );
  assert.equal(
    daemonEvents.some(
      (event: any) =>
        event.type === "daemon.interaction.response" &&
        event.response.kind === "toolApproval" &&
        event.response.status === "blocked",
    ),
    true,
  );
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /approval unavailable/);
});

void test("SparkAgentLoop preserves tool-returned isError results", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  host.registerTool({
    name: "business_error",
    description: "returns an explicit tool error",
    parameters: { type: "object" },
    async execute() {
      return {
        content: [{ type: "text", text: "business rule failed" }],
        details: { error: "business_rule_failed" },
        isError: true,
      };
    },
  });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-business-error",
    name: "business_error",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "handled" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });

  await loop.submit("trigger business error");

  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /business_rule_failed/);
});

void test("SparkAgentLoop unknown tool returns an isError tool result without throwing", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-2",
    name: "missing",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "fallback" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  await loop.submit("trigger missing tool");
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /unknown tool: missing/);
});

void test("SparkAgentLoop drainOutboxIntoMessages turns sendUserMessage envelopes into next-turn user messages", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  const firstAssistant = buildAssistant([{ type: "text", text: "first turn" }]);
  const secondAssistant = buildAssistant([{ type: "text", text: "after outbox" }]);
  let calls = 0;
  const fake: SparkAgentStreamFunction = (_model, _context) => {
    calls += 1;
    if (calls === 1) {
      // After turn 1, push a user message into the outbox so the loop runs again.
      host.sendUserMessage("follow up", { deliverAs: "steer" });
    }
    const message = calls === 1 ? firstAssistant : secondAssistant;
    let resolve!: (value: AssistantMessage) => void;
    const resultPromise = new Promise<AssistantMessage>((r) => {
      resolve = r;
    });
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message };
        resolve(message);
      },
      result: () => resultPromise,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({
    host,
    streamFunction: fake,
    getModel: () => TEST_MODEL,
    maxRoundtrips: 4,
  });
  await loop.submit("start");
  // Expected message log: user("start"), asst1, user("follow up"), asst2
  const messages = loop.getMessages();
  assert.equal(messages.length, 4);
  assert.equal(messages[2]!.role, "user");
  assert.match(JSON.stringify(messages[2]!.content), /follow up/);
  assert.equal((messages[3] as AssistantMessage).content[0]!.type, "text");
});

void test("SparkAgentLoop triggerTurn queues hidden custom messages without visible user echo", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-trigger-turn-custom-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "goal tick executed" }]);
  let streamCalls = 0;
  let contextMessages: Message[] = [];
  const eventTypes: string[] = [];
  const fake: SparkAgentStreamFunction = (_model, context) => {
    streamCalls += 1;
    contextMessages = [...context.messages];
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: finalAssistant };
      },
      result: async () => finalAssistant,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      eventTypes.push(event.type);
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendMessage(
    { customType: "spark-goal-request", content: "queued goal instruction", display: false },
    { deliverAs: "followUp", triggerTurn: true },
  );

  await completed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(streamCalls, 1);
  assert.equal(loop.getState(), "idle");
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0]?.role, "user");
  assert.match(String(contextMessages[0]?.content), /\[spark-goal-request\]/);
  assert.match(String(contextMessages[0]?.content), /queued goal instruction/);
  assert.match(JSON.stringify(loop.getMessages()), /spark-goal-request/);
  assert.equal(eventTypes.includes("user_message"), false);
});

void test("SparkAgentLoop triggerTurn uses queued user instruction without duplicate custom", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-trigger-turn-user-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "goal tick executed" }]);
  let contextMessages: Message[] = [];
  const fake: SparkAgentStreamFunction = (_model, context) => {
    contextMessages = [...context.messages];
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: finalAssistant };
      },
      result: async () => finalAssistant,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendUserMessage("queued goal instruction", { deliverAs: "followUp" });
  host.sendMessage(
    { customType: "spark-goal-request", content: "queued goal instruction", display: false },
    { deliverAs: "nextTurn", triggerTurn: true },
  );

  await completed;
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0]?.content, "queued goal instruction");
  assert.doesNotMatch(JSON.stringify(loop.getMessages()), /spark-goal-request/);
});

void test("SparkAgentLoop triggerTurn runs hidden before_agent_start context without visible user echo", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-trigger-turn-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "goal tick executed" }]);
  let streamCalls = 0;
  let contextMessages: Message[] = [];
  const eventTypes: string[] = [];
  host.on("before_agent_start", () => ({
    message: {
      customType: "spark-mode-context",
      content: "hidden context payload",
      display: false,
    },
  }));
  const fake: SparkAgentStreamFunction = (_model, context) => {
    streamCalls += 1;
    contextMessages = [...context.messages];
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: finalAssistant };
      },
      result: async () => finalAssistant,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      eventTypes.push(event.type);
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendMessage(
    { customType: "spark-goal-request", content: "queued goal instruction", display: false },
    { deliverAs: "nextTurn", triggerTurn: true },
  );

  await completed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(streamCalls, 1);
  assert.equal(loop.getState(), "idle");
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0]?.role, "user");
  assert.match(String(contextMessages[0]?.content), /\[spark-mode-context\]/);
  assert.match(String(contextMessages[0]?.content), /hidden context payload/);
  assert.doesNotMatch(JSON.stringify(loop.getMessages()), /spark-goal-request/);
  assert.equal(eventTypes.includes("user_message"), false);
});

void test("SparkAgentLoop abort cancels the in-flight stream and returns to idle", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  let aborted = false;
  const fake: SparkAgentStreamFunction = (_model, _context, options) => {
    let resolve!: (value: AssistantMessage) => void;
    const resultPromise = new Promise<AssistantMessage>((r) => {
      resolve = r;
    });
    options?.signal?.addEventListener("abort", () => {
      aborted = true;
      resolve(buildAssistant([{ type: "text", text: "aborted" }], "aborted"));
    });
    return {
      async *[Symbol.asyncIterator]() {
        // Wait forever until aborted
        await new Promise<void>((r) => {
          options?.signal?.addEventListener("abort", () => r());
        });
        yield {
          type: "error",
          reason: "aborted",
          error: buildAssistant([], "aborted"),
        };
      },
      result: () => resultPromise,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const promise = loop.submit("hang");
  // Abort after a microtask to ensure the loop entered streaming
  await new Promise<void>((resolve) => setImmediate(resolve));
  loop.abort("test_abort");
  await promise;
  assert.equal(aborted, true, "abort signal fired");
  assert.equal(loop.getState(), "idle");
});

void test("SparkAgentLoop refuses concurrent submit while in flight", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  let resolveStream!: (message: AssistantMessage) => void;
  const fake: SparkAgentStreamFunction = () => {
    const resultPromise = new Promise<AssistantMessage>((r) => {
      resolveStream = r;
    });
    return {
      async *[Symbol.asyncIterator]() {
        const message = await resultPromise;
        yield { type: "done", reason: "stop", message };
      },
      result: () => resultPromise,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, streamFunction: fake, getModel: () => TEST_MODEL });
  const first = loop.submit("first");
  await new Promise<void>((r) => setImmediate(r));
  await assert.rejects(loop.submit("second"), /not idle/);
  resolveStream(buildAssistant([{ type: "text", text: "ok" }]));
  await first;
  assert.equal(loop.getState(), "idle");
});
