/**
 * Cockpit command submission — projection outbox that delivers via spark-protocol envelopes.
 *
 * Daemon/runtime remains the canonical execution owner. Cockpit persists queued commands
 * in SQLite and runtime-ws flushes them as `server.command` envelopes on reconnect/heartbeat.
 */

import type { ServerCommandPayload } from "@zendev-lab/spark-protocol";
import type { DatabaseSync } from "node:sqlite";
import { queueCommandForWorkspaceOwner, type QueueCommandInput } from "./projection-services.ts";

export interface SubmitServerCommandInput {
  workspaceId: string;
  projectId?: string | null;
  requestedByUserId?: string | null;
  idempotencyKey?: string | null;
  payload: ServerCommandPayload;
  createdAt?: string;
}

export function submitServerCommand(db: DatabaseSync, input: SubmitServerCommandInput) {
  const queueInput: QueueCommandInput = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    requestedByUserId: input.requestedByUserId,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    createdAt: input.createdAt,
  };
  return queueCommandForWorkspaceOwner(db, queueInput);
}
