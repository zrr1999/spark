import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  parseSparkAssignment,
  parseSparkSessionRegistryRecord,
  parseSparkSessionRegistryRecords,
  parseSparkSessionView,
  sparkSessionArchiveRequestSchema,
  sparkSessionBindRequestSchema,
  sparkSessionCreateRequestSchema,
  sparkSessionGetRequestSchema,
  sparkSessionListRequestSchema,
  sparkSessionSnapshotPageSchema,
  sparkSessionSnapshotRequestSchema,
  sparkSessionUnbindRequestSchema,
  sparkTurnCancelRequestSchema,
  sparkTurnCancelResultSchema,
  sparkTurnStatusRequestSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  sparkTurnStreamRequestSchema,
  sparkTurnSubmitRequestSchema,
  sparkTurnSubmitResultSchema,
  type SparkAssignment,
  type SparkCommandKind,
  type SparkInvocationStatus,
  type SparkProtocolJsonValue,
  type SparkSessionRegistryRecord,
  type SparkSessionView,
} from "@zendev-lab/spark-protocol";
import { loadSparkSessionSnapshot, SparkSessionRegistryError } from "@zendev-lab/spark-session";
import type { SparkPaths } from "@zendev-lab/spark-system";

import type { SparkDaemonModelControl } from "./model-control.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import { validateSparkDaemonTask, type SparkDaemonTask } from "./core/index.ts";
import { SparkInvocationStore, type SparkInvocationRecord } from "./store/invocations.ts";
import { getWorkspaceById, listWorkspaces, resolveWorkspaceLocalPath } from "./store/workspaces.ts";

// Result and projection carry the same public page, so each copy must leave
// room for the other copy and terminal envelope metadata under the 64 KiB wire cap.
const maxSessionControlProjectionBytes = 24 * 1024;
const maxSessionListRecords = 100;
const defaultSessionSnapshotMessages = 32;
const maxTurnStreamEvents = 100;

export interface SparkDaemonSessionControlOptions {
  paths: SparkPaths;
  db: DatabaseSync;
  sessionRegistry?: DaemonSessionRegistry;
  modelControl?: SparkDaemonModelControl;
  actor: "spark-daemon-local-rpc" | "spark-daemon-runtime-ws";
}

export interface SparkDaemonSessionControlRequest {
  kind: Extract<
    SparkCommandKind,
    | "session.list.request"
    | "session.get.request"
    | "session.snapshot.request"
    | "session.create.request"
    | "session.bind.request"
    | "session.unbind.request"
    | "session.archive.request"
    | "turn.submit.request"
    | "turn.cancel.request"
    | "turn.status.request"
    | "turn.stream.subscribe"
  >;
  payload: Record<string, unknown>;
  scope: "any" | "daemon" | "workspace";
  workspaceId?: string;
  workspaceBindingId?: string;
  sessionId?: string;
  idempotencyKey?: string;
}

export interface SparkDaemonSessionControlResult {
  result: Record<string, SparkProtocolJsonValue>;
  projection?: {
    kind: "session.list" | "session.detail" | "session.snapshot" | "turn.status" | "turn.stream";
    data: Record<string, SparkProtocolJsonValue>;
  };
  invocationId?: string;
}

