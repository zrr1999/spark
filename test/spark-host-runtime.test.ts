import assert from "node:assert/strict";
import { test } from "vitest";

import type { SparkHostContext, ToolConfig } from "@zendev-lab/spark-core";

import { SparkHostRuntime } from "../apps/spark-tui/src/host/runtime.ts";

test("SparkHostRuntime registers tools and reflects them in getAllTools", () => {
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

test("SparkHostRuntime keeps registered and active tool queries distinct", () => {
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
    host
      .getAllTools()
      .map((tool) => tool.name)
      .sort(),
    ["tool_a", "tool_b"],
  );
  assert.deepEqual(host.getActiveTools(), ["tool_b"]);
  assert.equal(host.listTools().length, 2, "all tools remain registered, only active flag flips");
});

test("SparkHostRuntime resolves and exposes immutable fail-closed tool policies", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-policy-test" });
  host.registerTool({
    name: "safe_read",
    description: "read-only inspection",
    parameters: {},
    policy: {
      effect: "read",
      executionMode: "parallel",
      domains: [" files ", "files"],
      phases: ["plan", "implement"],
      approval: "none",
    },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });

  const safePolicy = host.getTool("safe_read")?.policy;
  assert.deepEqual(safePolicy, {
    effect: "read",
    executionMode: "parallel",
    domains: ["files"],
    phases: ["plan", "implement"],
    approval: "none",
  });
  assert.equal(Object.isFrozen(safePolicy), true);
  assert.equal(Object.isFrozen(safePolicy?.domains), true);
  assert.deepEqual(
    host.getAllTools().find((tool) => tool.name === "safe_read")?.policy,
    safePolicy,
  );

  host.registerTool({
    name: "malformed",
    description: "runtime-invalid policy",
    parameters: {},
    effect: "external_write",
    executionMode: "parallel",
    policy: {
      effect: "read",
      executionMode: "parallel",
      domains: ["cue", 42],
      phases: "implement",
      approval: "sometimes",
    },
    async execute() {
      return { content: [{ type: "text", text: "never" }] };
    },
  } as unknown as ToolConfig);

  assert.deepEqual(host.getTool("malformed")?.policy, {
    effect: "unknown",
    executionMode: "sequential",
    domains: [],
    phases: [],
    approval: "required",
  });

  host.registerTool({
    name: "conflicting_effect",
    description: "canonical and legacy declarations disagree",
    parameters: {},
    effect: "external_write",
    executionMode: "parallel",
    policy: { effect: "read", executionMode: "parallel", approval: "none" },
    async execute() {
      return { content: [{ type: "text", text: "never" }] };
    },
  });
  assert.deepEqual(host.getTool("conflicting_effect")?.policy, {
    effect: "unknown",
    executionMode: "sequential",
    domains: [],
    phases: [],
    approval: "required",
  });
});

test("SparkHostRuntime permanently excludes tools outside the host allowlist", () => {
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

test("SparkHostRuntime intersects name and fail-closed effect allowlists", () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-host-runtime-read-only-test",
    allowedTools: ["read_allowed", "write_named", "unknown_named"],
    allowedToolEffects: ["read"],
  });
  for (const [name, policy] of [
    ["read_allowed", { effect: "read" as const }],
    ["write_named", { effect: "local_write" as const }],
    ["outside_name_allowlist", { effect: "read" as const }],
    ["unknown_named", undefined],
  ] as const) {
    host.registerTool({
      name,
      description: name,
      parameters: {},
      ...(policy ? { policy } : {}),
      async execute() {
        return { content: [{ type: "text", text: name }] };
      },
    });
  }

  assert.deepEqual(host.getActiveTools(), ["read_allowed"]);
  host.setActiveTools(["read_allowed", "write_named", "outside_name_allowlist", "unknown_named"]);
  assert.deepEqual(host.getActiveTools(), ["read_allowed"]);
  assert.equal(host.isToolDispatchAllowed("read_allowed", host.getTool("read_allowed")!), true);

  // Simulate a stale/mutated active bit. Final dispatch admission must still
  // deny tools whose effect or name is outside the request-scoped policy.
  for (const name of ["write_named", "outside_name_allowlist", "unknown_named"]) {
    const tool = host.getTool(name)!;
    tool.active = true;
    assert.equal(host.isToolDispatchAllowed(name, tool), false, name);
  }
});

