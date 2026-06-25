import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  SparkForegroundDriveSubstrate,
  scheduledDriveDelayMs,
} from "../packages/spark-extension/src/extension/spark-drive-substrate.ts";

void test("SparkForegroundDriveSubstrate cancels stale generations per drive", async () => {
  const substrate = new SparkForegroundDriveSubstrate();
  const fired: string[] = [];

  substrate.schedule({
    drive: "goal",
    baseKey: "workspace:session",
    delayMs: 5,
    run: (generation) => fired.push(`goal:${generation}`),
  });
  substrate.schedule({
    drive: "goal",
    baseKey: "workspace:session",
    delayMs: 5,
    run: (generation) => fired.push(`goal:${generation}`),
  });
  substrate.schedule({
    drive: "loop",
    baseKey: "workspace:session",
    delayMs: 5,
    run: (generation) => fired.push(`loop:${generation}`),
  });

  await delay(25);

  assert.deepEqual(fired.sort(), ["goal:2", "loop:1"]);
});

void test("SparkForegroundDriveSubstrate clears timers without affecting other drives", async () => {
  const substrate = new SparkForegroundDriveSubstrate();
  const fired: string[] = [];

  substrate.schedule({
    drive: "goal",
    baseKey: "workspace:session",
    delayMs: 5,
    run: () => fired.push("goal"),
  });
  substrate.schedule({
    drive: "loop",
    baseKey: "workspace:session",
    delayMs: 5,
    run: () => fired.push("loop"),
  });
  substrate.clearTimer("goal", "workspace:session");

  await delay(25);

  assert.deepEqual(fired, ["loop"]);
});

void test("scheduledDriveDelayMs supports absent, invalid, past, and future schedules", () => {
  assert.equal(scheduledDriveDelayMs(undefined), undefined);
  assert.equal(scheduledDriveDelayMs({ nextRunAt: "not-a-date" }), 0);
  assert.equal(scheduledDriveDelayMs({ nextRunAt: "2000-01-01T00:00:00.000Z" }), 0);
  const future = Date.now() + 10_000;
  const computed = scheduledDriveDelayMs({ nextRunAt: new Date(future).toISOString() });
  assert.equal(typeof computed, "number");
  assert.ok(computed! > 0 && computed! <= 10_000);
});
