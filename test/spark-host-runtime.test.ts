import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@zendev-lab/spark-extension-api";

import { SparkHostRuntime } from "../apps/spark-tui/src/host/runtime.ts";

void test("SparkHostRuntime registers tools and reflects them in getAllTools", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  host.registerTool({
    name: "impl_status",
    description: "Show Spark status",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  host.registerTool({
    name: "impl_use_project",
    description: "Select Spark project",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });

  const names = host
    .getAllTools()
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(names, ["impl_status", "impl_use_project"]);
});

void test("SparkHostRuntime setActiveTools toggles getAllTools view", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  host.registerTool({
    name: "tool_a",
    description: "a",
    parameters: {},
    async execute() {
      return { content: [{ type: "text", text: "a" }] };
    },
  });
  host.registerTool({
    name: "tool_b",
    description: "b",
    parameters: {},
    async execute() {
      return { content: [{ type: "text", text: "b" }] };
    },
  });
  assert.deepEqual(
    host
      .getAllTools()
      .map((tool) => tool.name)
      .sort(),
    ["tool_a", "tool_b"],
  );

  host.setActiveTools(["tool_b"]);
  assert.deepEqual(
    host.getAllTools().map((tool) => tool.name),
    ["tool_b"],
  );
  assert.equal(host.listTools().length, 2, "all tools remain registered, only active flag flips");
});

void test("SparkHostRuntime permanently excludes tools outside the host allowlist", () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-host-runtime-channel-test",
    sessionSurface: "channel",
    sessionSource: "channel",
    allowedTools: ["session"],
  });
  for (const name of ["cue_exec", "cue_jobs", "session"]) {
    host.registerTool({
      name,
      description: name,
      parameters: {},
      async execute() {
        return { content: [{ type: "text", text: name }] };
      },
    });
  }

  assert.deepEqual(host.getActiveTools(), ["session"]);
  host.setActiveTools(["cue_exec", "cue_jobs", "session"]);
  assert.deepEqual(host.getActiveTools(), ["session"]);
  assert.equal(host.makeContext().sessionSurface, "channel");
  assert.equal(host.makeContext().sessionSource, "channel");
});

void test("SparkHostRuntime registerCommand adds numeric suffix for duplicate names", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  let aCalled = 0;
  let bCalled = 0;
  host.registerCommand("review", {
    description: "first review",
    handler: () => void (aCalled += 1),
  });
  host.registerCommand("review", {
    description: "second review",
    handler: () => void (bCalled += 1),
  });
  host.registerCommand("review", { description: "third review", handler: () => void 0 });

  const commands = host
    .listCommands()
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(commands, ["review", "review:1", "review:2"]);

  await host.getCommand("review")!.handler("", host.makeContext());
  await host.getCommand("review:1")!.handler("", host.makeContext());
  assert.equal(aCalled, 1);
  assert.equal(bCalled, 1);
});

void test("SparkHostRuntime emit fires registered listeners with a fresh context", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test", hasUI: true });
  const seen: ExtensionContext[] = [];
  host.on("session_start", (_event, ctx) => {
    seen.push(ctx);
  });
  await host.emit("session_start", { reason: "boot" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.cwd, "/tmp/spark-host-runtime-test");
  assert.equal(seen[0]!.hasUI, true);
  assert.equal(typeof seen[0]!.ui, "object");
});

void test("SparkHostRuntime sendMessage and sendUserMessage push envelopes into the outbox", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  host.sendMessage(
    {
      customType: "spark-mode-request",
      content: "Spark default research requested",
      display: true,
      details: { project: "p1" },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
  host.sendUserMessage("Continue working toward the goal", { deliverAs: "steer" });
  assert.equal(host.peekOutbox().length, 2);
  const drained = host.drainOutbox();
  assert.equal(drained.length, 2);
  assert.equal(host.peekOutbox().length, 0);
  assert.equal(drained[0]!.kind, "custom");
  assert.equal(drained[0]!.customType, "spark-mode-request");
  assert.equal(drained[0]!.options.deliverAs, "steer");
  assert.equal(drained[0]!.options.triggerTurn, true);
  assert.equal(drained[1]!.kind, "user");
});

void test("SparkHostRuntime makeContext returns a no-op ui transport when none is plugged in", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  const ctx = host.makeContext();
  // Defensive optional chaining must keep extensions safe before TUI plugs in
  assert.doesNotThrow(() => ctx.ui?.notify?.("hello", "info"));
  assert.doesNotThrow(() => ctx.ui?.setStatus?.("spark", "Spark"));
  assert.doesNotThrow(() => ctx.ui?.setWidget?.("spark", () => undefined));
  assert.equal(ctx.ui?.confirm, undefined);
});

void test("SparkHostRuntime setUiTransport plugs a real UI bridge into subsequent contexts", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test", hasUI: true });
  const notifications: Array<{ message: string; level?: string }> = [];
  host.setUiTransport({
    notify: (message, level) => {
      notifications.push({ message, level });
    },
  });
  const ctx = host.makeContext();
  ctx.ui?.notify?.("Spark active", "info");
  assert.deepEqual(notifications, [{ message: "Spark active", level: "info" }]);
});

void test("SparkHostRuntime sessionManager defaults are defensive stubs", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  const ctx = host.makeContext();
  const manager = (ctx as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager;
  assert.equal(typeof manager, "object");
  // The default session manager has no methods; spark-graft uses optional chaining.
  assert.equal(manager?.getEntries, undefined);
});

void test("SparkHostRuntime emit awaits async listeners and surfaces their results", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  host.on("turn_start", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "started";
  });
  host.on("turn_start", () => "sync");
  const results = await host.emit("turn_start");
  assert.deepEqual(results, ["started", "sync"]);
});

void test("SparkHostRuntime onToolRegistration fires for every registerTool", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  const seen: string[] = [];
  const off = host.onToolRegistration((info) => {
    seen.push(info.name);
  });
  host.registerTool({
    name: "first",
    description: "f",
    parameters: {},
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  host.registerTool({
    name: "second",
    description: "s",
    parameters: {},
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  off();
  host.registerTool({
    name: "third",
    description: "t",
    parameters: {},
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  assert.deepEqual(seen, ["first", "second"]);
});

void test("SparkHostRuntime isIdle reflects setIdle toggle", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  assert.equal(host.isIdle(), true);
  host.setIdle(false);
  assert.equal(host.isIdle(), false);
  host.setIdle(true);
  assert.equal(host.isIdle(), true);
});
