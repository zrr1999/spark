import type { DatabaseSync } from "node:sqlite";
import {
  createId,
  type HumanRequestCreatedPayload,
  type SparkHumanInteractionStatus,
} from "@zendev-lab/spark-protocol";

type JsonObject = Record<string, unknown>;
type HumanQuestion = HumanRequestCreatedPayload["questions"][number];
type HumanRequestKind = HumanRequestCreatedPayload["kind"];
type HumanWaitStatus = SparkHumanInteractionStatus;

export type SparkDaemonHumanWaitDelivery = "blocking" | "async";

export interface SparkDaemonHumanWaitInput {
  humanRequestId?: string;
  interactionRequestId?: string;
  sessionId?: string;
  invocationId?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
  toolCallId?: string;
  delivery?: SparkDaemonHumanWaitDelivery;
  kind: HumanRequestKind;
  title: string;
  prompt: string;
  questions?: HumanQuestion[];
  context?: JsonObject;
  contextArtifactRefs?: string[];
}

export interface SparkDaemonHumanWaitRecord extends Required<
  Omit<SparkDaemonHumanWaitInput, "humanRequestId">
> {
  humanRequestId: string;
  status: HumanWaitStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SparkDaemonHumanWaitResponse {
  humanRequestId: string;
  humanResponseId: string;
  status: Exclude<HumanWaitStatus, "pending">;
  answers: JsonObject;
  responseArtifactRefs: string[];
  deliveredAt: string;
}

export interface SparkDaemonHumanWaitRegistration {
  wait: SparkDaemonHumanWaitRecord;
  /** Defined only for blocking waits. Async asks intentionally own no suspended tool promise. */
  response?: Promise<SparkDaemonHumanWaitResponse>;
}

export type SparkDaemonHumanWaitDeliveryOutcome =
  | "accepted"
  | "replayed"
  | "already_resolved"
  | "orphaned"
  | "unknown_request"
  | "transient";

export interface SparkDaemonHumanWaitDeliveryResult {
  outcome: SparkDaemonHumanWaitDeliveryOutcome;
  retryable: boolean;
  returnedToTool: boolean;
  message: string;
  winnerResponseId?: string;
  wait?: SparkDaemonHumanWaitRecord;
  response?: SparkDaemonHumanWaitResponse;
}

export interface SparkDaemonHumanWaitCallback {
  wait: SparkDaemonHumanWaitRecord;
  questionId: string;
  value: string;
  label: string;
}

export interface SparkDaemonHumanWaitOutboxInput {
  messageId: string;
  kind: "human.request.created" | "human.response.recorded";
  envelope: JsonObject;
}

export type SparkDaemonHumanWaitOutboxEntry = SparkDaemonHumanWaitOutboxInput;

export interface SparkDaemonHumanWaitOutboxRoute {
  runtimeId: string;
  serverUrl: string | null;
}

export interface SparkDaemonHumanWaitInteractionLookup {
  interactionRequestId: string;
  sessionId?: string;
  invocationId?: string;
}

export class SparkDaemonHumanWaitLookupError extends Error {
  override readonly name = "SparkDaemonHumanWaitLookupError";
  readonly code: "human_interaction_not_found" | "human_interaction_ambiguous";

  constructor(
    code: "human_interaction_not_found" | "human_interaction_ambiguous",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

interface ActiveHumanWait {
  wait: SparkDaemonHumanWaitRecord;
  resolve(response: SparkDaemonHumanWaitResponse): void;
}

interface HumanWaitRow {
  requestJson: string;
  responseJson: string | null;
  acceptedResponseId: string | null;
  status: HumanWaitStatus;
  updatedAt: string;
}

/**
 * Daemon-owned human interaction state.
 *
 * The SQLite row is authoritative. The in-memory map is only the continuation
 * for a currently blocking tool call, so async asks and daemon restarts remain
 * explicit instead of pretending a JavaScript Promise is durable.
 */
export class SparkDaemonHumanWaitRegistry {
  private readonly active = new Map<string, ActiveHumanWait>();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  register(
    input: SparkDaemonHumanWaitInput,
    outbox?: SparkDaemonHumanWaitOutboxInput,
  ): SparkDaemonHumanWaitRegistration {
    const now = new Date().toISOString();
    const wait: SparkDaemonHumanWaitRecord = {
      humanRequestId: input.humanRequestId ?? createId("hreq"),
      interactionRequestId: input.interactionRequestId ?? "",
      sessionId: input.sessionId ?? "",
      invocationId: input.invocationId ?? "",
      workspaceBindingId: input.workspaceBindingId ?? "",
      workspaceId: input.workspaceId ?? "",
      projectId: input.projectId ?? "",
      toolCallId: input.toolCallId ?? "",
      delivery: input.delivery ?? "blocking",
      kind: input.kind,
      title: input.title,
      prompt: input.prompt,
      questions: input.questions ?? [],
      context: input.context ?? {},
      contextArtifactRefs: input.contextArtifactRefs ?? [],
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO daemon_human_waits
            (human_request_id, invocation_id, workspace_binding_id, workspace_id, project_id,
             tool_call_id, kind, status, request_json, response_json, accepted_response_id,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`,
        )
        .run(
          wait.humanRequestId,
          nullable(wait.invocationId),
          nullable(wait.workspaceBindingId),
          nullable(wait.workspaceId),
          nullable(wait.projectId),
          nullable(wait.toolCallId),
          wait.kind,
          JSON.stringify(wait),
          now,
          now,
        );
      if (outbox) {
        this.db
          .prepare(
            `INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?)`,
          )
          .run(outbox.messageId, outbox.kind, JSON.stringify(outbox.envelope), now, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    if (wait.delivery === "async") return { wait };

    let resolve!: (response: SparkDaemonHumanWaitResponse) => void;
    const response = new Promise<SparkDaemonHumanWaitResponse>((done) => {
      resolve = done;
    });
    this.active.set(wait.humanRequestId, { wait, resolve });
    return { wait, response };
  }

  deliver(
    input: {
      humanRequestId?: string;
      humanResponseId?: string;
      status: Exclude<HumanWaitStatus, "pending">;
      answers?: JsonObject;
      responseArtifactRefs?: string[];
    },
    outbox?: SparkDaemonHumanWaitOutboxInput,
  ): SparkDaemonHumanWaitDeliveryResult {
    if (!input.humanRequestId) {
      return unknownRequest(
        "Human response did not include a humanRequestId for a daemon-owned wait.",
      );
    }
    const existing = this.readRow(input.humanRequestId);
    if (!existing) {
      return unknownRequest("No daemon-owned human wait matched this response.");
    }

    const humanResponseId = input.humanResponseId ?? createId("hres");
    const response: SparkDaemonHumanWaitResponse = {
      humanRequestId: input.humanRequestId,
      humanResponseId,
      status: input.status,
      answers: input.answers ?? {},
      responseArtifactRefs: input.responseArtifactRefs ?? [],
      deliveredAt: new Date().toISOString(),
    };
    let updateChanges = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      updateChanges = Number(
        this.db
          .prepare(
            `UPDATE daemon_human_waits
             SET status = ?, response_json = ?, accepted_response_id = ?, updated_at = ?
             WHERE human_request_id = ? AND status = 'pending'`,
          )
          .run(
            response.status,
            JSON.stringify(response),
            humanResponseId,
            response.deliveredAt,
            response.humanRequestId,
          ).changes,
      );
      if (updateChanges === 1 && outbox) {
        this.db
          .prepare(
            `INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            outbox.messageId,
            outbox.kind,
            JSON.stringify(outbox.envelope),
            response.deliveredAt,
            response.deliveredAt,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    if (updateChanges === 1) {
      const active = this.active.get(input.humanRequestId);
      if (active) {
        this.active.delete(input.humanRequestId);
        active.resolve(response);
        return {
          outcome: "accepted",
          retryable: false,
          returnedToTool: true,
          message: "Returned human response to the daemon-owned wait.",
          winnerResponseId: humanResponseId,
          wait: existing.wait,
          response,
        };
      }
      if (existing.wait.delivery === "async") {
        return {
          outcome: "accepted",
          retryable: false,
          returnedToTool: false,
          message: "Recorded human response for the async daemon-owned ask.",
          winnerResponseId: humanResponseId,
          wait: existing.wait,
          response,
        };
      }
      return {
        outcome: "orphaned",
        retryable: false,
        returnedToTool: false,
        message: "Recorded human response, but the blocking daemon wait is no longer attached.",
        winnerResponseId: humanResponseId,
        wait: existing.wait,
        response,
      };
    }

    const settled = this.readRow(input.humanRequestId);
    if (!settled) return unknownRequest("Daemon-owned human wait disappeared during delivery.");
    if (settled.acceptedResponseId === humanResponseId) {
      return {
        outcome: "replayed",
        retryable: false,
        returnedToTool: false,
        message: "Human response was already accepted.",
        winnerResponseId: humanResponseId,
        wait: settled.wait,
        ...(settled.response ? { response: settled.response } : {}),
      };
    }
    return {
      outcome: "already_resolved",
      retryable: false,
      returnedToTool: false,
      message: "Human request was already resolved by another response.",
      ...(settled.acceptedResponseId ? { winnerResponseId: settled.acceptedResponseId } : {}),
      wait: settled.wait,
      ...(settled.response ? { response: settled.response } : {}),
    };
  }

  get(humanRequestId: string): SparkDaemonHumanWaitRecord | null {
    return this.readRow(humanRequestId)?.wait ?? null;
  }

  listPending(): SparkDaemonHumanWaitRecord[] {
    const rows = this.db
      .prepare(
        `SELECT request_json AS requestJson, response_json AS responseJson,
                accepted_response_id AS acceptedResponseId, status, updated_at AS updatedAt
         FROM daemon_human_waits
         WHERE status = 'pending'
         ORDER BY created_at`,
      )
      .all() as unknown as HumanWaitRow[];
    return rows.map((row) => parseHumanWaitRow(row).wait);
  }

  requireUniquePendingInteraction(
    input: SparkDaemonHumanWaitInteractionLookup,
  ): SparkDaemonHumanWaitRecord {
    return requireUniqueInteractionMatch(this.listPending(), input, "pending ");
  }

  /** Resolve a stable response retry after the wait may already have settled. */
  requireUniqueInteraction(
    input: SparkDaemonHumanWaitInteractionLookup,
  ): SparkDaemonHumanWaitRecord {
    const rows = this.db
      .prepare(
        `SELECT request_json AS requestJson, response_json AS responseJson,
                accepted_response_id AS acceptedResponseId, status, updated_at AS updatedAt
         FROM daemon_human_waits
         ORDER BY created_at`,
      )
      .all() as unknown as HumanWaitRow[];
    return requireUniqueInteractionMatch(
      rows.map((row) => parseHumanWaitRow(row).wait),
      input,
      "",
    );
  }

  hasActive(humanRequestId: string): boolean {
    return this.active.has(humanRequestId);
  }

  /** Resolve an opaque channel callback token without trusting any answer data from the client. */
  findCallback(token: string): SparkDaemonHumanWaitCallback | null {
    if (!token) return null;
    const rows = this.db
      .prepare(
        `SELECT request_json AS requestJson, response_json AS responseJson,
                accepted_response_id AS acceptedResponseId, status, updated_at AS updatedAt
         FROM daemon_human_waits
         ORDER BY created_at DESC`,
      )
      .all() as unknown as HumanWaitRow[];
    for (const row of rows) {
      const parsed = parseHumanWaitRow(row);
      const callbacks = recordValue(parsed.wait.context.channelCallbacks);
      const selection = callbacks ? recordValue(callbacks[token]) : undefined;
      const questionId = stringValue(selection?.questionId);
      const value = stringValue(selection?.value);
      const label = stringValue(selection?.label);
      if (questionId && value && label) {
        return { wait: parsed.wait, questionId, value, label };
      }
    }
    return null;
  }

  listPendingOutbox(limit = 100): SparkDaemonHumanWaitOutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id AS messageId, kind, payload_json AS payloadJson
         FROM outbox
         WHERE kind IN ('human.request.created', 'human.response.recorded')
           AND status != 'acked'
         ORDER BY created_at
         LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as Array<{
      messageId: string;
      kind: "human.request.created" | "human.response.recorded";
      payloadJson: string;
    }>;
    return rows.map((row) => ({
      messageId: row.messageId,
      kind: row.kind,
      envelope: JSON.parse(row.payloadJson) as JsonObject,
    }));
  }

  /**
   * Return only outbox entries owned by one runtime uplink. Route filtering is
   * part of the SQL query so a busy Cockpit cannot consume the shared LIMIT and
   * starve another Cockpit's pending entries.
   */
  listPendingOutboxForRoute(
    route: SparkDaemonHumanWaitOutboxRoute,
    limit = 100,
  ): SparkDaemonHumanWaitOutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT o.id AS messageId, o.kind, o.payload_json AS payloadJson
         FROM outbox o
         WHERE o.kind IN ('human.request.created', 'human.response.recorded')
           AND o.status != 'acked'
           AND CAST(json_extract(o.payload_json, '$.runtimeId') AS TEXT) = ?
           AND (
             (
               COALESCE(CAST(json_extract(o.payload_json, '$.workspaceBindingId') AS TEXT), '') = ''
             )
             OR (
               ? IS NOT NULL
               AND EXISTS (
                 SELECT 1
                 FROM workspaces w
                 WHERE w.id = CAST(json_extract(o.payload_json, '$.workspaceBindingId') AS TEXT)
                   AND w.server_url = ?
               )
             )
           )
         ORDER BY o.created_at, o.id
         LIMIT ?`,
      )
      .all(
        route.runtimeId,
        route.serverUrl,
        route.serverUrl,
        Math.max(1, Math.floor(limit)),
      ) as Array<{
      messageId: string;
      kind: "human.request.created" | "human.response.recorded";
      payloadJson: string;
    }>;
    return rows.map((row) => ({
      messageId: row.messageId,
      kind: row.kind,
      envelope: JSON.parse(row.payloadJson) as JsonObject,
    }));
  }

  acknowledgeOutbox(messageId: string): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare(
          `UPDATE outbox SET status = 'acked', updated_at = ?
           WHERE id = ?
             AND kind IN ('human.request.created', 'human.response.recorded')
             AND status != 'acked'`,
        )
        .run(now, messageId).changes === 1
    );
  }

  acknowledgeOutboxForRoute(messageId: string, route: SparkDaemonHumanWaitOutboxRoute): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare(
          `UPDATE outbox AS o
           SET status = 'acked', updated_at = ?
           WHERE o.id = ?
             AND o.kind IN ('human.request.created', 'human.response.recorded')
             AND o.status != 'acked'
             AND CAST(json_extract(o.payload_json, '$.runtimeId') AS TEXT) = ?
             AND (
               (
                 COALESCE(CAST(json_extract(o.payload_json, '$.workspaceBindingId') AS TEXT), '') = ''
               )
               OR (
                 ? IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                   FROM workspaces w
                   WHERE w.id = CAST(json_extract(o.payload_json, '$.workspaceBindingId') AS TEXT)
                     AND w.server_url = ?
                 )
               )
             )`,
        )
        .run(now, messageId, route.runtimeId, route.serverUrl, route.serverUrl).changes === 1
    );
  }

  private readRow(humanRequestId: string): {
    wait: SparkDaemonHumanWaitRecord;
    response?: SparkDaemonHumanWaitResponse;
    acceptedResponseId?: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT request_json AS requestJson, response_json AS responseJson,
                accepted_response_id AS acceptedResponseId, status, updated_at AS updatedAt
         FROM daemon_human_waits
         WHERE human_request_id = ?`,
      )
      .get(humanRequestId) as HumanWaitRow | undefined;
    return row ? parseHumanWaitRow(row) : null;
  }
}

