import type { DatabaseSync } from "node:sqlite";
import { createId, type HumanRequestCreatedPayload } from "@zendev-lab/spark-protocol";

type JsonObject = Record<string, unknown>;
type HumanQuestion = HumanRequestCreatedPayload["questions"][number];
type HumanRequestKind = HumanRequestCreatedPayload["kind"];

export interface SparkDaemonHumanWaitInput {
  humanRequestId?: string;
  invocationId?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
  toolCallId?: string;
  kind: HumanRequestKind;
  title: string;
  prompt: string;
  questions?: HumanQuestion[];
  context?: JsonObject;
  contextArtifactRefs?: string[];
}

export interface SparkDaemonHumanWaitRecord extends Required<SparkDaemonHumanWaitInput> {
  humanRequestId: string;
  status: "pending" | "answered" | "cancelled" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface SparkDaemonHumanWaitResponse {
  humanRequestId: string;
  status: "answered" | "cancelled" | "archived";
  answers: JsonObject;
  responseArtifactRefs: string[];
  deliveredAt: string;
}

export interface SparkDaemonHumanWaitRegistration {
  wait: SparkDaemonHumanWaitRecord;
  response: Promise<SparkDaemonHumanWaitResponse>;
}

export interface SparkDaemonHumanWaitDeliveryResult {
  returnedToTool: boolean;
  message: string;
  wait?: SparkDaemonHumanWaitRecord;
  response?: SparkDaemonHumanWaitResponse;
}

interface ActiveHumanWait {
  wait: SparkDaemonHumanWaitRecord;
  resolve(response: SparkDaemonHumanWaitResponse): void;
}

export class SparkDaemonHumanWaitRegistry {
  private readonly active = new Map<string, ActiveHumanWait>();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  register(input: SparkDaemonHumanWaitInput): SparkDaemonHumanWaitRegistration {
    const now = new Date().toISOString();
    const wait: SparkDaemonHumanWaitRecord = {
      humanRequestId: input.humanRequestId ?? createId("hreq"),
      invocationId: input.invocationId ?? "",
      workspaceBindingId: input.workspaceBindingId ?? "",
      workspaceId: input.workspaceId ?? "",
      projectId: input.projectId ?? "",
      toolCallId: input.toolCallId ?? "",
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
    this.db
      .prepare(
        `INSERT OR REPLACE INTO daemon_human_waits
          (human_request_id, invocation_id, workspace_binding_id, workspace_id, project_id,
           tool_call_id, kind, status, request_json, response_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
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
    let resolve!: (response: SparkDaemonHumanWaitResponse) => void;
    const response = new Promise<SparkDaemonHumanWaitResponse>((done) => {
      resolve = done;
    });
    this.active.set(wait.humanRequestId, { wait, resolve });
    return { wait, response };
  }

  deliver(input: {
    humanRequestId?: string | undefined;
    status: "answered" | "cancelled" | "archived";
    answers?: JsonObject;
    responseArtifactRefs?: string[];
  }): SparkDaemonHumanWaitDeliveryResult {
    if (!input.humanRequestId) {
      return {
        returnedToTool: false,
        message: "Human response did not include a humanRequestId for a daemon-owned wait.",
      };
    }
    const existing = this.get(input.humanRequestId);
    if (!existing) {
      return {
        returnedToTool: false,
        message: "No daemon-owned human wait matched this response.",
      };
    }
    const response: SparkDaemonHumanWaitResponse = {
      humanRequestId: input.humanRequestId,
      status: input.status,
      answers: input.answers ?? {},
      responseArtifactRefs: input.responseArtifactRefs ?? [],
      deliveredAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE daemon_human_waits
           SET status = ?, response_json = ?, updated_at = ?
         WHERE human_request_id = ?`,
      )
      .run(
        response.status,
        JSON.stringify(response),
        response.deliveredAt,
        response.humanRequestId,
      );
    const active = this.active.get(input.humanRequestId);
    if (!active) {
      return {
        returnedToTool: false,
        message: "Recorded human response, but the active daemon wait is no longer attached.",
        wait: existing,
        response,
      };
    }
    this.active.delete(input.humanRequestId);
    active.resolve(response);
    return {
      returnedToTool: true,
      message: "Returned human response to the daemon-owned wait.",
      wait: existing,
      response,
    };
  }

  get(humanRequestId: string): SparkDaemonHumanWaitRecord | null {
    const row = this.db
      .prepare(
        "SELECT request_json AS requestJson FROM daemon_human_waits WHERE human_request_id = ?",
      )
      .get(humanRequestId) as { requestJson: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.requestJson) as SparkDaemonHumanWaitRecord;
  }

  listPending(): SparkDaemonHumanWaitRecord[] {
    const rows = this.db
      .prepare(
        "SELECT request_json AS requestJson FROM daemon_human_waits WHERE status = 'pending' ORDER BY created_at",
      )
      .all() as Array<{ requestJson: string }>;
    return rows.map((row) => JSON.parse(row.requestJson) as SparkDaemonHumanWaitRecord);
  }

  hasActive(humanRequestId: string): boolean {
    return this.active.has(humanRequestId);
  }
}

function nullable(value: string): string | null {
  return value ? value : null;
}
