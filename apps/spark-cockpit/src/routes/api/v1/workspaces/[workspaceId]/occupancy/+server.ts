import { getCurrentUserIdBySessionToken } from "@zendev-lab/spark-cockpit-coordination/cockpit-queries";
import { getDatabase } from "$lib/server/db";
import {
  queueWorkspaceOccupancyCommand,
  workspaceExists,
  type WorkspaceOccupancyAction,
} from "$lib/server/workspace-occupancy";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const workspaceId = params.workspaceId;
  if (!workspaceId) throw error(400, "workspaceId is required");
  if (locals.workspaceId && locals.workspaceId !== workspaceId) {
    throw error(403, "Workspace session does not match occupancy target");
  }

  const db = getDatabase();
  if (!workspaceExists(db, workspaceId)) throw error(404, "Workspace not found");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, "Invalid JSON body");
  }
  if (!isRecord(body)) throw error(400, "Invalid occupancy payload");

  const action = parseAction(body.action);
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!action) throw error(400, "action must be attach, heartbeat, or release");
  if (!clientId) throw error(400, "clientId is required");

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : undefined;
  const leaseTtlMs =
    typeof body.leaseTtlMs === "number" && Number.isFinite(body.leaseTtlMs)
      ? Math.max(0, Math.floor(body.leaseTtlMs))
      : undefined;

  const command = queueWorkspaceOccupancyCommand(db, {
    workspaceId,
    action,
    clientId,
    ...(sessionId ? { sessionId } : {}),
    ...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
    requestedByUserId: getCurrentUserIdBySessionToken(db, locals.sessionToken),
  });

  return json({
    ok: true,
    action,
    workspaceId,
    clientId,
    commandId: command.id,
  });
};

function parseAction(value: unknown): WorkspaceOccupancyAction | null {
  if (value === "attach" || value === "heartbeat" || value === "release") return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
