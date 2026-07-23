import assert from "node:assert/strict";
import { test } from "vitest";

import type { ToolConfig } from "../packages/spark-core/src/index.ts";
import { loadSparkHeadlessSessionModule } from "../packages/spark-host/src/headless-loader.ts";
import {
  runSparkHeadlessRoleInstruction,
  runSparkHeadlessSession,
  type SparkHeadlessRoleInstructionInput,
} from "../apps/spark-tui/src/headless-role-executor.ts";
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

test("runSparkHeadlessRoleInstruction records completed and blocked structured outcomes", async () => {
  for (const expected of [
    {
      kind: "completed" as const,
      code: "worker_completed",
      reason: "Implementation and validation completed",
      expectedStatus: "succeeded" as const,
    },
    {
      kind: "blocked" as const,
      code: "missing_daemon_control",
      reason: "Independent daemon restart control is unavailable",
      expectedStatus: "failed" as const,
    },
  ]) {
    let executionPhase: "plan" | "implement" | undefined;
    const services = headlessRoleServices(async (tools) => {
      await executeRoleOutcomeTool(tools, expected);
      return successfulOutcome("structured outcome recorded");
    });

    const result = await runSparkHeadlessRoleInstruction(roleInstructionInput(expected.kind), {
      createServices: async (options) => {
        executionPhase = options?.executionPhase;
        return services as never;
      },
    });

    assert.equal(executionPhase, "implement");
    assert.deepEqual(result.outcome, {
      kind: expected.kind,
      code: expected.code,
      reason: expected.reason,
    });
    assert.equal(result.record.status, expected.expectedStatus);
    assert.deepEqual(services.runtime.getActiveTools(), ["read", "role_report_outcome"]);
  }
});

test("runSparkHeadlessRoleInstruction rejects duplicate structured outcome reports", async () => {
  const services = headlessRoleServices(async (tools) => {
    await executeRoleOutcomeTool(tools, {
      kind: "completed",
      code: "worker_completed",
      reason: "First terminal report",
    });
    await assert.rejects(
      executeRoleOutcomeTool(tools, {
        kind: "blocked",
        code: "late_blocker",
        reason: "A second report must not replace the first",
      }),
      /may only be called once/u,
    );
    return successfulOutcome("duplicate rejected");
  });

  const result = await runSparkHeadlessRoleInstruction(roleInstructionInput("duplicate"), {
    createServices: async () => services as never,
  });

  assert.deepEqual(result.outcome, {
    kind: "completed",
    code: "worker_completed",
    reason: "First terminal report",
  });
  assert.equal(result.record.status, "succeeded");
});

test("runSparkHeadlessRoleInstruction fails closed when a scheduler worker omits its outcome", async () => {
  const services = headlessRoleServices(async () => successfulOutcome("natural model completion"));

  const result = await runSparkHeadlessRoleInstruction(roleInstructionInput("missing"), {
    createServices: async () => services as never,
  });

  assert.equal(result.record.status, "failed");
  assert.equal(result.outcome.kind, "failed");
  assert.equal(result.outcome.code, "missing_structured_outcome");
  assert.match(result.outcome.reason, /without calling role_report_outcome/u);
});

test("runSparkHeadlessRoleInstruction records provider resolution failures structurally", async () => {
  const services = headlessRoleServices(async () => successfulOutcome("must not run"));
  services.providerRegistry = {
    buildModel() {
      throw new Error("configured provider is unavailable");
    },
  };
  const input = roleInstructionInput("provider");
  input.model = "missing/model";

  const result = await runSparkHeadlessRoleInstruction(input, {
    createServices: async () => services as never,
  });

  assert.equal(result.record.status, "failed");
  assert.equal(result.outcome.kind, "failed");
  assert.equal(result.outcome.code, "provider_resolution_failed");
  assert.match(result.outcome.reason, /configured provider is unavailable/u);
});

