import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MAX_CHANNEL_DELIVERY_RETRY_MS,
  SparkChannelDeliveryStore,
  channelDeliveryRetryDelayMs,
  sparkChannelDeliveryKinds,
} from "./channel-deliveries.ts";
import { migrateSparkDaemonDatabase } from "./schema.ts";

function createStore(options: { now?: () => string; random?: () => number } = {}): {
  db: DatabaseSync;
  store: SparkChannelDeliveryStore;
} {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  return { db, store: new SparkChannelDeliveryStore(db, options) };
}

describe("SparkChannelDeliveryStore", () => {
  it("stores every delivery kind and makes the idempotency key unique and immutable", () => {
    const { db, store } = createStore({ now: () => "2026-07-15T00:00:00.000Z" });
    try {
      for (const [index, kind] of sparkChannelDeliveryKinds.entries()) {
        const delivery = store.enqueue({
          deliveryId: `delivery-${index}`,
          kind,
          idempotencyKey: `idem-${index}`,
          payload: { kind, index },
        });
        expect(delivery).toMatchObject({
          deliveryId: `delivery-${index}`,
          kind,
          idempotencyKey: `idem-${index}`,
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: "2026-07-15T00:00:00.000Z",
        });
      }

      const first = store.require("delivery-0");
      expect(
        store.enqueue({
          kind: "reply",
          idempotencyKey: "idem-0",
          payload: { kind: "reply", index: 0 },
        }),
      ).toEqual(first);
      expect(() =>
        store.enqueue({
          kind: "ask",
          idempotencyKey: "idem-0",
          payload: { kind: "ask", index: 0 },
        }),
      ).toThrow(/CHANNEL_DELIVERY_IDEMPOTENCY_CONFLICT/u);
      expect(() =>
        db
          .prepare("UPDATE channel_deliveries SET idempotency_key = ? WHERE id = ?")
          .run("changed", "delivery-0"),
      ).toThrow(/idempotency_key is immutable/u);
    } finally {
      db.close();
    }
  });

  it("renews an active fenced lease and reclaims it only after heartbeats stop", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-channel-delivery-"));
    const databasePath = join(root, "daemon.sqlite");
    const dbA = new DatabaseSync(databasePath);
    const dbB = new DatabaseSync(databasePath);
    let now = "2026-07-15T00:00:00.000Z";
    try {
      migrateSparkDaemonDatabase(dbA);
      const storeA = new SparkChannelDeliveryStore(dbA, { now: () => now });
      const storeB = new SparkChannelDeliveryStore(dbB, { now: () => now });
      storeA.enqueue({
        deliveryId: "delivery-lease",
        kind: "reply",
        idempotencyKey: "lease-once",
        payload: { text: "hello" },
      });

      const firstClaim = storeA.claimDue("worker-a", { leaseMs: 1_000 });
      expect(firstClaim).toMatchObject({
        deliveryId: "delivery-lease",
        status: "pending",
        attemptCount: 1,
        leaseOwner: "worker-a",
        leaseExpiresAt: "2026-07-15T00:00:01.000Z",
      });
      expect(firstClaim?.leaseToken).toMatch(/^chlease_/u);
      expect(storeB.claimDue("worker-b", { leaseMs: 1_000 })).toBeUndefined();

      now = "2026-07-15T00:00:00.800Z";
      expect(
        storeA.renewLease("delivery-lease", firstClaim!.leaseToken!, { leaseMs: 1_000 }),
      ).toMatchObject({
        deliveryId: "delivery-lease",
        leaseOwner: "worker-a",
        leaseExpiresAt: "2026-07-15T00:00:01.800Z",
      });

      now = "2026-07-15T00:00:01.000Z";
      expect(storeB.claimDue("worker-b", { leaseMs: 2_000 })).toBeUndefined();

      now = "2026-07-15T00:00:01.800Z";
      const reclaimed = storeB.claimDue("worker-b", { leaseMs: 2_000 });
      expect(reclaimed).toMatchObject({
        deliveryId: "delivery-lease",
        attemptCount: 2,
        leaseOwner: "worker-b",
        leaseExpiresAt: "2026-07-15T00:00:03.800Z",
      });
      expect(reclaimed?.leaseToken).not.toBe(firstClaim?.leaseToken);
      expect(() =>
        storeA.renewLease("delivery-lease", firstClaim!.leaseToken!, { leaseMs: 1_000 }),
      ).toThrow(/CHANNEL_DELIVERY_LEASE_LOST/u);
      expect(() =>
        storeA.recordDelivered("delivery-lease", firstClaim!.leaseToken!, { stale: true }),
      ).toThrow(/CHANNEL_DELIVERY_LEASE_LOST/u);
      expect(() =>
        storeA.recordFailure("delivery-lease", firstClaim!.leaseToken!, "stale failure"),
      ).toThrow(/CHANNEL_DELIVERY_LEASE_LOST/u);

      expect(
        storeB.recordDelivered("delivery-lease", reclaimed!.leaseToken!, {
          adapter: "qq-main",
          messageId: "message-1",
        }),
      ).toMatchObject({
        status: "delivered",
        attemptCount: 2,
        receipt: { adapter: "qq-main", messageId: "message-1" },
        deliveredAt: "2026-07-15T00:00:01.800Z",
      });
      expect(storeA.claimDue("worker-c")).toBeUndefined();
    } finally {
      dbB.close();
      dbA.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries forever with injected deterministic exponential backoff capped at 60 seconds", () => {
    let now = "2026-07-15T00:00:00.000Z";
    let random = 0;
    const { db, store } = createStore({
      now: () => now,
      random: () => random,
    });
    try {
      store.enqueue({
        deliveryId: "delivery-retry",
        kind: "ask",
        idempotencyKey: "retry-forever",
        payload: { prompt: "continue?" },
      });
      const first = store.claimDue("worker-a", { leaseMs: 10_000 });
      expect(
        store.recordFailure("delivery-retry", first!.leaseToken!, "channel unavailable"),
      ).toMatchObject({
        status: "retry_wait",
        attemptCount: 1,
        nextAttemptAt: "2026-07-15T00:00:00.500Z",
        lastError: "channel unavailable",
      });
      expect(store.summary()).toEqual({
        pending: 1,
        retrying: 1,
        inFlight: 0,
        delivered: 0,
        oldestPendingAt: "2026-07-15T00:00:00.000Z",
        lastError: "channel unavailable",
        lastErrorAt: "2026-07-15T00:00:00.000Z",
      });

      now = "2026-07-15T00:00:00.499Z";
      expect(store.claimDue("worker-b")).toBeUndefined();
      now = "2026-07-15T00:00:00.500Z";
      random = 1;
      const second = store.claimDue("worker-b", { leaseMs: 10_000 });
      expect(second).toMatchObject({ attemptCount: 2, leaseOwner: "worker-b" });
      expect(
        store.recordFailure("delivery-retry", second!.leaseToken!, "still unavailable"),
      ).toMatchObject({
        attemptCount: 2,
        nextAttemptAt: "2026-07-15T00:00:02.500Z",
      });

      now = "2026-07-15T01:00:00.000Z";
      const recovered = store.claimDue("worker-recovered", { leaseMs: 10_000 });
      expect(recovered).toMatchObject({ deliveryId: "delivery-retry", attemptCount: 3 });
      store.recordDelivered("delivery-retry", recovered!.leaseToken!, { recovered: true });

      store.enqueue({
        deliveryId: "delivery-unbounded",
        kind: "interaction_ack",
        idempotencyKey: "unbounded-attempts",
        payload: { responseId: "response-1" },
      });
      db.prepare("UPDATE channel_deliveries SET attempt_count = 999 WHERE id = ?").run(
        "delivery-unbounded",
      );
      const thousandth = store.claimDue("worker-c", { leaseMs: 10_000 });
      expect(thousandth).toMatchObject({ deliveryId: "delivery-unbounded", attemptCount: 1_000 });
      expect(
        store.recordFailure("delivery-unbounded", thousandth!.leaseToken!, "attempt 1000"),
      ).toMatchObject({
        status: "retry_wait",
        attemptCount: 1_000,
        nextAttemptAt: "2026-07-15T01:01:00.000Z",
      });
      expect(channelDeliveryRetryDelayMs(1_000, () => 1)).toBe(MAX_CHANNEL_DELIVERY_RETRY_MS);
    } finally {
      db.close();
    }
  });
});
