import { createId } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { describe, expect, it } from "vitest";
import { createWorkspaceWithOwnerBinding } from "./projection-services.ts";
import {
  registerRuntimeEphemeralSecretDispatcher,
  runRuntimeEphemeralSecretRequest,
  runtimeChannelRouteForWorkspace,
  runtimeModelRouteForRuntime,
} from "./runtime-model-channel-control.ts";
import { RuntimeControlCommandError } from "./runtime-control.ts";

const now = "2026-07-15T00:00:00.000Z";
const marker = "SPARK_SECRET_MARKER_runtime_control";

describe("runtime ephemeral secret control", () => {
  it.each([
    ["http", { pageProtocol: "http:" }],
    ["missing-owner", { actorUserId: "" }],
    ["csrf", { csrfVerified: false }],
  ] as const)("rejects %s before daemon execution", async (_name, override) => {
    const h = setup();
    let executionCount = 0;
    const unregister = registerRuntimeEphemeralSecretDispatcher(h.db, h.runtimeId, () => {
      executionCount += 1;
      return () => {};
    });
    try {
      const requestId = createId("eph");
      const reasonCode = await rejectedReason(
        runRuntimeEphemeralSecretRequest(h.db, {
          route: runtimeModelRouteForRuntime(h.runtimeId),
          request: {
            operation: "provider.auth.api_key.set",
            providerName: "openai",
            apiKey: marker,
          },
          context: { ...secureContext(h.userId), ...override } as never,
          requestId,
        }),
      );
      expect(executionCount).toBe(0);
      expect(auditRows(h.db)).toHaveLength(0);
      rejectionTranscript(_name, requestId, reasonCode, executionCount);
    } finally {
      unregister();
      h.db.close();
    }
  });

  it("rejects insecure WS, timeout, disconnect, and replay without retry", async () => {
    const h = setup();
    const route = runtimeModelRouteForRuntime(h.runtimeId);
    const insecureWsRequestId = createId("eph");
    const insecureWsReason = await rejectedReason(
      runRuntimeEphemeralSecretRequest(h.db, {
        route,
        request: {
          operation: "provider.auth.api_key.set",
          providerName: "openai",
          apiKey: marker,
        },
        context: secureContext(h.userId),
        requestId: insecureWsRequestId,
      }),
    );
    expect(insecureWsReason).toBe("SECRET_RUNTIME_UNAVAILABLE");
    rejectionTranscript("insecure-ws", insecureWsRequestId, insecureWsReason, 0);

    let timeoutExecutions = 0;
    const unregisterTimeout = registerRuntimeEphemeralSecretDispatcher(h.db, h.runtimeId, () => {
      timeoutExecutions += 1;
      return () => {};
    });
    const timeoutRequestId = createId("eph");
    const timeoutReason = await rejectedReason(
      runRuntimeEphemeralSecretRequest(h.db, {
        route,
        request: {
          operation: "provider.auth.api_key.set",
          providerName: "openai",
          apiKey: marker,
        },
        context: { ...secureContext(h.userId), timeoutMs: 5 },
        requestId: timeoutRequestId,
      }),
    );
    expect(timeoutReason).toBe("SECRET_TIMEOUT");
    unregisterTimeout();
    expect(timeoutExecutions).toBe(1);
    expect(auditOutcome(h.db, timeoutRequestId)).toBe("timed_out");
    rejectionTranscript("timeout", timeoutRequestId, timeoutReason, timeoutExecutions);

    let disconnectExecutions = 0;
    const unregisterDisconnect = registerRuntimeEphemeralSecretDispatcher(
      h.db,
      h.runtimeId,
      ({ reject }) => {
        disconnectExecutions += 1;
        reject(
          new RuntimeControlCommandError("runtime disconnected", "SECRET_RUNTIME_DISCONNECTED"),
        );
        return () => {};
      },
    );
    const disconnectRequestId = createId("eph");
    const disconnectReason = await rejectedReason(
      runRuntimeEphemeralSecretRequest(h.db, {
        route,
        request: {
          operation: "provider.auth.api_key.set",
          providerName: "openai",
          apiKey: marker,
        },
        context: secureContext(h.userId),
        requestId: disconnectRequestId,
      }),
    );
    expect(disconnectReason).toBe("SECRET_RUNTIME_DISCONNECTED");
    unregisterDisconnect();
    expect(disconnectExecutions).toBe(1);
    expect(auditOutcome(h.db, disconnectRequestId)).toBe("disconnected");
    rejectionTranscript("disconnect", disconnectRequestId, disconnectReason, disconnectExecutions);

    let replayExecutions = 0;
    const unregisterSuccess = registerRuntimeEphemeralSecretDispatcher(
      h.db,
      h.runtimeId,
      ({ resolve }) => {
        replayExecutions += 1;
        resolve({
          operation: "provider.auth.api_key.set",
          status: "succeeded",
          result: { providers: [], diagnostics: [] },
          completedAt: now,
        });
        return () => {};
      },
    );
    const replayRequestId = createId("eph");
    await runRuntimeEphemeralSecretRequest(h.db, {
      route,
      request: {
        operation: "provider.auth.api_key.set",
        providerName: "openai",
        apiKey: marker,
      },
      context: secureContext(h.userId),
      requestId: replayRequestId,
    });
    const replayReason = await rejectedReason(
      runRuntimeEphemeralSecretRequest(h.db, {
        route,
        request: {
          operation: "provider.auth.api_key.set",
          providerName: "openai",
          apiKey: marker,
        },
        context: secureContext(h.userId),
        requestId: replayRequestId,
      }),
    );
    expect(replayReason).toBe("SECRET_REPLAY_REJECTED");
    unregisterSuccess();
    expect(replayExecutions).toBe(1);
    rejectionTranscript("replay", replayRequestId, replayReason, 0);
    expect(JSON.stringify(auditRows(h.db))).not.toContain(marker);
    expect(databaseText(h.db)).not.toContain(marker);
    h.db.close();
  });

  it("requires the active workspace owner route for channel credentials", async () => {
    const h = setup();
    let executionCount = 0;
    const unregister = registerRuntimeEphemeralSecretDispatcher(
      h.db,
      h.runtimeId,
      ({ resolve }) => {
        executionCount += 1;
        resolve({
          operation: "channel.configure",
          status: "succeeded",
          result: {
            workspaceId: h.workspaceId,
            available: true,
            configured: true,
            ingressEnabled: true,
            state: "running",
            adapters: [],
            routes: [],
            configuration: { routes: [], onUnbound: "create" },
            observedAt: now,
            text: "channels running\n",
          },
          completedAt: now,
        });
        return () => {};
      },
    );
    try {
      await runRuntimeEphemeralSecretRequest(h.db, {
        route: runtimeChannelRouteForWorkspace(h.db, h.workspaceId),
        request: {
          operation: "channel.configure",
          workspaceId: h.workspaceId,
          config: {
            adapters: {
              infoflow: {
                type: "infoflow",
                app_key: marker,
                app_secret: marker,
                app_agent_id: "43163",
              },
            },
            routes: {},
            ingress: { enabled: true, on_unbound: "create" },
          },
        },
        context: secureContext(h.userId),
      });
      expect(executionCount).toBe(1);
      expect(databaseText(h.db)).not.toContain(marker);
    } finally {
      unregister();
      h.db.close();
    }
  });
});