function requireUniqueInteractionMatch(
  waits: SparkDaemonHumanWaitRecord[],
  input: SparkDaemonHumanWaitInteractionLookup,
  statusLabel: string,
): SparkDaemonHumanWaitRecord {
  const interactionRequestId = input.interactionRequestId.trim();
  const sessionId = input.sessionId?.trim();
  const invocationId = input.invocationId?.trim();
  const matches = waits.filter(
    (wait) =>
      wait.interactionRequestId === interactionRequestId &&
      (!sessionId || wait.sessionId === sessionId) &&
      (!invocationId || wait.invocationId === invocationId),
  );
  if (matches.length === 0) {
    throw new SparkDaemonHumanWaitLookupError(
      "human_interaction_not_found",
      `No ${statusLabel}daemon-owned human interaction matched ${interactionRequestId || "(empty)"}.`,
    );
  }
  if (matches.length > 1) {
    throw new SparkDaemonHumanWaitLookupError(
      "human_interaction_ambiguous",
      `Multiple ${statusLabel}daemon-owned human interactions matched ${interactionRequestId}; include sessionId or invocationId.`,
    );
  }
  return matches[0]!;
}

function parseHumanWaitRow(row: HumanWaitRow): {
  wait: SparkDaemonHumanWaitRecord;
  response?: SparkDaemonHumanWaitResponse;
  acceptedResponseId?: string;
} {
  const stored = JSON.parse(row.requestJson) as SparkDaemonHumanWaitRecord;
  const wait: SparkDaemonHumanWaitRecord = {
    ...stored,
    delivery: stored.delivery ?? "blocking",
    interactionRequestId: stored.interactionRequestId ?? "",
    sessionId: stored.sessionId ?? "",
    status: row.status,
    updatedAt: row.updatedAt,
  };
  return {
    wait,
    ...(row.responseJson
      ? { response: JSON.parse(row.responseJson) as SparkDaemonHumanWaitResponse }
      : {}),
    ...(row.acceptedResponseId ? { acceptedResponseId: row.acceptedResponseId } : {}),
  };
}

function unknownRequest(message: string): SparkDaemonHumanWaitDeliveryResult {
  return {
    outcome: "unknown_request",
    retryable: false,
    returnedToTool: false,
    message,
  };
}

function nullable(value: string): string | null {
  return value ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
