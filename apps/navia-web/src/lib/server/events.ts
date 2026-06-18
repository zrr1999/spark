import type { DatabaseSync } from "node:sqlite";

export interface EventCursor {
  createdAt: string;
  id: string;
}

export interface EventRow extends EventCursor {
  workspaceId: string | null;
  projectId: string | null;
  actorKind: string;
  actorId: string | null;
  kind: string;
  subjectKind: string | null;
  subjectId: string | null;
  payloadJson: string;
}

export interface SerializedEvent extends EventCursor {
  workspaceId: string | null;
  projectId: string | null;
  actorKind: string;
  actorId: string | null;
  kind: string;
  subjectKind: string | null;
  subjectId: string | null;
  payload: unknown;
}

export function loadEventBatch(
  db: DatabaseSync,
  cursor: EventCursor | null,
  limit = 50,
): EventRow[] {
  if (cursor) {
    return db
      .prepare(
        `SELECT id,
                workspace_id AS workspaceId,
                project_id AS projectId,
                actor_kind AS actorKind,
                actor_id AS actorId,
                kind,
                subject_kind AS subjectKind,
                subject_id AS subjectId,
                payload_json AS payloadJson,
                created_at AS createdAt
         FROM events
         WHERE created_at > ? OR (created_at = ? AND id > ?)
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(cursor.createdAt, cursor.createdAt, cursor.id, limit) as unknown as EventRow[];
  }

  return db
    .prepare(
      `SELECT * FROM (
         SELECT id,
                workspace_id AS workspaceId,
                project_id AS projectId,
                actor_kind AS actorKind,
                actor_id AS actorId,
                kind,
                subject_kind AS subjectKind,
                subject_id AS subjectId,
                payload_json AS payloadJson,
                created_at AS createdAt
         FROM events
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )
       ORDER BY createdAt ASC, id ASC`,
    )
    .all(limit) as unknown as EventRow[];
}

export function serializeEventRow(row: EventRow): SerializedEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    actorKind: row.actorKind,
    actorId: row.actorId,
    kind: row.kind,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    payload: parsePayload(row.payloadJson),
    createdAt: row.createdAt,
  };
}

export function encodeSseMessage(event: string, data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function cursorFromEvent(row: EventRow | SerializedEvent): EventCursor {
  return { createdAt: row.createdAt, id: row.id };
}

function parsePayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson);
  } catch {
    return { invalidPayloadJson: true };
  }
}
