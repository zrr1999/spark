import type { DatabaseSync } from "node:sqlite";
import type { QqbotGatewayCursor } from "@zendev-lab/spark-channels";

export interface SparkQqbotGatewayCursorStoreOptions {
  now?: () => string;
}

interface QqbotGatewayCursorRow {
  session_id: string;
  last_seq: number;
}

/** Daemon-owned gateway resume state, scoped to one workspace adapter. */
export class SparkQqbotGatewayCursorStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(db: DatabaseSync, options: SparkQqbotGatewayCursorStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get(workspaceId: string, adapterId: string): QqbotGatewayCursor | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id, last_seq
         FROM qqbot_gateway_cursors
         WHERE workspace_id = ? AND adapter_id = ?`,
      )
      .get(
        requiredIdentity(workspaceId, "workspaceId"),
        requiredIdentity(adapterId, "adapterId"),
      ) as QqbotGatewayCursorRow | undefined;
    return row ? { sessionId: row.session_id, lastSeq: row.last_seq } : undefined;
  }

  save(workspaceId: string, adapterId: string, cursor: QqbotGatewayCursor | null): void {
    const workspace = requiredIdentity(workspaceId, "workspaceId");
    const adapter = requiredIdentity(adapterId, "adapterId");
    if (!cursor) {
      this.db
        .prepare(
          `DELETE FROM qqbot_gateway_cursors
           WHERE workspace_id = ? AND adapter_id = ?`,
        )
        .run(workspace, adapter);
      return;
    }
    const sessionId = requiredIdentity(cursor.sessionId, "sessionId");
    if (!Number.isSafeInteger(cursor.lastSeq) || cursor.lastSeq < 0) {
      throw new Error("qqbot gateway cursor lastSeq must be a non-negative safe integer");
    }
    this.db
      .prepare(
        `INSERT INTO qqbot_gateway_cursors
           (workspace_id, adapter_id, session_id, last_seq, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, adapter_id) DO UPDATE SET
           session_id = excluded.session_id,
           last_seq = excluded.last_seq,
           updated_at = excluded.updated_at
         WHERE qqbot_gateway_cursors.session_id != excluded.session_id
            OR qqbot_gateway_cursors.last_seq <= excluded.last_seq`,
      )
      .run(workspace, adapter, sessionId, cursor.lastSeq, this.now());
  }
}

function requiredIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`qqbot gateway cursor ${label} must not be empty`);
  return normalized;
}
