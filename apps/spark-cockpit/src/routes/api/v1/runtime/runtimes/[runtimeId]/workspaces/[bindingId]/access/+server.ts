import { workspaceBrowserAuthorizationSchema } from "@zendev-lab/spark-protocol";
import { bearerTokenFromAuthorization } from "@zendev-lab/spark-system";
import { json, type RequestHandler } from "@sveltejs/kit";
import { getDatabase } from "$lib/server/db";
import { errorJson } from "$lib/server/json";
import {
  createRuntimeWorkspaceBrowserAccess,
  RuntimeAccessTokenError,
  RuntimeEnrollmentError,
} from "@zendev-lab/spark-coordination/runtime-registration";

export const POST: RequestHandler = ({ params, request, locals, url }) => {
  const runtimeId = params.runtimeId;
  const bindingId = params.bindingId;
  if (!runtimeId || !bindingId) {
    return errorJson(
      "missing_workspace_access_route",
      "Workspace browser access route is incomplete.",
      400,
      undefined,
      locals.requestId,
    );
  }

  try {
    const authorization = createRuntimeWorkspaceBrowserAccess(getDatabase(), {
      runtimeId,
      bindingId,
      runtimeToken: bearerTokenFromAuthorization(request.headers.get("authorization") ?? undefined),
    });
    const loginUrl = new URL(
      `/${encodeURIComponent(authorization.workspaceSlug)}/login`,
      url.origin,
    ).toString();
    return json(
      {
        ...workspaceBrowserAuthorizationSchema.parse(authorization),
        loginUrl,
      },
      { status: 201 },
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
