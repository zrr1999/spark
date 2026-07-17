import {
  parseSparkDaemonEvent,
  sanitizeSparkDisplayError,
  type SparkDaemonEvent,
  type SparkMessageView,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";

export interface SessionSerializedEvent {
  id: string;
  sequence: number | null;
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
  /** Durable invocation id used by the daemon cancellation contract for the active turn. */
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
      sequence:
        typeof event.sequence === "number" && Number.isSafeInteger(event.sequence)
          ? event.sequence
          : null,
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
    view.gitBranch ?? "",
    view.model ? `${view.model.providerName}/${view.model.modelId}` : "",
    view.thinkingLevel ?? "",
    view.usage?.inputTokens ?? "",
    view.usage?.outputTokens ?? "",
    view.usage?.cacheReadTokens ?? "",
    view.usage?.cacheWriteTokens ?? "",
    view.usage?.costUsd ?? "",
    view.usage?.contextTokens ?? "",
    view.usage?.contextWindow ?? "",
    JSON.stringify(view.pendingTurns ?? null),
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
  const activeTurnId = queuedTurnId(view);
  const invocationIds = new Set(input.invocationIds);
  for (const pending of view?.pendingTurns ?? []) {
    invocationIds.add(pending.invocationId);
  }
  if (activeTurnId) invocationIds.add(activeTurnId);
  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId ?? null,
    view,
    activeTurnId,
    cursor: input.cursor ?? null,
    processedEventIds: new Set(),
    commandIds: new Set(input.commandIds),
    invocationIds,
  };
}

/**
 * Register the durable turn receipt returned by `turn.submit` before the first
 * runtime event arrives. Direct Cockpit turns do not have a legacy command id,
 * so their invocation updates can only be scoped safely by this receipt.
 *
 * This only records invocation ownership. Admission is not execution, so a
 * queued receipt must not create a Stop target or a running indicator.
 * Structural session fields stay owned by daemon snapshots / `daemon.view_event`.
 */
export function registerQueuedSessionTurn(
  state: SessionLiveEventState,
  turnId: string,
  _createdAt = new Date().toISOString(),
): boolean {
  const normalized = turnId.trim();
  if (!normalized) return false;
  state.invocationIds.add(normalized);
  return true;
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
    } else if (!state.invocationIds.has(invocationId)) {
      return { changed: false, refreshActivity: false };
    }
    const previousActiveTurnId = state.activeTurnId;
    applyInvocationCancellationTarget(
      state,
      invocationId,
      stringField(event.payload, "status")?.toLocaleLowerCase(),
    );
    // Projection events never rewrite structural view fields; they only refresh
    // activity and may update the local cancellation target.
    return {
      changed: state.activeTurnId !== previousActiveTurnId,
      refreshActivity: true,
    };
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

function applyInvocationCancellationTarget(
  state: SessionLiveEventState,
  invocationId: string,
  status: string | null | undefined,
): void {
  if (!status) return;
  if (status === "queued") return;
  if (status === "running" || status === "streaming") {
    state.activeTurnId = invocationId;
    return;
  }
  if (!isTerminalInvocationStatus(status)) return;
  const remaining = state.view?.pendingTurns?.filter((turn) => turn.invocationId !== invocationId);
  if (remaining && remaining.length !== (state.view?.pendingTurns?.length ?? 0)) {
    state.activeTurnId = nextPendingTurnId(remaining);
    return;
  }
  if (state.activeTurnId === invocationId) {
    state.activeTurnId = null;
  }
}

