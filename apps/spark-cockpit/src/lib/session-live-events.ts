import {
  parseSparkDaemonEvent,
  sanitizeSparkDisplayError,
  type SparkDaemonEvent,
  type SparkMessageView,
  type SparkSessionSnapshotHistory,
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

export function shouldAdoptSessionHistory(
  current: SparkSessionSnapshotHistory | null,
  incoming: SparkSessionSnapshotHistory | null,
): incoming is SparkSessionSnapshotHistory {
  if (!incoming) return false;
  if (!current) return true;
  if (incoming.loadedMessages !== current.loadedMessages) {
    return incoming.loadedMessages > current.loadedMessages;
  }
  if (incoming.totalMessages < current.totalMessages) return false;
  if (!current.hasEarlierMessages && incoming.hasEarlierMessages) return false;
  if (!current.nextBeforeMessageId && incoming.nextBeforeMessageId) return false;
  return true;
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
 * Adopt a refreshed server projection without replacing the live reducer.
 * Keeping the reducer identity preserves its SSE cursor and replay fences, while
 * the monotonic merge prevents a slightly older page snapshot from erasing text
 * that has already arrived through the event stream.
 */
export function reconcileSessionLiveEventState(
  state: SessionLiveEventState,
  input: {
    workspaceId?: string | null;
    view?: SparkSessionView | null;
    commandIds?: Iterable<string>;
    invocationIds?: Iterable<string>;
    preserveCurrentHistory?: boolean;
  },
): boolean {
  state.workspaceId = input.workspaceId ?? state.workspaceId;
  for (const commandId of input.commandIds ?? []) state.commandIds.add(commandId);
  for (const invocationId of input.invocationIds ?? []) state.invocationIds.add(invocationId);
  if (!input.view || input.view.sessionId !== state.sessionId) return false;

  const previous = state.view;
  state.view = reconcileSessionView(
    previous,
    normalizeSnapshotAgainstInvocationPhases(cloneSessionView(input.view), state.invocationPhases),
    state.sessionId,
    {
      preserveCurrentHistory: input.preserveCurrentHistory ?? false,
      source: "refresh",
    },
  );
  syncInvocationStateFromView(state, false);
  return state.view !== previous;
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
 * Apply a confirmed `turn.cancel` receipt before the matching lifecycle event
 * or refreshed projection arrives. Without this, a stale page snapshot can keep
 * the cancelled invocation in `pendingTurns` and the queue UI looks stuck.
 */
export function settleCancelledSessionTurn(
  state: SessionLiveEventState,
  turnId: string,
  status: string = "cancelled",
  emittedAt = new Date().toISOString(),
): boolean {
  const normalizedTurnId = turnId.trim();
  const normalizedStatus = status.trim().toLocaleLowerCase() || "cancelled";
  if (!normalizedTurnId || !isTerminalInvocationStatus(normalizedStatus)) return false;
  state.invocationIds.add(normalizedTurnId);
  const previousActiveTurnId = state.activeTurnId;
  acceptInvocationPhase(state, normalizedTurnId, normalizedStatus);
  const viewChanged = applyDaemonInvocationPhaseToView(
    state,
    normalizedTurnId,
    normalizedStatus,
    emittedAt,
  );
  applyInvocationCancellationTarget(state, normalizedTurnId, normalizedStatus);
  return viewChanged || state.activeTurnId !== previousActiveTurnId;
}

/**
 * When the daemon registry says the conversation is no longer running, drop any
 * locally remembered running turns. Status probes use this so a missed terminal
 * SSE/projection cannot leave the header spinner and Stop button stuck.
 *
 * Queued follow-ups are preserved: registry "ready" is compatible with a queue.
 */
export function convergeSessionLiveEventStateFromRegistryStatus(
  state: SessionLiveEventState,
  registryStatus: string,
  emittedAt = new Date().toISOString(),
): boolean {
  const normalized = registryStatus.trim().toLocaleLowerCase();
  if (!normalized || normalized === "running") return false;

  const runningIds = new Set<string>();
  for (const turn of state.view?.pendingTurns ?? []) {
    if (turn.status === "running") runningIds.add(turn.invocationId);
  }
  for (const [invocationId, phase] of state.invocationPhases) {
    if (phase === "running") runningIds.add(invocationId);
  }
  if (state.activeTurnId) runningIds.add(state.activeTurnId);

  let changed = false;
  for (const invocationId of runningIds) {
    if (settleCancelledSessionTurn(state, invocationId, "succeeded", emittedAt)) {
      changed = true;
    }
  }

  if (
    state.view &&
    isActiveSessionStatus(state.view.status) &&
    !(state.view.pendingTurns?.some((turn) => turn.status === "running") ?? false) &&
    !(state.view.pendingTurns?.some((turn) => turn.status === "queued") ?? false)
  ) {
    state.view = { ...state.view, status: "idle", updatedAt: emittedAt };
    changed = true;
  }

  return changed;
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
    const previous = state.view;
    state.view = reconcileSessionView(
      previous,
      normalizeSnapshotAgainstInvocationPhases(
        cloneSessionView({
          ...viewEvent.session,
          ...(mailbox ? { mailbox } : {}),
        }),
        state.invocationPhases,
      ),
      state.sessionId,
      { preserveCurrentHistory: true, source: "event" },
    );
    syncInvocationStateFromView(state, true);
    return { changed: state.view !== previous, refreshActivity: false };
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
    const messages = upsertSessionMessage(current.messages, message, state.sessionId, "ordered");
    if (messages === current.messages) {
      return { changed: false, refreshActivity: false };
    }
    state.view = {
      ...current,
      messages,
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
  if (viewEvent.type === "artifact.update") {
    state.view = {
      ...current,
      artifacts: upsertByKey(current.artifacts, viewEvent.artifact, (artifact) => artifact.ref),
      updatedAt: viewEvent.artifact.updatedAt ?? viewEvent.artifact.createdAt ?? event.createdAt,
    };
    return { changed: true, refreshActivity: false };
  }
  if (viewEvent.type === "evidence.update") {
    state.view = {
      ...current,
      evidence: upsertByKey(current.evidence ?? [], viewEvent.evidence, (item) => item.ref),
      updatedAt: viewEvent.evidence.updatedAt ?? viewEvent.evidence.createdAt ?? event.createdAt,
    };
    return { changed: true, refreshActivity: false };
  }
  const _exhaustive: never = viewEvent;
  void _exhaustive;
  return { changed: false, refreshActivity: false };
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

function reconcileSessionView(
  current: SparkSessionView | null,
  snapshot: SparkSessionView,
  sessionId: string,
  options: {
    preserveCurrentHistory: boolean;
    source: "event" | "refresh";
  },
): SparkSessionView {
  if (!current) return snapshot;
  const snapshotComparison = compareProjectionTimestamp(snapshot, current);
  const snapshotOrder = options.source === "event" ? 1 : snapshotComparison;
  const snapshotPreferred = snapshotOrder !== null && snapshotOrder >= 0;
  const shell = snapshotPreferred ? snapshot : current;
  const messages = reconcileSnapshotMessages(
    current.messages,
    snapshot.messages,
    sessionId,
    options.preserveCurrentHistory,
    snapshotOrder,
  );
  const next: SparkSessionView = {
    ...shell,
    messages,
    tools: mergeSnapshotItems(current.tools, snapshot.tools, (item) => item.id, snapshotOrder),
    runs: mergeSnapshotItems(current.runs, snapshot.runs, (item) => item.id, snapshotOrder),
    tasks: mergeSnapshotItems(current.tasks, snapshot.tasks, (item) => item.ref, snapshotOrder),
    artifacts: mergeSnapshotItems(
      current.artifacts,
      snapshot.artifacts,
      (item) => item.ref,
      snapshotOrder,
    ),
    evidence: mergeSnapshotItems(
      current.evidence ?? [],
      snapshot.evidence ?? [],
      (item) => item.ref,
      snapshotOrder,
    ),
    ...(snapshot.mailbox || current.mailbox
      ? {
          mailbox: mergeSnapshotItems(
            current.mailbox ?? [],
            snapshot.mailbox ?? [],
            (item) => item.id,
            snapshotOrder,
          ),
        }
      : {}),
    updatedAt: laterTimestamp(current.updatedAt, snapshot.updatedAt),
  };
  return sameJsonValue(current, next) ? current : next;
}

function reconcileSnapshotMessages(
  current: SparkMessageView[],
  snapshot: SparkMessageView[],
  sessionId: string,
  preserveCurrentHistory: boolean,
  snapshotOrder: number | null,
): SparkMessageView[] {
  if (preserveCurrentHistory) {
    return mergeMessageSequences(
      current,
      snapshot,
      sessionId,
      snapshotOrder !== null && snapshotOrder < 0 ? "current" : "heuristic",
    );
  }
  const snapshotIds = new Set(snapshot.map((message) => message.id));
  const lastSharedCurrentIndex = current.findLastIndex((message) => snapshotIds.has(message.id));
  const retainedCurrent = current.filter((message, index) => {
    const isShared = snapshotIds.has(message.id);
    const isLiveSuffix = lastSharedCurrentIndex < 0 || index > lastSharedCurrentIndex;
    return isShared || isLiveSuffix || Boolean(userMessageInvocationId(message));
  });
  return mergeMessageSequences(
    snapshot,
    retainedCurrent,
    sessionId,
    snapshotOrder === null || snapshotOrder < 0 ? "next" : "heuristic",
  );
}

function mergeSnapshotItems<T>(
  current: readonly T[],
  snapshot: readonly T[],
  key: (item: T) => string,
  snapshotOrder: number | null,
): T[] {
  const snapshotByKey = new Map(snapshot.map((item) => [key(item), item]));
  const currentKeys = new Set(current.map(key));
  return [
    ...current.map((item) => {
      const projected = snapshotByKey.get(key(item));
      if (!projected) return item;
      if (snapshotOrder !== null && snapshotOrder !== 0) {
        return snapshotOrder > 0 ? projected : item;
      }
      return preferProjectionRevision(item, projected, snapshotOrder === 0);
    }),
    ...snapshot.filter((item) => !currentKeys.has(key(item))),
  ];
}

function mergeMessageSequences(
  base: SparkMessageView[],
  overlay: SparkMessageView[],
  sessionId: string,
  revisionPreference: MessageRevisionPreference,
): SparkMessageView[] {
  let messages = [...base];
  for (const [overlayIndex, message] of overlay.entries()) {
    const existingIndex = messageIndex(messages, message);
    if (existingIndex >= 0) {
      messages = upsertSessionMessage(messages, message, sessionId, revisionPreference);
      continue;
    }
    const insertionIndex = messageInsertionIndex(messages, overlay, overlayIndex);
    messages = [...messages.slice(0, insertionIndex), message, ...messages.slice(insertionIndex)];
  }
  return messages;
}

function messageInsertionIndex(
  messages: SparkMessageView[],
  source: SparkMessageView[],
  sourceIndex: number,
): number {
  for (let index = sourceIndex + 1; index < source.length; index += 1) {
    const anchor = source[index];
    if (!anchor) continue;
    const anchorIndex = messageIndex(messages, anchor);
    if (anchorIndex >= 0) return anchorIndex;
  }
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    const anchor = source[index];
    if (!anchor) continue;
    const anchorIndex = messageIndex(messages, anchor);
    if (anchorIndex >= 0) return anchorIndex + 1;
  }

  const createdAt = source[sourceIndex]?.createdAt;
  if (createdAt) {
    const laterIndex = messages.findIndex(
      (message) => message.createdAt && compareTimestampStrings(message.createdAt, createdAt) > 0,
    );
    if (laterIndex >= 0) return laterIndex;
  }
  return messages.length;
}

function messageIndex(messages: readonly SparkMessageView[], message: SparkMessageView): number {
  const exactIndex = messages.findIndex((candidate) => candidate.id === message.id);
  if (exactIndex >= 0) return exactIndex;
  const invocationId = userMessageInvocationId(message);
  return invocationId
    ? messages.findIndex((candidate) => userMessageInvocationId(candidate) === invocationId)
    : -1;
}

function preferProjectionRevision<T>(current: T, next: T, fallbackPreferNext: boolean): T {
  const comparison = compareProjectionTimestamp(next, current);
  if (comparison !== null && comparison !== 0) return comparison > 0 ? next : current;

  const currentStatus = projectionStatus(current);
  const nextStatus = projectionStatus(next);
  const currentTerminal = isTerminalProjectionStatus(currentStatus);
  const nextTerminal = isTerminalProjectionStatus(nextStatus);
  if (currentTerminal !== nextTerminal) return nextTerminal ? next : current;
  return fallbackPreferNext ? next : current;
}

function compareProjectionTimestamp(next: unknown, current: unknown): number | null {
  const nextTimestamp = projectionTimestamp(next);
  const currentTimestamp = projectionTimestamp(current);
  if (!nextTimestamp && !currentTimestamp) return null;
  if (!nextTimestamp) return -1;
  if (!currentTimestamp) return 1;
  return compareTimestampStrings(nextTimestamp, currentTimestamp);
}

function projectionTimestamp(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return (
    stringField(value, "updatedAt") ??
    stringField(value, "completedAt") ??
    stringField(value, "startedAt") ??
    stringField(value, "createdAt")
  );
}

function projectionStatus(value: unknown): string | null {
  return stringField(value, "status")?.toLocaleLowerCase() ?? null;
}

function isTerminalProjectionStatus(status: string | null): boolean {
  return Boolean(
    status &&
    [
      "succeeded",
      "completed",
      "done",
      "failed",
      "error",
      "lost",
      "timeout",
      "timed_out",
      "cancelled",
      "canceled",
    ].includes(status),
  );
}

function laterTimestamp(current: string | undefined, next: string | undefined): string | undefined {
  if (!current) return next;
  if (!next) return current;
  return compareTimestampStrings(next, current) > 0 ? next : current;
}

function compareTimestampStrings(next: string, current: string): number {
  const nextTime = Date.parse(next);
  const currentTime = Date.parse(current);
  if (Number.isFinite(nextTime) && Number.isFinite(currentTime)) return nextTime - currentTime;
  return next.localeCompare(current);
}

function syncInvocationStateFromView(state: SessionLiveEventState, pruneMissing: boolean): void {
  const pendingTurns = state.view?.pendingTurns ?? [];
  const pendingInvocationIds = new Set(pendingTurns.map((turn) => turn.invocationId));
  if (pruneMissing) {
    for (const [invocationId, phase] of state.invocationPhases) {
      if (!isTerminalInvocationStatus(phase) && !pendingInvocationIds.has(invocationId)) {
        state.invocationPhases.delete(invocationId);
      }
    }
  }
  for (const pending of pendingTurns) {
    state.invocationIds.add(pending.invocationId);
    acceptInvocationPhase(state, pending.invocationId, pending.status);
  }
  state.activeTurnId = queuedTurnId(state.view);
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
    evidence: [...(view.evidence ?? [])],
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
    evidence: [],
    createdAt,
    updatedAt: createdAt,
    metadata: {},
  };
}

function upsertById<T extends { id: string }>(items: readonly T[], next: T): T[] {
  return upsertByKey(items, next, (item) => item.id);
}

function upsertSessionMessage(
  items: SparkMessageView[],
  next: SparkMessageView,
  sessionId: string,
  revisionPreference: MessageRevisionPreference,
): SparkMessageView[] {
  const exactIndex = items.findIndex((item) => item.id === next.id);
  if (exactIndex >= 0) {
    const current = items[exactIndex]!;
    const preferred = preferMessageRevision(current, next, revisionPreference);
    if (preferred === current) return items;
    return items.map((item, index) => (index === exactIndex ? preferred : item));
  }

  const invocationId = userMessageInvocationId(next);
  if (!invocationId) return [...items, next];
  const correlatedIndex = items.findIndex((item) => userMessageInvocationId(item) === invocationId);
  if (correlatedIndex < 0) return [...items, next];

  const current = items[correlatedIndex]!;
  const livePrefix = `${sessionId}:message:user:`;
  const currentIsTemporary = current.id.startsWith(livePrefix);
  const nextIsTemporary = next.id.startsWith(livePrefix);
  const preferred =
    currentIsTemporary !== nextIsTemporary
      ? currentIsTemporary
        ? next
        : current
      : revisionPreference === "ordered" || revisionPreference === "next"
        ? next
        : current;
  if (preferred === current) return items;
  return items.map((item, index) => (index === correlatedIndex ? preferred : item));
}

function preferMessageRevision(
  current: SparkMessageView,
  next: SparkMessageView,
  revisionPreference: MessageRevisionPreference,
): SparkMessageView {
  if (sameJsonValue(current, next)) return current;
  if (revisionPreference === "ordered" || revisionPreference === "next") return next;
  if (revisionPreference === "current") return current;

  const currentPhase = messageStatusPhase(current.status);
  const nextPhase = messageStatusPhase(next.status);
  if (currentPhase !== nextPhase) return nextPhase > currentPhase ? next : current;
  const comparison = compareProjectionTimestamp(next, current);
  if (comparison !== null && comparison !== 0) return comparison > 0 ? next : current;
  if (current.status === "streaming" && next.status === "streaming") {
    return messageProjectionWeight(next) >= messageProjectionWeight(current) ? next : current;
  }
  return current;
}

type MessageRevisionPreference = "ordered" | "next" | "current" | "heuristic";

function messageProjectionWeight(message: SparkMessageView): number {
  return message.text.length + JSON.stringify(message.parts ?? []).length;
}

function messageStatusPhase(status: SparkMessageView["status"]): number {
  if (status === "done" || status === "error") return 2;
  if (status === "streaming") return 1;
  return 0;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