export async function executeSparkDaemonSessionControl(
  options: SparkDaemonSessionControlOptions,
  request: SparkDaemonSessionControlRequest,
): Promise<SparkDaemonSessionControlResult> {
  switch (request.kind) {
    case "session.list.request": {
      const parsed = sparkSessionListRequestSchema.parse(request.payload);
      assertScopeInput(request, parsed.scope);
      const sessions = projectSessionInvocationActivity(
        new SparkInvocationStore(options.db),
        await listSessionsForRequest(options, request, parsed),
      );
      const records = parseSparkSessionRegistryRecords(sessions);
      const page =
        options.actor === "spark-daemon-runtime-ws"
          ? boundedSessionList(records, parsed.cursor, parsed.limit)
          : { sessions: records, hasMore: false };
      const data = publicObject(page);
      return { result: data, projection: { kind: "session.list", data } };
    }
    case "session.get.request": {
      const parsed = sparkSessionGetRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      const owned = await requireSession(options, parsed.sessionId, request);
      const session =
        projectSessionInvocationActivity(new SparkInvocationStore(options.db), [owned])[0] ?? owned;
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "session.snapshot.request": {
      const parsed = sparkSessionSnapshotRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      const session = await requireSession(options, parsed.sessionId, request);
      if (!options.paths.piAgentDir) {
        throw new Error("Spark daemon native session storage is not available.");
      }
      const snapshot = projectPendingSessionTurns(
        options.db,
        await loadSparkSessionSnapshot({
          sessionsRoot: join(options.paths.piAgentDir, "sessions"),
          session,
        }),
      );
      const window = boundedSessionSnapshot(snapshot, parsed);
      const data = publicObject(window);
      return { result: data, projection: { kind: "session.snapshot", data } };
    }
    case "session.create.request": {
      const parsed = sparkSessionCreateRequestSchema.parse(request.payload);
      if (
        options.actor === "spark-daemon-runtime-ws" &&
        (parsed.cwd !== undefined || parsed.sessionPath !== undefined)
      ) {
        throw new SparkSessionRegistryError(
          "session_local_path_forbidden",
          "Remote session creation cannot select daemon-local cwd or sessionPath.",
        );
      }
      assertScopeInput(request, parsed.scope);
      const session = parseSparkSessionRegistryRecord(
        projectSessionForRequest(
          options.db,
          await requireSessionRegistry(options).create(parsed),
          request,
        ),
      );
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "session.bind.request": {
      const parsed = sparkSessionBindRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      await requireSession(options, parsed.sessionId, request);
      const session = parseSparkSessionRegistryRecord(
        projectSessionForRequest(
          options.db,
          await requireSessionRegistry(options).bind(parsed),
          request,
        ),
      );
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "session.unbind.request": {
      const parsed = sparkSessionUnbindRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      await requireSession(options, parsed.sessionId, request);
      const session = parseSparkSessionRegistryRecord(
        projectSessionForRequest(
          options.db,
          await requireSessionRegistry(options).unbind(parsed.sessionId, parsed.externalKey),
          request,
        ),
      );
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "session.archive.request": {
      const parsed = sparkSessionArchiveRequestSchema.parse({
        ...request.payload,
        sessionId: request.sessionId ?? request.payload.sessionId,
      });
      await requireSession(options, parsed.sessionId, request);
      const session = parseSparkSessionRegistryRecord(
        projectSessionForRequest(
          options.db,
          await requireSessionRegistry(options).archive(parsed.sessionId),
          request,
        ),
      );
      const data = publicObject({ session });
      return { result: data, projection: { kind: "session.detail", data } };
    }
    case "turn.submit.request": {
      const parsed = parseTurnSubmitPayload(request.payload, request.sessionId);
      const session = options.sessionRegistry
        ? await requireSession(options, parsed.sessionId, request)
        : undefined;
      if (!session && request.scope !== "any") {
        throw new Error("Spark daemon session registry is not available.");
      }
      const route: { cwd?: string; workspaceId?: string } = session
        ? sessionTurnRoute(options.db, session, parsed.assignment)
        : parsed.assignment?.target.workspaceId
          ? { workspaceId: parsed.assignment.target.workspaceId }
          : {};
      const idempotencyKey = parsed.idempotencyKey ?? request.idempotencyKey;
      const store = new SparkInvocationStore(options.db);
      const existing = idempotencyKey ? store.findByIdempotencyKey(idempotencyKey) : undefined;
      if (existing) {
        assertIdempotentTurnReplay(existing, parsed);
        const replay = sparkTurnSubmitResultSchema.parse({
          invocationId: existing.invocationId,
          status: "queued",
          acceptedAt: existing.createdAt,
        });
        return { result: publicObject(replay), invocationId: existing.invocationId };
      }

      // Dynamic defaults are frozen only for the first admission. A retry of
      // the same wire request returns above before a concurrent model/thinking
      // change can manufacture an idempotency conflict.
      const model = await effectiveTurnModel(options, parsed.sessionId, parsed.model);
      const thinkingLevel = await effectiveTurnThinkingLevel(options, parsed.sessionId);
      await options.sessionRegistry?.recordTurnQueued(parsed.sessionId);
      let submitted;
      try {
        submitted = submitInvocationTask(
          options.db,
          {
            type: "session.run",
            sessionId: parsed.sessionId,
            prompt: parsed.prompt,
            ...(model ? { model } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
            ...(parsed.reset !== undefined ? { reset: parsed.reset } : {}),
            ...(route.cwd ? { cwd: route.cwd } : {}),
            ...(request.workspaceBindingId
              ? { workspaceBindingId: request.workspaceBindingId }
              : {}),
            ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
            ...(parsed.assignment ? { assignment: parsed.assignment } : {}),
            ...(parsed.messageMetadata ? { messageMetadata: parsed.messageMetadata } : {}),
            ...(parsed.originBinding
              ? {
                  channelReply: {
                    workspaceId: parsed.originBinding.workspaceId,
                    adapter: parsed.originBinding.adapter,
                    adapterId: parsed.originBinding.adapterId,
                    ...(parsed.originBinding.adapterAccountIdentity
                      ? { adapterAccountIdentity: parsed.originBinding.adapterAccountIdentity }
                      : {}),
                    recipient: parsed.originBinding.recipient,
                  },
                  channelContext: { externalKey: parsed.originBinding.externalKey },
                }
              : {}),
            actor: options.actor,
          },
          idempotencyKey,
          invocationSource(parsed.messageMetadata),
        );
      } catch (error) {
        const raced = idempotencyKey ? store.findByIdempotencyKey(idempotencyKey) : undefined;
        if (raced) {
          try {
            assertIdempotentTurnReplay(raced, parsed);
          } finally {
            if (isTerminalInvocationStatus(raced.status)) {
              await settleManagedSessionTurn(options.sessionRegistry, parsed.sessionId);
            }
          }
          const replay = turnSubmitResultForInvocation(raced);
          return { result: publicObject(replay), invocationId: raced.invocationId };
        }
        await settleManagedSessionTurn(options.sessionRegistry, parsed.sessionId);
        throw error;
      }
      if (isTerminalInvocationStatus(store.require(submitted.invocationId).status)) {
        await settleManagedSessionTurn(options.sessionRegistry, parsed.sessionId);
      }
      const data = publicObject(submitted);
      return { result: data, invocationId: submitted.invocationId };
    }
    case "turn.status.request": {
      const parsed = sparkTurnStatusRequestSchema.parse(request.payload);
      const status = invocationStatusResult(
        new SparkInvocationStore(options.db),
        parsed.invocationId,
      );
      await assertInvocationScope(options, status.sessionId, request);
      const data = publicObject(status);
      return {
        result: data,
        projection: { kind: "turn.status", data },
        invocationId: parsed.invocationId,
      };
    }
    case "turn.stream.subscribe": {
      const parsed = sparkTurnStreamRequestSchema.parse(request.payload);
      const store = new SparkInvocationStore(options.db);
      const invocation = store.require(parsed.invocationId);
      await assertInvocationScope(options, invocation.sessionId, request);
      const page = boundedTurnStreamPage(store, parsed.invocationId, parsed.after, parsed.limit);
      const data = publicObject(page);
      return {
        result: data,
        projection: { kind: "turn.stream", data },
        invocationId: parsed.invocationId,
      };
    }
    case "turn.cancel.request": {
      const parsed = sparkTurnCancelRequestSchema.parse(request.payload);
      const store = new SparkInvocationStore(options.db);
      const invocation = store.require(parsed.invocationId);
      await assertInvocationScope(options, invocation.sessionId, request);
      const reason = parsed.reason ?? "Spark runtime turn cancellation requested.";
      const outcome = store.requestCancellation(parsed.invocationId, reason);
      if (outcome === "cancelled" && invocation.sessionId) {
        await settleManagedSessionTurn(options.sessionRegistry, invocation.sessionId);
      }
      const current = store.require(parsed.invocationId);
      const result = sparkTurnCancelResultSchema.parse({
        invocationId: parsed.invocationId,
        status: current.status,
        cancelRequested: outcome === "cancelled" || outcome === "requested",
      });
      const data = publicObject(result);
      return { result: data, invocationId: parsed.invocationId };
    }
  }
}

function assertIdempotentTurnReplay(
  existing: SparkInvocationRecord,
  parsed: ReturnType<typeof parseTurnSubmitPayload>,
): void {
  const task = validateSparkDaemonTask(existing.task);
  if (
    task.sessionId !== parsed.sessionId ||
    task.prompt !== parsed.prompt ||
    task.reset !== parsed.reset ||
    JSON.stringify(task.assignment) !== JSON.stringify(parsed.assignment) ||
    JSON.stringify(task.messageMetadata) !== JSON.stringify(parsed.messageMetadata) ||
    JSON.stringify(originBindingFromTask(task)) !== JSON.stringify(parsed.originBinding)
  ) {
    throw new Error(`Invocation idempotency conflict: ${parsed.idempotencyKey ?? "unknown"}`);
  }
}

function originBindingFromTask(task: SparkDaemonTask) {
  if (!task.channelReply || !task.channelContext) return undefined;
  return {
    workspaceId: task.channelReply.workspaceId,
    adapter: task.channelReply.adapter,
    adapterId: task.channelReply.adapterId,
    ...(task.channelReply.adapterAccountIdentity
      ? { adapterAccountIdentity: task.channelReply.adapterAccountIdentity }
      : {}),
    externalKey: task.channelContext.externalKey,
    recipient: task.channelReply.recipient,
  };
}

export function assertIdempotentTurnPayloadReplay(
  existing: SparkInvocationRecord,
  input: {
    payload: Record<string, unknown>;
    sessionId?: string;
    idempotencyKey?: string;
  },
): void {
  assertIdempotentTurnReplay(
    existing,
    parseTurnSubmitPayload(
      { ...input.payload, idempotencyKey: input.idempotencyKey },
      input.sessionId,
    ),
  );
}

function requireSessionRegistry(options: SparkDaemonSessionControlOptions): DaemonSessionRegistry {
  if (!options.sessionRegistry) throw new Error("Spark daemon session registry is not available.");
  return options.sessionRegistry;
}

async function listSessionsForRequest(
  options: SparkDaemonSessionControlOptions,
  request: SparkDaemonSessionControlRequest,
  parsed: ReturnType<typeof sparkSessionListRequestSchema.parse>,
): Promise<SparkSessionRegistryRecord[]> {
  const registry = requireSessionRegistry(options);
  if (request.scope !== "workspace") return await registry.list(parsed);

  const sessions = await registry.list({ includeArchived: parsed.includeArchived });
  return sessions.flatMap((session) => {
    try {
      return [projectSessionForRequest(options.db, session, request)];
    } catch (error) {
      if (error instanceof SparkSessionRegistryError && error.code === "session_scope_mismatch") {
        return [];
      }
      throw error;
    }
  });
}

async function requireSession(
  options: SparkDaemonSessionControlOptions,
  sessionId: string,
  request: Pick<SparkDaemonSessionControlRequest, "scope" | "workspaceId" | "workspaceBindingId">,
): Promise<SparkSessionRegistryRecord> {
  const session = await requireSessionRegistry(options).get(sessionId);
  if (!session) {
    throw new SparkSessionRegistryError("session_not_found", `unknown session: ${sessionId}`);
  }
  return projectSessionForRequest(options.db, session, request);
}

function assertScopeInput(
  request: Pick<SparkDaemonSessionControlRequest, "scope" | "workspaceId">,
  scope: { kind: "daemon" } | { kind: "workspace"; workspaceId: string } | undefined,
): void {
  if (request.scope === "any") return;
  if (request.scope === "daemon" && scope?.kind === "workspace") {
    throw new SparkSessionRegistryError(
      "session_scope_mismatch",
      "Daemon-scoped command cannot target a workspace session scope.",
    );
  }
  if (request.scope === "workspace") {
    if (scope?.kind !== "workspace" || scope.workspaceId !== request.workspaceId) {
      throw new SparkSessionRegistryError(
        "session_scope_mismatch",
        `Workspace command must target workspace ${request.workspaceId ?? "unknown"}.`,
      );
    }
  }
}

function projectSessionForRequest(
  db: DatabaseSync,
  session: SparkSessionRegistryRecord,
  request: Pick<SparkDaemonSessionControlRequest, "scope" | "workspaceId" | "workspaceBindingId">,
): SparkSessionRegistryRecord {
  if (request.scope === "any") return session;
  if (request.scope === "daemon") {
    if (session.scope.kind === "daemon") return session;
    throw new SparkSessionRegistryError(
      "session_scope_mismatch",
      `session ${session.sessionId} is not daemon-global`,
    );
  }

  const workspaceId = request.workspaceId?.trim();
  if (session.scope.kind === "workspace" && workspaceId) {
    if (requestWorkspaceAliases(db, request).has(session.scope.workspaceId)) {
      return parseSparkSessionRegistryRecord({
        ...session,
        scope: { kind: "workspace", workspaceId },
        workspaceId,
      });
    }
  }
  throw new SparkSessionRegistryError(
    "session_scope_mismatch",
    `session ${session.sessionId} does not belong to workspace ${workspaceId ?? "unknown"}`,
  );
}

function requestWorkspaceAliases(
  db: DatabaseSync,
  request: Pick<SparkDaemonSessionControlRequest, "workspaceId" | "workspaceBindingId">,
): Set<string> {
  const aliases = new Set(
    [request.workspaceId?.trim(), request.workspaceBindingId?.trim()].filter(
      (value): value is string => Boolean(value),
    ),
  );
  const routeWorkspace = getWorkspaceById(
    db,
    request.workspaceBindingId?.trim() || request.workspaceId?.trim() || "",
  );
  if (!routeWorkspace) return aliases;

  aliases.add(routeWorkspace.id);
  if (routeWorkspace.serverWorkspaceId) aliases.add(routeWorkspace.serverWorkspaceId);

  // A local workspace key is a useful legacy alias only while it identifies
  // one daemon workspace. Local paths are deliberately not aliases: distinct
  // workspace identities may share a checkout and must remain separate in
  // Cockpit/session routing.
  const localKeyMatches = listWorkspaces(db).filter(
    (workspace) => workspace.localWorkspaceKey === routeWorkspace.localWorkspaceKey,
  );
  if (localKeyMatches.length === 1) aliases.add(routeWorkspace.localWorkspaceKey);
  return aliases;
}

async function assertInvocationScope(
  options: SparkDaemonSessionControlOptions,
  sessionId: string | undefined,
  request: Pick<SparkDaemonSessionControlRequest, "scope" | "workspaceId">,
): Promise<void> {
  if (request.scope === "any" && !options.sessionRegistry) return;
  if (!sessionId) throw new Error("Invocation has no daemon-owned session route.");
  await requireSession(options, sessionId, request);
}

function parseTurnSubmitPayload(payload: Record<string, unknown>, sessionId?: string) {
  const parsed = sparkTurnSubmitRequestSchema.parse({
    ...payload,
    sessionId: sessionId ?? payload.sessionId,
  });
  const assignment =
    payload.assignment === undefined ? undefined : parseSparkAssignment(payload.assignment);
  const messageMetadata =
    payload.messageMetadata === undefined
      ? undefined
      : publicObject(payload.messageMetadata as Record<string, unknown>);
  return { ...parsed, assignment, messageMetadata };
}

async function effectiveTurnModel(
  options: SparkDaemonSessionControlOptions,
  sessionId: string,
  requestedModel?: string,
): Promise<string | undefined> {
  if (requestedModel) {
    if (
      !requestedModel.includes("/") ||
      requestedModel.startsWith("/") ||
      requestedModel.endsWith("/")
    ) {
      throw new Error(`Invalid frozen Spark model: ${requestedModel}`);
    }
    return requestedModel;
  }
  if (!options.modelControl) return undefined;
  const model = await options.modelControl.effectiveModel(sessionId);
  await options.modelControl.prepareModel(model);
  return `${model.providerName}/${model.modelId}`;
}

async function effectiveTurnThinkingLevel(
  options: SparkDaemonSessionControlOptions,
  sessionId: string,
): Promise<string | undefined> {
  return options.modelControl?.effectiveThinkingLevel(sessionId);
}

function sessionTurnRoute(
  db: DatabaseSync,
  session: SparkSessionRegistryRecord,
  assignment?: SparkAssignment,
): { cwd: string; workspaceId?: string } {
  if (session.scope.kind === "daemon") {
    if (assignment?.target.workspaceId) {
      throw new SparkSessionRegistryError(
        "session_scope_mismatch",
        `daemon-global session ${session.sessionId} cannot target a workspace`,
      );
    }
    const cwd = session.cwd?.trim();
    if (!cwd) {
      throw new SparkSessionRegistryError(
        "session_cwd_unavailable",
        `daemon-global session ${session.sessionId} has no execution directory`,
      );
    }
    return { cwd };
  }
  const workspaceId = session.scope.workspaceId;
  if (assignment?.target.workspaceId && assignment.target.workspaceId !== workspaceId) {
    throw new SparkSessionRegistryError(
      "session_scope_mismatch",
      `session ${session.sessionId} belongs to workspace ${workspaceId}`,
    );
  }
  const sessionCwd = session.cwd?.trim();
  const cwd =
    sessionCwd && sessionCwd !== "/" ? sessionCwd : resolveWorkspaceLocalPath(db, workspaceId);
  if (!cwd?.trim() || cwd === "/") {
    throw new SparkSessionRegistryError(
      "session_cwd_unavailable",
      `workspace session ${session.sessionId} has no daemon-local execution directory`,
    );
  }
  return { cwd: cwd.trim(), workspaceId };
}

function submitInvocationTask(
  db: DatabaseSync,
  task: SparkDaemonTask,
  idempotencyKey?: string,
  source?: { kind: string; ref?: string },
) {
  const store = new SparkInvocationStore(db);
  const input = {
    sessionId: task.sessionId,
    workspaceBindingId: task.workspaceBindingId,
    idempotencyKey,
    prompt: task.prompt,
    task,
    ...(source ? { sourceKind: source.kind, sourceRef: source.ref } : {}),
  };
  const invocation =
    source?.kind === "session.question" ? store.submitIfSessionIdle(input) : store.submit(input);
  return turnSubmitResultForInvocation(invocation);
}

function turnSubmitResultForInvocation(invocation: SparkInvocationRecord) {
  return sparkTurnSubmitResultSchema.parse({
    invocationId: invocation.invocationId,
    status: "queued",
    acceptedAt: invocation.createdAt,
  });
}

function invocationStatusResult(store: SparkInvocationStore, invocationId: string) {
  const invocation = store.require(invocationId);
  return sparkTurnStatusResultSchema.parse({
    invocationId,
    sessionId: invocation.sessionId,
    retryOfInvocationId: invocation.retryOfInvocationId,
    status: invocation.status,
    createdAt: invocation.createdAt,
    updatedAt: invocation.updatedAt,
    startedAt: invocation.startedAt,
    finishedAt: invocation.finishedAt,
    cancelReason: invocation.cancelReason,
    ...(invocation.errorMessage
      ? { error: { code: invocation.errorCode, message: invocation.errorMessage } }
      : {}),
    eventCursor: store.latestEventSequence(invocationId),
  });
}

function boundedSessionList(
  sessions: SparkSessionRegistryRecord[],
  cursor?: string,
  requestedLimit = maxSessionListRecords,
) {
  const start = cursor ? sessions.findIndex((session) => session.sessionId === cursor) + 1 : 0;
  if (cursor && start === 0) throw new Error("Session list cursor is no longer available.");
  const remaining = Math.max(0, sessions.length - start);
  let limit = Math.min(maxSessionListRecords, requestedLimit, remaining);
  while (limit > 0) {
    const records = sessions.slice(start, start + limit);
    const hasMore = start + limit < sessions.length;
    const page = {
      sessions: records,
      hasMore,
      ...(hasMore ? { nextCursor: records.at(-1)!.sessionId } : {}),
    };
    if (encodedBytes(page) <= maxSessionControlProjectionBytes) return page;
    limit = Math.floor(limit / 2);
  }
  if (remaining === 0) return { sessions: [], hasMore: false };
  throw new Error("Session registry record exceeds the bounded runtime projection limit.");
}

function boundedTurnStreamPage(
  store: SparkInvocationStore,
  invocationId: string,
  after: number,
  requestedLimit: number,
) {
  let limit = Math.min(maxTurnStreamEvents, requestedLimit);
  while (limit > 0) {
    const page = sparkTurnStreamPageSchema.parse(store.eventPage(invocationId, after, limit));
    if (encodedBytes(page) <= maxSessionControlProjectionBytes) return page;
    limit = Math.floor(limit / 2);
  }
  throw new Error("Invocation event exceeds the bounded runtime projection limit.");
}

function boundedSessionSnapshot(
  snapshot: SparkSessionView,
  request: { messageLimit?: number; beforeMessageId?: string },
) {
  const totalMessages = snapshot.messages.length;
  const end = request.beforeMessageId
    ? snapshot.messages.findIndex((message) => message.id === request.beforeMessageId)
    : totalMessages;
  if (end < 0) {
    throw new SparkSessionRegistryError(
      "session_snapshot_cursor_not_found",
      `session snapshot cursor is no longer available: ${request.beforeMessageId}`,
    );
  }
  let limit = Math.min(request.messageLimit ?? defaultSessionSnapshotMessages, end);
  while (limit > 0 || end === 0) {
    const start = Math.max(0, end - limit);
    const messages = snapshot.messages.slice(start, end);
    const toolCallIds = new Set(
      messages.flatMap((message) =>
        [
          message.toolCallId,
          ...(message.parts ?? []).map((part) =>
            "toolCallId" in part ? part.toolCallId : undefined,
          ),
        ].filter((value): value is string => Boolean(value)),
      ),
    );
    const projected = parseSparkSessionView({
      ...snapshot,
      messages,
      tools: snapshot.tools.filter((tool) => toolCallIds.has(tool.id)),
    });
    const result = sparkSessionSnapshotPageSchema.parse({
      snapshot: projected,
      history: {
        totalMessages,
        loadedMessages: messages.length,
        hiddenMessages: totalMessages - messages.length,
        earlierMessages: start,
        laterMessages: totalMessages - end,
        hasEarlierMessages: start > 0,
        ...(start > 0 && messages[0] ? { nextBeforeMessageId: messages[0].id } : {}),
      },
    });
    if (encodedBytes(result) <= maxSessionControlProjectionBytes) return result;
    if (limit === 1) break;
    limit = Math.floor(limit / 2);
  }
  throw new Error("Session snapshot page exceeds the bounded runtime projection limit.");
}

function projectPendingSessionTurns(
  db: DatabaseSync,
  snapshot: SparkSessionView,
): SparkSessionView {
  const pending = new SparkInvocationStore(db).listPendingForSession(snapshot.sessionId);
  const hasRunningTurn = pending.some((invocation) => invocation.status === "running");
  const hasQueuedTurn = pending.some((invocation) => invocation.status === "queued");
  const messages = pending.map((invocation) => ({
    id: `invocation:${invocation.invocationId}`,
    role: "user" as const,
    text: validateSparkDaemonTask(invocation.task).prompt,
    status: "done" as const,
    createdAt: invocation.createdAt,
    metadata: {
      source: "daemon.invocation",
      invocationId: invocation.invocationId,
      invocationStatus: invocation.status,
    },
  }));
  return parseSparkSessionView({
    ...snapshot,
    pendingTurns: pending.map((invocation) => ({
      invocationId: invocation.invocationId,
      prompt: validateSparkDaemonTask(invocation.task).prompt,
      status: invocation.status,
      createdAt: invocation.createdAt,
      ...(invocation.startedAt ? { startedAt: invocation.startedAt } : {}),
    })),
    status: hasRunningTurn
      ? "running"
      : hasQueuedTurn
        ? "queued"
        : snapshot.status === "running" ||
            snapshot.status === "streaming" ||
            snapshot.status === "queued"
          ? "idle"
          : snapshot.status,
    messages: [...snapshot.messages, ...messages],
    ...(messages.at(-1)?.createdAt
      ? { updatedAt: messages.at(-1)?.createdAt }
      : snapshot.updatedAt
        ? { updatedAt: snapshot.updatedAt }
        : {}),
  });
}

function projectSessionInvocationActivity(
  store: SparkInvocationStore,
  sessions: SparkSessionRegistryRecord[],
): SparkSessionRegistryRecord[] {
  const runningSessionIds = store.runningSessionIds();
  return sessions.map((session) =>
    session.status === "archived"
      ? session
      : {
          ...session,
          status: runningSessionIds.has(session.sessionId) ? "running" : "ready",
        },
  );
}

async function settleManagedSessionTurn(
  registry: DaemonSessionRegistry | undefined,
  sessionId: string,
): Promise<void> {
  try {
    await registry?.recordTurnSettled(sessionId);
  } catch (error) {
    console.error(`[spark-daemon] failed to settle session turn ${sessionId}`, error);
  }
}

function invocationSource(
  messageMetadata: Record<string, unknown> | undefined,
): { kind: string; ref?: string } | undefined {
  const mail = messageMetadata?.sessionMail;
  if (!mail || typeof mail !== "object" || Array.isArray(mail)) return undefined;
  const record = mail as Record<string, unknown>;
  if (record.kind !== "request" && record.kind !== "question") return undefined;
  return {
    kind: `session.${record.kind}`,
    ...(typeof record.messageId === "string" && record.messageId.trim()
      ? { ref: record.messageId.trim() }
      : {}),
  };
}

function isTerminalInvocationStatus(status: SparkInvocationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function publicObject(value: Record<string, unknown>): Record<string, SparkProtocolJsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, SparkProtocolJsonValue>;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
