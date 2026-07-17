import type { RequestEvent } from "@sveltejs/kit";
import { RuntimeControlCommandError } from "@zendev-lab/spark-coordination/runtime-control";
import type { RuntimeEphemeralSecretRequestContext } from "@zendev-lab/spark-coordination/runtime-model-channel-control";
import { getCurrentUserId } from "./auth.ts";
import { getDatabase } from "./db.ts";

export function requireSecretRequestContext(
  event: Pick<RequestEvent, "locals" | "request" | "url">,
): RuntimeEphemeralSecretRequestContext {
  if (event.url.protocol !== "https:") {
    throw new RuntimeControlCommandError(
      "Secret operations require the HTTPS Cockpit origin.",
      "SECRET_HTTPS_REQUIRED",
    );
  }
  const origin = event.request.headers.get("origin");
  if (!origin || origin !== event.url.origin) {
    throw new RuntimeControlCommandError(
      "Secret operation origin validation failed.",
      "SECRET_CSRF_REQUIRED",
    );
  }
  const actorUserId = getCurrentUserId(getDatabase(), event.locals.sessionToken);
  if (!actorUserId) {
    throw new RuntimeControlCommandError(
      "Secret operations require an authenticated Cockpit owner session.",
      "SECRET_OWNER_REQUIRED",
    );
  }
  return {
    actorUserId,
    browserRequestId: event.locals.requestId,
    csrfVerified: true,
    pageProtocol: "https:",
  };
}
