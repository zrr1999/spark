import {
  runtimeRelocationPreflightRequestSchema,
  runtimeRelocationPreflightResponseSchema,
} from "@zendev-lab/spark-protocol";
import { json, type RequestHandler } from "@sveltejs/kit";
import { errorJson } from "$lib/server/json";
import {
  cockpitRuntimeRelocationInstanceId,
  preflightCockpitRuntimeRelocation,
  RuntimeRelocationPreflightError,
  RuntimeTokenRefreshError,
} from "$lib/server/runtime-relocation";

export const POST: RequestHandler = async ({ request, url, locals }) => {
  if (url.protocol !== "https:") {
    return errorJson(
      "relocation_https_required",
      "Runtime relocation preflight requires HTTPS.",
      400,
      undefined,
      locals.requestId,
    );
  }
  const parsed = runtimeRelocationPreflightRequestSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parsed.success) {
    return errorJson(
      "invalid_runtime_relocation_preflight",
      "Runtime relocation preflight payload is invalid.",
      400,
      parsed.error.flatten(),
      locals.requestId,
    );
  }
  const instanceId = cockpitRuntimeRelocationInstanceId();
  if (!instanceId || instanceId !== parsed.data.sourceInstanceId) {
    return errorJson(
      "relocation_instance_mismatch",
      "Target Cockpit is not the relocated source instance.",
      409,
      undefined,
      locals.requestId,
    );
  }
  try {
    const refreshed = preflightCockpitRuntimeRelocation(parsed.data);
    const webSocketUrl = new URL(
      `/api/v1/runtime/runtimes/${encodeURIComponent(refreshed.runtimeId)}/ws`,
      url.origin,
    );
    webSocketUrl.protocol = "wss:";
    return json(
      runtimeRelocationPreflightResponseSchema.parse({
        instanceId,
        ...refreshed,
        webSocketUrl: webSocketUrl.toString(),
      }),
    );
  } catch (error) {
    if (error instanceof RuntimeRelocationPreflightError) {
      return errorJson(
        error.reasonCode.toLowerCase(),
        error.message,
        409,
        undefined,
        locals.requestId,
      );
    }
    if (error instanceof RuntimeTokenRefreshError) {
      return errorJson(
        error.reasonCode.toLowerCase(),
        error.message,
        401,
        undefined,
        locals.requestId,
      );
    }
    throw error;
  }
};
