import type { DatabaseSync } from "node:sqlite";

import {
  getRuntimeSessionProjection,
  listRuntimeSessionProjections,
  listRuntimeSessionRoutes,
  reconcileRuntimeSessionListProjection,
  runRuntimeSessionControlCommand,
  runtimeSessionRouteForRuntime,
  runtimeSessionRouteForSession,
  runtimeSessionRouteForWorkspace,
  type RuntimeSessionRoute,
} from "@zendev-lab/spark-coordination/runtime-session-control";
import { RuntimeControlCommandError } from "@zendev-lab/spark-coordination/runtime-control";
import {
  parseSparkSessionRegistryRecord,
  parseSparkSessionRegistryRecords,
  sparkSessionCreateRequestSchema,
  sparkSessionListRequestSchema,
  sparkSessionSnapshotRequestSchema,
  sparkProtocolJsonObjectSchema,
  sparkTurnCancelResultSchema,
  sparkTurnStatusResultSchema,
  sparkTurnStreamPageSchema,
  sparkTurnSubmitResultSchema,
  type SparkAssignment,
  type SparkSessionBindRequest,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  type SparkSessionRegistryRecord,
  type SparkSessionSnapshotRequest,
  type SparkTurnCancelResult,
  type SparkTurnStatusResult,
  type SparkTurnStreamPage,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import {
  parseSessionSnapshotWindow,
  type SessionSnapshotWindow,
} from "../session-snapshot-window.ts";

import { getDatabase } from "./db.ts";

export type CockpitRuntimeSessionListRequest = SparkSessionListRequest & {
  runtimeId?: string;
};

export type CockpitRuntimeSessionCreateRequest = SparkSessionCreateRequest & {
  runtimeId?: string;
  idempotencyKey?: string;
};

export type CockpitRuntimeSessionSnapshotRequest = Omit<SparkSessionSnapshotRequest, "sessionId">;

export interface CockpitRuntimeSessionListResult {
  sessions: SparkSessionRegistryRecord[];
  /** True when a live owner route can accept control commands. */
  controlAvailable: boolean;
}

export interface CockpitRuntimeSessionClient {
  listWithControlState(
    options?: CockpitRuntimeSessionListRequest,
  ): Promise<CockpitRuntimeSessionListResult>;
  list(options?: CockpitRuntimeSessionListRequest): Promise<SparkSessionRegistryRecord[]>;
  get(sessionId: string): Promise<SparkSessionRegistryRecord>;
  snapshot(
    sessionId: string,
    options?: CockpitRuntimeSessionSnapshotRequest,
  ): Promise<SessionSnapshotWindow>;
  create(input: CockpitRuntimeSessionCreateRequest): Promise<SparkSessionRegistryRecord>;
  bind(input: SparkSessionBindRequest): Promise<SparkSessionRegistryRecord>;
  unbind(input: SparkSessionBindRequest): Promise<SparkSessionRegistryRecord>;
  archive(sessionId: string): Promise<SparkSessionRegistryRecord>;
  submit(input: {
    sessionId: string;
    prompt: string;
    assignment: SparkAssignment;
    messageMetadata?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<SparkTurnSubmitResult>;
  cancel(input: {
    sessionId: string;
    invocationId: string;
    reason?: string;
  }): Promise<SparkTurnCancelResult>;
  status(input: { sessionId: string; invocationId: string }): Promise<SparkTurnStatusResult>;
  stream(input: {
    sessionId: string;
    invocationId: string;
    after?: number;
    limit?: number;
  }): Promise<SparkTurnStreamPage>;
}

export class CockpitRuntimeSessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CockpitRuntimeSessionUnavailableError";
  }
}

export function isCockpitRuntimeSessionNotFoundError(error: unknown): boolean {
  return (
    error instanceof RuntimeControlCommandError &&
    (error.reasonCode === "SESSION_NOT_FOUND" ||
      error.reasonCode === "session_not_found" ||
      error.reasonCode === "session_scope_mismatch")
  );
}

export function createCockpitRuntimeSessionClient(
  injectedDatabase?: DatabaseSync,
): CockpitRuntimeSessionClient {
  const database = () => injectedDatabase ?? getDatabase();
  return {
    listWithControlState: async (options) =>
      await listSessionsWithControlState(database(), options),
    list: async (options) => (await listSessionsWithControlState(database(), options)).sessions,
    get: async (sessionId) => await getSession(database(), sessionId),
    snapshot: async (sessionId, options) =>
      await getSessionSnapshot(database(), sessionId, options),
    create: async (input) => await createSession(database(), input),
    bind: async (input) => await bindSession(database(), input),
    unbind: async (input) => await unbindSession(database(), input),
    archive: async (sessionId) => await archiveSession(database(), sessionId),
    submit: async (input) => await submitTurn(database(), input),
    cancel: async (input) => await cancelTurn(database(), input),
    status: async (input) => await getTurnStatus(database(), input),
    stream: async (input) => await getTurnStream(database(), input),
  };
}

async function listSessionsWithControlState(
  db: DatabaseSync,
  options: CockpitRuntimeSessionListRequest = {},
): Promise<CockpitRuntimeSessionListResult> {
  const { runtimeId, ...request } = options;
  const parsed = sparkSessionListRequestSchema.parse(request);
  let routes: RuntimeSessionRoute[];
  try {
    routes = routesForList(db, parsed, runtimeId);
  } catch (error) {
    const stale = projectedSessions(db, parsed, runtimeId);
    if (stale.length > 0) return { sessions: stale, controlAvailable: false };
    throw unavailableFrom(error);
  }
  if (routes.length === 0) {
    const stale = projectedSessions(db, parsed, runtimeId);
    if (stale.length > 0) return { sessions: stale, controlAvailable: false };
    throw new CockpitRuntimeSessionUnavailableError(
      "No connected Spark daemon runtime is available for session control.",
    );
  }

  const results = await Promise.allSettled(
    routes.map((route) => listRouteSessions(db, route, parsed)),
  );
  if (results.every((result) => result.status === "rejected")) {
    const stale = projectedSessions(db, parsed, runtimeId);
    // Only an explicit response timeout preserves the connected owner's
    // control state. Protocol, authorization, and routing failures must fail
    // closed instead of turning a stale projection into a writable surface.
    if (shouldRetainControlForStaleProjection(results, stale.length > 0)) {
      return { sessions: stale, controlAvailable: true };
    }
    throw unavailableFrom(results[0]!.reason);
  }
  return {
    sessions: projectedSessions(db, parsed, runtimeId),
    controlAvailable: results.some((result) => result.status === "fulfilled"),
  };
}

export function shouldRetainControlForStaleProjection(
  results: PromiseSettledResult<unknown>[],
  hasStaleProjection: boolean,
): boolean {
  return (
    hasStaleProjection &&
    results.length > 0 &&
    results.every(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof RuntimeControlCommandError &&
        result.reason.reasonCode === "COMMAND_RESULT_TIMEOUT",
    )
  );
}

async function listRouteSessions(
  db: DatabaseSync,
  route: RuntimeSessionRoute,
  request: ReturnType<typeof sparkSessionListRequestSchema.parse>,
): Promise<SparkSessionRegistryRecord[]> {
  const candidateSessionIds = listRuntimeSessionProjections(db, {
    runtimeId: route.runtimeId,
    scope: route.scope,
    ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
    includeArchived: true,
  }).map((projection) => projection.session.sessionId);
  const sessions: SparkSessionRegistryRecord[] = [];
  let cursor: string | undefined;
  while (true) {
    const result = await runRuntimeSessionControlCommand(db, {
      route,
      payload: {
        kind: "session.list.request",
        payload: {
          scope:
            route.scope === "workspace"
              ? { kind: "workspace", workspaceId: route.workspaceId! }
              : { kind: "daemon" },
          ...(request.includeArchived !== undefined
            ? { includeArchived: request.includeArchived }
            : {}),
          ...(cursor ? { cursor } : {}),
          limit: 100,
        },
      },
    });
    const page = parseSessionListPage(result);
    sessions.push(...page.sessions);
    if (!page.hasMore) {
      reconcileRuntimeSessionListProjection(db, route, sessions, {
        candidateSessionIds,
        includeArchived: request.includeArchived,
      });
      return sessions;
    }
    if (!page.nextCursor || page.nextCursor === cursor) {
      throw new RuntimeControlCommandError(
        "Spark daemon returned an invalid session list cursor.",
        "SESSION_LIST_CURSOR_INVALID",
      );
    }
    cursor = page.nextCursor;
  }
}

function parseSessionListPage(value: Record<string, unknown>): {
  sessions: SparkSessionRegistryRecord[];
  hasMore: boolean;
  nextCursor?: string;
} {
  const sessions = parseSparkSessionRegistryRecords(value.sessions);
  if (typeof value.hasMore !== "boolean") {
    throw new RuntimeControlCommandError(
      "Spark daemon returned an invalid session list page.",
      "SESSION_LIST_PAGE_INVALID",
    );
  }
  if (value.nextCursor !== undefined && typeof value.nextCursor !== "string") {
    throw new RuntimeControlCommandError(
      "Spark daemon returned an invalid session list cursor.",
      "SESSION_LIST_CURSOR_INVALID",
    );
  }
  return {
    sessions,
    hasMore: value.hasMore,
    ...(typeof value.nextCursor === "string" ? { nextCursor: value.nextCursor } : {}),
  };
}

async function getSession(
  db: DatabaseSync,
  sessionId: string,
): Promise<SparkSessionRegistryRecord> {
  let projection = getRuntimeSessionProjection(db, sessionId);
  if (!projection) {
    await listSessionsWithControlState(db, { includeArchived: true });
    projection = getRuntimeSessionProjection(db, sessionId);
  }
  if (!projection) {
    throw new RuntimeControlCommandError("Session projection was not found.", "SESSION_NOT_FOUND");
  }
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, sessionId));
  await runRuntimeSessionControlCommand(db, {
    route,
    sessionId,
    payload: { kind: "session.get.request", payload: { sessionId } },
  });
  return requireProjectedSession(db, sessionId).session;
}

