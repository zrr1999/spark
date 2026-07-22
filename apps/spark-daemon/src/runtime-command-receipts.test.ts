import { describe, expect, it } from "vitest";
import {
  createId,
  createServerCommandEnvelope,
  runtimeProtocolVersion,
} from "@zendev-lab/spark-protocol";
import { openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import {
  acknowledgeRuntimeCommandTerminal,
  acknowledgeRuntimeCommandTerminalForRoute,
  claimRuntimeCommandReceipt,
  pendingRuntimeCommandTerminals,
  pendingRuntimeCommandTerminalsForRoute,
  recordRuntimeCommandAck,
  recordRuntimeCommandTerminal,
  recoverInterruptedRuntimeCommandReceipts,
  runtimeCommandReceipt,
} from "./runtime-command-receipts.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";
import { addWorkspace } from "./store/workspaces.ts";

const receiptCommandId = "cmd_10000000000000000000000000000000";

function daemonCommand() {
  return createServerCommandEnvelope({
    runtimeId: "rt_10000000000000000000000000000000",
    commandId: receiptCommandId,
    idempotencyKey: "idem_10000000000000000000000000000000",
    sentAt: "2026-07-15T00:00:00.000Z",
    payload: { kind: "daemon.status.request", scope: "daemon" },
  });
}

function turnSubmitCommand() {
  return createServerCommandEnvelope({
    runtimeId: "rt_10000000000000000000000000000000",
    commandId: receiptCommandId,
    idempotencyKey: "idem_10000000000000000000000000000000",
    sessionId: "sess-recovery",
    sentAt: "2026-07-15T00:00:00.000Z",
    payload: {
      kind: "turn.submit.request",
      scope: "daemon",
      payload: { sessionId: "sess-recovery", prompt: "recover admission" },
    },
  });
}

function seedTerminal(
  db: ReturnType<typeof openMemoryDatabase>,
  input: {
    commandId: string;
    messageId: string;
    runtimeId: string;
    workspaceBindingId?: string;
  },
): Record<string, unknown> {
  const now = "2026-07-15T00:00:02.000Z";
  const terminal = {
    messageId: input.messageId,
    type: "runtime.command.result",
    runtimeId: input.runtimeId,
    ...(input.workspaceBindingId ? { workspaceBindingId: input.workspaceBindingId } : {}),
    commandId: input.commandId,
    payload: { status: "succeeded" },
  };
  db.prepare(
    `INSERT INTO runtime_command_receipts
      (command_id, runtime_id, scope, workspace_binding_id, kind, payload_hash, status,
       delivery_count, terminal_message_id, terminal_json, first_seen_at, last_seen_at,
       completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test.command', ?, 'succeeded', 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.commandId,
    input.runtimeId,
    input.workspaceBindingId ? "workspace" : "daemon",
    input.workspaceBindingId ?? null,
    `hash-${input.commandId}`,
    input.messageId,
    JSON.stringify(terminal),
    now,
    now,
    now,
    now,
    now,
  );
  return terminal;
}

describe("runtime command receipts", () => {
  it("filters terminals before limiting and rejects cross-Cockpit acknowledgements", () => {
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const serverA = "https://a.example.test/";
    const serverB = "https://b.example.test/";
    const runtimeA = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const runtimeB = "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const bindingA = "rtwb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const bindingB = "rtwb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    addWorkspace(db, {
      id: bindingA,
      serverUrl: serverA,
      localWorkspaceKey: "workspace-a",
      displayName: "Workspace A",
      localPath: "/workspace-a",
    });
    addWorkspace(db, {
      id: bindingB,
      serverUrl: serverB,
      localWorkspaceKey: "workspace-b",
      displayName: "Workspace B",
      localPath: "/workspace-b",
    });
    for (let index = 0; index < 100; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      seedTerminal(db, {
        commandId: `command-a-${suffix}`,
        messageId: `message-a-${suffix}`,
        runtimeId: runtimeA,
        workspaceBindingId: bindingA,
      });
    }
    const terminalB = seedTerminal(db, {
      commandId: "command-b",
      messageId: "message-b",
      runtimeId: runtimeB,
      workspaceBindingId: bindingB,
    });

    expect(
      pendingRuntimeCommandTerminalsForRoute(db, { runtimeId: runtimeB, serverUrl: serverB }),
    ).toEqual([terminalB]);
    expect(
      acknowledgeRuntimeCommandTerminalForRoute(db, "message-b", {
        runtimeId: runtimeA,
        serverUrl: serverA,
      }),
    ).toBe(false);
    expect(
      acknowledgeRuntimeCommandTerminalForRoute(db, "message-b", {
        runtimeId: runtimeB,
        serverUrl: serverB,
      }),
    ).toBe(true);
    db.close();
  });

  it("routes daemon-scoped terminals by runtime id", () => {
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const terminalA = seedTerminal(db, {
      commandId: "command-daemon-a",
      messageId: "message-daemon-a",
      runtimeId: "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    seedTerminal(db, {
      commandId: "command-daemon-b",
      messageId: "message-daemon-b",
      runtimeId: "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(
      pendingRuntimeCommandTerminalsForRoute(db, {
        runtimeId: "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        serverUrl: null,
      }),
    ).toEqual([terminalA]);
    expect(
      acknowledgeRuntimeCommandTerminalForRoute(db, "message-daemon-a", {
        runtimeId: "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        serverUrl: null,
      }),
    ).toBe(false);
    expect(
      acknowledgeRuntimeCommandTerminalForRoute(db, "message-daemon-a", {
        runtimeId: "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        serverUrl: null,
      }),
    ).toBe(true);
    db.close();
  });

  it("claims once, replays persisted terminal state, and rejects payload conflicts", () => {
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const command = daemonCommand();
    expect(claimRuntimeCommandReceipt(db, command)).toMatchObject({
      kind: "new",
      claimToken: expect.any(String),
    });
    const ack = {
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.ack",
      sentAt: "2026-07-15T00:00:01.000Z",
      runtimeId: command.runtimeId,
      commandId: command.commandId,
      ackOf: command.messageId,
      payload: { accepted: true },
    };
    const terminal = {
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.result",
      sentAt: "2026-07-15T00:00:02.000Z",
      runtimeId: command.runtimeId,
      commandId: command.commandId,
      ackOf: command.messageId,
      payload: {
        status: "succeeded",
        result: { workspaceCount: 1 },
        completedAt: "2026-07-15T00:00:02.000Z",
      },
    };
    recordRuntimeCommandAck(db, receiptCommandId, ack);
    recordRuntimeCommandTerminal(db, {
      commandId: receiptCommandId,
      status: "succeeded",
      envelope: terminal,
    });

    expect(claimRuntimeCommandReceipt(db, command)).toEqual({
      kind: "replay",
      ack,
      terminal,
    });
    expect(
      claimRuntimeCommandReceipt(db, {
        ...command,
        payload: { ...command.payload, title: "different payload" },
      }),
    ).toEqual({ kind: "conflict" });
    expect(pendingRuntimeCommandTerminals(db)).toEqual([terminal]);
    expect(acknowledgeRuntimeCommandTerminal(db, terminal.messageId)).toBe(true);
    expect(pendingRuntimeCommandTerminals(db)).toEqual([]);
    expect(runtimeCommandReceipt(db, receiptCommandId)).toMatchObject({
      status: "succeeded",
      deliveryCount: 3,
      terminalAckedAt: expect.any(String),
    });
    db.close();
  });

  it("turns interrupted processing into one bounded failed result on restart", () => {
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const command = daemonCommand();
    claimRuntimeCommandReceipt(db, command, "2026-07-15T00:00:00.000Z");

    expect(recoverInterruptedRuntimeCommandReceipts(db, "2026-07-15T00:01:00.000Z")).toBe(1);
    expect(recoverInterruptedRuntimeCommandReceipts(db)).toBe(0);
    expect(runtimeCommandReceipt(db, receiptCommandId)).toMatchObject({
      status: "failed",
      terminal: {
        type: "runtime.command.result",
        commandId: receiptCommandId,
        payload: {
          status: "failed",
          result: { reasonCode: "DAEMON_RESTARTED" },
        },
      },
    });
    expect(pendingRuntimeCommandTerminals(db)).toHaveLength(1);
    db.close();
  });

  it("recovers a committed turn admission instead of reporting a contradictory restart failure", () => {
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const command = turnSubmitCommand();
    claimRuntimeCommandReceipt(db, command, "2026-07-15T00:00:00.000Z");
    const invocation = new SparkInvocationStore(db).submit({
      sessionId: "sess-recovery",
      idempotencyKey: command.idempotencyKey,
      prompt: "recover admission",
      task: {
        type: "session.run",
        sessionId: "sess-recovery",
        prompt: "recover admission",
      },
      now: "2026-07-15T00:00:01.000Z",
    });

    expect(recoverInterruptedRuntimeCommandReceipts(db, "2026-07-15T00:01:00.000Z")).toBe(1);
    expect(runtimeCommandReceipt(db, receiptCommandId)).toMatchObject({
      status: "succeeded",
      ack: {
        type: "runtime.command.ack",
        commandId: receiptCommandId,
        invocationId: invocation.invocationId,
        payload: { accepted: true, invocationId: invocation.invocationId },
      },
      terminal: {
        type: "runtime.command.result",
        commandId: receiptCommandId,
        invocationId: invocation.invocationId,
        payload: {
          status: "succeeded",
          result: {
            invocationId: invocation.invocationId,
            status: "queued",
            acceptedAt: invocation.createdAt,
          },
        },
      },
    });
    expect(pendingRuntimeCommandTerminals(db)).toHaveLength(1);
    db.close();
  });

  it("releases an interrupted turn receipt when admission never committed", () => {
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const command = turnSubmitCommand();
    claimRuntimeCommandReceipt(db, command, "2026-07-15T00:00:00.000Z");

    expect(recoverInterruptedRuntimeCommandReceipts(db, "2026-07-15T00:01:00.000Z")).toBe(1);
    expect(runtimeCommandReceipt(db, receiptCommandId)).toBeUndefined();
    expect(claimRuntimeCommandReceipt(db, command)).toMatchObject({
      kind: "new",
      claimToken: expect.any(String),
    });
    db.close();
  });

  it("reclaims an expired turn admission lease and fences the stale claimant", () => {
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const command = turnSubmitCommand();
    const first = claimRuntimeCommandReceipt(db, command, "2026-07-15T00:00:00.000Z", {
      leaseMs: 1_000,
    });
    expect(first).toMatchObject({ kind: "new", claimToken: expect.any(String) });
    if (first.kind !== "new") throw new Error("expected the initial receipt claim");

    expect(
      claimRuntimeCommandReceipt(db, command, "2026-07-15T00:00:00.500Z", { leaseMs: 1_000 }),
    ).toEqual({ kind: "replay" });
    const second = claimRuntimeCommandReceipt(db, command, "2026-07-15T00:00:01.001Z", {
      leaseMs: 1_000,
    });
    expect(second).toMatchObject({ kind: "new", claimToken: expect.any(String) });
    if (second.kind !== "new") throw new Error("expected the expired receipt to be reclaimed");
    expect(second.claimToken).not.toBe(first.claimToken);

    const staleTerminal = {
      messageId: createId("msg"),
      type: "runtime.command.result",
      payload: { status: "succeeded" },
    };
    expect(
      recordRuntimeCommandAck(
        db,
        receiptCommandId,
        { type: "runtime.command.ack" },
        "2026-07-15T00:00:01.002Z",
        first.claimToken,
      ),
    ).toBe(false);
    expect(
      recordRuntimeCommandTerminal(db, {
        commandId: receiptCommandId,
        status: "succeeded",
        envelope: staleTerminal,
        claimToken: first.claimToken,
      }),
    ).toBe(false);
    expect(runtimeCommandReceipt(db, receiptCommandId)).toMatchObject({
      status: "processing",
      ack: null,
      terminal: null,
    });

    const terminal = { ...staleTerminal, messageId: createId("msg") };
    expect(
      recordRuntimeCommandAck(
        db,
        receiptCommandId,
        { type: "runtime.command.ack" },
        "2026-07-15T00:00:01.003Z",
        second.claimToken,
      ),
    ).toBe(true);
    expect(
      recordRuntimeCommandTerminal(db, {
        commandId: receiptCommandId,
        status: "succeeded",
        envelope: terminal,
        claimToken: second.claimToken,
      }),
    ).toBe(true);
    expect(runtimeCommandReceipt(db, receiptCommandId)).toMatchObject({
      status: "succeeded",
      terminal,
    });
    db.close();
  });

  it("treats the outer session route as part of receipt replay identity", () => {
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const command = turnSubmitCommand();
    claimRuntimeCommandReceipt(db, command);

    expect(
      claimRuntimeCommandReceipt(db, {
        ...command,
        sessionId: "sess-other",
      }),
    ).toEqual({ kind: "conflict" });
    db.close();
  });

  it("fails loudly when the recovered idempotency key belongs to a different turn", () => {
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const command = turnSubmitCommand();
    claimRuntimeCommandReceipt(db, command, "2026-07-15T00:00:00.000Z");
    new SparkInvocationStore(db).submit({
      sessionId: "sess-recovery",
      idempotencyKey: command.idempotencyKey,
      prompt: "different prompt",
      task: {
        type: "session.run",
        sessionId: "sess-recovery",
        prompt: "different prompt",
      },
      now: "2026-07-15T00:00:01.000Z",
    });

    expect(recoverInterruptedRuntimeCommandReceipts(db, "2026-07-15T00:01:00.000Z")).toBe(1);
    expect(runtimeCommandReceipt(db, receiptCommandId)).toMatchObject({
      status: "failed",
      terminal: {
        payload: { status: "failed", result: { reasonCode: "IDEMPOTENCY_CONFLICT" } },
      },
    });
    db.close();
  });
});
