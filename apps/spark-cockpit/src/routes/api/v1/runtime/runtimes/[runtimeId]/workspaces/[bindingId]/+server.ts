import { json, type RequestHandler } from "@sveltejs/kit";
import { unbindRuntimeWorkspace } from "@zendev-lab/spark-cockpit-coordination/runtime-registration";
import { bearerTokenFromAuthorization } from "@zendev-lab/spark-system";
import { getDatabase } from "$lib/server/db";
import { errorJson } from "$lib/server/json";
import {
  RuntimeAccessTokenError,
  RuntimeEnrollmentError,
} from "@zendev-lab/spark-cockpit-coordination/runtime-registration";

export const DELETE: RequestHandler = ({ params, request, locals }) => {
  const runtimeId = params.runtimeId;
  const bindingId = params.bindingId;
  if (!runtimeId || !bindingId) {
    return errorJson(
      "missing_workspace_binding_route",
      "Workspace unbind route is incomplete.",
      400,
      undefined,
      locals.requestId,
    );
  }

  try {
    return json(
      unbindRuntimeWorkspace(getDatabase(), {
        runtimeId,
        bindingId,
        runtimeToken: bearerTokenFromAuthorization(
          request.headers.get("authorization") ?? undefined,
        ),
      }),
    );
  } catch (caught) {
    if (caught instanceof RuntimeAccessTokenError) {
      return errorJson(
        caught.reasonCode.toLowerCase(),
        caught.message,
        caught.reasonCode === "RUNTIME_TOKEN_SCOPE_INVALID" ? 403 : 401,
        undefined,
        locals.requestId,
      );
    }
    if (caught instanceof RuntimeEnrollmentError) {
      return errorJson(
        caught.reasonCode.toLowerCase(),
        caught.message,
        caught.reasonCode === "WORKSPACE_BINDING_NOT_FOUND" ? 404 : 400,
        undefined,
        locals.requestId,
      );
    }
    throw caught;
  }
};
