import assert from "node:assert/strict";
import { test } from "vitest";

import { loadSparkHeadlessSessionModule } from "../packages/spark-host/src/headless-loader.ts";
import { runSparkHeadlessSession } from "../apps/spark-tui/src/headless-role-executor.ts";
import type { SparkRunOutcome } from "../apps/spark-tui/src/host/index.ts";

test("daemon headless loader resolves the real worker module and provider dependencies", async () => {
  const headless = await loadSparkHeadlessSessionModule();

  assert.equal(typeof headless.createSparkHeadlessRoleExecutor, "function");
  assert.equal(typeof headless.createSparkHeadlessSessionExecutor, "function");
});

test("runSparkHeadlessSession times out a never-resolving agent turn", async () => {
  const unsubscribed: string[] = [];
  let abortedReason: string | undefined;
  let capturedServiceOptions:
    | {
        sessionSurface?: "local" | "channel";
        channelBinding?: { adapter: "feishu" | "infoflow" | "qqbot"; externalKey: string };
        allowedTools?: readonly string[];
        sparkStateRoot?: string;
        approvalMethod?: "skip" | "human" | "auto";
        streamTimeoutMs?: number;
        toolTimeoutMs?: number;
        interactionTimeoutMs?: number;
      }
    | undefined;
  const record = {
    header: { id: "session-timeout" },
    path: "/tmp/session-timeout.jsonl",
    entries: [],
  };
  const services = {
    agentLoop: {
      onEvent: () => () => unsubscribed.push("agentLoop"),
      setViewSessionId: () => undefined,
      replacePromptItems: () => undefined,
      getPromptItems: () => [],
      submitWithOutcome: async () => await new Promise<never>(() => undefined),
      abort: (reason?: string) => {
        abortedReason = reason;
      },
    },
    runtime: {
      onDaemonEvent: () => () => unsubscribed.push("runtime"),
      setSessionId: () => undefined,
    },
    sessionStore: {
      createSession: () => record,
      findById: async () => undefined,
      loadByRef: async () => record,
      forkSession: () => record,
      appendMessage: () => undefined,
      save: async () => undefined,
    },
    diagnostics: [],
  };

  await assert.rejects(
    runSparkHeadlessSession(
      {
        cwd: process.cwd(),
        sessionId: "session-timeout",
        prompt: "hang",
        timeoutMs: 10,
        sessionSurface: "channel",
        channelBinding: { adapter: "qqbot", externalKey: "qqbot:c2c:user-1" },
        allowedTools: ["session"],
      },
      {
        controlSparkHome: "/tmp/control-spark-home",
        createServices: async (options) => {
          capturedServiceOptions = options;
          return services as never;
        },
      },
    ),
    /Spark headless session timed out after 10ms/u,
  );

  assert.equal(abortedReason, "Spark headless session timed out after 10ms");
  assert.equal(capturedServiceOptions?.sessionSurface, "channel");
  assert.deepEqual(capturedServiceOptions?.channelBinding, {
    adapter: "qqbot",
    externalKey: "qqbot:c2c:user-1",
  });
  assert.deepEqual(capturedServiceOptions?.allowedTools, ["session"]);
  assert.equal(capturedServiceOptions?.sparkStateRoot, undefined);
  assert.equal(capturedServiceOptions?.approvalMethod, "auto");
  assert.equal(capturedServiceOptions?.streamTimeoutMs, 0);
  assert.equal(capturedServiceOptions?.toolTimeoutMs, undefined);
  assert.equal(capturedServiceOptions?.interactionTimeoutMs, undefined);
  assert.deepEqual(unsubscribed.sort(), ["agentLoop", "runtime"]);
});

for (const terminal of [
  {
    stopReason: "error" as const,
    errorMessage: "provider unavailable",
    expected: /provider unavailable/u,
  },
  {
    stopReason: "aborted" as const,
    errorMessage: "provider stream ended",
    expected: /provider stream ended/u,
  },
]) {
  test(`runSparkHeadlessSession rejects assistant stopReason=${terminal.stopReason}`, async () => {
    const assistant = terminalAssistant(terminal.stopReason, terminal.errorMessage);

    await assert.rejects(
      runSparkHeadlessSession(
        { cwd: process.cwd(), sessionId: `session-${terminal.stopReason}`, prompt: "hello" },
        {
          createServices: async () =>
            headlessServices(async () => terminalOutcome(assistant)) as never,
        },
      ),
      terminal.expected,
    );
  });
}

test("runSparkHeadlessSession preserves an active caller cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("operator cancelled");
  let createServicesCalls = 0;
  let submitCalls = 0;
  controller.abort(reason);

  await assert.rejects(
    runSparkHeadlessSession(
      {
        cwd: process.cwd(),
        sessionId: "session-cancelled",
        prompt: "hello",
        signal: controller.signal,
      },
      {
        createServices: async () => {
          createServicesCalls += 1;
          return headlessServices(async () => {
            submitCalls += 1;
            return terminalOutcome(terminalAssistant("aborted", "provider aborted"));
          }) as never;
        },
      },
    ),
    (error) => error === reason,
  );
  assert.equal(createServicesCalls, 0);
  assert.equal(submitCalls, 0);
});

test("runSparkHeadlessSession never submits when cancellation wins during bootstrap", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during service bootstrap");
  let submitCalls = 0;

  await assert.rejects(
    runSparkHeadlessSession(
      {
        cwd: process.cwd(),
        sessionId: "session-bootstrap-cancelled",
        prompt: "must not execute",
        signal: controller.signal,
      },
      {
        createServices: async () => {
          controller.abort(reason);
          return headlessServices(async () => {
            submitCalls += 1;
            return terminalOutcome(terminalAssistant("aborted", "too late"));
          }) as never;
        },
      },
    ),
    (error) => error === reason,
  );
  assert.equal(submitCalls, 0);
});

function terminalAssistant(stopReason: "error" | "aborted", errorMessage: string) {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
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
    errorMessage,
    timestamp: Date.now(),
  };
}

function terminalOutcome(assistant: ReturnType<typeof terminalAssistant>): SparkRunOutcome {
  return assistant.stopReason === "aborted"
    ? { status: "aborted", assistant, roundtrips: 0, reason: assistant.errorMessage }
    : {
        status: "failed",
        assistant,
        roundtrips: 0,
        errorMessage: assistant.errorMessage,
      };
}

function headlessServices(submitWithOutcome: () => Promise<SparkRunOutcome>) {
  const record = {
    header: { id: "session-terminal" },
    path: "/tmp/session-terminal.jsonl",
    entries: [],
  };
  return {
    agentLoop: {
      onEvent: () => () => undefined,
      setViewSessionId: () => undefined,
      replacePromptItems: () => undefined,
      getPromptItems: () => [],
      submitWithOutcome,
      abort: () => undefined,
    },
    runtime: {
      onDaemonEvent: () => () => undefined,
      setSessionId: () => undefined,
    },
    sessionStore: {
      createSession: () => record,
      findById: async () => undefined,
      loadByRef: async () => record,
      forkSession: () => record,
      appendMessage: () => undefined,
      save: async () => undefined,
    },
    diagnostics: [],
  };
}
