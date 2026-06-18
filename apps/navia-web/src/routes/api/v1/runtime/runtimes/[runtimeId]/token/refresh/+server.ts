import {
  runtimeTokenRefreshRequestSchema,
  runtimeTokenRefreshResponseSchema,
} from "@navia-dev/protocol";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { errorJson } from "$lib/server/json";
import { refreshRuntimeToken, RuntimeTokenRefreshError } from "$lib/server/runtime-registration";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const runtimeId = params.runtimeId;
  if (!runtimeId) {
    return errorJson(
      "missing_runtime_id",
      "Runtime token refresh route is missing a runtime id.",
      400,
      undefined,
      locals.requestId,
    );
  }

  const parsed = runtimeTokenRefreshRequestSchema.safeParse(
    await request.json().catch(() => undefined),
  );

  if (!parsed.success) {
    return errorJson(
      "invalid_runtime_token_refresh",
      "Runtime token refresh payload is invalid.",
      400,
      parsed.error.flatten(),
      locals.requestId,
    );
  }

  let refreshed;
  try {
    refreshed = refreshRuntimeToken(getDatabase(), {
      runtimeId,
      refreshToken: parsed.data.refreshToken,
    });
  } catch (caught) {
    if (caught instanceof RuntimeTokenRefreshError) {
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

  const response = runtimeTokenRefreshResponseSchema.parse(refreshed);
  return json(response);
};
