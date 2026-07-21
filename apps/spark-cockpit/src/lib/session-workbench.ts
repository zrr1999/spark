import type { SparkJsonObject, SparkSessionView } from "@zendev-lab/spark-protocol";

const MAX_OUTPUT_CHARS = 4_000;
const MAX_PREVIEW_CHARS = 8_000;

export type SessionInspectorTab = "summary" | "artifacts" | "changes" | "tasks" | "messages";

/** Product-facing artifact kinds shown in the session sidebar. */
export const SESSION_PRODUCT_ARTIFACT_KINDS = new Set(["issue", "pr", "preview"]);

export interface SessionWorkbenchActivityCommand {
  id: string;
  title: string | null;
  goal: string | null;
  status: string;
  deliveryStatus: string | null;
  runtimeName: string | null;
  runtimeStatus: string | null;
  invocationId: string | null;
  invocationStatus: string | null;
  latestLog: string | null;
  latestLogAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionWorkbenchActivityReport {
  id: string;
  kind: string;
  title: string;
  text: string;
  role: string | null;
  status: string | null;
  createdAt: string;
  runKind?: string;
  interaction?: {
    requestId: string | null;
    kind: string | null;
  };
}

export interface SessionWorkbenchActivity {
  commands?: readonly SessionWorkbenchActivityCommand[];
  reports?: readonly SessionWorkbenchActivityReport[];
}

export interface SessionWorkbenchRun {
  id: string;
  canonicalId: string | null;
  source: "session" | "command" | "report";
  kind: string;
  title: string;
  status: string;
  summary: string | null;
  progress: number | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  commandId: string | null;
  invocationId: string | null;
  runtimeName: string | null;
  runtimeStatus: string | null;
  latestOutput: string | null;
  artifactRefs: string[];
}

export interface SessionWorkbenchTask {
  id: string;
  ref: string | null;
  projectRef: string | null;
  source: "session" | "activity";
  title: string;
  description: string | null;
  status: string;
  owner: string | null;
  todoDone: number;
  todoTotal: number;
  todos: SessionWorkbenchTodo[];
  runRefs: string[];
  artifactRefs: string[];
}

export interface SessionWorkbenchTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "blocked" | "done" | "cancelled";
  notes: string[];
}

export interface SessionWorkbenchSessionTodo {
  anchor: string;
  summary: string;
  items: SessionWorkbenchTodo[];
  updatedAt: string | null;
}

export interface SessionWorkbenchArtifact {
  id: string;
  ref: string;
  source: "session" | "activity";
  title: string;
  kind: string;
  format: string;
  status: string | null;
  producer: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  preview: string | null;
  canonicalChange: boolean;
}

