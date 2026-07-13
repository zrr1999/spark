import assert from "node:assert/strict";
import test from "node:test";

import { runSparkHeadlessSession } from "../apps/spark-tui/src/headless-role-executor.ts";

void test("runSparkHeadlessSession times out a never-resolving agent turn", async () => {
  const unsubscribed: string[] = [];
  let abortedReason: string | undefined;
  let capturedServiceOptions:
    | {
        sessionSurface?: "local" | "channel";
        allowedTools?: readonly string[];
        sparkStateRoot?: string;
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
      replaceMessages: () => undefined,
      getMessages: () => [],
      submit: async () => await new Promise<never>(() => undefined),
      abort: (reason?: string) => {
        abortedReason = reason;
      },
    },
    runtime: {
      onDaemonEvent: () => () => unsubscribed.push("runtime"),
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
  assert.deepEqual(capturedServiceOptions?.allowedTools, ["session"]);
  assert.equal(capturedServiceOptions?.sparkStateRoot, "/tmp/control-spark-home");
  assert.deepEqual(unsubscribed.sort(), ["agentLoop", "runtime"]);
});