async function getSessionSnapshot(
  db: DatabaseSync,
  sessionId: string,
  options: CockpitRuntimeSessionSnapshotRequest = {},
): Promise<SessionSnapshotWindow> {
  const request = sparkSessionSnapshotRequestSchema.parse({ sessionId, ...options });
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId,
    payload: { kind: "session.snapshot.request", payload: publicJsonObject(request) },
  });
  // The projection table intentionally stores only the display snapshot. Page
  // counts and cursors live in the exact command result and must not be rebuilt
  // from an already bounded view.
  return parseSessionSnapshotWindow(result);
}

async function createSession(
  db: DatabaseSync,
  input: CockpitRuntimeSessionCreateRequest,
): Promise<SparkSessionRegistryRecord> {
  const { runtimeId, idempotencyKey, ...request } = input;
  const parsed = sparkSessionCreateRequestSchema.parse(request);
  const route = requireOnlineRoute(
    db,
    parsed.scope.kind === "workspace"
      ? runtimeSessionRouteForWorkspace(db, parsed.scope.workspaceId)
      : runtimeSessionRouteForRuntime(runtimeId ?? ""),
  );
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: parsed.sessionId,
    idempotencyKey,
    payload: { kind: "session.create.request", payload: publicJsonObject(parsed) },
  });
  const created = parseSparkSessionRegistryRecord(result.session);
  return requireProjectedSession(db, created.sessionId).session;
}