export interface SessionWorkbenchContext {
  sessionId: string;
  title: string | null;
  status: string;
  cwd: string | null;
  model: {
    providerName: string;
    providerLabel: string;
    modelId: string;
    modelLabel: string;
    displayLabel: string;
  } | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Cross-session agent-to-agent messages (not human ask / inbox). */
export interface SessionWorkbenchMessage {
  id: string;
  fromSessionId: string;
  kind: "request" | "question" | "notification";
  intent: string;
  subject: string | null;
  body: string;
  createdAt: string;
  status: "unread" | "read" | "acknowledged";
  channelDelivery: {
    status: "pending" | "delivered" | "failed" | "uncertain";
    total: number;
    pending: number;
    delivered: number;
    failed: number;
    uncertain: number;
  } | null;
}

/** @deprecated Use SessionWorkbenchMessage. */
export type SessionWorkbenchMailMessage = SessionWorkbenchMessage;

export interface SessionWorkbenchView {
  runs: SessionWorkbenchRun[];
  tasks: SessionWorkbenchTask[];
  /** Product artifacts (issue / pr / preview) bound to this session. */
  artifacts: SessionWorkbenchArtifact[];
  changes: SessionWorkbenchArtifact[];
  /** Agent-internal evidence; not rendered in the session sidebar. */
  evidence: SessionWorkbenchArtifact[];
  /** Cross-session agent messages (renamed from mailbox). */
  messages: SessionWorkbenchMessage[];
  sessionTodo: SessionWorkbenchSessionTodo | null;
  context: SessionWorkbenchContext;
}

export interface SessionInspectorLabels {
  ariaLabel: string;
  tabs: Record<SessionInspectorTab, string>;
  summaryHeading: string;
  artifactsHeading: string;
  tasksHeading: string;
  changesHeading: string;
  messagesHeading: string;
  noTasksTitle: string;
  noTasksBody: string;
  noArtifactsTitle: string;
  noArtifactsBody: string;
  noChangesTitle: string;
  noChangesBody: string;
  noMessagesTitle: string;
  noMessagesBody: string;
  noSessionTodoTitle: string;
  noSessionTodoBody: string;
  noActiveSessionTodo: string;
  unassignedProject: string;
  progress: string;
  todoList: string;
  sessionTodoHeading: string;
  openSessionTodo: string;
  sessionTodoPending: string;
  sessionTodoInProgress: string;
  messageFrom: string;
  messageRequest: string;
  messageQuestion: string;
  messageNotification: string;
  messageUnread: string;
  messageRead: string;
  messageAcknowledged: string;
  messageDeliveryPending: string;
  messageDeliveryDelivered: string;
  messageDeliveryFailed: string;
  messageDeliveryUncertain: string;
  sessionId: string;
  sessionStatus: string;
  workingDirectory: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  unavailable: string;
}

/**
 * Build a Cockpit-local, read-only coding-session inspector projection.
 *
 * The daemon snapshot stays authoritative for session/run/task/artifact state.
 * Cockpit activity only supplies delivery diagnostics and server-projected
 * evidence; it is never used to fabricate Git state or an interactive terminal.
 */
export function buildSessionWorkbenchView(input: {
  session: SparkSessionView;
  activity?: SessionWorkbenchActivity | null;
}): SessionWorkbenchView {
  const commands = input.activity?.commands ?? [];
  const reports = input.activity?.reports ?? [];

  const runs = input.session.runs.map(sessionRun);
  mergeActivityCommands(runs, commands);
  appendRunReports(runs, reports);

  // Canonical tasks stay authoritative. task.update is the reload-safe fallback
  // while lifecycle events remain append-only diagnostics, not task state.
  const sessionTasks = input.session.tasks.map(sessionTask);
  const canonicalTaskIds = new Set(sessionTasks.map((task) => task.id));
  const tasks = deduplicateTasks([
    ...sessionTasks,
    ...reports
      .filter((report) => report.kind === "task.update" && !canonicalTaskIds.has(report.id))
      .map(activityTask),
  ]);

  const artifacts = deduplicateArtifacts([
    ...input.session.artifacts.map(sessionArtifact),
    ...reports.filter(isArtifactReport).map(activityArtifact),
  ]);
  const evidence = deduplicateArtifacts([
    ...(input.session.evidence ?? []).map(sessionEvidence),
    ...artifacts.filter(
      (artifact) => !SESSION_PRODUCT_ARTIFACT_KINDS.has(artifact.kind) && !artifact.canonicalChange,
    ),
    ...reports.filter(isEvidenceReport).map(activityEvidence),
  ]);

  const productArtifacts = artifacts.filter((artifact) =>
    SESSION_PRODUCT_ARTIFACT_KINDS.has(artifact.kind),
  );
  const changeArtifacts = artifacts.filter((artifact) => artifact.canonicalChange);

  return {
    runs: sortByRecency(runs),
    tasks,
    artifacts: productArtifacts,
    changes: changeArtifacts,
    evidence,
    messages: [...(input.session.mailbox ?? [])]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((message) => ({
        id: message.id,
        fromSessionId: message.fromSessionId,
        kind: message.kind,
        intent: message.intent,
        subject: message.subject ?? null,
        body: message.body,
        createdAt: message.createdAt,
        status: message.ackedAt ? "acknowledged" : message.readAt ? "read" : "unread",
        channelDelivery: message.channelDelivery ?? null,
      })),
    sessionTodo: latestSessionTodo(input.session),
    context: sessionContext(input.session),
  };
}

function latestSessionTodo(session: SparkSessionView): SessionWorkbenchSessionTodo | null {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    const result = message.parts?.findLast(
      (part) =>
        part.type === "tool-result" && part.toolName === "todo" && part.status === "complete",
    );
    if (!result || result.type !== "tool-result") continue;

    const content = nonEmpty(result.summary) ?? nonEmpty(message.text);
    if (!content) continue;
    const lines = content.split(/\r?\n/).map((line) => line.trim());
    const summary = lines.find((line) => line && !line.startsWith("- [")) ?? content;
    return {
      anchor: `message:${message.id}`,
      summary,
      items: lines.flatMap((line, itemIndex) => parseSessionTodoLine(line, itemIndex)),
      updatedAt: message.updatedAt ?? message.createdAt ?? null,
    };
  }
  return null;
}

