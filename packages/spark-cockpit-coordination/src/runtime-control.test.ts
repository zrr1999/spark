import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import { createWorkspaceWithOwnerBinding, unbindWorkspaceOwner } from "./projection-services.ts";
import {
  markRuntimeControlCommandDeliveryAttempt,
  pendingRuntimeControlCommands,
  recordRuntimeControlCommandAck,
  recordRuntimeControlCommandResult,
  recoverUnacknowledgedRuntimeControlCommands,
  requireRuntimeControlCommand,
  RuntimeControlCommandError,
  submitRuntimeControlCommand,
} from "./runtime-control.ts";

function setup() {
  const db = openMemoryDatabase();
  migrate(db);
  const now = "2026-07-15T00:00:00.000Z";
  const runtimeId = createId("rt");
  const bindingId = createId("rtwb");
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
       created_at, updated_at)
     VALUES (?, 'install-control', 'Control daemon', 'online', ?, '{}', '{}', ?, ?)`,
  ).run(runtimeId, runtimeProtocolVersion, now, now);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
       diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'control-local', 'Control workspace', 'available', '{}', '{}', ?, ?)`,
  ).run(bindingId, runtimeId, now, now);
  const workspace = createWorkspaceWithOwnerBinding(db, {
    slug: "control-workspace",
    name: "Control workspace",
    runtimeWorkspaceBindingId: bindingId,
    createdAt: now,
  });
  return { db, now, runtimeId, bindingId, workspaceId: workspace.id };
}

