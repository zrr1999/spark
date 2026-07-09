import { json, type RequestHandler } from "@sveltejs/kit";
import type { PushSubscription } from "web-push";
import { getDatabase } from "$lib/server/db";
import {
  deleteWebPushSubscription,
  saveWebPushSubscription,
  webPushPublicConfig,
} from "$lib/server/web-push";

export const GET: RequestHandler = () => json(webPushPublicConfig());

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { subscription?: unknown } | null;
  if (!body?.subscription || typeof body.subscription !== "object") {
    return json({ error: "invalid_push_subscription" }, { status: 400 });
  }
  saveWebPushSubscription(getDatabase(), body.subscription as PushSubscription);
  return json({ ok: true });
};

export const DELETE: RequestHandler = () => {
  deleteWebPushSubscription(getDatabase());
  return json({ ok: true });
};