function parseSessionTodoLine(line: string, index: number): SessionWorkbenchTodo[] {
  const match = line.match(/^[-*]\s+\[(pending|in_progress|blocked|done|cancelled)]\s+(.+)$/);
  if (!match) return [];
  const status = match[1] as SessionWorkbenchTodo["status"];
  const rawContent = match[2].trim();
  const [candidateId, ...remainder] = rawContent.split(/\s+/);
  const hasProjectedId = /^todo-[a-z0-9_-]+$/i.test(candidateId) && remainder.length > 0;
  return [
    {
      id: hasProjectedId ? candidateId : `session-todo-${index + 1}`,
      content: hasProjectedId ? remainder.join(" ") : rawContent,
      status,
      notes: [],
    },
  ];
}

function sessionRun(run: SparkSessionView["runs"][number]): SessionWorkbenchRun {
  return {
    id: `run:${run.id}`,
    canonicalId: run.id,
    source: "session",
    kind: run.kind,
    title: run.title ?? run.id,
    status: run.status,
    summary: nonEmpty(run.summary),
    progress: run.progress ?? null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    updatedAt: run.completedAt ?? run.startedAt ?? null,
    commandId: null,
    invocationId: run.id,
    runtimeName: null,
    runtimeStatus: null,
    latestOutput: null,
    artifactRefs: [...run.artifactRefs],
  };
}

function mergeActivityCommands(
  runs: SessionWorkbenchRun[],
  commands: readonly SessionWorkbenchActivityCommand[],
) {
  const byInvocationId = new Map(
    runs.flatMap((run) => (run.invocationId ? [[run.invocationId, run] as const] : [])),
  );

  for (const command of commands) {
    const existing = command.invocationId ? byInvocationId.get(command.invocationId) : undefined;
    if (existing) {
      existing.commandId = command.id;
      existing.runtimeName = command.runtimeName;
      existing.runtimeStatus = command.runtimeStatus;
      existing.latestOutput = boundedText(command.latestLog, MAX_OUTPUT_CHARS);
      existing.updatedAt = command.latestLogAt ?? command.updatedAt;
      if (command.invocationStatus) existing.status = command.invocationStatus;
      continue;
    }

    runs.push({
      id: `command:${command.id}`,
      canonicalId: command.invocationId,
      source: "command",
      kind: "daemon",
      title: command.goal ?? command.title ?? command.id,
      status: command.invocationStatus ?? command.deliveryStatus ?? command.status,
      summary: null,
      progress: null,
      startedAt: command.createdAt,
      completedAt: null,
      updatedAt: command.latestLogAt ?? command.updatedAt,
      commandId: command.id,
      invocationId: command.invocationId,
      runtimeName: command.runtimeName,
      runtimeStatus: command.runtimeStatus,
      latestOutput: boundedText(command.latestLog, MAX_OUTPUT_CHARS),
      artifactRefs: [],
    });
  }
}

