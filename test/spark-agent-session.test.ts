import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SparkAgentSession,
  createSparkCliHostServices,
  type SparkCliHostServicesOptions,
  type SparkConfig,
} from "../apps/spark-tui/src/host/index.ts";
import {
  createSparkHeadlessRoleExecutor,
  createSparkHeadlessSessionExecutor,
} from "../apps/spark-tui/src/headless-role-executor.ts";
import {
  SparkNativeSession,
  SparkNativeTuiApp,
  createSparkNativeUiTransport,
} from "../apps/spark-tui/src/native-tui.ts";
import type { TUI } from "../apps/spark-tui/src/tui/pi-tui-adapter.ts";
import {
  SparkDaemonQueue,
  createSparkDaemonWorkerContext,
  processSparkDaemonQueueBatch,
  waitForSparkDaemonActiveTasks,
} from "../apps/spark-daemon/src/core/index.ts";

type FakeStreamSimple = (context: {
  messages?: unknown[];
}) => AssistantMessage | Promise<AssistantMessage>;
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

function fakeTui(): TUI {
  return {
    requestRender: () => undefined,
    terminal: { rows: 30, cols: 120 },
    addChild: () => undefined,
    removeChild: () => undefined,
    setFocus: () => undefined,
  } as unknown as TUI;
}

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

    const first = await session.run({ sessionId: "session-a", prompt: "first" });
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

    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
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

void test("daemon session.run executor drains queue item into persisted Spark session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-daemon-session-exec-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const queue = new SparkDaemonQueue({ sparkHome });
    await queue.enqueue({
      type: "session.run",
      sessionId: "queued-session",
      prompt: "queued prompt",
    });

    const executeSession = createSparkHeadlessSessionExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });
    const executeTask = async (
      task: { sessionId: string; prompt: string; reset?: boolean },
      context: { signal: AbortSignal },
    ) =>
      await executeSession({
        cwd,
        sparkHome,
        sessionId: task.sessionId,
        prompt: task.prompt,
        reset: task.reset,
        signal: context.signal,
      });
    const context = createSparkDaemonWorkerContext({ queue, executeTask });

    const didWork = await processSparkDaemonQueueBatch({
      queue,
      active: context.active,
      executeTask,
    });
    assert.equal(didWork, true);
    await waitForSparkDaemonActiveTasks(context.active);
    const processed = await queue.listEntries("processed");
    assert.equal(processed.length, 1);
    assert.equal((await queue.list("failed")).length, 0);
    assert.match(JSON.stringify(processed[0]?.payload.result), /"type":"view_event"/);

    const services = await makeFakeServices({ cwd, sparkHome });
    const latest = await services.sessionStore.findMostRecent();
    assert.equal(latest?.id, "queued-session");
    assert.equal(latest?.messageCount, 2);
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
  fake: { streamSimple?: FakeStreamSimple } = {},
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

function fakeProviderModule(fake: { streamSimple?: FakeStreamSimple } = {}) {
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
            contextWindow: 8192,
            maxTokens: 4096,
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
