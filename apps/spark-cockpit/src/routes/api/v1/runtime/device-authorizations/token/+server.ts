import {
  runtimeDeviceTokenRequestSchema,
  runtimeProtocolVersion,
  runtimeRegistrationResponseSchema,
} from "@zendev-lab/spark-protocol";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { errorJson } from "$lib/server/json";
import {
  exchangeRuntimeDeviceAuthorization,
  RuntimeDeviceAuthorizationError,
} from "@zendev-lab/spark-coordination/runtime-registration";

const deviceErrorStatuses = {
  authorization_pending: 202,
  slow_down: 429,
  access_denied: 403,
  expired_token: 410,
  invalid_grant: 400,
  approval_forbidden: 403,
  too_many_pending_authorizations: 429,
  authorization_capacity_exceeded: 503,
} as const;

export const POST: RequestHandler = async ({ request, locals, url }) => {
  const parsed = runtimeDeviceTokenRequestSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parsed.success) {
    return errorJson(
      "invalid_device_token_request",
      "Daemon device code is invalid.",
      400,
      parsed.error.flatten(),
      locals.requestId,
    );
  }

  let registered;
  try {
    registered = exchangeRuntimeDeviceAuthorization(getDatabase(), {
      deviceCode: parsed.data.deviceCode,
    });
  } catch (caught) {
    if (caught instanceof RuntimeDeviceAuthorizationError) {
      return errorJson(
        caught.reasonCode,
        caught.message,
        deviceErrorStatuses[caught.reasonCode],
        undefined,
        locals.requestId,
      );
    }
    throw caught;
  }

  const response = runtimeRegistrationResponseSchema.parse({
    runtimeId: registered.runtimeId,
    runtimeToken: registered.runtimeToken,
    runtimeTokenExpiresAt: registered.runtimeTokenExpiresAt,
    refreshToken: registered.refreshToken,
    refreshTokenExpiresAt: registered.refreshTokenExpiresAt,
    protocolVersion: runtimeProtocolVersion,
    webSocketUrl: `${url.origin}/api/v1/runtime/runtimes/${registered.runtimeId}/ws`,
    heartbeatIntervalMs: 15_000,
    staleAfterMs: 45_000,
    registeredAt: registered.registeredAt,
    ...(registered.workspaceBinding ? { workspaceBinding: registered.workspaceBinding } : {}),
  });
  return json(response, { status: 201, headers: { "cache-control": "no-store" } });
};
