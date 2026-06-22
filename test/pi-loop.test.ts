import assert from "node:assert/strict";
import test from "node:test";

import {
  LOOP_CUSTOM_ENTRY_TYPE,
  blockLoop,
  clearLoopEntry,
  compactLoopPrompt,
  continuationLoopIdFromPrompt,
  createLoop,
  createLoopResult,
  evaluateLoopTick,
  loopContinuationPrompt,
  reconstructLoop,
  recordLoopFailure,
  replaceLoop,
  setLoopEntry,
  updateLoopStatus,
} from "../packages/pi-loop/src/index.ts";

void test("pi-loop creates, reconstructs, and clears loop state", () => {
  const loop = createLoop("Keep making progress", 100);
  assert.equal(loop.objective, "Keep making progress");
  assert.equal(loop.status, "active");
  assert.equal(loop.tick.count, 0);

  const entries = [
    { type: "custom", customType: LOOP_CUSTOM_ENTRY_TYPE, data: setLoopEntry(loop, "tool", 101) },
  ];
  assert.deepEqual(reconstructLoop(entries).loop, loop);

  entries.push({
    type: "custom",
    customType: LOOP_CUSTOM_ENTRY_TYPE,
    data: clearLoopEntry(loop.loopId, "tool", 102),
  });
  assert.equal(reconstructLoop(entries).hasLoop, false);
});

void test("pi-loop lifecycle uses active and paused only and has no complete status", () => {
  const loop = createLoop("Continue safely", 100);
  const paused = updateLoopStatus(loop, "paused");
  assert.equal(paused.ok, true);
  assert.equal(paused.loop?.status, "paused");

  const resumed = updateLoopStatus(paused.loop, "active");
  assert.equal(resumed.ok, true);
  assert.equal(resumed.loop?.status, "active");
  assert.equal(updateLoopStatus(resumed.loop, "active").ok, false);

  assert.doesNotMatch(JSON.stringify(resumed.loop), /complete/iu);
  assert.ok(["active", "paused"].includes(resumed.loop?.status ?? ""));
});

void test("pi-loop tick continues, waits, blocks, and never emits goal completion instructions", () => {
  const loop = createLoop("Run the next step", 100);
  const first = evaluateLoopTick({ loop, now: 101, reason: "start" });
  assert.equal(first.decision, "continue");
  assert.equal(first.loop?.tick.count, 1);
  assert.match(first.prompt ?? "", /pi_loop_continuation/);
  assert.doesNotMatch(first.prompt ?? "", /goal\(\{ action: "complete" \}\)/);
  assert.doesNotMatch(first.prompt ?? "", /reviewer/iu);

  const failed = recordLoopFailure(first.loop!, { retryBackoffMs: [30_000] }, 102);
  const waiting = evaluateLoopTick({ loop: failed, now: 120, reason: "retry" });
  assert.equal(waiting.decision, "wait");

  const blockedLoop = blockLoop(first.loop!, "needs user decision", ["artifact:blocker"], 130);
  const blocked = evaluateLoopTick({ loop: blockedLoop, now: 131 });
  assert.equal(blocked.decision, "blocked");
  assert.match(blocked.message, /needs user decision/);
});

void test("pi-loop prompts preserve continuation markers", () => {
  const loop = createLoop("Ship a layered primitive", 100);
  const compact = compactLoopPrompt(loop);
  const full = loopContinuationPrompt(loop);

  assert.equal(continuationLoopIdFromPrompt(compact), loop.loopId);
  assert.equal(continuationLoopIdFromPrompt(full), loop.loopId);
  assert.match(full, /<pi_loop_continuation loop_id=/);
  assert.match(full, /<\/pi_loop_continuation>/);
});

void test("pi-loop result helpers reject empty objectives and concurrent loops", () => {
  assert.equal(createLoopResult(null, "   ").ok, false);
  const current = createLoop("current", 100);
  const rejected = createLoopResult(current, "next");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.loop, current);

  const paused = updateLoopStatus(current, "paused").loop;
  const rejectedPaused = createLoopResult(paused, "next");
  assert.equal(rejectedPaused.ok, false);
  assert.equal(rejectedPaused.loop, paused);

  const replacement = replaceLoop("replacement");
  assert.equal(replacement.ok, true);
  assert.equal(replacement.loop?.objective, "replacement");
});