function isTerminalInvocationStatus(status: string): boolean {
  return [
    "succeeded",
    "completed",
    "done",
    "failed",
    "lost",
    "timeout",
    "timed_out",
    "cancelled",
    "canceled",
  ].includes(status);
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
  event: Pick<SessionSerializedEvent, "createdAt" | "id" | "sequence">,
): string {
  return event.sequence === null
    ? `${event.createdAt}|${event.id}`
    : `${event.sequence}|${event.createdAt}|${event.id}`;
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
      const turnId = daemonEvent.invocationId ?? null;
      const previousActiveTurnId = state.activeTurnId;
      const viewChanged = turnId
        ? applyDaemonInvocationPhaseToView(
            state,
            turnId,
            daemonEvent.status,
            daemonEvent.emittedAt ?? event.createdAt,
          )
        : false;
      if (daemonEvent.status === "running") {
        state.activeTurnId = turnId ?? state.activeTurnId;
      } else if (turnId) {
        applyInvocationCancellationTarget(state, turnId, daemonEvent.status);
      } else if (state.activeTurnId) {
        state.activeTurnId = null;
      }
      return {
        changed: viewChanged || state.activeTurnId !== previousActiveTurnId,
        refreshActivity: true,
      };
    }
    // Lifecycle / session meta events never rewrite pendingTurns or status;
    // those come from `session.snapshot` / incremental view events.
    return { changed: false, refreshActivity: true };
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
    for (const pending of state.view.pendingTurns ?? []) {
      state.invocationIds.add(pending.invocationId);
    }
    state.activeTurnId = queuedTurnId(state.view);
    return { changed: true, refreshActivity: false };
  }

  const current = state.view ?? emptySessionView(state.sessionId, event.createdAt);
  if (viewEvent.type === "session.message") {
    if (viewEvent.sessionId !== state.sessionId) {
      return { changed: false, refreshActivity: false };
    }
    const message = sanitizeLiveMessage(viewEvent.message);
    state.view = {
      ...current,
      status: message.status === "streaming" ? "running" : current.status,
      messages: upsertById(current.messages, message),
      updatedAt: message.updatedAt ?? message.createdAt ?? event.createdAt,
    };
    return { changed: true, refreshActivity: false };
  }
  if (viewEvent.type === "run.update") {
    if (viewEvent.sessionId && viewEvent.sessionId !== state.sessionId) {
      return { changed: false, refreshActivity: false };
    }
    state.view = {
      ...current,
      // A run card may describe a nested workflow, role or task. It is useful
      // inspector data, but it does not own the conversation execution state.
      // Only daemon lifecycle / pending-turn truth may drive the header spinner
      // and Stop target.
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

function applyDaemonInvocationPhaseToView(
  state: SessionLiveEventState,
  invocationId: string,
  status: string,
  emittedAt: string,
): boolean {
  const current = state.view;
  if (!current) return false;

  const normalized = status.toLocaleLowerCase();
  let pendingTurns = current.pendingTurns;
  if (pendingTurns !== undefined) {
    pendingTurns = isTerminalInvocationStatus(normalized)
      ? pendingTurns.filter((turn) => turn.invocationId !== invocationId)
      : pendingTurns.map((turn) =>
          turn.invocationId === invocationId &&
          (normalized === "queued" || normalized === "running")
            ? {
                ...turn,
                status: normalized,
                ...(normalized === "running" && !turn.startedAt ? { startedAt: emittedAt } : {}),
              }
            : turn,
        );
  }

  const hasRunning = pendingTurns?.some((turn) => turn.status === "running") ?? false;
  const hasQueued = pendingTurns?.some((turn) => turn.status === "queued") ?? false;
  const nextStatus =
    normalized === "running"
      ? "running"
      : normalized === "queued"
        ? hasRunning
          ? "running"
          : "queued"
        : isTerminalInvocationStatus(normalized)
          ? hasRunning
            ? "running"
            : hasQueued
              ? "queued"
              : "idle"
          : current.status;

  state.view = {
    ...current,
    status: nextStatus,
    ...(pendingTurns !== undefined ? { pendingTurns } : {}),
    updatedAt: emittedAt,
  };
  return true;
}

function cloneSessionView(view: SparkSessionView): SparkSessionView {
  return {
    ...view,
    ...(view.pendingTurns ? { pendingTurns: view.pendingTurns.map((turn) => ({ ...turn })) } : {}),
    messages: view.messages.map(sanitizeLiveMessage),
    tools: [...view.tools],
    runs: [...view.runs],
    tasks: [...view.tasks],
    artifacts: [...view.artifacts],
    ...(view.mailbox ? { mailbox: [...view.mailbox] } : {}),
    metadata: { ...view.metadata },
  };
}

function sanitizeLiveMessage(message: SparkMessageView): SparkMessageView {
  if (message.status !== "error") return message;
  const metadataError = stringField(message.metadata, "errorMessage");
  const text = sanitizeSparkDisplayError(metadataError ?? message.text, {
    fallback: "Spark reported an error without additional details.",
  });
  return {
    ...message,
    text,
    ...(message.parts
      ? {
          parts: message.parts.map((part) =>
            part.type === "text"
              ? {
                  ...part,
                  text: sanitizeSparkDisplayError(part.text, { fallback: text }),
                }
              : (part.type === "tool-call" || part.type === "tool-result") &&
                  part.status === "failed" &&
                  part.summary
                ? {
                    ...part,
                    summary: sanitizeSparkDisplayError(part.summary, {
                      fallback: `${part.toolName} failed.`,
                    }),
                  }
                : part,
          ),
        }
      : {}),
    metadata: {
      ...message.metadata,
      ...(metadataError ? { errorMessage: text } : {}),
    },
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
  const pending = view.pendingTurns;
  if (pending !== undefined) {
    return pending.find((turn) => turn.status === "running")?.invocationId ?? null;
  }
  for (let index = view.messages.length - 1; index >= 0; index -= 1) {
    const message = view.messages[index];
    if (!message) continue;
    if (stringField(message.metadata, "source") !== "daemon.invocation") continue;
    const status = stringField(message.metadata, "invocationStatus")?.toLocaleLowerCase();
    if (status !== "running" && status !== "streaming") continue;
    const invocationId = stringField(message.metadata, "invocationId");
    if (invocationId) return invocationId;
  }
  return null;
}

function nextPendingTurnId(pendingTurns: SparkSessionView["pendingTurns"]): string | null {
  if (!pendingTurns?.length) return null;
  return pendingTurns.find((turn) => turn.status === "running")?.invocationId ?? null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function daemonEventFromPayload(value: unknown): SparkDaemonEvent | null {
  try {
    return parseSparkDaemonEvent(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
