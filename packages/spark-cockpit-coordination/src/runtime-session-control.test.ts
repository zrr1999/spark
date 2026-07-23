import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import {
  createId,
  runtimeProtocolVersion,
  sparkProtocolJsonObjectSchema,
  type RuntimeCommandResultPayload,
  type SparkSessionRegistryRecord,
} from "@zendev-lab/spark-protocol";
import { createWorkspaceWithOwnerBinding, recordInvocationUpdate } from "./projection-services.ts";
import {
  getRuntimeSessionProjection,
  getRuntimeTurnStatusProjection,
  getRuntimeTurnStreamProjection,
  listRuntimeSessionRoutes,
  reconcileRuntimeSessionListProjection,
  recordRuntimeSessionControlProjection,
  runRuntimeSessionControlCommand,
  runtimeSessionRouteForSession,
} from "./runtime-session-control.ts";
import {
  markRuntimeControlCommandDeliveryAttempt,
  recordRuntimeControlCommandResult,
  registerRuntimeControlDispatcher,
  requireRuntimeControlCommand,
  submitRuntimeControlCommand,
} from "./runtime-control.ts";

const now = "2026-07-15T00:00:00.000Z";

function setup() {
  const db = openMemoryDatabase();
  migrate(db);
  const runtimeId = createId("rt");
  const bindingId = createId("rtwb");
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
       created_at, updated_at)
     VALUES (?, 'install-session-control', 'Session daemon', 'online', ?, '{}', '{}', ?, ?)`,
  ).run(runtimeId, runtimeProtocolVersion, now, now);
  db.prepare(
    `INSERT INTO runtime_sessions
      (id, runtime_id, transport, status, connected_at, last_seen_at)
     VALUES (?, ?, 'websocket', 'connected', ?, ?)`,
  ).run(createId("rtsn"), runtimeId, now, now);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
       diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'session-control', 'Session workspace', 'available', '{}', '{}', ?, ?)`,
  ).run(bindingId, runtimeId, now, now);
  const workspace = createWorkspaceWithOwnerBinding(db, {
    slug: "session-control",
    name: "Session workspace",
    runtimeWorkspaceBindingId: bindingId,
    createdAt: now,
  });
  return { db, runtimeId, bindingId, workspaceId: workspace.id };
}

function workspaceSession(workspaceId: string): SparkSessionRegistryRecord {
  return {
    sessionId: createId("sess"),
    scope: { kind: "workspace", workspaceId },
    workspaceId,
    title: "Workspace session",
    status: "ready",
    bindings: [],
    createdAt: now,
    updatedAt: now,
  };
}

