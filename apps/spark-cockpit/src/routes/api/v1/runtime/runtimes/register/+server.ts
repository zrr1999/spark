import {
  runtimeRegistrationRequestSchema,
  runtimeRegistrationResponseSchema,
  runtimeProtocolVersion,
} from "@zendev-lab/spark-protocol";
import { bearerTokenFromAuthorization } from "@zendev-lab/spark-system";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { errorJson } from "$lib/server/json";
import {
  registerRuntime,
  RuntimeEnrollmentError,
  RuntimeWorkspaceOwnerConflictError,
} from "$lib/server/runtime-registration";

export const POST: RequestHandler = async ({ request, locals, url }) => {
  const parsed = runtimeRegistrationRequestSchema.safeParse(
    await request.json().catch(() => undefined),
  );

  if (!parsed.success) {
    return errorJson(
      "invalid_runtime_registration",
      "Workspace registration payload is invalid.",
      400,
      parsed.error.flatten(),
      locals.requestId,
    );
  }

  let registered;
  try {
    registered = registerRuntime(getDatabase(), parsed.data, bearerToken(request));
  } catch (caught) {
    if (caught instanceof RuntimeWorkspaceOwnerConflictError) {
      return errorJson(
        caught.reasonCode.toLowerCase(),
        caught.message,
        409,
        undefined,
        locals.requestId,
      );
    }
    if (caught instanceof RuntimeEnrollmentError) {
      return errorJson(
        caught.reasonCode.toLowerCase(),
        caught.message,
        401,
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

  return json(response, { status: 201 });
};

function bearerToken(request: Request) {
  return bearerTokenFromAuthorization(request.headers.get("authorization") ?? undefined);
}
