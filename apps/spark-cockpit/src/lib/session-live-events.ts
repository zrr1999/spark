import type { SparkDaemonEvent, SparkSessionView } from "@zendev-lab/spark-protocol";

export interface SessionSerializedEvent {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  kind: string;
  subjectId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface SessionLiveEventState {
  sessionId: string;
  workspaceId: string | null;
  view: SparkSessionView | null;
  /** Queue file name used by the daemon cancellation contract for the active turn. */
  activeTurnId: string | null;
  cursor: string | null;
  processedEventIds: Set<string>;
  commandIds: Set<string>;
  invocationIds: Set<string>;
}

export interface SessionLiveEventResult {
  changed: boolean;
  refreshActivity: boolean;
}

export interface SessionActivityRefreshState {
  pending: boolean;
  refreshing: boolean;
}

const MAX_REPLAY_EVENT_IDS = 512;

export function sessionEventCursorStorageKey(sessionId: string): string | null {
  const normalized = sessionId.trim();
  return normalized ? `spark-cockpit:session:${normalized}:events-cursor` : null;
}

export function createSessionActivityRefreshState(): SessionActivityRefreshState {
  return { pending: false, refreshing: false };
}

export function requestSessionActivityRefresh(state: SessionActivityRefreshState): void {
  state.pending = true;
}

export function canStartSessionActivityRefresh(
  state: SessionActivityRefreshState,
  canRefresh: boolean,
): boolean {
  return canRefresh && state.pending && !state.refreshing;
}

export function beginSessionActivityRefresh(
  state: SessionActivityRefreshState,
  canRefresh: boolean,
): boolean {
  if (!canStartSessionActivityRefresh(state, canRefresh)) return false;
  state.pending = false;
  state.refreshing = true;
  return true;
}

export function finishSessionActivityRefresh(state: SessionActivityRefreshState): void {
  state.refreshing = false;
}

export function parseSessionSerializedEvent(value: string): SessionSerializedEvent | null {
  try {
    const event = JSON.parse(value) as unknown;
    if (
      !isRecord(event) ||
      typeof event.id !== "string" ||
      typeof event.kind !== "string" ||
      typeof event.createdAt !== "string"
    ) {
      return null;
    }
    return {
      id: event.id,
      workspaceId: nullableString(event.workspaceId),
      projectId: nullableString(event.projectId),
      kind: event.kind,
      subjectId: nullableString(event.subjectId),
      payload: event.payload,
      createdAt: event.createdAt,
    };
  } catch {
    return null;
  }
}

export function sessionViewRevisionKey(view: SparkSessionView | null): string {
  if (!view) return "none";
  const latest = view.messages.at(-1);
  return [
    view.updatedAt ?? "",
    view.status,
    view.messages.length,
    latest?.id ?? "",
    latest?.status ?? "",
    latest?.text ?? "",
    view.runs.length,
    view.tasks.length,
    view.artifacts.length,
    view.mailbox?.length ?? 0,
    view.mailbox?.at(-1)?.id ?? "",
    view.mailbox?.at(-1)?.readAt ?? "",
    view.mailbox?.at(-1)?.ackedAt ?? "",
  ].join(":");
}

export function createSessionLiveEventState(input: {
  sessionId: string;
  workspaceId?: string | null;
  view?: SparkSessionView | null;
  commandIds?: Iterable<string>;
  invocationIds?: Iterable<string>;
  cursor?: string | null;
}): SessionLiveEventState {
  const view = input.view ? cloneSessionView(input.view) : null;
  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId ?? null,
    view,
    activeTurnId: queuedTurnId(view),
    cursor: input.cursor ?? null,
    processedEventIds: new Set(),
    commandIds: new Set(input.commandIds),
    invocationIds: new Set(input.invocationIds),
  };
}

/**
 * Apply only events that belong to the selected conversation. Native view events
 * update the transcript immediately; projection-only activity asks for one
 * debounced server refresh. Unrelated workspaces and sessions are ignored.
 */