async function bindSession(
  db: DatabaseSync,
  input: SparkSessionBindRequest,
): Promise<SparkSessionRegistryRecord> {
  return await mutateSession(db, "session.bind.request", input);
}

async function unbindSession(
  db: DatabaseSync,
  input: SparkSessionBindRequest,
): Promise<SparkSessionRegistryRecord> {
  return await mutateSession(db, "session.unbind.request", input);
}

async function archiveSession(
  db: DatabaseSync,
  sessionId: string,
): Promise<SparkSessionRegistryRecord> {
  return await mutateSession(db, "session.archive.request", { sessionId });
}

async function mutateSession(
  db: DatabaseSync,
  kind: "session.bind.request" | "session.unbind.request" | "session.archive.request",
  input: SparkSessionBindRequest | { sessionId: string },
): Promise<SparkSessionRegistryRecord> {
  const sessionId = input.sessionId.trim();
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, sessionId));
  await runRuntimeSessionControlCommand(db, {
    route,
    sessionId,
    payload: { kind, payload: input },
  });
  return requireProjectedSession(db, sessionId).session;
}

async function submitTurn(
  db: DatabaseSync,
  input: {
    sessionId: string;
    prompt: string;
    assignment: SparkAssignment;
    messageMetadata?: Record<string, unknown>;
    idempotencyKey?: string;
  },
): Promise<SparkTurnSubmitResult> {
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, input.sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    payload: {
      kind: "turn.submit.request",
      payload: {
        sessionId: input.sessionId,
        prompt: input.prompt,
        assignment: input.assignment,
        ...(input.messageMetadata
          ? { messageMetadata: publicJsonObject(input.messageMetadata) }
          : {}),
      },
    },
  });
  return sparkTurnSubmitResultSchema.parse(result);
}