describe("runtime control command outbox", () => {
  it("queues typed daemon and workspace commands with idempotent replay", () => {
    const h = setup();
    const idempotencyKey = createId("idem");
    const daemon = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      idempotencyKey,
      payload: { kind: "daemon.status.request", scope: "daemon" },
      createdAt: h.now,
    });
    const repeated = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      idempotencyKey,
      payload: { kind: "daemon.status.request", scope: "daemon" },
      createdAt: h.now,
    });
    const workspace = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      workspaceId: h.workspaceId,
      payload: { kind: "workspace.snapshot.request", scope: "workspace" },
      createdAt: h.now,
    });

    expect(repeated.commandId).toBe(daemon.commandId);
    expect(daemon).toMatchObject({ scope: "daemon", status: "queued", attemptCount: 0 });
    expect(workspace).toMatchObject({
      scope: "workspace",
      workspaceId: h.workspaceId,
      runtimeWorkspaceBindingId: h.bindingId,
    });
    expect(pendingRuntimeControlCommands(h.db, h.runtimeId)).toHaveLength(2);
    h.db.close();
  });

  it("does not deliver queued workspace commands after the owner projection is unbound", () => {
    const h = setup();
    const daemon = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      payload: { kind: "daemon.status.request", scope: "daemon" },
      createdAt: h.now,
    });
    submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      workspaceId: h.workspaceId,
      payload: { kind: "workspace.snapshot.request", scope: "workspace" },
      createdAt: h.now,
    });

    unbindWorkspaceOwner(h.db, {
      workspaceId: h.workspaceId,
      expectedRuntimeWorkspaceBindingId: h.bindingId,
      endedAt: "2026-07-15T00:01:00.000Z",
    });

    expect(pendingRuntimeControlCommands(h.db, h.runtimeId)).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({ commandId: daemon.commandId }),
      }),
    ]);
    h.db.close();
  });

  it("redelivers unacknowledged commands and converges to one terminal result", () => {
    const h = setup();
    const command = submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      idempotencyKey: createId("idem"),
      payload: { kind: "daemon.status.request", scope: "daemon" },
      createdAt: h.now,
    });
    markRuntimeControlCommandDeliveryAttempt(h.db, {
      commandId: command.commandId,
      runtimeId: h.runtimeId,
      sent: true,
      attemptedAt: "2026-07-15T00:00:01.000Z",
    });
    expect(requireRuntimeControlCommand(h.db, command.commandId)).toMatchObject({
      status: "delivered",
      attemptCount: 1,
    });

    recordRuntimeControlCommandAck(h.db, {
      runtimeId: h.runtimeId,
      commandId: command.commandId,
      payload: { accepted: true },
      acknowledgedAt: "2026-07-15T00:00:01.500Z",
    });
    expect(requireRuntimeControlCommand(h.db, command.commandId).status).toBe("accepted");
    expect(
      recoverUnacknowledgedRuntimeControlCommands(h.db, h.runtimeId, "2026-07-15T00:00:02.000Z"),
    ).toBe(1);
    markRuntimeControlCommandDeliveryAttempt(h.db, {
      commandId: command.commandId,
      runtimeId: h.runtimeId,
      sent: true,
      attemptedAt: "2026-07-15T00:00:03.000Z",
    });
    recordRuntimeControlCommandAck(h.db, {
      runtimeId: h.runtimeId,
      commandId: command.commandId,
      payload: { accepted: true },
      acknowledgedAt: "2026-07-15T00:00:04.000Z",
    });
    const result = {
      status: "succeeded" as const,
      result: { invocations: { running: 0 } },
      projection: { kind: "daemon.status" as const, data: { online: true } },
      completedAt: "2026-07-15T00:00:05.000Z",
    };
    recordRuntimeControlCommandResult(h.db, {
      runtimeId: h.runtimeId,
      commandId: command.commandId,
      messageId: "msg_00000000000000000000000000000001",
      payload: result,
    });
    recordRuntimeControlCommandResult(h.db, {
      runtimeId: h.runtimeId,
      commandId: command.commandId,
      messageId: "msg_00000000000000000000000000000001",
      payload: result,
    });

    expect(requireRuntimeControlCommand(h.db, command.commandId)).toMatchObject({
      status: "succeeded",
      attemptCount: 2,
      result,
    });
    expect(
      h.db
        .prepare(
          `SELECT COUNT(*) AS count FROM events
           WHERE kind = 'runtime.control.result' AND subject_id = ?`,
        )
        .get(command.commandId),
    ).toEqual({ count: 1 });
    h.db.close();
  });

  it("rejects invalid runtime/workspace routes and idempotency conflicts", () => {
    const h = setup();
    const otherRuntimeId = createId("rt");
    h.db
      .prepare(
        `INSERT INTO runtime_connections
        (id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, 'Other', 'online', ?, '{}', '{}', ?, ?)`,
      )
      .run(otherRuntimeId, runtimeProtocolVersion, h.now, h.now);

    expectRuntimeControlError(
      () =>
        submitRuntimeControlCommand(h.db, {
          runtimeId: otherRuntimeId,
          workspaceId: h.workspaceId,
          payload: { kind: "workspace.snapshot.request", scope: "workspace" },
        }),
      "WORKSPACE_ROUTE_INVALID",
    );
    expectRuntimeControlError(
      () =>
        submitRuntimeControlCommand(h.db, {
          runtimeId: h.runtimeId,
          workspaceId: h.workspaceId,
          payload: { kind: "daemon.status.request", scope: "daemon" },
        }),
      "COMMAND_SCOPE_INVALID",
    );

    const conflictingKey = createId("idem");
    submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      idempotencyKey: conflictingKey,
      payload: { kind: "daemon.status.request", scope: "daemon" },
    });
    expectRuntimeControlError(
      () =>
        submitRuntimeControlCommand(h.db, {
          runtimeId: h.runtimeId,
          idempotencyKey: conflictingKey,
          workspaceId: h.workspaceId,
          payload: { kind: "workspace.snapshot.request", scope: "workspace" },
        }),
      "IDEMPOTENCY_CONFLICT",
    );
    const sessionKey = createId("idem");
    const invocationId = createId("inv");
    submitRuntimeControlCommand(h.db, {
      runtimeId: h.runtimeId,
      idempotencyKey: sessionKey,
      sessionId: createId("sess"),
      payload: {
        kind: "turn.cancel.request",
        scope: "daemon",
        payload: { invocationId },
      },
    });
    expectRuntimeControlError(
      () =>
        submitRuntimeControlCommand(h.db, {
          runtimeId: h.runtimeId,
          idempotencyKey: sessionKey,
          sessionId: createId("sess"),
          payload: {
            kind: "turn.cancel.request",
            scope: "daemon",
            payload: { invocationId },
          },
        }),
      "IDEMPOTENCY_CONFLICT",
    );
    expectRuntimeControlError(
      () =>
        submitRuntimeControlCommand(h.db, {
          runtimeId: h.runtimeId,
          idempotencyKey: "friendly-but-not-wire-safe",
          payload: { kind: "daemon.status.request", scope: "daemon" },
        }),
      "IDEMPOTENCY_KEY_INVALID",
    );
    h.db.close();
  });
});

function expectRuntimeControlError(action: () => unknown, reasonCode: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeControlCommandError);
    expect((error as RuntimeControlCommandError).reasonCode).toBe(reasonCode);
    return;
  }
  throw new Error(`Expected runtime control error ${reasonCode}.`);
}
