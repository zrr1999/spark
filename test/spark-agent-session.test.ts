import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SparkAgentSession,
  createSparkCliHostServices,
  sessionEntriesToAgentMessages,
  sessionEntriesToPromptItems,
  type SparkCliHostServicesOptions,
  type SparkConfig,
} from "../apps/spark-tui/src/host/index.ts";
import { SPARK_PROMPT_ITEM_METADATA_KEY } from "../packages/spark-turn/src/agent-loop.ts";
import { assistantMessageToFinalAnswerText } from "../apps/spark-tui/src/host/agent-session.ts";
import { createSparkHeadlessRoleExecutor } from "../apps/spark-tui/src/headless-role-executor.ts";
import {
  SparkNativeSession,
  SparkNativeTuiApp,
  createSparkNativeUiTransport,
} from "../apps/spark-tui/src/native-tui.ts";
import type { TUI } from "../apps/spark-tui/src/tui/pi-tui-adapter.ts";

type FakeStreamSimple = (context: {
  messages?: unknown[];
}) => AssistantMessage | Promise<AssistantMessage>;
type FakeProviderOptions = {
  streamSimple?: FakeStreamSimple;
  contextWindow?: number;
  maxTokens?: number;
};
type AssistantMessage = {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  stopReason: "stop";
  timestamp: number;
};

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function testContentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function fakeTui(): TUI {
  return {
    requestRender: () => undefined,
    terminal: { rows: 30, cols: 120 },
    addChild: () => undefined,
    removeChild: () => undefined,
    setFocus: () => undefined,
  } as unknown as TUI;
}

void test("channel-facing assistant text excludes thinking, tool arguments, and commentary", () => {
  assert.equal(
    assistantMessageToFinalAnswerText({
      content: [
        { type: "thinking", thinking: "private reasoning" },
        {
          type: "text",
          text: "先检查目录",
          textSignature: JSON.stringify({ phase: "commentary" }),
        },
        { type: "toolCall", name: "cue_exec", arguments: { command: "private" } },
        {
          type: "text",
          text: "检查完成",
          textSignature: JSON.stringify({ phase: "final_answer" }),
        },
      ],
    }),
    "检查完成",
  );
});

void test("channel-facing assistant text does not turn a tool-use preamble into a reply", () => {
  assert.equal(
    assistantMessageToFinalAnswerText({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "我先检查目录" },
        { type: "toolCall", name: "cue_exec", arguments: { command: "private" } },
      ],
    }),
    "",
  );
});

void test("session replay retains runtime authority without promoting legacy custom data", () => {
  const entries = [
    {
      type: "custom_message" as const,
      id: "runtime-control",
      parentId: null,
      timestamp: "2026-07-15T00:00:00.000Z",
      customType: "runtime-policy",
      content: "policy <bounded>",
      display: false,
      details: {
        [SPARK_PROMPT_ITEM_METADATA_KEY]: {
          authority: "runtime_control",
          trust: "trusted",
          visibility: "hidden",
          persistence: "session",
        },
      },
    },
    {
      type: "custom_message" as const,
      id: "legacy-data",
      parentId: "runtime-control",
      timestamp: "2026-07-15T00:00:01.000Z",
      customType: "legacy-extension-data",
      content: "legacy payload",
      display: true,
    },
  ];

  const items = sessionEntriesToPromptItems(entries);
  assert.deepEqual(
    items.map(({ authority, trust, visibility, persistence }) => ({
      authority,
      trust,
      visibility,
      persistence,
    })),
    [
      {
        authority: "runtime_control",
        trust: "trusted",
        visibility: "hidden",
        persistence: "session",
      },
      {
        authority: "runtime_data",
        trust: "untrusted",
        visibility: "visible",
        persistence: "session",
      },
    ],
  );
  const lowered = sessionEntriesToAgentMessages(entries);
  assert.match(testContentText(lowered[0]?.content), /<spark_runtime_control trust="trusted"/u);
  assert.match(testContentText(lowered[0]?.content), /policy &lt;bounded&gt;/u);
  assert.match(testContentText(lowered[1]?.content), /<spark_runtime_data trust="untrusted"/u);
});

