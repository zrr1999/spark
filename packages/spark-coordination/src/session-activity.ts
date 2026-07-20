import type { DatabaseSync } from "node:sqlite";
import {
  sanitizeSparkDisplayError,
  sparkMessageViewSchema,
  type SparkMessageView,
} from "@zendev-lab/spark-protocol";

export interface SessionActivityCommand {
  id: string;
  title: string | null;
  goal: string | null;
  status: string;
  deliveryStatus: string | null;
  attemptCount: number | null;
  lastAttemptAt: string | null;
  ackedAt: string | null;
  rejectedAt: string | null;
  rejectMessage: string | null;
  runtimeWorkspaceName: string | null;
  runtimeName: string | null;
  runtimeStatus: string | null;
  invocationId: string | null;
  invocationStatus: string | null;
  latestLog: string | null;
  latestLogAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionActivityReport {
  id: string;
  kind: string;
  title: string;
  text: string;
  role: string | null;
  status: string | null;
  createdAt: string;
  /** Canonical structured message when the report originated from a view event. */
  message?: SparkMessageView;
  interaction?: {
    requestId: string | null;
    kind: string | null;
  };
}

export interface SessionActivityQueuedTurn {
  commandId: string;
  invocationId: string;
  prompt: string;
  status: "queued" | "running";
  createdAt: string;
  startedAt: string | null;
}

export interface SessionActivityProjection {
  commands: SessionActivityCommand[];
  /** Canonical queued and running direct turns, ordered by submission time. */
  queuedTurns: SessionActivityQueuedTurn[];
  reports: SessionActivityReport[];
}

interface CommandRow {
  id: string;
  title: string | null;
  payloadJson: string;
  status: string;
  deliveryStatus: string | null;
  attemptCount: number | null;
  lastAttemptAt: string | null;
  ackedAt: string | null;
  rejectedAt: string | null;
  rejectMessage: string | null;
  runtimeWorkspaceName: string | null;
  runtimeName: string | null;
  runtimeStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InvocationRow {
  commandId: string;
  runtimeInvocationId: string;
  status: string;
  updatedAt: string;
}

interface LogRow {
  commandId: string;
  content: string;
  createdAt: string;
}

interface EventRow {
  id: string;
  kind: string;
  payloadJson: string;
  createdAt: string;
}

interface ArtifactReportRow {
  id: string;
  kind: string;
  title: string | null;
  contentRefJson: string;
  invocationStatus: string;
  createdAt: string;
}

interface DirectTurnCommandRow {
  id: string;
  payloadJson: string;
  status: string;
  rejectCode: string | null;
  rejectMessage: string | null;
  resultJson: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DirectTurnInvocationRow {
  commandId: string;
  runtimeInvocationId: string;
  status: string;
  terminalReason: string | null;
  payloadJson: string;
  completedAt: string | null;
  updatedAt: string;
}

interface QueuedTurnRow {
  commandId: string;
  payloadJson: string;
  runtimeInvocationId: string;
  status: "queued" | "running";
  createdAt: string;
  startedAt: string | null;
}

export function loadSessionActivity(
  db: DatabaseSync,
  input: {
    workspaceId: string;
    sessionId: string;
    limit?: number;
  },
): SessionActivityProjection {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const commandRows = db
    .prepare(
      `SELECT c.id,
              c.title,
              c.payload_json AS payloadJson,
              c.status,
              c.created_at AS createdAt,
              c.updated_at AS updatedAt,
              cd.status AS deliveryStatus,
              cd.attempt_count AS attemptCount,
              cd.last_attempt_at AS lastAttemptAt,
              cd.acked_at AS ackedAt,
              cd.rejected_at AS rejectedAt,
              cd.reject_message AS rejectMessage,
              rb.display_name AS runtimeWorkspaceName,
              rc.name AS runtimeName,
              rc.status AS runtimeStatus
       FROM commands c
       LEFT JOIN command_deliveries cd ON cd.command_id = c.id
       LEFT JOIN runtime_workspace_bindings rb ON rb.id = cd.runtime_workspace_binding_id
       LEFT JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE c.workspace_id = ?
         AND c.kind = 'assignment.create.request'
         AND json_extract(c.payload_json, '$.payload.target.sessionId') = ?
       ORDER BY c.created_at DESC
       LIMIT ?`,
    )
    .all(input.workspaceId, input.sessionId, limit) as unknown as CommandRow[];

  const matchedCommands = commandRows
    .map((row) => ({ row, assignment: assignmentFromCommandPayload(row.payloadJson) }))
    .filter(({ assignment }) => assignment.sessionId === input.sessionId);
  const commandIds = matchedCommands.map(({ row }) => row.id);
  const invocations = latestInvocationsByCommand(db, commandIds);
  const latestLogs = latestLogsByCommand(db, commandIds);

  const commands = matchedCommands.map(({ row, assignment }): SessionActivityCommand => {
    const invocation = invocations.get(row.id) ?? null;
    const latestLog = latestLogs.get(row.id) ?? null;
    return {
      id: row.id,
      title: row.title,
      goal: assignment.goal,
      status: row.status,
      deliveryStatus: row.deliveryStatus,
      attemptCount: row.attemptCount,
      lastAttemptAt: row.lastAttemptAt,
      ackedAt: row.ackedAt,
      rejectedAt: row.rejectedAt,
      rejectMessage: row.rejectMessage,
      runtimeWorkspaceName: row.runtimeWorkspaceName,
      runtimeName: row.runtimeName,
      runtimeStatus: row.runtimeStatus,
      invocationId: invocation?.runtimeInvocationId ?? null,
      invocationStatus: invocation?.status ?? null,
      latestLog: latestLog?.content ?? null,
      latestLogAt: latestLog?.createdAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });

  const sessionReports = loadSessionReports(db, { ...input, limit });
  const sessionReportIds = new Set(sessionReports.map((report) => report.id));
  const directTurnReports = loadDirectTurnReports(db, { ...input, limit }).filter(
    (report) => !sessionReportIds.has(report.id),
  );

  return {
    commands,
    queuedTurns: loadQueuedTurns(db, { ...input, limit }),
    reports: [
      ...sessionReports,
      ...directTurnReports,
      ...loadArtifactReportsByCommand(db, commandIds, limit),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  };
}

function loadQueuedTurns(
  db: DatabaseSync,
  input: { workspaceId: string; sessionId: string; limit: number },
): SessionActivityQueuedTurn[] {
  const rows = db
    .prepare(
      `WITH latest_invocations AS (
         SELECT runtime_id AS runtimeId,
                command_id AS commandId,
                runtime_invocation_id AS runtimeInvocationId,
                status,
                started_at AS startedAt,
                ROW_NUMBER() OVER (
                  PARTITION BY runtime_id, command_id
                  ORDER BY updated_at DESC, runtime_invocation_id DESC
                ) AS rowNumber
         FROM runtime_invocation_projections
         WHERE workspace_id = ?
           AND session_id = ?
           AND command_id IS NOT NULL
       )
       SELECT c.id AS commandId,
              c.payload_json AS payloadJson,
              invocation.runtimeInvocationId,
              invocation.status,
              c.created_at AS createdAt,
              invocation.startedAt
       FROM runtime_control_commands c
       JOIN latest_invocations invocation
         ON invocation.runtimeId = c.runtime_id
        AND invocation.commandId = c.id
        AND invocation.rowNumber = 1
       WHERE c.workspace_id = ?
         AND c.session_id = ?
         AND c.kind = 'turn.submit.request'
         AND invocation.status IN ('queued', 'running')
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT ?`,
    )
    .all(
      input.workspaceId,
      input.sessionId,
      input.workspaceId,
      input.sessionId,
      input.limit,
    ) as unknown as QueuedTurnRow[];

  return rows.flatMap((row): SessionActivityQueuedTurn[] => {
    const prompt = directTurnPrompt(row.payloadJson);
    if (!prompt) return [];
    return [
      {
        commandId: row.commandId,
        invocationId: row.runtimeInvocationId,
        prompt,
        status: row.status,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
      },
    ];
  });
}

function latestInvocationsByCommand(db: DatabaseSync, commandIds: string[]) {
  const map = new Map<string, InvocationRow>();
  if (commandIds.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT command_id AS commandId,
              runtime_invocation_id AS runtimeInvocationId,
              status,
              updated_at AS updatedAt
       FROM mirrored_invocations
       WHERE command_id IN (${placeholders(commandIds)})
       ORDER BY updated_at DESC`,
    )
    .all(...commandIds) as unknown as InvocationRow[];
  for (const row of rows) {
    if (!map.has(row.commandId)) map.set(row.commandId, row);
  }
  return map;
}

function latestLogsByCommand(db: DatabaseSync, commandIds: string[]) {
  const map = new Map<string, LogRow>();
  if (commandIds.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT mi.command_id AS commandId,
              l.content,
              l.created_at AS createdAt
       FROM invocation_log_chunks l
       JOIN mirrored_invocations mi ON mi.id = l.invocation_id
       WHERE mi.command_id IN (${placeholders(commandIds)})
       ORDER BY l.created_at DESC, l.sequence DESC`,
    )
    .all(...commandIds) as unknown as LogRow[];
  for (const row of rows) {
    if (!map.has(row.commandId)) map.set(row.commandId, row);
  }
  return map;
}

function loadDirectTurnReports(
  db: DatabaseSync,
  input: { workspaceId: string; sessionId: string; limit: number },
): SessionActivityReport[] {
  const commands = db
    .prepare(
      `SELECT id,
              payload_json AS payloadJson,
              status,
              reject_code AS rejectCode,
              reject_message AS rejectMessage,
              result_json AS resultJson,
              completed_at AS completedAt,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM runtime_control_commands
       WHERE workspace_id = ?
         AND session_id = ?
         AND kind = 'turn.submit.request'
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(input.workspaceId, input.sessionId, input.limit) as unknown as DirectTurnCommandRow[];
  if (commands.length === 0) return [];

  const commandIds = commands.map((command) => command.id);
  const invocationRows = db
    .prepare(
      `SELECT command_id AS commandId,
              runtime_invocation_id AS runtimeInvocationId,
              status,
              terminal_reason AS terminalReason,
              payload_json AS payloadJson,
              completed_at AS completedAt,
              updated_at AS updatedAt
       FROM runtime_invocation_projections
       WHERE command_id IN (${placeholders(commandIds)})
       ORDER BY updated_at DESC, runtime_invocation_id DESC`,
    )
    .all(...commandIds) as unknown as DirectTurnInvocationRow[];
  const invocations = new Map<string, DirectTurnInvocationRow>();
  for (const invocation of invocationRows) {
    if (!invocations.has(invocation.commandId)) invocations.set(invocation.commandId, invocation);
  }

  return commands.flatMap((command) => {
    const reports: SessionActivityReport[] = [];
    const prompt = directTurnPrompt(command.payloadJson);
    if (prompt) {
      reports.push({
        id: `turn-submit:${command.id}:prompt`,
        kind: "turn.submit.prompt",
        title: "User message",
        text: prompt,
        role: "user",
        status: null,
        createdAt: command.createdAt,
      });
    }

    const invocation = invocations.get(command.id) ?? null;
    const failure = directTurnFailure(command, invocation);
    if (failure) reports.push(failure);
    return reports;
  });
}

function directTurnPrompt(payloadJson: string): string | null {
  return stringValue(recordValue(parseJson(payloadJson), "payload"), "prompt");
}

function directTurnFailure(
  command: DirectTurnCommandRow,
  invocation: DirectTurnInvocationRow | null,
): SessionActivityReport | null {
  const invocationFailed =
    invocation !== null && ["failed", "timeout", "timed_out", "lost"].includes(invocation.status);
  const commandFailed = ["failed", "rejected"].includes(command.status);
  if (!invocationFailed && !commandFailed) return null;

  const status = invocationFailed ? invocation.status : command.status;
  const invocationError = recordValue(parseJson(invocation?.payloadJson ?? ""), "error");
  const commandResult = recordValue(parseJson(command.resultJson ?? ""), "result");
  const fallback = directTurnFailureFallback(status, command.rejectCode);
  const rawText =
    (invocationFailed ? invocation.terminalReason : null) ||
    stringValue(invocationError, "message") ||
    command.rejectMessage ||
    stringValue(commandResult, "message") ||
    fallback;
  const text = sanitizeSparkDisplayError(rawText, { fallback });
  const invocationId = invocationFailed ? invocation.runtimeInvocationId : null;

  return {
    id: invocationId
      ? `message:invocation:${invocationId}:failure`
      : `turn-submit:${command.id}:failure`,
    kind: invocationId ? "session.message" : "turn.submit.failure",
    title: directTurnFailureTitle(status),
    text,
    role: "system",
    status,
    createdAt:
      (invocationFailed ? invocation.completedAt || invocation.updatedAt : command.completedAt) ||
      command.updatedAt,
  };
}

function directTurnFailureTitle(status: string): string {
  if (status === "rejected") return "Turn rejected";
  if (status === "timeout" || status === "timed_out") return "Turn timed out";
  if (status === "lost") return "Turn lost";
  return "Turn failed";
}

function directTurnFailureFallback(status: string, rejectCode: string | null): string {
  const suffix = rejectCode ? ` (${rejectCode})` : "";
  if (status === "rejected") return `Spark rejected the turn before it started${suffix}.`;
  if (status === "timeout" || status === "timed_out") {
    return "The turn timed out before Spark produced a reply.";
  }
  if (status === "lost") return "Spark lost the turn before it produced a reply.";
  return `The turn failed before Spark produced a reply${suffix}.`;
}

function loadSessionReports(
  db: DatabaseSync,
  input: { workspaceId: string; sessionId: string; limit: number },
): SessionActivityReport[] {
  const rows = db
    .prepare(
      `SELECT id,
              kind,
              payload_json AS payloadJson,
              created_at AS createdAt
       FROM events
       WHERE workspace_id = ?
         AND kind IN (
           'daemon.view_event',
           'daemon.task.lifecycle',
           'daemon.interaction.request',
           'daemon.interaction.response'
         )
         AND (
           json_extract(payload_json, '$.sessionId') = ?
           OR json_extract(payload_json, '$.view.sessionId') = ?
           OR json_extract(payload_json, '$.view.session.sessionId') = ?
         )
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(
      input.workspaceId,
      input.sessionId,
      input.sessionId,
      input.sessionId,
      input.limit * 4,
    ) as unknown as EventRow[];

  const seenMessageIds = new Set<string>();
  const seenStableReports = new Set<string>();
  return rows.flatMap((row) => {
    const payload = parseJson(row.payloadJson);
    if (sessionIdFromDaemonPayload(payload) !== input.sessionId) return [];
    const messageId = daemonMessageId(payload);
    if (messageId && seenMessageIds.has(messageId)) return [];
    if (messageId) seenMessageIds.add(messageId);
    const report = reportFromDaemonPayload(row, payload);
    const stableKey = report ? stableReportKey(report) : null;
    if (stableKey && seenStableReports.has(stableKey)) return [];
    if (stableKey) seenStableReports.add(stableKey);
    return report ? [report] : [];
  });
}

function stableReportKey(report: SessionActivityReport) {
  if (
    report.kind !== "run.update" &&
    report.kind !== "task.update" &&
    report.kind !== "artifact.update"
  ) {
    return null;
  }
  return `${report.kind}:${report.id}`;
}

function loadArtifactReportsByCommand(
  db: DatabaseSync,
  commandIds: string[],
  limit: number,
): SessionActivityReport[] {
  if (commandIds.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT a.id,
              a.kind,
              a.title,
              a.content_ref_json AS contentRefJson,
              a.created_at AS createdAt,
              mi.status AS invocationStatus
       FROM artifacts a
       JOIN mirrored_invocations mi ON mi.id = a.invocation_id
       WHERE mi.command_id IN (${placeholders(commandIds)})
       ORDER BY a.created_at DESC
       LIMIT ?`,
    )
    .all(...commandIds, limit) as unknown as ArtifactReportRow[];

  return rows.flatMap((row) => {
    const contentRef = parseJson(row.contentRefJson);
    const text = stringValue(contentRef, "assistantTextPreview");
    if (!text) return [];
    return [
      {
        id: row.id,
        kind: `artifact.${row.kind}`,
        title: row.title || "Daemon report",
        text,
        role: "assistant",
        status: artifactReportStatus(text, row.invocationStatus),
        createdAt: row.createdAt,
      },
    ];
  });
}

function assignmentFromCommandPayload(payloadJson: string) {
  const parsed = parseJson(payloadJson);
  const payload = recordValue(parsed, "payload");
  const target = recordValue(payload, "target");
  return {
    goal: stringValue(payload, "goal"),
    sessionId: stringValue(target, "sessionId"),
  };
}

function reportFromDaemonPayload(
  row: EventRow,
  payload: Record<string, unknown> | null,
): SessionActivityReport | null {
  if (!payload) return null;
  if (payload.type === "daemon.view_event") {
    const view = recordValue(payload, "view");
    const viewType = stringValue(view, "type");
    if (viewType === "session.message") {
      const message = recordValue(view, "message");
      const parsedMessage = sparkMessageViewSchema.safeParse(message);
      const invocationId = stringValue(payload, "invocationId");
      const correlatedMessage = parsedMessage.success
        ? correlateUserMessage(parsedMessage.data, invocationId)
        : undefined;
      const messageId = stringValue(message, "id");
      const role = stringValue(message, "role");
      const status = stringValue(message, "status");
      const text = stringValue(message, "text") || "(empty message)";
      return {
        id: messageId ? `message:${messageId}` : row.id,
        kind: viewType,
        title: role ? `${role} message` : "Session message",
        text,
        role,
        status,
        createdAt: row.createdAt,
        ...(correlatedMessage ? { message: correlatedMessage } : {}),
      };
    }
    if (viewType === "run.update") {
      const run = recordValue(view, "run");
      const runId = stringValue(run, "id");
      const title = stringValue(run, "title") || runId || "Run update";
      const status = stringValue(run, "status");
      const summary = stringValue(run, "summary");
      return {
        id: runId || row.id,
        kind: viewType,
        title,
        text: summary || (status ? `Run ${status}.` : "Run updated."),
        role: null,
        status,
        createdAt: row.createdAt,
      };
    }
    if (viewType === "task.update") {
      const task = recordValue(view, "task");
      const taskRef = stringValue(task, "ref");
      const title =
        stringValue(task, "title") || stringValue(task, "name") || taskRef || "Task update";
      const status = stringValue(task, "status");
      const description = stringValue(task, "description");
      return {
        id: taskRef || row.id,
        kind: viewType,
        title,
        text: description || (status ? `Task ${status}.` : "Task updated."),
        role: null,
        status,
        createdAt: row.createdAt,
      };
    }
    if (viewType === "artifact.update") {
      const artifact = recordValue(view, "artifact");
      const artifactRef = stringValue(artifact, "ref");
      const title = stringValue(artifact, "title") || artifactRef || "Artifact update";
      const status = stringValue(artifact, "status");
      const preview = stringValue(artifact, "preview");
      return {
        id: artifactRef || row.id,
        kind: viewType,
        title,
        text: preview || (status ? `Artifact ${status}.` : "Artifact updated."),
        role: stringValue(artifact, "producer"),
        status,
        createdAt: row.createdAt,
      };
    }
    if (viewType === "session.snapshot") {
      const session = recordValue(view, "session");
      const title = stringValue(session, "title") || stringValue(session, "sessionId") || "Session";
      const status = stringValue(session, "status");
      return {
        id: row.id,
        kind: viewType,
        title,
        text: status ? `Session ${status}.` : "Session snapshot updated.",
        role: null,
        status,
        createdAt: row.createdAt,
      };
    }
  }
  if (payload.type === "daemon.task.lifecycle") {
    const taskType = stringValue(payload, "taskType") || "task";
    const status = stringValue(payload, "status");
    return {
      id: row.id,
      kind: "daemon.task.lifecycle",
      title: taskType,
      text:
        stringValue(payload, "summary") || (status ? `${taskType} ${status}.` : "Task updated."),
      role: null,
      status,
      createdAt: row.createdAt,
    };
  }
  if (payload.type === "daemon.interaction.request") {
    const request = recordValue(payload, "request");
    return {
      id: row.id,
      kind: "daemon.interaction.request",
      title: stringValue(request, "title") || "Interaction request",
      text: stringValue(request, "prompt") || "Spark requested operator input.",
      role: null,
      status: stringValue(request, "status"),
      createdAt: row.createdAt,
      interaction: {
        requestId: stringValue(request, "requestId"),
        kind: stringValue(request, "kind"),
      },
    };
  }
  if (payload.type === "daemon.interaction.response") {
    const response = recordValue(payload, "response");
    return {
      id: row.id,
      kind: "daemon.interaction.response",
      title: "Interaction response",
      text: stringValue(response, "summary") || "Operator response recorded.",
      role: null,
      status: stringValue(response, "status"),
      createdAt: row.createdAt,
      interaction: {
        requestId: stringValue(response, "requestId"),
        kind: stringValue(response, "kind"),
      },
    };
  }
  return null;
}

function correlateUserMessage(
  message: SparkMessageView,
  invocationId: string | null,
): SparkMessageView {
  if (message.role !== "user" || !invocationId) return message;
  return {
    ...message,
    metadata: { ...message.metadata, invocationId },
  };
}

function daemonMessageId(payload: Record<string, unknown> | null): string | null {
  if (!payload || payload.type !== "daemon.view_event") return null;
  const view = recordValue(payload, "view");
  if (stringValue(view, "type") !== "session.message") return null;
  return stringValue(recordValue(view, "message"), "id");
}

function sessionIdFromDaemonPayload(payload: Record<string, unknown> | null) {
  if (!payload) return null;
  const directSessionId = stringValue(payload, "sessionId");
  if (directSessionId) return directSessionId;
  const view = recordValue(payload, "view");
  const viewSessionId = stringValue(view, "sessionId");
  if (viewSessionId) return viewSessionId;
  const session = recordValue(view, "session");
  return stringValue(session, "sessionId");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordValue(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return isRecord(value) ? value : null;
}

function stringValue(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function artifactReportStatus(text: string, invocationStatus: string) {
  if (/^\s*blocked:/iu.test(text)) return "blocked";
  if (/^\s*failed:/iu.test(text)) return "failed";
  return invocationStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function placeholders(values: unknown[]) {
  return values.map(() => "?").join(", ");
}