function appendRunReports(
  runs: SessionWorkbenchRun[],
  reports: readonly SessionWorkbenchActivityReport[],
) {
  const latestByRunId = new Map<string, SessionWorkbenchActivityReport>();
  for (const report of reports) {
    if (report.kind !== "run.update") continue;
    const previous = latestByRunId.get(report.id);
    if (!previous || report.createdAt > previous.createdAt) latestByRunId.set(report.id, report);
  }

  const canonicalRuns = new Map(
    runs.flatMap((run) => (run.canonicalId ? [[run.canonicalId, run] as const] : [])),
  );
  for (const report of latestByRunId.values()) {
    const canonical = canonicalRuns.get(report.id);
    if (canonical) {
      canonical.title = report.title || canonical.title;
      canonical.status = report.status ?? canonical.status;
      canonical.summary = boundedText(report.text, MAX_OUTPUT_CHARS) ?? canonical.summary;
      if (!canonical.updatedAt || report.createdAt > canonical.updatedAt) {
        canonical.updatedAt = report.createdAt;
      }
      continue;
    }

    runs.push({
      id: `report:${report.id}`,
      canonicalId: report.id,
      source: "report",
      kind: report.runKind ?? "other",
      title: report.title || report.id,
      status: report.status ?? "unknown",
      summary: boundedText(report.text, MAX_OUTPUT_CHARS),
      progress: null,
      startedAt: null,
      completedAt: null,
      updatedAt: report.createdAt,
      commandId: null,
      invocationId: null,
      runtimeName: null,
      runtimeStatus: null,
      latestOutput: null,
      artifactRefs: [],
    });
  }
}

function sessionTask(task: SparkSessionView["tasks"][number]): SessionWorkbenchTask {
  const todoDone = task.todos.filter((todo) => todo.status === "done").length;
  return {
    id: task.ref,
    ref: task.ref,
    projectRef: task.projectRef ?? null,
    source: "session",
    title: task.title,
    description: nonEmpty(task.description),
    status: task.status,
    owner: nonEmpty(task.owner),
    todoDone,
    todoTotal: task.todos.length,
    todos: task.todos.map((todo) => ({ ...todo, notes: [...todo.notes] })),
    runRefs: [...task.runRefs],
    artifactRefs: [...task.artifactRefs],
  };
}

function activityTask(report: SessionWorkbenchActivityReport): SessionWorkbenchTask {
  return {
    id: report.id,
    ref: report.id,
    projectRef: null,
    source: "activity",
    title: report.title || report.id,
    description: nonEmpty(report.text),
    status: report.status ?? "unknown",
    owner: null,
    todoDone: 0,
    todoTotal: 0,
    todos: [],
    runRefs: [],
    artifactRefs: [],
  };
}

function sessionArtifact(
  artifact: SparkSessionView["artifacts"][number],
): SessionWorkbenchArtifact {
  return {
    id: artifactId(artifact.ref),
    ref: artifact.ref,
    source: "session",
    title: artifact.title,
    kind: artifact.kind,
    format: artifact.format,
    status: nonEmpty(artifact.status),
    producer: nonEmpty(artifact.producer),
    createdAt: artifact.createdAt ?? null,
    updatedAt: artifact.updatedAt ?? null,
    preview: boundedText(artifact.preview, MAX_PREVIEW_CHARS),
    canonicalChange: hasCanonicalDiffMarker(artifact.metadata),
  };
}

function sessionEvidence(
  evidence: NonNullable<SparkSessionView["evidence"]>[number],
): SessionWorkbenchArtifact {
  return {
    id: artifactId(evidence.ref),
    ref: evidence.ref,
    source: "session",
    title: evidence.title,
    kind: evidence.kind,
    format: evidence.format,
    status: nonEmpty(evidence.status),
    producer: nonEmpty(evidence.producer),
    createdAt: evidence.createdAt ?? null,
    updatedAt: evidence.updatedAt ?? null,
    preview: boundedText(evidence.preview, MAX_PREVIEW_CHARS),
    canonicalChange: false,
  };
}

function activityArtifact(report: SessionWorkbenchActivityReport): SessionWorkbenchArtifact {
  const kind =
    report.kind === "artifact.update" ? "artifact" : report.kind.slice("artifact.".length);
  const canonicalChange = kind === "diff" || kind === "patch";
  return {
    id: artifactId(report.id),
    ref: report.id.startsWith("artifact:") ? report.id : `artifact:${report.id}`,
    source: "activity",
    title: report.title || report.id,
    kind,
    format: canonicalChange ? "diff" : "text",
    status: report.status,
    producer: report.role,
    createdAt: report.createdAt,
    updatedAt: report.createdAt,
    preview: boundedText(report.text, MAX_PREVIEW_CHARS),
    canonicalChange,
  };
}

