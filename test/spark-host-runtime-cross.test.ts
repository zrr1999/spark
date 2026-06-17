import assert from "node:assert/strict";
import test from "node:test";

import piAskExtension from "../packages/pi-ask/src/extension.ts";
import piCueExtension from "../packages/pi-cue/src/index.ts";
import piGraftExtension from "../packages/pi-graft/src/extension.ts";
import { SparkHostRuntime } from "../packages/spark-cli/src/host/runtime.ts";

void test("SparkHostRuntime accepts piCueExtension(pi) without throwing", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-cross" });
  assert.doesNotThrow(() => piCueExtension(host));
  const toolNames = host.getAllTools().map((tool) => tool.name);
  assert.ok(toolNames.includes("cue_exec"), `expected cue_exec in ${toolNames.join(",")}`);
  assert.ok(toolNames.includes("cue_jobs"));
  assert.ok(toolNames.length >= 5, "pi-cue registers multiple tools");
});

void test("SparkHostRuntime accepts piGraftExtension(pi) and records its tools", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-cross" });
  assert.doesNotThrow(() => piGraftExtension(host as never));
  const commandNames = host.listCommands().map((entry) => entry.name);
  assert.equal(
    commandNames.some((name) => name.startsWith("graft-")),
    false,
  );
  const toolNames = host.getAllTools().map((tool) => tool.name);
  assert.ok(toolNames.includes("graft_status"));
  assert.ok(toolNames.includes("graft_doctor"));
});

void test("SparkHostRuntime accepts piAskExtension(pi) and registers canonical ask tool", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-cross" });
  assert.doesNotThrow(() => piAskExtension(host));
  const toolNames = host.getAllTools().map((tool) => tool.name);
  assert.ok(toolNames.includes("ask"));
  assert.ok(!toolNames.includes("ask_user"));
  assert.ok(!toolNames.includes("ask_flow"));
});

void test("SparkHostRuntime survives a session_start event from pi-graft", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-cross" });
  piGraftExtension(host as never);
  // pi-graft registers an on("session_start") handler that defensively reads
  // ctx.sessionManager.getBranch() / getEntries(); SparkHostRuntime ships a
  // bare sessionManager stub so the handler must complete without throwing.
  const results = await host.emit("session_start", {});
  assert.equal(results.length >= 1, true, "session_start fires at least one listener");
});