export function applySessionLiveEvent(
  state: SessionLiveEventState,
  event: SessionSerializedEvent,
): SessionLiveEventResult {
  if (state.processedEventIds.has(event.id)) {
    return { changed: false, refreshActivity: false };
  }
  rememberEventId(state.processedEventIds, event.id);
  state.cursor = sessionEventCursor(event);

  const daemonResult = applyDaemonEvent(state, event);
  if (daemonResult) return daemonResult;

  if (state.workspaceId && event.workspaceId !== state.workspaceId) {
    return { changed: false, refreshActivity: false };
  }

  if (event.kind === "command.queued") {
    const command = recordField(event.payload, "command");
    const commandId = stringField(command, "id") ?? event.subjectId;
    if (!commandId || assignmentSessionId(command) !== state.sessionId) {
      return { changed: false, refreshActivity: false };
    }
    state.commandIds.add(commandId);
    return { changed: false, refreshActivity: true };
  }

  if (event.kind.startsWith("command.")) {
    if (!event.subjectId || !state.commandIds.has(event.subjectId)) {
      return { changed: false, refreshActivity: false };
    }
    return { changed: false, refreshActivity: true };
  }

  if (event.kind === "invocation.updated") {
    const commandId = stringField(event.payload, "commandId");
    const invocationId = stringField(event.payload, "runtimeInvocationId") ?? event.subjectId;
    if (!invocationId) return { changed: false, refreshActivity: false };
    if (commandId && state.commandIds.has(commandId)) {
      state.invocationIds.add(invocationId);
      return { changed: false, refreshActivity: true };
    }
    if (!state.invocationIds.has(invocationId)) {
      return { changed: false, refreshActivity: false };
    }
    return { changed: false, refreshActivity: true };
  }

  if (event.kind === "invocation.log_chunk" || event.kind === "artifact.projected") {
    const invocationId =
      stringField(event.payload, "runtimeInvocationId") ??
      stringField(event.payload, "invocationId") ??
      event.subjectId;
    return {
      changed: false,
      refreshActivity: Boolean(invocationId && state.invocationIds.has(invocationId)),
    };
  }

  return { changed: false, refreshActivity: false };
}

function rememberEventId(eventIds: Set<string>, eventId: string) {
  eventIds.add(eventId);
  while (eventIds.size > MAX_REPLAY_EVENT_IDS) {
    const oldest = eventIds.values().next().value;
    if (typeof oldest !== "string") return;
    eventIds.delete(oldest);
  }
}

export function sessionEventCursor(
  event: Pick<SessionSerializedEvent, "createdAt" | "id">,
): string {
  return `${event.createdAt}|${event.id}`;
}

