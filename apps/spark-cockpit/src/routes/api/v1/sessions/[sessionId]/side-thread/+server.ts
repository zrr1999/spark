import {
  CockpitRuntimeSessionUnavailableError,
  isCockpitRuntimeSessionNotFoundError,
} from "$lib/server/cockpit-runtime-session-client";
import {
  controlManagedSideThreadForCockpit,
  getLiveManagedSessionForCockpit,
  getManagedSideThreadSnapshotForCockpit,
} from "$lib/server/managed-sessions";
import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
import {
  isSparkSideThreadErrorCode,
  sparkSideThreadConfigureRequestSchema,
  sparkSideThreadEnsureRequestSchema,
  sparkSideThreadHandoffRequestSchema,
  sparkSideThreadResetRequestSchema,
  sparkSideThreadSubmitRequestSchema,
} from "@zendev-lab/spark-protocol";
import { sparkLocalRpcSideThreadOrpcErrors } from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { RuntimeControlCommandError } from "@zendev-lab/spark-cockpit-coordination/runtime-control";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

class InvalidSideThreadActionError extends Error {}

const sideThreadActionNames = ["ensure", "submit", "reset", "configure", "handoff"] as const;

function parseSideThreadAction(
  action: string,
  parentSessionId: string,
  input: Record<string, unknown>,
): unknown {
  // The URL parent was authorized against the current workspace above. Never
  // allow an untrusted body field to redirect the daemon command elsewhere.
  const request = { ...input, parentSessionId };
  const parsed =
    action === "ensure"
      ? sparkSideThreadEnsureRequestSchema.safeParse(request)
      : action === "submit"
        ? sparkSideThreadSubmitRequestSchema.safeParse(request)
        : action === "reset"
          ? sparkSideThreadResetRequestSchema.safeParse(request)
          : action === "configure"
            ? sparkSideThreadConfigureRequestSchema.safeParse(request)
            : sparkSideThreadHandoffRequestSchema.safeParse(request);
  if (!parsed.success) throw new InvalidSideThreadActionError();
  return parsed.data;
}

function sideThreadActionErrorResponse(error: unknown): Response {
  if (error instanceof InvalidSideThreadActionError) {
    return json({ error: "invalid_side_thread_action" }, { status: 400 });
  }
  if (error instanceof CockpitRuntimeSessionUnavailableError) {
    return json({ error: "side_thread_unavailable" }, { status: 503 });
  }
  if (isCockpitRuntimeSessionNotFoundError(error)) {
    return json({ error: "session_not_found" }, { status: 404 });
  }
  if (error instanceof RuntimeControlCommandError) {
    const code = error.reasonCode.toLowerCase();
    if (["command_result_timeout", "runtime_unavailable", "runtime_offline"].includes(code)) {
      return json({ error: "side_thread_unavailable" }, { status: 503 });
    }
    if (
      [
        "session_not_found",
        "session_scope_mismatch",
        "side_thread_not_found",
        "side_thread_parent_not_found",
        "side_thread_scope_mismatch",
      ].includes(code)
    ) {
      return json({ error: "side_thread_not_found" }, { status: 404 });
    }
    if (isSparkSideThreadErrorCode(code)) {
      return json({ error: code }, { status: sparkLocalRpcSideThreadOrpcErrors[code].status });
    }
  }
  return json({ error: "side_thread_control_failed" }, { status: 500 });
}

/** The parent session remains the authorization boundary for the daemon projection. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  try {
    // Side Thread content can include parent context. Authorize against the
    // daemon's current session record instead of a possibly stale projection.
    const session = await getLiveManagedSessionForCockpit(params.sessionId);
    const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
    if (!session || !workspaceId || (locals?.workspaceId && locals.workspaceId !== workspaceId)) {
      return json({ error: "session_not_found" }, { status: 404 });
    }
    const beforeExchangeId = url.searchParams.get("before")?.trim() || undefined;
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 32;
    const snapshot = await getManagedSideThreadSnapshotForCockpit(params.sessionId, {
      workspaceId,
      ...(beforeExchangeId ? { beforeExchangeId } : {}),
      limit,
    });
    if (!snapshot) return json({ error: "side_thread_not_found" }, { status: 404 });
    return json(snapshot, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return sideThreadActionErrorResponse(error);
  }
};

/**
 * Cockpit is a transport adapter for the daemon-owned Side Thread controller.
 * Every action has the same request shape and generation/head admission rules
 * as TUI; this route neither persists state nor reconstructs lifecycle logic.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  try {
    const session = await getLiveManagedSessionForCockpit(params.sessionId);
    const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
    if (!session || !workspaceId || (locals?.workspaceId && locals.workspaceId !== workspaceId)) {
      return json({ error: "session_not_found" }, { status: 404 });
    }
    const body: unknown = await request.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      !("action" in body) ||
      typeof body.action !== "string"
    ) {
      return json({ error: "invalid_side_thread_action" }, { status: 400 });
    }
    const { action, ...input } = body as { action: string } & Record<string, unknown>;
    if (!sideThreadActionNames.includes(action as (typeof sideThreadActionNames)[number])) {
      return json({ error: "invalid_side_thread_action" }, { status: 400 });
    }
    const parentSessionId = params.sessionId;
    const parsed = parseSideThreadAction(action, parentSessionId, input);
    const result = await controlManagedSideThreadForCockpit(
      parentSessionId,
      workspaceId,
      async (client) => {
        if (action === "ensure") {
          if (!client.ensureSideThread)
            throw new CockpitRuntimeSessionUnavailableError("unavailable");
          return await client.ensureSideThread(parsed as never);
        }
        if (action === "submit") {
          if (!client.submitSideThread)
            throw new CockpitRuntimeSessionUnavailableError("unavailable");
          return await client.submitSideThread(parsed as never);
        }
        if (action === "reset") {
          if (!client.resetSideThread)
            throw new CockpitRuntimeSessionUnavailableError("unavailable");
          return await client.resetSideThread(parsed as never);
        }
        if (action === "configure") {
          if (!client.configureSideThread)
            throw new CockpitRuntimeSessionUnavailableError("unavailable");
          return await client.configureSideThread(parsed as never);
        }
        if (!client.handoffSideThread)
          throw new CockpitRuntimeSessionUnavailableError("unavailable");
        return await client.handoffSideThread(parsed as never);
      },
    );
    if (!result) return json({ error: "session_not_found" }, { status: 404 });
    return json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return sideThreadActionErrorResponse(error);
  }
};