function daemonSession(): SparkSessionRegistryRecord {
  return {
    sessionId: createId("sess"),
    scope: { kind: "daemon", daemonId: "install-session-control" },
    title: "Daemon session",
    status: "ready",
    bindings: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("runtime session projections", () => {
  it("isolates daemon and active workspace owner routes", () => {
    const h = setup();
    const workspace = workspaceSession(h.workspaceId);
    const daemon = daemonSession();
    projectSession(h, workspace, "workspace");
    projectSession(h, daemon, "daemon");

    expect(listRuntimeSessionRoutes(h.db)).toEqual([
      { runtimeId: h.runtimeId, scope: "daemon" },
      {
        runtimeId: h.runtimeId,
        scope: "workspace",
        workspaceId: h.workspaceId,
        runtimeWorkspaceBindingId: h.bindingId,
      },
    ]);
    expect(runtimeSessionRouteForSession(h.db, workspace.sessionId)).toMatchObject({
      runtimeId: h.runtimeId,
      scope: "workspace",
      workspaceId: h.workspaceId,
      runtimeWorkspaceBindingId: h.bindingId,
    });
    expect(runtimeSessionRouteForSession(h.db, daemon.sessionId)).toEqual({
      runtimeId: h.runtimeId,
      scope: "daemon",
    });

    const mismatched = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      payload: {
        kind: "session.get.request",
        scope: "daemon",
        payload: { sessionId: workspace.sessionId },
      },
      sessionId: workspace.sessionId,
      createdAt: now,
    });
    expect(() =>
      recordResult(h, mismatched.commandId, {
        status: "succeeded",
        result: { session: publicValue(workspace) },
        projection: { kind: "session.detail", data: { session: publicValue(workspace) } },
        completedAt: now,
      }),
    ).toThrowError(/Daemon command returned a workspace session/u);
    expect(requireRuntimeControlCommand(h.db, mismatched.commandId).status).toBe("queued");
    expect(getRuntimeSessionProjection(h.db, workspace.sessionId)?.session).toEqual(workspace);
    h.db.close();
  });

  it("removes active workspace projections disproved by a complete daemon list", () => {
    const h = setup();
    const current = workspaceSession(h.workspaceId);
    const stale = { ...workspaceSession(h.workspaceId), title: "Stale route" };
    const archived = {
      ...workspaceSession(h.workspaceId),
      title: "Archived route",
      status: "archived" as const,
    };
    const daemon = daemonSession();
    projectSession(h, current, "workspace");
    projectSession(h, stale, "workspace");
    projectSession(h, archived, "workspace");
    projectSession(h, daemon, "daemon");

    const route = {
      runtimeId: h.runtimeId,
      scope: "workspace" as const,
      workspaceId: h.workspaceId,
      runtimeWorkspaceBindingId: h.bindingId,
    };
    const candidateSessionIds = [
      current.sessionId,
      stale.sessionId,
      archived.sessionId,
      daemon.sessionId,
    ];
    reconcileRuntimeSessionListProjection(h.db, route, [current], { candidateSessionIds });

    expect(getRuntimeSessionProjection(h.db, current.sessionId)?.session).toEqual(current);
    expect(getRuntimeSessionProjection(h.db, stale.sessionId)).toBeNull();
    expect(getRuntimeSessionProjection(h.db, archived.sessionId)?.session).toEqual(archived);
    expect(getRuntimeSessionProjection(h.db, daemon.sessionId)?.session).toEqual(daemon);

    reconcileRuntimeSessionListProjection(h.db, route, [current], {
      candidateSessionIds,
      includeArchived: true,
    });
    expect(getRuntimeSessionProjection(h.db, archived.sessionId)).toBeNull();
    h.db.close();
  });

  it("atomically projects bounded snapshots and invocation cursor pages", () => {
    const h = setup();
    const session = workspaceSession(h.workspaceId);
    projectSession(h, session, "workspace");

    const snapshotCommand = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      workspaceId: h.workspaceId,
      sessionId: session.sessionId,
      payload: {
        kind: "session.snapshot.request",
        scope: "workspace",
        payload: { sessionId: session.sessionId },
      },
      createdAt: now,
    });
    recordResult(h, snapshotCommand.commandId, {
      status: "succeeded",
      result: {},
      projection: {
        kind: "session.snapshot",
        data: {
          snapshot: {
            version: 1,
            sessionId: session.sessionId,
            status: "idle",
            messages: [
              {
                version: 1,
                id: "message-one",
                role: "user",
                text: "bounded",
                status: "done",
                metadata: {},
              },
            ],
            tools: [],
            runs: [],
            tasks: [],
            artifacts: [],
            metadata: {},
          },
          history: { totalMessages: 10_000, loadedMessages: 1, hiddenMessages: 9_999 },
        },
      },
      completedAt: "2026-07-15T00:00:01.000Z",
    });
    expect(getRuntimeSessionProjection(h.db, session.sessionId)).toMatchObject({
      history: { totalMessages: 10_000, loadedMessages: 1, hiddenMessages: 9_999 },
      snapshot: { messages: [{ id: "message-one" }] },
    });

    const submit = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      workspaceId: h.workspaceId,
      sessionId: session.sessionId,
      payload: {
        kind: "turn.submit.request",
        scope: "workspace",
        payload: { sessionId: session.sessionId, prompt: "run" },
      },
      createdAt: now,
    });
    const invocationId = createId("inv");
    recordResult(h, submit.commandId, {
      status: "succeeded",
      result: { invocationId, status: "queued", acceptedAt: now },
      completedAt: "2026-07-15T00:00:02.000Z",
    });

    const status = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      workspaceId: h.workspaceId,
      sessionId: session.sessionId,
      payload: {
        kind: "turn.status.request",
        scope: "workspace",
        payload: { invocationId },
      },
      createdAt: now,
    });
    recordResult(h, status.commandId, {
      status: "succeeded",
      result: {},
      projection: {
        kind: "turn.status",
        data: {
          invocationId,
          sessionId: session.sessionId,
          status: "running",
          createdAt: now,
          updatedAt: "2026-07-15T00:00:03.000Z",
          startedAt: "2026-07-15T00:00:03.000Z",
          eventCursor: 10_000,
        },
      },
      completedAt: "2026-07-15T00:00:03.000Z",
    });

    const stream = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      workspaceId: h.workspaceId,
      sessionId: session.sessionId,
      payload: {
        kind: "turn.stream.subscribe",
        scope: "workspace",
        payload: { invocationId, after: 9_998, limit: 2 },
      },
      createdAt: now,
    });
    const events = [9_999, 10_000].map((sequence) => ({
      invocationId,
      sequence,
      kind: sequence === 10_000 ? "invocation.succeeded" : "invocation.output",
      payload: { sequence },
      createdAt: "2026-07-15T00:00:04.000Z",
    }));
    const streamPayload: RuntimeCommandResultPayload = {
      status: "succeeded",
      result: {},
      projection: {
        kind: "turn.stream",
        data: { invocationId, events, nextCursor: 10_000, hasMore: false },
      },
      completedAt: "2026-07-15T00:00:04.000Z",
    };
    recordResult(h, stream.commandId, streamPayload);
    recordRuntimeSessionControlProjection(
      h.db,
      requireRuntimeControlCommand(h.db, stream.commandId),
      streamPayload,
    );

    expect(getRuntimeTurnStatusProjection(h.db, invocationId)).toMatchObject({
      invocationId,
      status: "running",
      eventCursor: 10_000,
    });
    const page = getRuntimeTurnStreamProjection(h.db, invocationId, 9_998, 100);
    expect(page).toMatchObject({
      invocationId,
      nextCursor: 10_000,
      hasMore: false,
      events: [{ sequence: 9_999 }, { sequence: 10_000 }],
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024 * 1024);
    expect(
      h.db
        .prepare(
          `SELECT COUNT(*) AS count FROM runtime_invocation_event_projections
           WHERE runtime_invocation_id = ? AND sequence = 10000`,
        )
        .get(invocationId),
    ).toEqual({ count: 1 });
    h.db.close();
  });

  it("does not let an older cursor page replace the canonical latest snapshot", () => {
    const h = setup();
    const session = workspaceSession(h.workspaceId);
    projectSession(h, session, "workspace");

    const latestCommand = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      workspaceId: h.workspaceId,
      sessionId: session.sessionId,
      payload: {
        kind: "session.snapshot.request",
        scope: "workspace",
        payload: { sessionId: session.sessionId },
      },
      createdAt: now,
    });
    recordResult(h, latestCommand.commandId, {
      status: "succeeded",
      result: {},
      projection: {
        kind: "session.snapshot",
        data: {
          snapshot: {
            version: 1,
            sessionId: session.sessionId,
            status: "idle",
            messages: [
              {
                version: 1,
                id: "latest-message",
                role: "user",
                text: "latest",
                status: "done",
                metadata: {},
              },
            ],
            tools: [],
            runs: [],
            tasks: [],
            artifacts: [],
            metadata: {},
          },
          history: {
            totalMessages: 3,
            loadedMessages: 1,
            hiddenMessages: 2,
            earlierMessages: 2,
            laterMessages: 0,
            hasEarlierMessages: true,
            nextBeforeMessageId: "latest-message",
          },
        },
      },
      completedAt: "2026-07-15T00:00:01.000Z",
    });

    const olderCommand = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      workspaceId: h.workspaceId,
      sessionId: session.sessionId,
      payload: {
        kind: "session.snapshot.request",
        scope: "workspace",
        payload: { sessionId: session.sessionId, beforeMessageId: "latest-message" },
      },
      createdAt: now,
    });
    recordResult(h, olderCommand.commandId, {
      status: "succeeded",
      result: {},
      projection: {
        kind: "session.snapshot",
        data: {
          snapshot: {
            version: 1,
            sessionId: session.sessionId,
            status: "idle",
            messages: [
              {
                version: 1,
                id: "older-message",
                role: "user",
                text: "older",
                status: "done",
                metadata: {},
              },
            ],
            tools: [],
            runs: [],
            tasks: [],
            artifacts: [],
            metadata: {},
          },
          history: {
            totalMessages: 3,
            loadedMessages: 1,
            hiddenMessages: 2,
            earlierMessages: 1,
            laterMessages: 1,
            hasEarlierMessages: true,
            nextBeforeMessageId: "older-message",
          },
        },
      },
      completedAt: "2026-07-15T00:00:02.000Z",
    });

    expect(getRuntimeSessionProjection(h.db, session.sessionId)).toMatchObject({
      snapshot: { messages: [{ id: "latest-message", text: "latest" }] },
      history: { totalMessages: 3, loadedMessages: 1, hiddenMessages: 2 },
      projectedAt: "2026-07-15T00:00:01.000Z",
    });
    h.db.close();
  });

  it("keeps direct invocation projections synchronized with runtime lifecycle updates", () => {
    const h = setup();
    const session = workspaceSession(h.workspaceId);
    projectSession(h, session, "workspace");
    const submit = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      workspaceId: h.workspaceId,
      sessionId: session.sessionId,
      payload: {
        kind: "turn.submit.request",
        scope: "workspace",
        payload: { sessionId: session.sessionId, prompt: "fail durably" },
      },
      createdAt: now,
    });
    const invocationId = createId("inv");
    recordResult(h, submit.commandId, {
      status: "succeeded",
      result: { invocationId, status: "queued", acceptedAt: now },
      completedAt: "2026-07-15T00:00:01.000Z",
    });

    recordInvocationUpdate(h.db, {
      runtimeWorkspaceBindingId: h.bindingId,
      workspaceId: h.workspaceId,
      payload: {
        runtimeInvocationId: invocationId,
        sequence: 4,
        status: "failed",
        completedAt: "2026-07-15T00:00:04.000Z",
        terminalReason: "Provider connection failed.",
        payload: { source: "daemon.lifecycle" },
      },
      updatedAt: "2026-07-15T00:00:04.000Z",
    });

    expect(getRuntimeTurnStatusProjection(h.db, invocationId)).toMatchObject({
      invocationId,
      sessionId: session.sessionId,
      status: "failed",
      eventCursor: 4,
      finishedAt: "2026-07-15T00:00:04.000Z",
      cancelReason: "Provider connection failed.",
    });
    expect(
      h.db
        .prepare(
          `SELECT command_id AS commandId, payload_json AS payloadJson
           FROM runtime_invocation_projections
           WHERE runtime_id = ? AND runtime_invocation_id = ?`,
        )
        .get(h.runtimeId, invocationId),
    ).toEqual({
      commandId: submit.commandId,
      payloadJson: JSON.stringify({ source: "daemon.lifecycle" }),
    });

    recordInvocationUpdate(h.db, {
      runtimeWorkspaceBindingId: h.bindingId,
      workspaceId: h.workspaceId,
      payload: {
        runtimeInvocationId: invocationId,
        sequence: 3,
        status: "running",
        startedAt: "2026-07-15T00:00:03.000Z",
        payload: { stale: true },
      },
      updatedAt: "2026-07-15T00:00:05.000Z",
    });

    expect(getRuntimeTurnStatusProjection(h.db, invocationId)).toMatchObject({
      status: "failed",
      eventCursor: 4,
      finishedAt: "2026-07-15T00:00:04.000Z",
      cancelReason: "Provider connection failed.",
    });
    h.db.close();
  });

  it("does not regress a lifecycle update when the queued admission result arrives late", () => {
    const h = setup();
    const session = workspaceSession(h.workspaceId);
    projectSession(h, session, "workspace");
    const submit = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      workspaceId: h.workspaceId,
      sessionId: session.sessionId,
      payload: {
        kind: "turn.submit.request",
        scope: "workspace",
        payload: { sessionId: session.sessionId, prompt: "finish before admission ack" },
      },
      createdAt: now,
    });
    const invocationId = createId("inv");

    recordInvocationUpdate(h.db, {
      runtimeWorkspaceBindingId: h.bindingId,
      workspaceId: h.workspaceId,
      payload: {
        runtimeInvocationId: invocationId,
        sequence: 4,
        status: "succeeded",
        startedAt: "2026-07-15T00:00:02.000Z",
        completedAt: "2026-07-15T00:00:04.000Z",
        payload: { source: "daemon.lifecycle" },
      },
      updatedAt: "2026-07-15T00:00:04.000Z",
    });
    recordResult(h, submit.commandId, {
      status: "succeeded",
      result: { invocationId, status: "queued", acceptedAt: now },
      completedAt: "2026-07-15T00:00:05.000Z",
    });

    expect(getRuntimeTurnStatusProjection(h.db, invocationId)).toMatchObject({
      status: "succeeded",
      eventCursor: 4,
      startedAt: "2026-07-15T00:00:02.000Z",
      finishedAt: "2026-07-15T00:00:04.000Z",
    });
    expect(
      h.db
        .prepare(
          `SELECT command_id AS commandId
           FROM runtime_invocation_projections
           WHERE runtime_id = ? AND runtime_invocation_id = ?`,
        )
        .get(h.runtimeId, invocationId),
    ).toEqual({ commandId: submit.commandId });
    h.db.close();
  });

  it("retries an ambiguous turn submit with one durable command and idempotency key", async () => {
    const h = setup();
    const invocationId = createId("inv");
    const deliveries: Array<{ commandId: string; idempotencyKey: string | null }> = [];
    const unregister = registerRuntimeControlDispatcher(h.db, h.runtimeId, () => {
      const row = h.db
        .prepare(
          `SELECT id AS commandId, idempotency_key AS idempotencyKey
           FROM runtime_control_commands ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { commandId: string; idempotencyKey: string | null };
      deliveries.push(row);
      if (deliveries.length === 1) {
        markRuntimeControlCommandDeliveryAttempt(h.db, {
          commandId: row.commandId,
          runtimeId: h.runtimeId,
          sent: true,
        });
        return;
      }
      recordRuntimeControlCommandResult(h.db, {
        runtimeId: h.runtimeId,
        commandId: row.commandId,
        messageId: createId("msg"),
        payload: {
          status: "succeeded",
          result: { invocationId, status: "queued", acceptedAt: now },
          completedAt: now,
        },
      });
    });

    try {
      await expect(
        runRuntimeSessionControlCommand(h.db, {
          route: {
            runtimeId: h.runtimeId,
            scope: "workspace",
            workspaceId: h.workspaceId,
            runtimeWorkspaceBindingId: h.bindingId,
          },
          sessionId: "sess_retry",
          payload: {
            kind: "turn.submit.request",
            payload: { sessionId: "sess_retry", prompt: "retry exactly once" },
          },
          timeoutMs: 5,
        }),
      ).resolves.toMatchObject({ invocationId, status: "queued" });
      expect(deliveries).toHaveLength(2);
      expect(deliveries[0]?.commandId).toBe(deliveries[1]?.commandId);
      expect(deliveries[0]?.idempotencyKey).toMatch(/^idem_[a-f0-9]{32}$/u);
      expect(deliveries[1]?.idempotencyKey).toBe(deliveries[0]?.idempotencyKey);
      expect(h.db.prepare("SELECT COUNT(*) AS count FROM runtime_control_commands").get()).toEqual({
        count: 1,
      });
    } finally {
      unregister();
      h.db.close();
    }
  });
});

function projectSession(
  h: ReturnType<typeof setup>,
  session: SparkSessionRegistryRecord,
  scope: "daemon" | "workspace",
): void {
  const command = submitRuntimeControlCommand(h.db, {
    runtimeId: h.runtimeId,
    ...(scope === "workspace" ? { workspaceId: h.workspaceId } : {}),
    sessionId: session.sessionId,
    payload: {
      kind: "session.create.request",
      scope,
      payload: { scope: session.scope, sessionId: session.sessionId },
    },
    createdAt: now,
  });
  recordResult(h, command.commandId, {
    status: "succeeded",
    result: { session: publicValue(session) },
    projection: { kind: "session.detail", data: { session: publicValue(session) } },
    completedAt: now,
  });
}

function publicValue(value: unknown) {
  return sparkProtocolJsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
}

function recordResult(
  h: ReturnType<typeof setup>,
  commandId: string,
  payload: RuntimeCommandResultPayload,
): void {
  recordRuntimeControlCommandResult(h.db, {
    runtimeId: h.runtimeId,
    commandId,
    messageId: createId("msg"),
    payload,
    project: (command, result) => recordRuntimeSessionControlProjection(h.db, command, result),
  });
}