function applyDaemonEvent(
  state: SessionLiveEventState,
  event: SessionSerializedEvent,
): SessionLiveEventResult | null {
  if (!event.kind.startsWith("daemon.")) return null;

  const daemonEvent = daemonEventFromPayload(event.payload);
  if (!daemonEvent) {
    return { changed: false, refreshActivity: false };
  }

  if (daemonEvent.sessionId !== state.sessionId) {
    return { changed: false, refreshActivity: false };
  }

  if (daemonEvent.type === "daemon.session.updated") {
    if (state.view && daemonEvent.title) {
      state.view = {
        ...state.view,
        title: daemonEvent.title,
        updatedAt: daemonEvent.emittedAt ?? event.createdAt,
      };
    }
    return { changed: Boolean(daemonEvent.title), refreshActivity: true };
  }

  if (daemonEvent.type !== "daemon.view_event") {
    if (daemonEvent.type === "daemon.task.lifecycle") {
      const turnId = daemonEvent.taskFileName ?? daemonEvent.invocationId ?? null;
      if (daemonEvent.status === "queued" || daemonEvent.status === "running") {
        state.activeTurnId = turnId ?? state.activeTurnId;
      } else if (!turnId || turnId === state.activeTurnId) {
        state.activeTurnId = null;
      }
      if (state.view) {
        state.view = {
          ...state.view,
          status:
            daemonEvent.status === "queued" || daemonEvent.status === "running"
              ? "running"
              : "idle",
          updatedAt: daemonEvent.emittedAt ?? event.createdAt,
        };
      }
    }
    return { changed: daemonEvent.type === "daemon.task.lifecycle", refreshActivity: true };
  }

  const viewEvent = daemonEvent.view;
  if (viewEvent.type === "session.snapshot") {
    if (viewEvent.session.sessionId !== state.sessionId) {
      return { changed: false, refreshActivity: false };
    }
    const mailbox = viewEvent.session.mailbox ?? state.view?.mailbox;
    state.view = cloneSessionView({
      ...viewEvent.session,
      ...(mailbox ? { mailbox } : {}),
    });
    state.activeTurnId = queuedTurnId(state.view);
    return { changed: true, refreshActivity: false };
  }

  const current = state.view ?? emptySessionView(state.sessionId, event.createdAt);
  if (viewEvent.type === "session.message") {
    if (viewEvent.sessionId !== state.sessionId) {
      return { changed: false, refreshActivity: false };
    }
    state.view = {
      ...current,
      status: viewEvent.message.status === "streaming" ? "running" : current.status,
      messages: upsertById(current.messages, viewEvent.message),
      updatedAt: viewEvent.message.updatedAt ?? viewEvent.message.createdAt ?? event.createdAt,
    };
    return { changed: true, refreshActivity: false };
  }
  if (viewEvent.type === "run.update") {
    if (viewEvent.sessionId && viewEvent.sessionId !== state.sessionId) {
      return { changed: false, refreshActivity: false };
    }
    state.view = {
      ...current,
      status:
        viewEvent.run.status === "queued" || viewEvent.run.status === "running"
          ? "running"
          : "idle",
      runs: upsertById(current.runs, viewEvent.run),
      updatedAt:
        viewEvent.run.completedAt ??
        viewEvent.run.startedAt ??
        daemonEvent.emittedAt ??
        event.createdAt,
    };
    return { changed: true, refreshActivity: false };
  }
  if (viewEvent.type === "task.update") {
    state.view = {
      ...current,
      tasks: upsertByKey(current.tasks, viewEvent.task, (task) => task.ref),
      updatedAt: daemonEvent.emittedAt ?? event.createdAt,
    };
    return { changed: true, refreshActivity: false };
  }
  state.view = {
    ...current,
    artifacts: upsertByKey(current.artifacts, viewEvent.artifact, (artifact) => artifact.ref),
    updatedAt: viewEvent.artifact.updatedAt ?? viewEvent.artifact.createdAt ?? event.createdAt,
  };
  return { changed: true, refreshActivity: false };
}

function cloneSessionView(view: SparkSessionView): SparkSessionView {
  return {
    ...view,
    messages: [...view.messages],
    tools: [...view.tools],
    runs: [...view.runs],
    tasks: [...view.tasks],
    artifacts: [...view.artifacts],
    ...(view.mailbox ? { mailbox: [...view.mailbox] } : {}),
    metadata: { ...view.metadata },
  };
}

function emptySessionView(sessionId: string, createdAt: string): SparkSessionView {
  return {
    version: 1,
    sessionId,
    status: "idle",
    messages: [],
    tools: [],
    runs: [],
    tasks: [],
    artifacts: [],
    createdAt,
    updatedAt: createdAt,
    metadata: {},
  };
}

function upsertById<T extends { id: string }>(items: readonly T[], next: T): T[] {
  return upsertByKey(items, next, (item) => item.id);
}

function upsertByKey<T>(items: readonly T[], next: T, key: (item: T) => string): T[] {
  const nextKey = key(next);
  const index = items.findIndex((item) => key(item) === nextKey);
  if (index < 0) return [...items, next];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function assignmentSessionId(command: Record<string, unknown> | null): string | null {
  const payload = recordField(command, "payload");
  const assignment = recordField(payload, "payload") ?? payload;
  return stringField(recordField(assignment, "target"), "sessionId");
}

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return isRecord(candidate) ? candidate : null;
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function queuedTurnId(view: SparkSessionView | null): string | null {
  if (!view) return null;
  for (const message of view.messages) {
    if (stringField(message.metadata, "source") !== "daemon.queue") continue;
    const taskFileName = stringField(message.metadata, "taskFileName");
    if (taskFileName) return taskFileName;
  }
  return null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function daemonEventFromPayload(value: unknown): SparkDaemonEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (
    value.type !== "daemon.task.lifecycle" &&
    value.type !== "daemon.view_event" &&
    value.type !== "daemon.interaction.request" &&
    value.type !== "daemon.interaction.response" &&
    value.type !== "daemon.session.updated"
  ) {
    return null;
  }
  if (value.type === "daemon.view_event" && !isRecord(value.view)) return null;
  return value as unknown as SparkDaemonEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
