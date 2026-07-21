import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import {
  createId,
  runtimeProtocolVersion,
  serverCommandEnvelopeSchema,
  type ServerCommandEnvelope,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  attachRuntimeWebSocket,
  createWorkspaceWithOwnerBinding,
  requireRuntimeControlCommand,
  submitRuntimeControlCommand,
  type RuntimeWebSocketConnection,
} from "@zendev-lab/spark-cockpit-coordination";
import {
  handleCommand,
  handleServerMessage,
  type MessageContext,
  type ServerSocket,
} from "./daemon.ts";
import { commandAck } from "./protocol/outbound.ts";
import {
  acknowledgeRuntimeCommandTerminal,
  runtimeCommandReceipt,
} from "./runtime-command-receipts.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";

class CockpitSocket extends EventEmitter implements RuntimeWebSocketConnection {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = "closed"): void {
    this.emit("close", code, Buffer.from(reason));
  }

  emitMessage(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

class CapturingDaemonSocket implements ServerSocket {
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown);
  }
}

it("typed runtime control reconnect executes once and stores one terminal result", async () => {
  const root = mkdtempSync(join(tmpdir(), "spark-typed-control-e2e-"));
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  const cockpitDb = openMemoryDatabase();
  const daemonDb = openSparkDaemonDatabase(paths);
  try {
    migrate(cockpitDb);
    const now = "2026-07-15T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    cockpitDb
      .prepare(
        `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
         created_at, updated_at)
       VALUES (?, 'install-typed-control', 'Typed daemon', 'offline', ?, '{}', '{}', ?, ?)`,
      )
      .run(runtimeId, runtimeProtocolVersion, now, now);
    cockpitDb
      .prepare(
        `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, local_path, display_name, status,
         capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'typed-control', ?, 'Typed control', 'available', '{}', '{}', ?, ?)`,
      )
      .run(bindingId, runtimeId, root, now, now);
    const workspace = createWorkspaceWithOwnerBinding(cockpitDb, {
      slug: "typed-control",
      name: "Typed control",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });
    const daemonWorkspace = registerWorkspace(daemonDb, {
      serverUrl: "https://cockpit.example.test/",
      serverBindingId: bindingId,
      serverWorkspaceId: workspace.id,
      serverStatus: "available",
      localWorkspaceKey: "typed-control",
      displayName: "Typed control",
      workspaceName: "Typed control",
      workspaceSlug: "typed-control",
      localPath: root,
      now,
    });
    const queued = submitRuntimeControlCommand(cockpitDb, {
      runtimeId,
      workspaceId: workspace.id,
      idempotencyKey: createId("idem"),
      payload: {
        kind: "task.start.request",
        scope: "workspace",
        title: "Execute exactly once",
        payload: { prompt: "return a bounded result" },
      },
      createdAt: now,
    });

    const firstCockpitSocket = connectCockpit(cockpitDb, runtimeId, daemonWorkspace.id, now);
    const firstDelivery = latestCommand(firstCockpitSocket);
    const firstDaemonSocket = new CapturingDaemonSocket();
    let executionCount = 0;
    const daemonContext = messageContext(paths, daemonDb, runtimeId, () => {
      executionCount += 1;
    });
    await handleCommand(firstDaemonSocket, firstDelivery, daemonContext);
    expect(executionCount).toBe(1);
    expect(firstDaemonSocket.sent.some(isCommandResult)).toBe(true);

    firstCockpitSocket.close(1006, "drop before ack and result");
    const secondCockpitSocket = connectCockpit(cockpitDb, runtimeId, daemonWorkspace.id, now);
    const redelivery = latestCommand(secondCockpitSocket);
    expect(redelivery.commandId).toBe(firstDelivery.commandId);
    expect(redelivery.messageId).not.toBe(firstDelivery.messageId);

    const secondDaemonSocket = new CapturingDaemonSocket();
    await handleCommand(secondDaemonSocket, redelivery, daemonContext);
    expect(executionCount).toBe(1);
    const replayedTerminal = secondDaemonSocket.sent.find(isCommandResult);
    expect(replayedTerminal).toBeDefined();
    if (!replayedTerminal) throw new Error("Expected a replayed terminal result.");
    expect(replayedTerminal.payload.replayed).toBe(true);
    for (const message of secondDaemonSocket.sent) secondCockpitSocket.emitMessage(message);
    secondCockpitSocket.emitMessage(replayedTerminal);

    const cockpitRecord = requireRuntimeControlCommand(cockpitDb, queued.commandId);
    const terminalEventCount = cockpitDb
      .prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE kind = 'runtime.control.result' AND subject_id = ?`,
      )
      .get(queued.commandId) as { count: number };
    const daemonReceiptBeforeAck = runtimeCommandReceipt(daemonDb, queued.commandId);
    const ingestAck = secondCockpitSocket.sent
      .map((message) => JSON.parse(message) as { type?: string; ackOf?: string })
      .findLast(
        (message) =>
          message.type === "server.ingest_ack" && message.ackOf === replayedTerminal.messageId,
      );
    expect(ingestAck).toBeDefined();
    if (!ingestAck?.ackOf) throw new Error("Expected a result ingest acknowledgement.");
    await handleServerMessage(new CapturingDaemonSocket(), JSON.stringify(ingestAck), {
      ...daemonContext,
      onIngestAck(ackOf) {
        const message = secondCockpitSocket.sent
          .map((value) => JSON.parse(value) as { ackOf?: string })
          .find((value) => value.ackOf === ackOf);
        expect(message).toBeDefined();
        expect(acknowledgeRuntimeCommandTerminal(daemonDb, ackOf, now)).toBe(true);
      },
    });
    const daemonReceiptAfterAck = runtimeCommandReceipt(daemonDb, queued.commandId);
    const maxPayloadBytes = Math.max(
      ...secondDaemonSocket.sent.map((message) => Buffer.byteLength(JSON.stringify(message))),
    );

    expect(cockpitRecord.status).toBe("succeeded");
    expect(cockpitRecord.attemptCount).toBe(2);
    expect(terminalEventCount.count).toBe(1);
    expect(daemonReceiptBeforeAck?.deliveryCount).toBe(2);
    expect(daemonReceiptAfterAck?.terminalAckedAt).toBe(now);
    expect(maxPayloadBytes).toBeLessThanOrEqual(64 * 1024);
    console.log(
      "SPARK_TYPED_CONTROL_RECONNECT_TRANSCRIPT",
      JSON.stringify({
        commandId: queued.commandId,
        deliveryAttempts: cockpitRecord.attemptCount,
        daemonExecutionCount: executionCount,
        terminalResultCount: terminalEventCount.count,
        daemonDeliveryCount: daemonReceiptAfterAck?.deliveryCount,
        maxPayloadBytes,
      }),
    );
  } finally {
    cockpitDb.close();
    daemonDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function connectCockpit(
  db: ReturnType<typeof openMemoryDatabase>,
  runtimeId: string,
  bindingId: string,
  sentAt: string,
): CockpitSocket {
  const ws = new CockpitSocket();
  attachRuntimeWebSocket(ws, { db, runtimeId });
  ws.emitMessage({
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "runtime.hello",
    sentAt,
    payload: {
      runtimeId,
      runtimeVersion: "0.1.0-test",
      supportedFeatures: ["ws-control-v1", "command-routing-v1"],
      workspaceBindings: [
        {
          bindingId,
          localWorkspaceKey: "typed-control",
          displayName: "Typed control",
          status: "available",
          capabilities: {},
          diagnostics: {},
        },
      ],
    },
  });
  return ws;
}

function latestCommand(ws: CockpitSocket): ServerCommandEnvelope {
  const raw = ws.sent
    .map((message) => JSON.parse(message) as unknown)
    .findLast(
      (message) =>
        Boolean(message) &&
        typeof message === "object" &&
        (message as { type?: string }).type === "server.command",
    );
  return serverCommandEnvelopeSchema.parse(raw);
}

function messageContext(
  paths: ReturnType<typeof resolveSparkPaths>,
  db: ReturnType<typeof openSparkDaemonDatabase>,
  runtimeId: string,
  onExecute: () => void,
): MessageContext {
  return {
    paths,
    config: { installationId: "install-typed-control", displayName: "Typed daemon", runtimeId },
    db,
    runtimeId,
    runtimeSessionId: undefined,
    setRuntimeSessionId() {},
    ensureHeartbeat() {},
    runSparkCommand: async (input) => {
      onExecute();
      const invocationId = createId("inv");
      input.emit(commandAck({ accepted: true, invocationId }, { ...input.route, invocationId }));
      return {
        invocationId,
        taskRuntimeId: `task-${invocationId}`,
        status: "succeeded",
        outputArtifactIds: [],
      };
    },
    cancelSparkInvocation: async ({ invocationId }) => ({
      invocationId,
      cancelled: false,
      message: "not used",
    }),
  };
}

function isCommandResult(value: unknown): value is {
  type: "runtime.command.result";
  messageId: string;
  payload: { replayed?: boolean };
} {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: string }).type === "runtime.command.result"
  );
}
