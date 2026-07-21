import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { SparkKeybindings, SparkHostRuntime } from "../apps/spark-tui/src/host/index.ts";

test("SparkKeybindings exposes the default binding table snapshot", () => {
  const kb = new SparkKeybindings();
  const snapshot = kb.snapshot();
  const ids = snapshot.bindings.map((row) => row.id).sort();
  assert.deepEqual(ids, [
    "app.abortTurn",
    "app.exit",
    "app.modelCycle.next",
    "app.modelCycle.prev",
    "app.modelPicker",
    "app.thinking.cycle",
    "app.toggleThinking",
    "app.toggleTools",
  ]);
  for (const row of snapshot.bindings) {
    assert.equal(row.overridden, false);
    assert.equal(row.key, row.defaultKey);
  }
});

test("SparkKeybindings keyFor returns user override when present, else default", () => {
  const kb = new SparkKeybindings({ overrides: { "app.modelPicker": "ctrl+m" } });
  assert.equal(kb.keyFor("app.modelPicker"), "ctrl+m");
  assert.equal(kb.keyFor("app.thinking.cycle"), "shift+tab");
  assert.equal(kb.keyFor("app.exit"), "ctrl+c");
});

test("SparkKeybindings executeKey runs the handler bound to a key", async () => {
  const calls: string[] = [];
  const kb = new SparkKeybindings({
    defaults: [
      {
        id: "app.exit",
        defaultKey: "ctrl+c",
        description: "exit",
        handler: () => void calls.push("exit"),
      },
    ],
  });
  const fired = await kb.executeKey("ctrl+c", {});
  assert.equal(fired, true);
  assert.deepEqual(calls, ["exit"]);

  const missed = await kb.executeKey("ctrl+x", {});
  assert.equal(missed, false);
});

test("SparkKeybindings most-recent registration wins on the same key (Spark mode override)", async () => {
  const calls: string[] = [];
  const kb = new SparkKeybindings({
    defaults: [
      {
        id: "app.thinking.cycle",
        defaultKey: "shift+tab",
        description: "thinking cycle",
        handler: () => void calls.push("thinking"),
      },
    ],
  });
  let sparkActive = true;
  kb.register({
    id: "app.spark.cycleMode",
    defaultKey: "shift+tab",
    description: "Spark mode cycle",
    handler: () => void calls.push("spark"),
    isActive: () => sparkActive,
  });

  await kb.executeKey("shift+tab", {});
  assert.deepEqual(calls, ["spark"], "spark cycleMode wins while active");

  // When Spark is inactive, the default thinking.cycle takes over again.
  sparkActive = false;
  await kb.executeKey("shift+tab", {});
  assert.deepEqual(calls, ["spark", "thinking"], "thinking.cycle takes over when spark inactive");
});

test("SparkKeybindings setOverride updates keyFor without re-registering", () => {
  const kb = new SparkKeybindings();
  assert.equal(kb.keyFor("app.exit"), "ctrl+c");
  kb.setOverride("app.exit", "ctrl+q");
  assert.equal(kb.keyFor("app.exit"), "ctrl+q");
  kb.setOverride("app.exit", undefined);
  assert.equal(kb.keyFor("app.exit"), "ctrl+c");
});

test("SparkKeybindings load/save round-trip uses ~/.spark/agent/keybindings.json layout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-keybindings-"));
  try {
    const path = join(dir, "keybindings.json");
    const a = new SparkKeybindings();
    a.setOverride("app.modelPicker", "ctrl+m");
    a.setOverride("app.exit", "ctrl+q");
    await a.saveToDisk(path);

    const b = new SparkKeybindings();
    await b.loadFromDisk(path);
    assert.equal(b.keyFor("app.modelPicker"), "ctrl+m");
    assert.equal(b.keyFor("app.exit"), "ctrl+q");
    // Bindings without overrides still report the default key
    assert.equal(b.keyFor("app.thinking.cycle"), "shift+tab");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkKeybindings loadFromDisk silently ignores missing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-keybindings-missing-"));
  try {
    const path = join(dir, "absent.json");
    const kb = new SparkKeybindings();
    await assert.doesNotReject(kb.loadFromDisk(path));
    assert.equal(kb.keyFor("app.exit"), "ctrl+c");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkHostRuntime.executeKey forwards to the embedded keybindings registry", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-keybindings-host" });
  let invocations = 0;
  host.getKeybindings().register({
    id: "test.binding",
    defaultKey: "ctrl+t",
    description: "test only",
    handler: () => void (invocations += 1),
  });
  const fired = await host.executeKey("ctrl+t");
  assert.equal(fired, true);
  assert.equal(invocations, 1);
});

test("SparkHostRuntime.registerShortcut wires extensions into the keybindings registry", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-keybindings-host" });
  let toggled = 0;
  host.registerShortcut("ctrl+shift+p", {
    description: "Toggle plan mode",
    handler: () => void (toggled += 1),
  });
  const fired = await host.executeKey("ctrl+shift+p");
  assert.equal(fired, true);
  assert.equal(toggled, 1);
});

test("SparkHostRuntime.registerShortcut respects isActive gate", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-keybindings-host" });
  let active = false;
  let invoked = 0;
  host.registerShortcut("ctrl+g", {
    description: "Gated",
    handler: () => void (invoked += 1),
    isActive: () => active,
  });
  assert.equal(await host.executeKey("ctrl+g"), false);
  assert.equal(invoked, 0);
  active = true;
  assert.equal(await host.executeKey("ctrl+g"), true);
  assert.equal(invoked, 1);
});
