import type { DatabaseSync } from "node:sqlite";
import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import {
  conversationActivityStatus,
  type ConversationActivityStatus,
} from "../conversation-status";

export { conversationActivityStatus } from "../conversation-status";

interface ConversationCommandRow {
  commandStatus: string;
  deliveryStatus: string | null;
  invocationStatus: string | null;
  sessionId: string;
  updatedAt: string;
}

export type CockpitConversationSummary = SparkSessionRegistryRecord & {
  activityStatus: ConversationActivityStatus;
  activityUpdatedAt: string;
};

/**
 * Enrich daemon-owned sessions with the latest user-visible conversation state.
 * Project/task/run records remain internal projections; the sidebar only needs
 * their rolled-up status and last activity time.
 */
export function loadConversationSummaries(
  db: DatabaseSync,
  sessions: SparkSessionRegistryRecord[],
): CockpitConversationSummary[] {
  if (sessions.length === 0) return [];

  const visibleSessionIds = [...new Set(sessions.map((session) => session.sessionId))];
  const latestBySession = new Map<
    string,
    { activityStatus: ConversationActivityStatus; activityUpdatedAt: string }
  >();
  const rows = db
    .prepare(
      `WITH visible_sessions AS (
         SELECT CAST(value AS TEXT) AS sessionId
           FROM json_each(?)
       ),
       candidate_commands AS (
         SELECT visible_sessions.sessionId,
                c.id AS commandId,
                c.created_at AS commandCreatedAt,
                c.status AS commandStatus,
                MAX(
                  c.updated_at,
                  COALESCE(cd.updated_at, c.updated_at),
                  COALESCE(mi.updated_at, c.updated_at)
                ) AS updatedAt,
                cd.status AS deliveryStatus,
                mi.status AS invocationStatus
           FROM commands c
           JOIN visible_sessions
             ON visible_sessions.sessionId = CASE
               WHEN json_valid(c.payload_json)
               THEN CAST(json_extract(c.payload_json, '$.payload.target.sessionId') AS TEXT)
               ELSE NULL
             END
           LEFT JOIN command_deliveries cd
             ON cd.id = (
               SELECT cd2.id
                 FROM command_deliveries cd2
                WHERE cd2.command_id = c.id
                ORDER BY cd2.updated_at DESC
                LIMIT 1
             )
           LEFT JOIN mirrored_invocations mi
             ON mi.id = (
               SELECT mi2.id
                 FROM mirrored_invocations mi2
                WHERE mi2.command_id = c.id
                ORDER BY mi2.updated_at DESC
                LIMIT 1
             )
          WHERE c.kind = 'assignment.create.request'
       ),
       ranked_commands AS (
         SELECT sessionId,
                commandStatus,
                deliveryStatus,
                invocationStatus,
                updatedAt,
                ROW_NUMBER() OVER (
                  PARTITION BY sessionId
                  ORDER BY updatedAt DESC, commandCreatedAt DESC, commandId DESC
                ) AS rowNumber
           FROM candidate_commands
       )
       SELECT sessionId,
              commandStatus,
              deliveryStatus,
              invocationStatus,
              updatedAt
         FROM ranked_commands
        WHERE rowNumber = 1`,
    )
    .all(JSON.stringify(visibleSessionIds)) as unknown as ConversationCommandRow[];

  for (const row of rows) {
    latestBySession.set(row.sessionId, {
      activityStatus: conversationActivityStatus(
        row.invocationStatus ?? row.deliveryStatus ?? row.commandStatus,
      ),
      activityUpdatedAt: row.updatedAt,
    });
  }

  return sessions.map((session) => {
    const latest = latestBySession.get(session.sessionId);
    const daemonStatus = sessionFallbackStatus(session.status);
    // Active execution is daemon-owned. A delayed Cockpit mirror may still say
    // queued/running after the daemon invocation has reached a terminal state;
    // never let that optional projection resurrect a settled conversation.
    const projectedOutcome =
      latest &&
      latest.activityUpdatedAt >= session.updatedAt &&
      latest.activityStatus !== "queued" &&
      latest.activityStatus !== "running"
        ? latest.activityStatus
        : null;
    return {
      ...session,
      activityStatus:
        daemonStatus === "running" ? daemonStatus : (projectedOutcome ?? daemonStatus),
      activityUpdatedAt:
        latest && latest.activityUpdatedAt > session.updatedAt
          ? latest.activityUpdatedAt
          : session.updatedAt,
    };
  });
}

function sessionFallbackStatus(status: string): ConversationActivityStatus {
  const normalized = status.trim().toLowerCase();
  if (["failed", "error"].includes(normalized)) return "failed";
  if (normalized === "running") return "running";
  return "ready";
}
