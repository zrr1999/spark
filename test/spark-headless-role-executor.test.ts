import assert from "node:assert/strict";
import test from "node:test";

import { runSparkHeadlessSession } from "../apps/spark-tui/src/headless-role-executor.ts";

void test("runSparkHeadlessSession times out a never-resolving agent turn", async () => {
  const unsubscribed: string[] = [];
  let abortedReason: string | undefined;
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
      },
      { createServices: async () => services as never },
    ),
    /Spark headless session timed out after 10ms/u,
  );

  assert.equal(abortedReason, "Spark headless session timed out after 10ms");
  assert.deepEqual(unsubscribed.sort(), ["agentLoop", "runtime"]);
});
