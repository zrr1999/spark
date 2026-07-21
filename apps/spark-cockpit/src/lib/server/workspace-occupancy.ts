import type { DatabaseSync } from "node:sqlite";
import { submitServerCommand } from "@zendev-lab/spark-coordination/command-submission";

export const cockpitOccupancyLeaseTtlMs = 60_000;

export type WorkspaceOccupancyAction = "attach" | "heartbeat" | "release";

export interface QueueWorkspaceOccupancyInput {
  workspaceId: string;
  action: WorkspaceOccupancyAction;
  clientId: string;
  sessionId?: string;
  leaseTtlMs?: number;
  requestedByUserId?: string | null;
}

export function workspaceExists(db: DatabaseSync, workspaceId: string): boolean {
  const row = db.prepare("SELECT id FROM workspaces WHERE id = ? LIMIT 1").get(workspaceId) as
    | { id: string }
    | undefined;
  return Boolean(row?.id);
}

export function queueWorkspaceOccupancyCommand(
  db: DatabaseSync,
  input: QueueWorkspaceOccupancyInput,
) {
  const leaseTtlMs = input.leaseTtlMs ?? cockpitOccupancyLeaseTtlMs;
  const sessionId = input.sessionId?.trim() || input.clientId;
  if (input.action === "attach") {
    return submitServerCommand(db, {
      workspaceId: input.workspaceId,
      requestedByUserId: input.requestedByUserId,
      payload: {
        kind: "workspace.client.attach.request",
        scope: "workspace",
        payload: {
          clientId: input.clientId,
          sessionId,
          kind: "interactive",
          displayName: "Cockpit workbench",
          leaseTtlMs,
          surface: "cockpit",
          metadata: {
            surface: "cockpit",
            sessionId,
          },
        },
      },
    });
  }
  if (input.action === "heartbeat") {
    return submitServerCommand(db, {
      workspaceId: input.workspaceId,
      requestedByUserId: input.requestedByUserId,
      payload: {
        kind: "workspace.client.heartbeat.request",
        scope: "workspace",
        payload: {
          clientId: input.clientId,
          leaseTtlMs,
        },
      },
    });
  }
  return submitServerCommand(db, {
    workspaceId: input.workspaceId,
    requestedByUserId: input.requestedByUserId,
    payload: {
      kind: "workspace.client.release.request",
      scope: "workspace",
      payload: {
        clientId: input.clientId,
      },
    },
  });
}