function activityEvidence(report: SessionWorkbenchActivityReport): SessionWorkbenchArtifact {
  const kind =
    report.kind === "evidence.update" ? "evidence" : report.kind.slice("evidence.".length);
  return {
    id: artifactId(report.id),
    ref:
      report.id.startsWith("evidence:") || report.id.startsWith("artifact:")
        ? report.id
        : `evidence:${report.id}`,
    source: "activity",
    title: report.title || report.id,
    kind,
    format: "text",
    status: report.status,
    producer: report.role,
    createdAt: report.createdAt,
    updatedAt: report.createdAt,
    preview: boundedText(report.text, MAX_PREVIEW_CHARS),
    canonicalChange: false,
  };
}

function sessionContext(session: SparkSessionView): SessionWorkbenchContext {
  const model = session.model
    ? {
        providerName: session.model.providerName,
        providerLabel: session.model.providerLabel ?? session.model.providerName,
        modelId: session.model.modelId,
        modelLabel: session.model.modelLabel ?? session.model.modelId,
        displayLabel: `${session.model.modelLabel ?? session.model.modelId} · ${session.model.providerLabel ?? session.model.providerName}`,
      }
    : null;
  return {
    sessionId: session.sessionId,
    title: nonEmpty(session.title),
    status: session.status,
    cwd: nonEmpty(session.cwd),
    model,
    createdAt: session.createdAt ?? null,
    updatedAt: session.updatedAt ?? null,
  };
}

function hasCanonicalDiffMarker(metadata: SparkJsonObject) {
  const presentation = stringMetadata(metadata, "presentation");
  const artifactKind = stringMetadata(metadata, "artifactKind");
  const contentType =
    stringMetadata(metadata, "contentType") ?? stringMetadata(metadata, "mediaType");
  return (
    presentation === "diff" ||
    presentation === "patch" ||
    artifactKind === "diff" ||
    artifactKind === "patch" ||
    contentType === "text/x-diff" ||
    contentType === "text/x-patch"
  );
}

function isArtifactReport(report: SessionWorkbenchActivityReport) {
  return (
    report.kind === "artifact.update" ||
    (report.kind.startsWith("artifact.") && report.kind.length > "artifact.".length)
  );
}

function isEvidenceReport(report: SessionWorkbenchActivityReport) {
  return (
    report.kind === "evidence.update" ||
    (report.kind.startsWith("evidence.") && report.kind.length > "evidence.".length)
  );
}

function deduplicateArtifacts(artifacts: SessionWorkbenchArtifact[]) {
  const byId = new Map<string, SessionWorkbenchArtifact>();
  for (const artifact of artifacts) {
    const existing = byId.get(artifact.id);
    if (!existing || (existing.source === "activity" && artifact.source === "session")) {
      byId.set(artifact.id, artifact);
    }
  }
  return [...byId.values()].sort((left, right) =>
    (right.updatedAt ?? right.createdAt ?? "").localeCompare(
      left.updatedAt ?? left.createdAt ?? "",
    ),
  );
}

function deduplicateTasks(tasks: SessionWorkbenchTask[]) {
  const byId = new Map<string, SessionWorkbenchTask>();
  for (const task of tasks) {
    const existing = byId.get(task.id);
    if (!existing || (existing.source === "activity" && task.source === "session")) {
      byId.set(task.id, task);
    }
  }
  return [...byId.values()];
}

function sortByRecency(runs: SessionWorkbenchRun[]) {
  return [...runs].sort((left, right) =>
    (right.updatedAt ?? right.startedAt ?? "").localeCompare(
      left.updatedAt ?? left.startedAt ?? "",
    ),
  );
}

function artifactId(ref: string) {
  const separator = ref.indexOf(":");
  return separator >= 0 ? ref.slice(separator + 1) || ref : ref;
}

function stringMetadata(metadata: SparkJsonObject, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function boundedText(value: string | null | undefined, maxChars: number) {
  const text = nonEmpty(value);
  if (!text) return null;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function nonEmpty(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
