import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { appendEvent } from "@zendev-lab/spark-server/projection-services";
import {
  deleteWebPushSubscription,
  dispatchNotificationsForEventBatch,
  dispatchWebPushNotification,
  loadWebPushSubscription,
  saveWebPushSubscription,
  webPushPublicConfig,
  type WebPushSender,
} from "./web-push";

const subscription = {
  endpoint: "https://push.example.test/send/1",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};
const env = {
  SPARK_COCKPIT_VAPID_PUBLIC_KEY: "public-key",
  SPARK_COCKPIT_VAPID_PRIVATE_KEY: "private-key",
  SPARK_COCKPIT_VAPID_SUBJECT: "mailto:ops@example.test",
};

describe("web push notifications", () => {
  it("stores and removes a single-user PushManager subscription", () => {
    const db = openMemoryDatabase();
    migrate(db);

    saveWebPushSubscription(db, subscription);
    expect(loadWebPushSubscription(db)).toEqual(subscription);
    deleteWebPushSubscription(db);
    expect(loadWebPushSubscription(db)).toBeNull();
    db.close();
  });

  it("exposes public VAPID configuration without leaking the private key", () => {
    expect(webPushPublicConfig(env)).toEqual({ configured: true, publicKey: "public-key" });
    expect(webPushPublicConfig({})).toEqual({ configured: false, publicKey: null });
  });

  it("dispatches sanitized notifications through the configured Web Push sender", async () => {
    const db = openMemoryDatabase();
    migrate(db);
    saveWebPushSubscription(db, subscription);
    const sent: Array<{ endpoint: string; payload: string; ttl: number | undefined }> = [];
    const sender: WebPushSender = async (target, payload, options) => {
      sent.push({ endpoint: target.endpoint, payload: String(payload), ttl: options?.TTL });
    };

    await expect(
      dispatchWebPushNotification({
        db,
        env,
        sender,
        notification: {
          title: "Spark task finished\nprivate detail",
          body: "A long-running Spark task completed. Open Cockpit to review the result.",
          tag: "spark-invocation-inv_done",
          url: "/",
          kind: "task_terminal",
        },
      }),
    ).resolves.toEqual({ status: "sent" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.endpoint).toBe(subscription.endpoint);
    expect(sent[0]?.ttl).toBe(60);
    expect(JSON.parse(sent[0]!.payload)).toEqual({
      title: "Spark task finished private detail",
      body: "A long-running Spark task completed. Open Cockpit to review the result.",
      tag: "spark-invocation-inv_done",
      url: "/",
      kind: "task_terminal",
    });
    db.close();
  });

  it("maps event batches to Web Push dispatch for terminal tasks and blockers", async () => {
    const db = openMemoryDatabase();
    migrate(db);
    saveWebPushSubscription(db, subscription);
    appendEvent(db, {
      actorKind: "runtime",
      kind: "invocation.updated",
      subjectKind: "invocation",
      subjectId: "inv_running",
      payload: { runtimeInvocationId: "inv_running", status: "running" },
      createdAt: "2026-07-03T00:00:00.000Z",
    });
    appendEvent(db, {
      actorKind: "runtime",
      kind: "invocation.updated",
      subjectKind: "invocation",
      subjectId: "inv_done",
      payload: { runtimeInvocationId: "inv_done", status: "succeeded", terminalReason: "secret" },
      createdAt: "2026-07-03T00:00:01.000Z",
    });
    appendEvent(db, {
      actorKind: "runtime",
      kind: "human.request.created",
      subjectKind: "human_request",
      subjectId: "hreq_blocker",
      payload: { prompt: "private blocker prompt" },
      createdAt: "2026-07-03T00:00:02.000Z",
    });
    const payloads: unknown[] = [];
    const sender: WebPushSender = async (_target, payload) => {
      payloads.push(JSON.parse(String(payload)) as unknown);
    };

    const result = await dispatchNotificationsForEventBatch({ db, cursor: null, env, sender });

    expect(result).toMatchObject({ sent: 2, skipped: 0, failed: 0 });
    expect(payloads).toEqual([
      {
        title: "Spark task finished",
        body: "A long-running Spark task completed. Open Cockpit to review the result.",
        tag: "spark-invocation-inv_done",
        url: "/",
        kind: "task_terminal",
      },
      {
        title: "Spark is waiting for you",
        body: "A blocker, approval, or review needs a response in Cockpit.",
        tag: "spark-blocker-hreq_blocker",
        url: "/",
        kind: "blocker",
      },
    ]);
    expect(result.cursor?.id).toMatch(/^evt_/);
    db.close();
  });
});
