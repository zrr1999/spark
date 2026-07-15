import {
  runtimeWorkspaceRegistrationRequestSchema,
  runtimeWorkspaceRegistrationResponseSchema,
} from "@zendev-lab/spark-protocol";
import { bearerTokenFromAuthorization } from "@zendev-lab/spark-system";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { errorJson } from "$lib/server/json";
import {
  registerRuntimeWorkspace,
  RuntimeAccessTokenError,
  RuntimeEnrollmentError,
  RuntimeWorkspaceOwnerConflictError,
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
    if (caught instanceof RuntimeWorkspaceOwnerConflictError) {
      return errorJson(
        caught.reasonCode.toLowerCase(),
        caught.message,
        409,
        undefined,
        locals.requestId,
      );
    }
    if (caught instanceof RuntimeAccessTokenError || caught instanceof RuntimeEnrollmentError) {
      const status =
        caught.reasonCode === "RUNTIME_TOKEN_SCOPE_INVALID" ||
        caught.reasonCode === "WORKSPACE_REGISTRATION_TOKEN_SCOPE_INVALID"
          ? 403
          : 401;
      return errorJson(
        caught.reasonCode.toLowerCase(),
        caught.message,
        status,
        undefined,
        locals.requestId,
      );
    }
    throw caught;
  }

  return json(runtimeWorkspaceRegistrationResponseSchema.parse(registered), { status: 201 });
};

function bearerToken(request: Request) {
  return bearerTokenFromAuthorization(request.headers.get("authorization") ?? undefined);
}
