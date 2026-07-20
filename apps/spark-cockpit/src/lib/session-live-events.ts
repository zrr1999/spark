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
  /** Monotonic phase fence for invocations that are currently pending or have settled. */
  invocationPhases: Map<string, string>;
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
  const invocationPhases = new Map<string, string>();
  for (const pending of view?.pendingTurns ?? []) {
    invocationIds.add(pending.invocationId);
    invocationPhases.set(pending.invocationId, pending.status);
  }
  if (activeTurnId) {
    invocationIds.add(activeTurnId);
    invocationPhases.set(activeTurnId, "running");
  }
  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId ?? null,
    view,
    activeTurnId,
    cursor: input.cursor ?? null,
    processedEventIds: new Set(),
    commandIds: new Set(input.commandIds),
    invocationIds,
    invocationPhases,
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
  acceptInvocationPhase(state, normalized, "queued");
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
    const status = stringField(event.payload, "status")?.toLocaleLowerCase();
    if (!status || !acceptInvocationPhase(state, invocationId, status)) {
      return { changed: false, refreshActivity: true };
    }
    const previousActiveTurnId = state.activeTurnId;
    const viewChanged = applyDaemonInvocationPhaseToView(
      state,
      invocationId,
      status,
      event.createdAt,
    );
    applyInvocationCancellationTarget(state, invocationId, status);
    // Invocation lifecycle converges the selected view immediately; the server
    // refresh remains necessary for sidebar/activity projections.
    return {
      changed: viewChanged || state.activeTurnId !== previousActiveTurnId,
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
      const status = daemonEvent.status.toLocaleLowerCase();
      if (
        !turnId ||
        !isKnownPendingInvocation(state, turnId) ||
        !acceptInvocationPhase(state, turnId, status)
      ) {
        return { changed: false, refreshActivity: true };
      }
      const previousActiveTurnId = state.activeTurnId;
      const viewChanged = applyDaemonInvocationPhaseToView(
        state,
        turnId,
        status,
        daemonEvent.emittedAt ?? event.createdAt,
      );
      applyInvocationCancellationTarget(state, turnId, status);
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
    state.view = normalizeSnapshotAgainstInvocationPhases(
      cloneSessionView({
        ...viewEvent.session,
        ...(mailbox ? { mailbox } : {}),
      }),
      state.invocationPhases,
    );
    const pendingInvocationIds = new Set(
      (state.view.pendingTurns ?? []).map((turn) => turn.invocationId),
    );
    for (const [invocationId, phase] of state.invocationPhases) {
      if (!isTerminalInvocationStatus(phase) && !pendingInvocationIds.has(invocationId)) {
        state.invocationPhases.delete(invocationId);
      }
    }
    for (const pending of state.view.pendingTurns ?? []) {
      state.invocationIds.add(pending.invocationId);
      acceptInvocationPhase(state, pending.invocationId, pending.status);
    }
    state.activeTurnId = queuedTurnId(state.view);
    return { changed: true, refreshActivity: false };
  }

  const current = state.view ?? emptySessionView(state.sessionId, event.createdAt);
  if (viewEvent.type === "session.message") {
    if (viewEvent.sessionId !== state.sessionId) {
      return { changed: false, refreshActivity: false };
    }
    const message = correlateLiveUserMessage(
      sanitizeLiveMessage(viewEvent.message),
      daemonEvent.invocationId ?? null,
    );
    state.view = {
      ...current,
      messages: upsertSessionMessage(current.messages, message, state.sessionId),
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
  let pendingTurnsChanged = false;
  if (pendingTurns !== undefined) {
    if (isTerminalInvocationStatus(normalized)) {
      const remaining = pendingTurns.filter((turn) => turn.invocationId !== invocationId);
      pendingTurnsChanged = remaining.length !== pendingTurns.length;
      pendingTurns = remaining;
    } else {
      pendingTurns = pendingTurns.map((turn) => {
        if (
          turn.invocationId !== invocationId ||
          (normalized !== "queued" && normalized !== "running") ||
          (turn.status === normalized && (normalized !== "running" || Boolean(turn.startedAt)))
        ) {
          return turn;
        }
        pendingTurnsChanged = true;
        return {
          ...turn,
          status: normalized,
          ...(normalized === "running" && !turn.startedAt ? { startedAt: emittedAt } : {}),
        };
      });
    }
  }

  const hasRunning = pendingTurns?.some((turn) => turn.status === "running") ?? false;
  const hasQueued = pendingTurns?.some((turn) => turn.status === "queued") ?? false;
  const nextStatus =
    pendingTurns !== undefined
      ? hasRunning
        ? "running"
        : hasQueued
          ? "queued"
          : isActiveSessionStatus(current.status)
            ? "idle"
            : current.status
      : normalized === "running"
        ? "running"
        : normalized === "queued"
          ? "queued"
          : isTerminalInvocationStatus(normalized)
            ? "idle"
            : current.status;

  if (!pendingTurnsChanged && nextStatus === current.status) return false;

  state.view = {
    ...current,
    status: nextStatus,
    ...(pendingTurns !== undefined ? { pendingTurns } : {}),
    updatedAt: emittedAt,
  };
  return true;
}

function acceptInvocationPhase(
  state: SessionLiveEventState,
  invocationId: string,
  status: string,
): boolean {
  const normalized = status.toLocaleLowerCase();
  const previous = state.invocationPhases.get(invocationId);
  if (previous && isTerminalInvocationStatus(previous)) return false;
  if (previous === "running" && normalized === "queued") return false;
  if (previous === normalized) return false;
  state.invocationPhases.set(invocationId, normalized);
  return true;
}

function isKnownPendingInvocation(state: SessionLiveEventState, invocationId: string): boolean {
  const phase = state.invocationPhases.get(invocationId);
  return phase === "queued" || phase === "running";
}

function normalizeSnapshotAgainstInvocationPhases(
  view: SparkSessionView,
  invocationPhases: ReadonlyMap<string, string>,
): SparkSessionView {
  if (view.pendingTurns === undefined) return view;
  const pendingTurns = view.pendingTurns.flatMap((turn) => {
    const knownPhase = invocationPhases.get(turn.invocationId);
    if (isTerminalInvocationStatus(knownPhase ?? "")) return [];
    if (knownPhase === "running" && turn.status === "queued") {
      return [{ ...turn, status: "running" as const }];
    }
    return [turn];
  });
  const hasRunning = pendingTurns.some((turn) => turn.status === "running");
  const hasQueued = pendingTurns.some((turn) => turn.status === "queued");
  return {
    ...view,
    pendingTurns,
    status: hasRunning
      ? "running"
      : hasQueued
        ? "queued"
        : isActiveSessionStatus(view.status)
          ? "idle"
          : view.status,
  };
}

function isActiveSessionStatus(status: string): boolean {
  const normalized = status.toLocaleLowerCase();
  return normalized === "running" || normalized === "streaming" || normalized === "queued";
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

function upsertSessionMessage(
  items: readonly SparkMessageView[],
  next: SparkMessageView,
  sessionId: string,
): SparkMessageView[] {
  const exactIndex = items.findIndex((item) => item.id === next.id);
  if (exactIndex >= 0) {
    return items.map((item, index) => (index === exactIndex ? next : item));
  }

  const invocationId = userMessageInvocationId(next);
  if (!invocationId) return [...items, next];
  const correlatedIndex = items.findIndex((item) => userMessageInvocationId(item) === invocationId);
  if (correlatedIndex < 0) return [...items, next];

  const current = items[correlatedIndex]!;
  const livePrefix = `${sessionId}:message:user:`;
  const currentIsTemporary = current.id.startsWith(livePrefix);
  const nextIsTemporary = next.id.startsWith(livePrefix);
  const preferred = currentIsTemporary && !nextIsTemporary ? next : current;
  return items.map((item, index) => (index === correlatedIndex ? preferred : item));
}

function correlateLiveUserMessage(
  message: SparkMessageView,
  invocationId: string | null,
): SparkMessageView {
  if (message.role !== "user" || !invocationId) return message;
  return {
    ...message,
    metadata: { ...message.metadata, invocationId },
  };
}

function userMessageInvocationId(message: SparkMessageView): string | null {
  if (message.role !== "user") return null;
  return stringField(message.metadata, "invocationId");
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