async function rejectedReason(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeControlCommandError);
    return (error as RuntimeControlCommandError).reasonCode;
  }
  throw new Error("Expected ephemeral secret request to be rejected.");
}

function rejectionTranscript(
  scenario: string,
  requestId: string,
  reasonCode: string,
  daemonExecutionCount: number,
): void {
  console.log(
    "SPARK_EPHEMERAL_SECRET_REJECTION",
    JSON.stringify({
      scenario,
      requestId,
      status: reasonCode,
      daemonExecutionCount,
      retryCount: 0,
    }),
  );
}

function setup() {
  const db = openMemoryDatabase();
  migrate(db);
  const runtimeId = createId("rt");
  const bindingId = createId("rtwb");
  const userId = createId("usr");
  db.prepare(
    `INSERT INTO users (id, display_name, role, status, created_at, updated_at)
     VALUES (?, 'Owner', 'owner', 'active', ?, ?)`,
  ).run(userId, now, now);
  db.prepare(
    `INSERT INTO runtime_connections
      (id, name, status, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, 'daemon', 'online', '{}', '{}', ?, ?)`,
  ).run(runtimeId, now, now);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
       diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'local', 'Local', 'available', '{}', '{}', ?, ?)`,
  ).run(bindingId, runtimeId, now, now);
  const workspace = createWorkspaceWithOwnerBinding(db, {
    runtimeWorkspaceBindingId: bindingId,
    slug: "local",
    name: "Local",
    createdAt: now,
  });
  return { db, runtimeId, bindingId, workspaceId: workspace.id, userId };
}

function secureContext(actorUserId: string) {
  return {
    actorUserId,
    browserRequestId: createId("msg"),
    csrfVerified: true as const,
    pageProtocol: "https:" as const,
  };
}

function auditRows(db: ReturnType<typeof openMemoryDatabase>) {
  return db.prepare("SELECT * FROM runtime_ephemeral_secret_audit ORDER BY created_at").all();
}

function auditOutcome(db: ReturnType<typeof openMemoryDatabase>, requestId: string): string {
  return (
    db
      .prepare("SELECT outcome FROM runtime_ephemeral_secret_audit WHERE request_id = ?")
      .get(requestId) as { outcome: string }
  ).outcome;
}

function databaseText(db: ReturnType<typeof openMemoryDatabase>): string {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return JSON.stringify(
    tables.map(({ name }) => ({
      name,
      rows: db.prepare(`SELECT * FROM ${JSON.stringify(name)}`).all(),
    })),
  );
}
