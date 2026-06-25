import assert from "node:assert/strict";
import test from "node:test";

import { SparkAuthSlotPool, type SparkAuthPool } from "@zendev-lab/spark-ai";

class FakeClock {
  value = 1_700_000_000_000;

  now(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

function authPool(): SparkAuthPool {
  return {
    id: "baidu-primary",
    slots: [
      {
        id: "main",
        priority: 100,
        authRef: { kind: "env", name: "BAIDU_ONEAPI_API_KEY" },
      },
      {
        id: "backup",
        priority: 10,
        authRef: { kind: "secret", id: "secret://baidu-backup-token" },
      },
    ],
  };
}

void test("SparkAuthSlotPool selects the highest-priority non-cooled slot", () => {
  const clock = new FakeClock();
  const pool = new SparkAuthSlotPool(authPool(), { clock, baseCooldownMs: 1_000 });

  const selection = pool.selectSlot();

  assert.equal(selection.slotId, "main");
  assert.equal(selection.reason, "available");
  assert.equal(selection.cooledDown, false);
  assert.equal(pool.snapshot().slots.find((slot) => slot.id === "main")?.inflight, 1);
});

void test("SparkAuthSlotPool cools failed rate-limit slots and chooses backup", () => {
  const clock = new FakeClock();
  const pool = new SparkAuthSlotPool(authPool(), { clock, baseCooldownMs: 1_000 });

  const selection = pool.selectSlot();
  pool.recordFailure(selection.slotId, "rate_limit");

  const snapshot = pool.snapshot();
  const main = snapshot.slots.find((slot) => slot.id === "main");
  assert.equal(main?.health, "cooldown");
  assert.equal(main?.consecutiveFailures, 1);
  assert.match(main?.cooldownUntil ?? "", /^2023-/u);

  const next = pool.selectSlot();
  assert.equal(next.slotId, "backup");
  assert.equal(next.reason, "available");
});

void test("SparkAuthSlotPool fail-opens with the least-cooled slot when all slots are cooling", () => {
  const clock = new FakeClock();
  const pool = new SparkAuthSlotPool(authPool(), { clock, baseCooldownMs: 1_000 });

  pool.recordFailure("main", "rate_limit");
  clock.advance(100);
  pool.recordFailure("backup", "rate_limit");

  const selection = pool.selectSlot();

  assert.equal(selection.slotId, "main");
  assert.equal(selection.reason, "all_slots_cooled_fail_open");
  assert.equal(selection.cooledDown, true);
});

void test("SparkAuthSlotPool applies capped exponential backoff", () => {
  const clock = new FakeClock();
  const pool = new SparkAuthSlotPool(authPool(), {
    clock,
    baseCooldownMs: 100,
    maxCooldownMs: 250,
  });

  pool.recordFailure("main", "rate_limit");
  assert.equal(new Date(pool.snapshot().slots[0]!.cooldownUntil!).getTime() - clock.now(), 100);
  pool.recordFailure("main", "rate_limit");
  assert.equal(new Date(pool.snapshot().slots[0]!.cooldownUntil!).getTime() - clock.now(), 200);
  pool.recordFailure("main", "rate_limit");
  assert.equal(new Date(pool.snapshot().slots[0]!.cooldownUntil!).getTime() - clock.now(), 250);
});

void test("SparkAuthSlotPool success clears cooldown and consecutive failures", () => {
  const clock = new FakeClock();
  const pool = new SparkAuthSlotPool(authPool(), { clock, baseCooldownMs: 1_000 });

  pool.recordFailure("main", "auth");
  let main = pool.snapshot().slots.find((slot) => slot.id === "main");
  assert.equal(main?.health, "cooldown");
  assert.equal(main?.consecutiveFailures, 1);

  pool.recordSuccess("main");
  main = pool.snapshot().slots.find((slot) => slot.id === "main");
  assert.equal(main?.health, "ok");
  assert.equal(main?.consecutiveFailures, 0);
  assert.equal(main?.cooldownUntil, undefined);
});

void test("SparkAuthSlotPool snapshot exposes only slot ids and authRefHash", () => {
  const pool = new SparkAuthSlotPool(authPool());

  const snapshot = pool.snapshot();
  const serialized = JSON.stringify(snapshot);

  assert.match(snapshot.slots[0]?.authRefHash ?? "", /^fnv1a:/u);
  assert.doesNotMatch(serialized, /BAIDU_ONEAPI_API_KEY/u);
  assert.doesNotMatch(serialized, /secret:\/\/baidu-backup-token/u);
});