async function cancelTurn(
  db: DatabaseSync,
  input: {
    sessionId: string;
    invocationId: string;
    reason?: string;
  },
): Promise<SparkTurnCancelResult> {
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, input.sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: input.sessionId,
    payload: {
      kind: "turn.cancel.request",
      payload: {
        invocationId: input.invocationId,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    },
  });
  return sparkTurnCancelResultSchema.parse(result);
}

async function getTurnStatus(
  db: DatabaseSync,
  input: {
    sessionId: string;
    invocationId: string;
  },
): Promise<SparkTurnStatusResult> {
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, input.sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: input.sessionId,
    payload: {
      kind: "turn.status.request",
      payload: { invocationId: input.invocationId },
    },
  });
  return sparkTurnStatusResultSchema.parse(result);
}

async function getTurnStream(
  db: DatabaseSync,
  input: {
    sessionId: string;
    invocationId: string;
    after?: number;
    limit?: number;
  },
): Promise<SparkTurnStreamPage> {
  const route = requireOnlineRoute(db, runtimeSessionRouteForSession(db, input.sessionId));
  const result = await runRuntimeSessionControlCommand(db, {
    route,
    sessionId: input.sessionId,
    payload: {
      kind: "turn.stream.subscribe",
      payload: {
        invocationId: input.invocationId,
        after: input.after ?? 0,
        limit: input.limit ?? 100,
      },
    },
  });
  return sparkTurnStreamPageSchema.parse(result);
}

function routesForList(
  db: DatabaseSync,
  request: ReturnType<typeof sparkSessionListRequestSchema.parse>,
  runtimeId?: string,
): RuntimeSessionRoute[] {
  if (request.scope?.kind === "workspace") {
    return [requireOnlineRoute(db, runtimeSessionRouteForWorkspace(db, request.scope.workspaceId))];
  }
  if (request.scope?.kind === "daemon") {
    return [requireOnlineRoute(db, runtimeSessionRouteForRuntime(runtimeId ?? ""))];
  }
  return listRuntimeSessionRoutes(db).filter((route) => route.scope === "workspace");
}

function projectedSessions(
  db: DatabaseSync,
  request: ReturnType<typeof sparkSessionListRequestSchema.parse>,
  runtimeId?: string,
): SparkSessionRegistryRecord[] {
  return parseSparkSessionRegistryRecords(
    listRuntimeSessionProjections(db, {
      ...(runtimeId ? { runtimeId } : {}),
      ...(request.scope?.kind === "workspace"
        ? { scope: "workspace" as const, workspaceId: request.scope.workspaceId }
        : request.scope?.kind === "daemon"
          ? { scope: "daemon" as const }
          : { scope: "workspace" as const }),
      includeArchived: request.includeArchived,
    }).map(({ session }) => session),
  );
}

function requireProjectedSession(
  db: DatabaseSync,
  sessionId: string,
): NonNullable<ReturnType<typeof getRuntimeSessionProjection>> {
  const projected = getRuntimeSessionProjection(db, sessionId);
  if (!projected) {
    throw new RuntimeControlCommandError(
      "Spark daemon completed the command without a session projection.",
      "SESSION_PROJECTION_MISSING",
    );
  }
  return projected;
}

function requireOnlineRoute(db: DatabaseSync, route: RuntimeSessionRoute): RuntimeSessionRoute {
  const online = listRuntimeSessionRoutes(db).some(
    (candidate) =>
      candidate.runtimeId === route.runtimeId &&
      candidate.scope === route.scope &&
      candidate.workspaceId === route.workspaceId,
  );
  if (!online) {
    throw new CockpitRuntimeSessionUnavailableError(
      route.scope === "workspace"
        ? "The workspace owner daemon is not connected to Cockpit."
        : "The selected Spark daemon runtime is not connected to Cockpit.",
    );
  }
  return route;
}

function publicJsonObject(value: unknown) {
  return sparkProtocolJsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
}

function unavailableFrom(error: unknown): CockpitRuntimeSessionUnavailableError {
  return new CockpitRuntimeSessionUnavailableError(
    error instanceof Error ? error.message : "Spark daemon session control is unavailable.",
  );
}
