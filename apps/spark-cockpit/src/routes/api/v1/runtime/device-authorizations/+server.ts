import {
  runtimeDeviceAuthorizationRequestSchema,
  runtimeDeviceAuthorizationResponseSchema,
} from "@zendev-lab/spark-protocol";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { errorJson } from "$lib/server/json";
import {
  createRuntimeDeviceAuthorization,
  RuntimeDeviceAuthorizationError,
} from "$lib/server/runtime-registration";

export const POST: RequestHandler = async ({ request, locals, url }) => {
  const parsed = runtimeDeviceAuthorizationRequestSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parsed.success) {
    return errorJson(
      "invalid_device_authorization_request",
      "Daemon registration metadata is invalid.",
      400,
      parsed.error.flatten(),
      locals.requestId,
    );
  }

  let authorization;
  try {
    authorization = createRuntimeDeviceAuthorization(getDatabase(), parsed.data);
  } catch (caught) {
    if (
      caught instanceof RuntimeDeviceAuthorizationError &&
      (caught.reasonCode === "too_many_pending_authorizations" ||
        caught.reasonCode === "authorization_capacity_exceeded")
    ) {
      return errorJson(
        caught.reasonCode,
        caught.message,
        caught.reasonCode === "too_many_pending_authorizations" ? 429 : 503,
        undefined,
        locals.requestId,
      );
    }
    throw caught;
  }
  const verificationUrl = new URL("/daemon/authorize", url.origin);
  const verificationUrlComplete = new URL(verificationUrl);
  verificationUrlComplete.searchParams.set("user_code", authorization.userCode);

  const response = runtimeDeviceAuthorizationResponseSchema.parse({
    deviceCode: authorization.deviceCode,
    userCode: authorization.userCode,
    verificationUri: verificationUrl.toString(),
    verificationUriComplete: verificationUrlComplete.toString(),
    expiresIn: authorization.expiresIn,
    interval: authorization.interval,
  });
  return json(response, { status: 201, headers: { "cache-control": "no-store" } });
};
