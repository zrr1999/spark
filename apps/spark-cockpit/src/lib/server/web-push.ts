import type { DatabaseSync } from "node:sqlite";
import webPush, { type PushSubscription, type RequestOptions } from "web-push";
import { cursorFromEvent, loadEventBatch, serializeEventRow, type EventCursor } from "./events";
import {
  notificationFromCockpitEvent,
  sanitizeNotificationPayload,
  type CockpitNotificationPayload,
} from "../cockpit-notifications";

export const webPushSubscriptionSettingKey = "spark_cockpit:web_push_subscription";
export const webPushVapidPublicKeyEnv = "SPARK_COCKPIT_VAPID_PUBLIC_KEY";
export const webPushVapidPrivateKeyEnv = "SPARK_COCKPIT_VAPID_PRIVATE_KEY";
export const webPushVapidSubjectEnv = "SPARK_COCKPIT_VAPID_SUBJECT";

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface WebPushDispatchResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
}

export type WebPushSender = (
  subscription: PushSubscription,
  payload?: string | Buffer,
  options?: RequestOptions,
) => Promise<unknown>;

export function loadWebPushConfig(
  env: Record<string, string | undefined> = process.env,
): WebPushConfig | null {
  const publicKey = env[webPushVapidPublicKeyEnv]?.trim();
  const privateKey = env[webPushVapidPrivateKeyEnv]?.trim();
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: env[webPushVapidSubjectEnv]?.trim() || "mailto:spark-cockpit@example.invalid",
  };
}

export function webPushPublicConfig(env?: Record<string, string | undefined>) {
  const config = loadWebPushConfig(env);
  return { configured: Boolean(config), publicKey: config?.publicKey ?? null };
}

export function saveWebPushSubscription(
  db: DatabaseSync,
  subscription: PushSubscription,
  now = new Date(),
): void {
  db.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(webPushSubscriptionSettingKey, JSON.stringify(subscription), now.toISOString());
}

export function deleteWebPushSubscription(db: DatabaseSync): void {
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(webPushSubscriptionSettingKey);
}

export function loadWebPushSubscription(db: DatabaseSync): PushSubscription | null {
  const row = db
    .prepare("SELECT value_json AS valueJson FROM app_settings WHERE key = ?")
    .get(webPushSubscriptionSettingKey) as { valueJson: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.valueJson) as unknown;
    return isPushSubscription(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function dispatchWebPushNotification(input: {
  db: DatabaseSync;
  notification: CockpitNotificationPayload;
  env?: Record<string, string | undefined>;
  sender?: WebPushSender;
}): Promise<WebPushDispatchResult> {
  const config = loadWebPushConfig(input.env);
  if (!config) return { status: "skipped", reason: "web_push_not_configured" };
  const subscription = loadWebPushSubscription(input.db);
  if (!subscription) return { status: "skipped", reason: "web_push_not_subscribed" };
  const notification = sanitizeNotificationPayload(input.notification);
  if (!notification) return { status: "skipped", reason: "invalid_notification" };

  const sender = input.sender ?? defaultWebPushSender(config);
  try {
    await sender(subscription, JSON.stringify(notification), { TTL: 60 });
    return { status: "sent" };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "web_push_send_failed",
    };
  }
}

export async function dispatchNotificationsForEventBatch(input: {
  db: DatabaseSync;
  cursor: EventCursor | null;
  limit?: number;
  env?: Record<string, string | undefined>;
  sender?: WebPushSender;
}): Promise<{ cursor: EventCursor | null; sent: number; skipped: number; failed: number }> {
  const rows = loadEventBatch(input.db, input.cursor, input.limit ?? 50);
  let cursor = input.cursor;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const event = serializeEventRow(row);
    cursor = cursorFromEvent(event);
    const notification = notificationFromCockpitEvent(event);
    if (!notification) continue;
    const result = await dispatchWebPushNotification({
      db: input.db,
      notification,
      env: input.env,
      sender: input.sender,
    });
    if (result.status === "sent") sent += 1;
    else if (result.status === "failed") failed += 1;
    else skipped += 1;
  }
  return { cursor, sent, skipped, failed };
}

export function latestEventCursor(db: DatabaseSync): EventCursor | null {
  const row = db
    .prepare(
      "SELECT id, created_at AS createdAt FROM events ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get() as { id: string; createdAt: string } | undefined;
  return row ? { id: row.id, createdAt: row.createdAt } : null;
}

export function startWebPushEventDispatcher(input: {
  db: DatabaseSync;
  intervalMs?: number;
  env?: Record<string, string | undefined>;
  sender?: WebPushSender;
}): () => void {
  let cursor = latestEventCursor(input.db);
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void dispatchNotificationsForEventBatch({
      db: input.db,
      cursor,
      env: input.env,
      sender: input.sender,
    })
      .then((result) => {
        cursor = result.cursor;
      })
      .finally(() => {
        running = false;
      });
  };
  const interval = setInterval(tick, input.intervalMs ?? 5_000);
  return () => clearInterval(interval);
}

function defaultWebPushSender(config: WebPushConfig): WebPushSender {
  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return (subscription, payload, options) =>
    webPush.sendNotification(subscription, payload, options);
}

function isPushSubscription(value: unknown): value is PushSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = record.keys as Record<string, unknown> | undefined;
  return (
    typeof record.endpoint === "string" &&
    record.endpoint.startsWith("https://") &&
    Boolean(keys && typeof keys.p256dh === "string" && typeof keys.auth === "string")
  );
}
