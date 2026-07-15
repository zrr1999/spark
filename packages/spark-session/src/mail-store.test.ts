import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SparkSessionMailStore } from "./mail-store.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(now: () => number = () => Date.parse("2026-07-15T00:00:00Z")) {
  const sparkHome = await mkdtemp(join(tmpdir(), "spark-session-mail-receipts-"));
  tempRoots.push(sparkHome);
  return new SparkSessionMailStore({ sparkHome, now });
}

describe("SparkSessionMailStore channel delivery receipts", () => {
  it("normalizes targets into one deterministic pending set and preserves idempotency", async () => {
    const store = await createStore();
    const first = await store.send({
      toSessionId: "session:channel",
      fromSessionId: "session:sender",
      visibility: "user",
      deliveryTargets: [
        { adapter: " qqbot ", externalKey: " user:2 " },
        { adapter: "infoflow", externalKey: "user:1" },
        { adapter: "qqbot", externalKey: "user:2" },
      ],
      body: "release ready",
      idempotencyKey: "notify:release",
      source: "tool",
    });

    expect(first.message.delivery).toBe("channel");
    expect(first.message.deliveries).toEqual([
      {
        adapter: "infoflow",
        externalKey: "user:1",
        status: "pending",
        attemptCount: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: null,
        receipt: null,
      },
      {
        adapter: "qqbot",
        externalKey: "user:2",
        status: "pending",
        attemptCount: 0,
        lastAttemptAt: null,
        deliveredAt: null,
        lastError: null,
        receipt: null,
      },
    ]);

    const retry = await store.send({
      toSessionId: "session:channel",
      fromSessionId: "session:sender",
      visibility: "user",
      deliveryTargets: [
        { adapter: "qqbot", externalKey: "user:2" },
        { adapter: "infoflow", externalKey: "user:1" },
      ],
      body: "release ready",
      idempotencyKey: "notify:release",
      source: "tool",
    });
    expect(retry.created).toBe(false);
    expect(retry.message.id).toBe(first.message.id);

    await expect(
      store.send({
        toSessionId: "session:channel",
        fromSessionId: "session:sender",
        visibility: "internal",
        deliveryTargets: [
          { adapter: "infoflow", externalKey: "user:1" },
          { adapter: "qqbot", externalKey: "user:2" },
        ],
        body: "release ready",
        idempotencyKey: "notify:release",
        source: "tool",
      }),
    ).rejects.toThrow(/reused for a different message/u);
    await expect(
      store.send({
        toSessionId: "session:channel",
        delivery: "mailbox",
        deliveryTargets: [{ adapter: "infoflow", externalKey: "user:1" }],
      }),
    ).rejects.toThrow(/mailbox delivery cannot declare channel delivery targets/u);
  });

  it("keeps failures retryable and makes the first success durable and idempotent", async () => {
    let now = Date.parse("2026-07-15T01:00:00Z");
    const store = await createStore(() => now);
    const sent = await store.send({
      toSessionId: "session:channel",
      delivery: "channel",
      deliveryTargets: [{ adapter: "infoflow", externalKey: "user:1" }],
      body: "build finished",
    });

    now += 1_000;
    const failed = await store.recordChannelDelivery(
      "session:channel",
      sent.message.id,
      { adapter: " infoflow ", externalKey: " user:1 " },
      { ok: false, error: "gateway unavailable" },
    );
    expect(failed.deliveries[0]).toMatchObject({
      status: "failed",
      attemptCount: 1,
      lastAttemptAt: "2026-07-15T01:00:01.000Z",
      deliveredAt: null,
      lastError: "gateway unavailable",
      receipt: null,
    });

    now += 1_000;
    const transportReceipt = { platformMessageId: "msg:42", metadata: { delivered: true } };
    const delivered = await store.recordChannelDelivery(
      "session:channel",
      sent.message.id,
      { adapter: "infoflow", externalKey: "user:1" },
      { ok: true, receipt: transportReceipt },
    );
    transportReceipt.metadata.delivered = false;
    expect(delivered.deliveries[0]).toEqual({
      adapter: "infoflow",
      externalKey: "user:1",
      status: "delivered",
      attemptCount: 2,
      lastAttemptAt: "2026-07-15T01:00:02.000Z",
      deliveredAt: "2026-07-15T01:00:02.000Z",
      lastError: null,
      receipt: { platformMessageId: "msg:42", metadata: { delivered: true } },
    });

    now += 1_000;
    const duplicate = await store.recordChannelDelivery(
      "session:channel",
      sent.message.id,
      { adapter: "infoflow", externalKey: "user:1" },
      { ok: false, error: "late duplicate failure" },
    );
    expect(duplicate.deliveries).toEqual(delivered.deliveries);
    expect((await store.get("session:channel", sent.message.id)).deliveries).toEqual(
      delivered.deliveries,
    );
  });
});
