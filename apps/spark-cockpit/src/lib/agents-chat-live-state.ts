export const agentsCockpitSource = "agents-cockpit";

export interface AgentsChatSerializedEvent {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  actorKind: string;
  actorId: string | null;
  kind: string;
  subjectKind: string | null;
  subjectId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface AgentsChatCommandLive {
  id: string;
  kind: string;
  title: string | null;
  payloadJson: string;
  status: string;
  deliveryStatus: string | null;
  createdAt: string;
  updatedAt: string;
  attemptCount: number | null;
  lastAttemptAt: string | null;
  ackedAt: string | null;
  rejectedAt: string | null;
  rejectCode: string | null;
  rejectMessage: string | null;
  runtimeWorkspaceName: string | null;
  runtimeName: string | null;
  runtimeStatus: string | null;
}

export interface AgentsChatInvocationLive {
  id: string;
  runtimeInvocationId: string;
  commandId: string | null;
  taskRuntimeId: string | null;
  agentName: string | null;
  status: string;
  updatedAt: string;
}

export interface AgentsChatLogChunkLive {
  id: string;
  runtimeInvocationId: string;
  agentName: string | null;
  stream: string;
  sequence: number;
  content: string;
  createdAt: string;
}

export interface AgentsChatLiveState {
  workspaceId: string;
  commands: AgentsChatCommandLive[];
  invocations: AgentsChatInvocationLive[];
  logChunks: AgentsChatLogChunkLive[];
  cursor: string | null;
  processedEventIds: Set<string>;
  commandIds: Set<string>;
  invocationIds: Set<string>;
}

export function createAgentsChatLiveState(input: {
  workspaceId: string;
  commands: AgentsChatCommandLive[];
  invocations: AgentsChatInvocationLive[];
  logChunks: AgentsChatLogChunkLive[];
  cursor?: string | null;
}): AgentsChatLiveState {
  return {
    workspaceId: input.workspaceId,
    commands: [...input.commands],
    invocations: [...input.invocations],
    logChunks: [...input.logChunks],
    cursor: input.cursor ?? null,
    processedEventIds: new Set(),
    commandIds: new Set(input.commands.map((command) => command.id)),
    invocationIds: new Set(input.invocations.map((invocation) => invocation.runtimeInvocationId)),
  };
}

export function addOptimisticAgentsChatCommand(
  state: AgentsChatLiveState,
  input: { prompt: string; createdAt?: string },
): string | null {
  const prompt = input.prompt.replace(/\s+/gu, " ").trim();
  if (!prompt) return null;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const id = `optimistic-${createdAt}-${state.commands.length}`;
  const runtimeTaskId = `optimistic-task-${createdAt}`;
  state.commands.unshift({
    id,
    kind: "task.start.request",
    title: prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt,
    payloadJson: JSON.stringify({
      kind: "task.start.request",
      title: prompt,
      payload: { prompt, runtimeTaskId, source: agentsCockpitSource },
    }),
    status: "queued",
    deliveryStatus: "pending",
    createdAt,
    updatedAt: createdAt,
    attemptCount: 0,
    lastAttemptAt: null,
    ackedAt: null,
    rejectedAt: null,
    rejectCode: null,
    rejectMessage: null,
    runtimeWorkspaceName: null,
    runtimeName: null,
    runtimeStatus: null,
  });
  state.commandIds.add(id);
  sortCommands(state.commands);
  return id;
}

export function applyAgentsChatEvent(
  state: AgentsChatLiveState,
  event: AgentsChatSerializedEvent,
): boolean {
  if (state.processedEventIds.has(event.id)) return false;
  state.processedEventIds.add(event.id);
  state.cursor = eventCursor(event);

  if (event.workspaceId !== state.workspaceId || event.projectId !== null) return false;

  if (event.kind === "command.queued") return mergeQueuedCommand(state, event);
  if (event.kind === "command.acked") return mergeCommandStatus(state, event, "acked", "acked");
  if (event.kind === "command.rejected")
    return mergeCommandStatus(state, event, "rejected", "rejected");
  if (event.kind === "invocation.updated") return mergeInvocationUpdate(state, event);
  if (event.kind === "invocation.log_chunk") return mergeInvocationLogChunk(state, event);
  return false;
}

export function eventCursor(event: Pick<AgentsChatSerializedEvent, "createdAt" | "id">): string {
  return `${event.createdAt}|${event.id}`;
}

function mergeQueuedCommand(state: AgentsChatLiveState, event: AgentsChatSerializedEvent): boolean {
  const payload = event.payload;
  if (!isRecord(payload) || !isRecord(payload.command)) return false;
  const command = commandFromQueuedPayload(payload.command, event.createdAt);
  if (!command || !isAgentsCockpitServerCommand(parseJson(command.payloadJson))) return false;

  const prompt = commandPrompt(command);
  if (prompt) {
    state.commands = state.commands.filter(
      (candidate) => !candidate.id.startsWith("optimistic-") || commandPrompt(candidate) !== prompt,
    );
  }
  upsertById(state.commands, command, (current) => ({ ...current, ...command }));
  sortCommands(state.commands);
  state.commandIds.add(command.id);
  return true;
}

function mergeCommandStatus(
  state: AgentsChatLiveState,
  event: AgentsChatSerializedEvent,
  status: string,
  deliveryStatus: string,
): boolean {
  const commandId = event.subjectId;
  if (!commandId || !state.commandIds.has(commandId)) return false;
  upsertById(
    state.commands,
    {
      id: commandId,
      kind: "task.start.request",
      title: null,
      payloadJson: "{}",
      status,
      deliveryStatus,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      attemptCount: null,
      lastAttemptAt: null,
      ackedAt: null,
      rejectedAt: null,
      rejectCode: null,
      rejectMessage: null,
      runtimeWorkspaceName: null,
      runtimeName: null,
      runtimeStatus: null,
    },
    (current) => ({
      ...current,
      status,
      deliveryStatus,
      updatedAt: event.createdAt,
      ...(status === "rejected" && isRecord(event.payload)
        ? {
            rejectCode: stringOrNull(event.payload.reasonCode),
            rejectMessage: stringOrNull(event.payload.message),
            rejectedAt: event.createdAt,
          }
        : {}),
      ...(status === "acked" ? { ackedAt: event.createdAt } : {}),
    }),
  );
  return true;
}

function mergeInvocationUpdate(
  state: AgentsChatLiveState,
  event: AgentsChatSerializedEvent,
): boolean {
  const payload = event.payload;
  if (!isRecord(payload)) return false;
  const runtimeInvocationId = stringOrNull(payload.runtimeInvocationId) ?? event.subjectId;
  const commandId = stringOrNull(payload.commandId);
  if (!runtimeInvocationId || (commandId && !state.commandIds.has(commandId))) return false;
  if (!commandId && !state.invocationIds.has(runtimeInvocationId)) return false;

  const invocation: AgentsChatInvocationLive = {
    id: runtimeInvocationId,
    runtimeInvocationId,
    commandId,
    taskRuntimeId: stringOrNull(payload.taskRuntimeId),
    agentName: stringOrNull(payload.agentName),
    status: stringOrNull(payload.status) ?? "running",
    updatedAt: event.createdAt,
  };

  upsertByRuntimeInvocationId(state.invocations, invocation, (current) => ({
    ...current,
    ...invocation,
    id: current.id,
  }));
  state.invocationIds.add(runtimeInvocationId);
  sortInvocations(state.invocations);
  return true;
}

function mergeInvocationLogChunk(
  state: AgentsChatLiveState,
  event: AgentsChatSerializedEvent,
): boolean {
  const payload = event.payload;
  if (!isRecord(payload)) return false;
  const runtimeInvocationId = stringOrNull(payload.runtimeInvocationId) ?? event.subjectId;
  if (!runtimeInvocationId || !state.invocationIds.has(runtimeInvocationId)) return false;

  const sequence =
    typeof payload.sequence === "number" ? payload.sequence : Number(payload.sequence);
  if (!Number.isFinite(sequence)) return false;

  const chunk: AgentsChatLogChunkLive = {
    id: event.id,
    runtimeInvocationId,
    agentName: agentNameForInvocation(state, runtimeInvocationId),
    stream: stringOrNull(payload.stream) ?? "system",
    sequence,
    content: stringOrNull(payload.content) ?? "",
    createdAt: event.createdAt,
  };

  const duplicate = state.logChunks.some(
    (existing) =>
      existing.runtimeInvocationId === chunk.runtimeInvocationId &&
      existing.sequence === chunk.sequence,
  );
  if (duplicate) return false;
  state.logChunks.push(chunk);
  state.logChunks.sort((left, right) => {
    const invocationOrder = left.runtimeInvocationId.localeCompare(right.runtimeInvocationId);
    if (invocationOrder !== 0) return invocationOrder;
    const sequenceOrder = left.sequence - right.sequence;
    if (sequenceOrder !== 0) return sequenceOrder;
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
  return true;
}

function commandFromQueuedPayload(
  value: Record<string, unknown>,
  createdAt: string,
): AgentsChatCommandLive | null {
  const id = stringOrNull(value.id);
  const kind = stringOrNull(value.kind);
  if (!id || !kind) return null;
  const payload = value.payload ?? {};
  return {
    id,
    kind,
    title: stringOrNull(value.title),
    payloadJson: JSON.stringify(payload),
    status: stringOrNull(value.status) ?? "queued",
    deliveryStatus: stringOrNull(value.deliveryStatus) ?? "pending",
    createdAt: stringOrNull(value.createdAt) ?? createdAt,
    updatedAt: stringOrNull(value.updatedAt) ?? createdAt,
    attemptCount: null,
    lastAttemptAt: null,
    ackedAt: null,
    rejectedAt: null,
    rejectCode: null,
    rejectMessage: null,
    runtimeWorkspaceName: null,
    runtimeName: null,
    runtimeStatus: null,
  };
}

function commandPrompt(command: AgentsChatCommandLive): string | null {
  const parsed = parseJson(command.payloadJson);
  if (!isRecord(parsed) || !isRecord(parsed.payload)) return null;
  return typeof parsed.payload.prompt === "string"
    ? parsed.payload.prompt.replace(/\s+/gu, " ").trim()
    : null;
}

function isAgentsCockpitServerCommand(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  return value.payload.source === agentsCockpitSource;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function upsertById<T extends { id: string }>(rows: T[], next: T, merge: (current: T) => T): void {
  const index = rows.findIndex((row) => row.id === next.id);
  if (index === -1) rows.push(next);
  else rows[index] = merge(rows[index]!);
}

function upsertByRuntimeInvocationId(
  rows: AgentsChatInvocationLive[],
  next: AgentsChatInvocationLive,
  merge: (current: AgentsChatInvocationLive) => AgentsChatInvocationLive,
): void {
  const index = rows.findIndex((row) => row.runtimeInvocationId === next.runtimeInvocationId);
  if (index === -1) rows.push(next);
  else rows[index] = merge(rows[index]!);
}

function sortCommands(commands: AgentsChatCommandLive[]): void {
  commands.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (commands.length > 8) commands.length = 8;
}

function sortInvocations(invocations: AgentsChatInvocationLive[]): void {
  invocations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (invocations.length > 16) invocations.length = 16;
}

function agentNameForInvocation(
  state: AgentsChatLiveState,
  runtimeInvocationId: string,
): string | null {
  return (
    state.invocations.find((invocation) => invocation.runtimeInvocationId === runtimeInvocationId)
      ?.agentName ?? null
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
