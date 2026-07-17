import type { DatabaseSync } from "node:sqlite";

export interface EventCursor {
  createdAt: string;
  id: string;
  /** Database-owned monotonic ingest sequence. Missing on legacy browser cursors. */
  sequence?: number;
}

export interface EventRow extends EventCursor {
  sequence: number;
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
    const sequence = cursor.sequence ?? eventSequenceForLegacyCursor(db, cursor);
    if (sequence !== null) {
      return db
        .prepare(
          `SELECT id,
                  ingest_sequence AS sequence,
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
           WHERE ingest_sequence > ?
           ORDER BY ingest_sequence ASC
           LIMIT ?`,
        )
        .all(sequence, limit) as unknown as EventRow[];
    }

    // Compatibility for a stale cursor whose event has since been removed.
    // New cursors always resolve to ingest_sequence above.
    return db
      .prepare(
        `SELECT id,
                ingest_sequence AS sequence,
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
         ORDER BY ingest_sequence ASC
         LIMIT ?`,
      )
      .all(cursor.createdAt, cursor.createdAt, cursor.id, limit) as unknown as EventRow[];
  }

  return db
    .prepare(
      `SELECT * FROM (
         SELECT id,
                ingest_sequence AS sequence,
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
         ORDER BY ingest_sequence DESC
         LIMIT ?
       )
       ORDER BY sequence ASC`,
    )
    .all(limit) as unknown as EventRow[];
}

export function latestEventCursor(db: DatabaseSync): EventCursor | null {
  const row = db
    .prepare(
      `SELECT id, created_at AS createdAt, ingest_sequence AS sequence
       FROM events
       ORDER BY ingest_sequence DESC
       LIMIT 1`,
    )
    .get() as { id: string; createdAt: string; sequence: number } | undefined;
  return row ? { id: row.id, createdAt: row.createdAt, sequence: row.sequence } : null;
}

export function serializeEventRow(row: EventRow): SerializedEvent {
  return {
    id: row.id,
    sequence: row.sequence,
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
  return {
    createdAt: row.createdAt,
    id: row.id,
    ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}),
  };
}

export interface EventDrainOptions {
  batchSize?: number;
  maxBatches?: number;
}

export interface EventDrainResult {
  rows: EventRow[];
  cursor: EventCursor | null;
  /** True when the bounded drain stopped on a full final batch. */
  mayHaveMore: boolean;
}

/** Drain a bounded backlog without letting one SSE client monopolize the loop. */
export function drainEventBatches(
  db: DatabaseSync,
  cursor: EventCursor | null,
  options: EventDrainOptions = {},
): EventDrainResult {
  const batchSize = positiveInteger(options.batchSize, 50);
  const maxBatches = positiveInteger(options.maxBatches, 8);
  const rows: EventRow[] = [];
  let nextCursor = cursor;
  let lastBatchSize = 0;

  for (let index = 0; index < maxBatches; index += 1) {
    const batch = loadEventBatch(db, nextCursor, batchSize);
    lastBatchSize = batch.length;
    if (batch.length === 0) break;
    rows.push(...batch);
    nextCursor = cursorFromEvent(batch.at(-1)!);
    if (batch.length < batchSize) break;
  }

  return {
    rows,
    cursor: nextCursor,
    mayHaveMore: lastBatchSize === batchSize,
  };
}

function eventSequenceForLegacyCursor(db: DatabaseSync, cursor: EventCursor): number | null {
  const row = db
    .prepare("SELECT ingest_sequence AS sequence FROM events WHERE id = ? LIMIT 1")
    .get(cursor.id) as { sequence: number | null } | undefined;
  return typeof row?.sequence === "number" ? row.sequence : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function parsePayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson);
  } catch {
    return { invalidPayloadJson: true };
  }
}
