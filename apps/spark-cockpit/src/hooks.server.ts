import { createId } from "@zendev-lab/spark-protocol";
import type { Handle } from "@sveltejs/kit";
import { sessionCookieName } from "$lib/server/auth";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.requestId = createId("msg");
  event.locals.sessionToken = event.cookies.get(sessionCookieName) ?? null;
  return resolve(event);
};