void test("SparkAgentSession persists and resumes JSONL sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const viewEvents: unknown[] = [];
    const services = await makeFakeServices({
      cwd,
      sparkHome,
      ui: { publishView: (event) => viewEvents.push(event) },
    });
    const session = new SparkAgentSession(services);

    const first = await session.run({
      sessionId: "session-a",
      prompt: "first",
      messageMetadata: {
        channel: { adapter: "infoflow", senderId: "platform-user" },
      },
    });
    assert.equal(first.sessionId, "session-a");
    assert.equal(first.newMessageCount, 2);
    assert.equal(first.assistantText, "count:1");

    const second = await session.run({ sessionId: "session-a", prompt: "second" });
    assert.equal(second.sessionPath, first.sessionPath);
    assert.equal(second.newMessageCount, 2);
    assert.equal(second.assistantText, "count:3");

    const record = await services.sessionStore.load(first.sessionPath);
    const messages = record.entries.filter((entry) => entry.type === "message");
    assert.equal(messages.length, 4);
    assert.deepEqual(
      messages.map((entry) => entry.message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.deepEqual(messages[0]?.message.metadata, {
      channel: { adapter: "infoflow", senderId: "platform-user" },
    });
    assert.equal(messages[1]?.message.metadata, undefined);
    assert.equal(messages[2]?.message.metadata, undefined);
    assert.equal(messages[3]?.message.metadata, undefined);
    assert.equal(
      viewEvents.some(
        (event: any) =>
          event.type === "session.message" &&
          event.sessionId === "session-a" &&
          event.message.role === "assistant",
      ),
      true,
    );
    assert.equal(
      viewEvents.some(
        (event: any) => event.type === "run.update" && event.run.status === "succeeded",
      ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkAgentSession compacts persisted history and retries a context overflow once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-overflow-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 1_000_000,
        maxTokens: 4_096,
        streamSimple: ({ messages }) => {
          providerCalls += 1;
          if (providerCalls === 1) {
            throw new Error(
              "Your input exceeds the context window of this model. Please adjust your input and try again.",
            );
          }
          return assistant(`recovered:${messages?.length ?? 0}`);
        },
      },
    );
    const record = services.sessionStore.createSession({ id: "overflow-session" });
    for (let index = 0; index < 8; index += 1) {
      services.sessionStore.appendMessage(record, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:${"history ".repeat(100)}`,
      });
    }
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "continue after overflow",
    });

    assert.equal(providerCalls, 2);
    assert.equal(result.outcome?.status, "completed");
    assert.match(result.assistantText, /^recovered:/u);
    const saved = await services.sessionStore.load(record.path);
    assert.equal(saved.entries.filter((entry) => entry.type === "compaction").length, 1);
    const persistedMessages = saved.entries.filter((entry) => entry.type === "message");
    assert.equal(
      persistedMessages.filter(
        (entry) =>
          entry.message.role === "user" && entry.message.content === "continue after overflow",
      ).length,
      1,
    );
    assert.equal(
      persistedMessages.some((entry) =>
        JSON.stringify(entry.message).includes("exceeds the context window"),
      ),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkAgentSession compacts an over-budget persisted session before its provider call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-preflight-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 40_000,
        maxTokens: 4_096,
        streamSimple: () => {
          providerCalls += 1;
          return assistant("continued after preflight compaction");
        },
      },
    );
    const record = services.sessionStore.createSession({ id: "preflight-session" });
    for (let index = 0; index < 80; index += 1) {
      services.sessionStore.appendMessage(record, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:${"history ".repeat(400)}`,
        ...(index === 79
          ? {
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
              },
            }
          : {}),
      });
    }
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "continue near the context limit",
    });

    assert.equal(providerCalls, 1);
    assert.equal(result.outcome?.status, "completed");
    const saved = await services.sessionStore.load(record.path);
    const compactions = saved.entries.filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0]?.metadata?.tokenSource, "estimated");
    assert.equal((compactions[0]?.metadata?.measuredReductionRatio ?? 0) > 0, true);
    assert.equal(
      saved.entries.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "continue near the context limit",
      ).length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkAgentSession meters only the compacted replay on the active branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-replay-meter-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    let providerReplay = "";
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 50_000,
        maxTokens: 4_096,
        streamSimple: ({ messages }) => {
          providerCalls += 1;
          providerReplay = JSON.stringify(messages);
          return assistant("continued without redundant compaction");
        },
      },
    );
    const record = services.sessionStore.createSession({ id: "metered-replay-session" });
    record.entries.push(
      {
        type: "message",
        id: "root",
        parentId: null,
        timestamp: "2026-07-17T00:00:00.000Z",
        message: { role: "user", content: "root request" },
      },
      {
        type: "message",
        id: "inactive-branch",
        parentId: "root",
        timestamp: "2026-07-17T00:00:01.000Z",
        message: {
          role: "assistant",
          content: `inactive branch ${"x".repeat(200_000)}`,
          usage: { input: 45_000, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        type: "message",
        id: "compacted-history",
        parentId: "root",
        timestamp: "2026-07-17T00:00:02.000Z",
        message: { role: "user", content: `already compacted ${"y".repeat(200_000)}` },
      },
    );
    let parentId = "compacted-history";
    for (let index = 0; index < 50; index += 1) {
      const id = `kept-${index}`;
      record.entries.push({
        type: "message",
        id,
        parentId,
        timestamp: `2026-07-17T00:01:${String(index).padStart(2, "0")}.000Z`,
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `kept context ${index} ${"k".repeat(2_000)}`,
        },
      });
      parentId = id;
    }
    record.entries.push(
      {
        type: "compaction",
        id: "existing-compaction",
        parentId,
        timestamp: "2026-07-17T00:02:00.000Z",
        summary: "The earlier active history was already summarized.",
        firstKeptEntryId: "kept-0",
        tokensBefore: 75_000,
      },
      {
        type: "message",
        id: "post-compaction",
        parentId: "existing-compaction",
        timestamp: "2026-07-17T00:02:01.000Z",
        message: { role: "user", content: "continue from the compacted replay" },
      },
    );
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "one more turn",
    });

    assert.equal(providerCalls, 1);
    assert.equal(result.outcome?.status, "completed");
    assert.doesNotMatch(providerReplay, /inactive branch|already compacted/u);
    assert.match(providerReplay, /earlier active history was already summarized/u);
    const saved = await services.sessionStore.load(record.path);
    assert.equal(saved.entries.filter((entry) => entry.type === "compaction").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("SparkAgentSession projects loop view events into native TUI transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-native-ui-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const nativeSession = new SparkNativeSession();
    const app = new SparkNativeTuiApp(fakeTui(), nativeSession, () => undefined);
    const services = await makeFakeServices({
      cwd,
      sparkHome,
      ui: createSparkNativeUiTransport(app, nativeSession),
    });

    const session = new SparkAgentSession(services);
    const result = await session.run({ sessionId: "native-ui-session", prompt: "hello" });

    assert.equal(result.sessionId, "native-ui-session");
    assert.match(stripAnsi(app.render(120).join("\n")), /spark> count:1/);
    assert.equal((await services.sessionStore.findMostRecent())?.id, "native-ui-session");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark headless role executor supports forked session runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-fork-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const services = await makeFakeServices({ cwd, sparkHome });
    const parent = services.sessionStore.createSession({
      id: "parent-session",
      timestamp: "2026-06-03T08:00:00.000Z",
    });
    services.sessionStore.appendMessage(parent, { role: "user", content: "parent prompt" });
    services.sessionStore.appendMessage(parent, { role: "assistant", content: "parent answer" });
    await services.sessionStore.save(parent);

    let roleApprovalMethod: SparkCliHostServicesOptions["approvalMethod"];
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => {
        roleApprovalMethod = options.approvalMethod;
        return await makeFakeServices(options);
      },
    });
    const result = await executeRole({
      role: {
        ref: "role:test",
        id: "test",
        systemPrompt: "You are a test role.",
      },
      instruction: {
        roleRef: "role:test",
        instruction: "continue from parent",
      },
      record: {
        ref: "run:forked",
        roleRef: "role:test",
        instruction: "continue from parent",
        status: "queued",
        launch: "forked",
        forkFromSession: "parent-session",
      },
      cwd,
      timeoutMs: 1_000,
      launch: "forked",
      forkFromSession: "parent-session",
    });

    assert.equal(result.record.status, "succeeded");
    assert.equal(result.record.launch, "forked");
    assert.equal(result.record.forkFromSession, "parent-session");
    assert.equal(roleApprovalMethod, "auto");
    assert.equal(result.stdout, "count:3");

    const child = await services.sessionStore.findById("spark-daemon-run:forked");
    assert.equal(child?.header.parentSession, parent.path);
    assert.equal(child?.entries.length, 4);
    assert.deepEqual(
      child?.entries
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message.content),
      [
        "parent prompt",
        "parent answer",
        "continue from parent",
        [{ type: "text", text: "count:3" }],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark headless role executor forwards live events through onEvent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-events-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const streamed: unknown[] = [];
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });

    const result = await executeRole({
      role: {
        ref: "role:test",
        id: "test",
        systemPrompt: "You are a streaming test role.",
      },
      instruction: {
        roleRef: "role:test",
        instruction: "emit events",
      },
      record: {
        ref: "run:events",
        roleRef: "role:test",
        instruction: "emit events",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
      onEvent: (event) => {
        streamed.push(event);
      },
    });

    assert.equal(result.record.status, "succeeded");
    assert.equal(streamed.length, result.jsonEvents.length);
    assert.equal(
      streamed.some((event: any) => event.type === "stream_event" && event.event?.type === "done"),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Spark headless role executor routes input control into a follow-up turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-input-control-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const firstStreamStarted = deferred<void>();
    const releaseFirstStream = deferred<void>();
    let streamCalls = 0;
    let controller: { send(text: string): void | Promise<void> } | undefined;
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) =>
        await makeFakeServices(options, {
          streamSimple: async (context) => {
            streamCalls += 1;
            if (streamCalls === 1) {
              firstStreamStarted.resolve();
              await releaseFirstStream.promise;
            }
            return assistant(`count:${context.messages?.length ?? 0}`);
          },
        }),
    });

    const resultPromise = executeRole({
      role: {
        ref: "role:test",
        id: "test",
        systemPrompt: "You are a role with follow-up input.",
      },
      instruction: {
        roleRef: "role:test",
        instruction: "start work",
      },
      record: {
        ref: "run:input-control",
        roleRef: "role:test",
        instruction: "start work",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
      inputControl: {
        register(inputController) {
          controller = inputController;
          return () => {
            if (controller === inputController) controller = undefined;
          };
        },
      },
    });

    await firstStreamStarted.promise;
    assert.ok(controller);
    await controller.send("continue with follow-up context");
    releaseFirstStream.resolve();

    const result = await resultPromise;
    assert.equal(result.record.status, "succeeded");
    assert.equal(result.stdout, "count:3");
    assert.equal(streamCalls, 2);
    assert.equal(controller, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("daemon native reviewer noSession does not persist session file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-anon-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });
    const services = await makeFakeServices({ cwd, sparkHome });
    const before = await listSessionFileNames(services.sessionStore.sessionDir);

    const result = await executeRole({
      role: { ref: "role:builtin-reviewer", id: "reviewer", systemPrompt: "You are a reviewer." },
      instruction: { roleRef: "role:builtin-reviewer", instruction: "review anonymously" },
      record: {
        ref: "run:anonymous-reviewer",
        roleRef: "role:builtin-reviewer",
        instruction: "review anonymously",
        status: "queued",
        noSession: true,
      },
      cwd,
      timeoutMs: 1_000,
      noSession: true,
    });

    const after = await listSessionFileNames(services.sessionStore.sessionDir);
    assert.deepEqual(after, before);
    assert.equal(result.record.status, "succeeded");
    assert.equal(result.record.noSession, true);
    assert.equal(result.record.sessionPersistence, "anonymous");
    assert.equal(result.record.sessionDir, undefined);
    assert.equal(
      await services.sessionStore.findById("spark-daemon-run:anonymous-reviewer"),
      undefined,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("persistent native role run writes workspace session file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-persistent-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });

    const result = await executeRole({
      role: { ref: "role:builtin-worker", id: "worker", systemPrompt: "You are a worker." },
      instruction: { roleRef: "role:builtin-worker", instruction: "persist role session" },
      record: {
        ref: "run:persistent-worker",
        roleRef: "role:builtin-worker",
        instruction: "persist role session",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
    });

    const services = await makeFakeServices({ cwd, sparkHome });
    const persisted = await services.sessionStore.findById("spark-daemon-run:persistent-worker");
    assert.equal(result.record.status, "succeeded");
    assert.equal(result.record.sessionPersistence, "persistent");
    assert.equal(result.record.sessionDir, services.sessionStore.sessionDir);
    assert.equal(persisted?.header.cwd, cwd);
    assert.equal(persisted?.entries.filter((entry) => entry.type === "message").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("anonymous role run is excluded from workspace session selector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-selector-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });

    await executeRole({
      role: { ref: "role:builtin-reviewer", id: "reviewer", systemPrompt: "You are a reviewer." },
      instruction: { roleRef: "role:builtin-reviewer", instruction: "anonymous selector" },
      record: {
        ref: "run:selector-anonymous",
        roleRef: "role:builtin-reviewer",
        instruction: "anonymous selector",
        status: "queued",
        noSession: true,
      },
      cwd,
      timeoutMs: 1_000,
      noSession: true,
    });
    await executeRole({
      role: { ref: "role:builtin-worker", id: "worker", systemPrompt: "You are a worker." },
      instruction: { roleRef: "role:builtin-worker", instruction: "persistent selector" },
      record: {
        ref: "run:selector-persistent",
        roleRef: "role:builtin-worker",
        instruction: "persistent selector",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
    });

    const services = await makeFakeServices({ cwd, sparkHome });
    const selectorIds = (await services.sessionStore.list()).map((session) => session.id);
    assert.deepEqual(selectorIds, ["spark-daemon-run:selector-persistent"]);
    assert.equal(selectorIds.includes("spark-daemon-run:selector-anonymous"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("anonymous role run artifact records sessionPersistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-artifact-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });

    const result = await executeRole({
      role: { ref: "role:builtin-reviewer", id: "reviewer", systemPrompt: "You are a reviewer." },
      instruction: { roleRef: "role:builtin-reviewer", instruction: "record persistence" },
      record: {
        ref: "run:artifact-anonymous",
        roleRef: "role:builtin-reviewer",
        instruction: "record persistence",
        status: "queued",
        noSession: true,
      },
      cwd,
      timeoutMs: 1_000,
      noSession: true,
    });

    assert.equal(result.record.status, "succeeded");
    assert.equal(result.record.sessionPersistence, "anonymous");
    assert.equal(result.record.noSession, true);
    assert.equal("sessionPath" in result.record, false);
    assert.equal(result.record.sessionDir, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function listSessionFileNames(sessionDir: string): Promise<string[]> {
  try {
    return (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function makeFakeServices(
  options: SparkCliHostServicesOptions,
  fake: FakeProviderOptions = {},
) {
  const config: SparkConfig = {
    extensions: [],
    providers: ["fake-provider"],
  };
  if (options.sparkHome) {
    await mkdir(options.sparkHome, { recursive: true });
    await writeFile(join(options.sparkHome, "config.json"), `${JSON.stringify(config)}\n`, "utf8");
  }
  return await createSparkCliHostServices({
    ...options,
    config,
    extensions: [],
    providers: ["fake-provider"],
    providerImporter: async () => fakeProviderModule(fake),
  });
}

function fakeProviderModule(fake: FakeProviderOptions = {}) {
  return {
    default(api: { registerProvider(name: string, config: unknown): void }) {
      api.registerProvider("fake-provider", {
        name: "Fake Provider",
        baseUrl: "https://fake.test",
        api: "openai-completions",
        streamSimple: (_model: unknown, context: { messages?: unknown[] }) => {
          let messagePromise: Promise<AssistantMessage> | undefined;
          const resolveMessage = async () => {
            messagePromise ??= Promise.resolve(
              fake.streamSimple?.(context) ?? assistant(`count:${context.messages?.length ?? 0}`),
            );
            return await messagePromise;
          };
          return {
            async *[Symbol.asyncIterator]() {
              const message = await resolveMessage();
              yield { type: "done", reason: "stop", message };
            },
            result: async () => await resolveMessage(),
          };
        },
        models: [
          {
            id: "fake-model",
            name: "Fake Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: fake.contextWindow ?? 8192,
            maxTokens: fake.maxTokens ?? 4096,
          },
        ],
      });
    },
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
