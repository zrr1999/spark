import { describe, expect, it } from "vitest";
import {
  createId,
  createServerCommandEnvelope,
  runtimeProtocolVersion,
} from "@zendev-lab/spark-protocol";
import { openMemoryDatabase } from "@zendev-lab/spark-db";
import {
  acknowledgeRuntimeCommandTerminal,
  claimRuntimeCommandReceipt,
  pendingRuntimeCommandTerminals,
  recordRuntimeCommandAck,
  recordRuntimeCommandTerminal,
  recoverInterruptedRuntimeCommandReceipts,
  runtimeCommandReceipt,
} from "./runtime-command-receipts.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

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

describe("runtime command receipts", () => {
  it("claims once, replays persisted terminal state, and rejects payload conflicts", () => {
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const command = daemonCommand();
    expect(claimRuntimeCommandReceipt(db, command)).toEqual({ kind: "new" });
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
});