test("runSparkHeadlessRoleInstruction records an in-flight abort as cancelled", async () => {
  const controller = new AbortController();
  const services = headlessRoleServices(async () => {
    controller.abort("parent stopped the role");
    return terminalOutcome(terminalAssistant("aborted", "parent stopped the role"));
  });
  const input = roleInstructionInput("cancelled");
  input.signal = controller.signal;

  const result = await runSparkHeadlessRoleInstruction(input, {
    createServices: async () => services as never,
  });

  assert.equal(result.record.status, "cancelled");
  assert.equal(result.outcome.kind, "cancelled");
  assert.equal(result.outcome.code, "role_run_cancelled");
  assert.match(result.outcome.reason, /parent stopped the role/u);
});

function roleInstructionInput(suffix: string): SparkHeadlessRoleInstructionInput {
  return {
    role: {
      ref: "role:builtin-worker",
      id: "worker",
      systemPrompt: "Implement the assigned task and report a structured terminal outcome.",
      allowedTools: ["read"],
    },
    instruction: {
      roleRef: "role:builtin-worker",
      instruction: "Complete the scheduler-owned task.",
    },
    record: {
      ref: `run:headless-${suffix}` as `run:${string}`,
      roleRef: "role:builtin-worker",
      instruction: "Complete the scheduler-owned task.",
      status: "queued",
    },
    cwd: process.cwd(),
    timeoutMs: 1_000,
    phase: "implement",
    requireStructuredOutcome: true,
    noSession: true,
  };
}

function headlessRoleServices(
  submitWithOutcome: (tools: Map<string, ToolConfig>) => Promise<SparkRunOutcome>,
) {
  const tools = new Map<string, ToolConfig>();
  let activeTools = ["read"];
  return {
    agentLoop: {
      onEvent: () => () => undefined,
      setViewSessionId: () => undefined,
      replacePromptItems: () => undefined,
      getPromptItems: () => [],
      submitWithOutcome: async () => await submitWithOutcome(tools),
      abort: () => undefined,
    },
    runtime: {
      onDaemonEvent: () => () => undefined,
      setSessionId: () => undefined,
      registerTool: (tool: ToolConfig) => tools.set(tool.name, tool),
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => {
        activeTools = [...names];
      },
    },
    providerRegistry: undefined as
      | {
          buildModel(providerName: string, modelId: string): unknown;
        }
      | undefined,
    sessionStore: {
      createSession: () => ({ header: { id: "unused" }, path: "", entries: [] }),
      findById: async () => undefined,
      loadByRef: async () => ({ header: { id: "unused" }, path: "", entries: [] }),
      forkSession: () => ({ header: { id: "unused" }, path: "", entries: [] }),
      appendMessage: () => undefined,
      save: async () => undefined,
    },
    diagnostics: [],
  };
}

async function executeRoleOutcomeTool(
  tools: Map<string, ToolConfig>,
  params: { kind: "completed" | "blocked" | "failed" | "cancelled"; code: string; reason: string },
): Promise<void> {
  const tool = tools.get("role_report_outcome");
  assert.ok(tool);
  await tool.execute(
    `outcome-${params.code}`,
    params,
    new AbortController().signal,
    () => undefined,
    {} as never,
  );
}

function successfulOutcome(text: string): SparkRunOutcome {
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions" as const,
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
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  return {
    status: "completed",
    assistant: message as SparkRunOutcome["assistant"],
    roundtrips: 0,
  };
}

function terminalAssistant(stopReason: "error" | "aborted", errorMessage: string) {
  return {
    role: "assistant" as const,
    content: [] as const,
    api: "openai-completions" as const,
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
    ? {
        status: "aborted",
        assistant: assistant as unknown as SparkRunOutcome["assistant"],
        roundtrips: 0,
        reason: assistant.errorMessage,
      }
    : {
        status: "failed",
        assistant: assistant as unknown as SparkRunOutcome["assistant"],
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