test("SparkHostRuntime suppresses unclassified lifecycle hooks under an effect allowlist", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-host-runtime-lifecycle-policy-test",
    allowedToolEffects: ["read"],
  });
  let compactHooks = 0;
  host.on("session_before_compact", () => {
    compactHooks += 1;
    return { unsafeCheckpoint: true };
  });
  host.on("session_compact", () => {
    compactHooks += 1;
  });

  assert.deepEqual(await host.emit("session_before_compact", {}), []);
  assert.deepEqual(await host.emit("session_compact", {}), []);
  assert.equal(compactHooks, 0);
});

test("SparkHostRuntime dispatches only declared lifecycle effects allowed by policy", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-host-runtime-hook-effects-test",
    allowedToolEffects: ["read"],
  });
  const invoked: string[] = [];
  host.on(
    "session_start",
    () => {
      invoked.push("read");
      return "read-result";
    },
    { effects: ["read"] },
  );
  host.on("session_start", () => invoked.push("local-write"), { effects: ["local_write"] });
  host.on("session_start", () => invoked.push("network"), { effects: ["external_write"] });
  host.on("session_start", () => invoked.push("unknown"));

  assert.deepEqual(await host.emit("session_start", { reason: "test" }), ["read-result"]);
  assert.deepEqual(invoked, ["read"]);
});

test("SparkHostRuntime keeps lifecycle dispatch behavior unchanged without an effect allowlist", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-host-runtime-hook-effects-unrestricted",
  });
  const invoked: string[] = [];
  host.on("session_start", () => {
    invoked.push("unknown");
    return "unknown-result";
  });
  host.on(
    "session_start",
    () => {
      invoked.push("write");
      return "write-result";
    },
    { effects: ["local_write"] },
  );

  assert.deepEqual(await host.emit("session_start", { reason: "test" }), [
    "unknown-result",
    "write-result",
  ]);
  assert.deepEqual(invoked, ["unknown", "write"]);
});

test("SparkHostRuntime registerCommand adds numeric suffix for duplicate names", async () => {
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

test("SparkHostRuntime emit fires registered listeners with a fresh context", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test", hasUI: true });
  const seen: SparkHostContext[] = [];
  host.on("session_start", (_event, ctx) => {
    seen.push(ctx);
  });
  await host.emit("session_start", { reason: "boot" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.cwd, "/tmp/spark-host-runtime-test");
  assert.equal(seen[0]!.hasUI, true);
  assert.equal(typeof seen[0]!.ui, "object");
});

test("SparkHostRuntime sendMessage and sendUserMessage push envelopes into the outbox", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  host.sendMessage(
    {
      customType: "spark-mode-request",
      content: "Spark default research requested",
      display: true,
      details: { project: "p1" },
      authority: "runtime_control",
      trust: "trusted",
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
  assert.equal(drained[0]!.authority, "runtime_control");
  assert.equal(drained[0]!.trust, "trusted");
  assert.equal(drained[1]!.kind, "user");
});

test("SparkHostRuntime makeContext returns a no-op ui transport when none is plugged in", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  const ctx = host.makeContext();
  // Defensive optional chaining must keep extensions safe before TUI plugs in
  assert.doesNotThrow(() => ctx.ui?.notify?.("hello", "info"));
  assert.doesNotThrow(() => ctx.ui?.setStatus?.("spark", "Spark"));
  assert.doesNotThrow(() => ctx.ui?.setWidget?.("spark", () => undefined));
  assert.equal(ctx.ui?.confirm, undefined);
});

test("SparkHostRuntime setUiTransport plugs a real UI bridge into subsequent contexts", () => {
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

test("SparkHostRuntime sessionManager defaults are defensive stubs", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  const ctx = host.makeContext();
  const manager = (ctx as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager;
  assert.equal(typeof manager, "object");
  // The default session manager has no methods; spark-graft uses optional chaining.
  assert.equal(manager?.getEntries, undefined);
});

test("SparkHostRuntime emit awaits async listeners and surfaces their results", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  host.on("turn_start", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "started";
  });
  host.on("turn_start", () => "sync");
  const results = await host.emit("turn_start");
  assert.deepEqual(results, ["started", "sync"]);
});

test("SparkHostRuntime onToolRegistration fires for every registerTool", () => {
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

test("SparkHostRuntime isIdle reflects setIdle toggle", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-host-runtime-test" });
  assert.equal(host.isIdle(), true);
  host.setIdle(false);
  assert.equal(host.isIdle(), false);
  host.setIdle(true);
  assert.equal(host.isIdle(), true);
});
