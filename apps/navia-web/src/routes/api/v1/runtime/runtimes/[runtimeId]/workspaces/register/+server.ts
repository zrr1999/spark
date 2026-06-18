import {
  runtimeWorkspaceRegistrationRequestSchema,
  runtimeWorkspaceRegistrationResponseSchema,
} from "@navia-dev/protocol";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { errorJson } from "$lib/server/json";
import {
  registerRuntimeWorkspace,
  RuntimeAccessTokenError,
  RuntimeEnrollmentError,
} from "$lib/server/runtime-registration";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const runtimeId = params.runtimeId;
  if (!runtimeId) {
    return errorJson(
      "missing_runtime_id",
      "Workspace registration route is missing a runtime id.",
      400,
      undefined,
      locals.requestId,
    );
  }

  const parsed = runtimeWorkspaceRegistrationRequestSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parsed.success) {
    return errorJson(
      "invalid_workspace_registration",
      "Workspace registration payload is invalid.",
      400,
      parsed.error.flatten(),
      locals.requestId,
    );
  }

  let registered;
  try {
    registered = registerRuntimeWorkspace(
      getDatabase(),
      runtimeId,
      parsed.data,
      bearerToken(request),
    );
  } catch (caught) {
    if (caught instanceof RuntimeAccessTokenError || caught instanceof RuntimeEnrollmentError) {
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

  return json(runtimeWorkspaceRegistrationResponseSchema.parse(registered), { status: 201 });
};

function bearerToken(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}
