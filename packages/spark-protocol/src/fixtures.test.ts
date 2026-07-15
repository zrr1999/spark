import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runtimeHeartbeatEnvelopeSchema,
  runtimeDeviceAuthorizationRequestSchema,
  runtimeDeviceAuthorizationResponseSchema,
  runtimeDeviceTokenRequestSchema,
  runtimeHelloEnvelopeSchema,
  runtimeMessageEnvelopeSchema,
  runtimeRegistrationRequestSchema,
  runtimeRegistrationResponseSchema,
  runtimeWorkspaceRegistrationRequestSchema,
  runtimeReconcileReportEnvelopeSchema,
  workspaceSnapshotEnvelopeSchema,
} from "./index.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "runtime-v1");
const mvpMessages = readFixture("mvp-messages.ws.json") as unknown[];
const typedControlMessages = readFixture("typed-control.ws.json") as unknown[];
const workspaceControlStates = readFixture("workspace-control-states.ws.json") as unknown[];
const registerRequest = readFixture("register-runtime.request.json");
const registerResponse = readFixture("register-runtime.response.json");
const heartbeat = readFixture("runtime-heartbeat.ws.json");
const hello = readFixture("runtime-hello.ws.json");

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as unknown;
}

function hasMessageType(message: unknown, type: string): boolean {
  return (
    typeof message === "object" && message !== null && "type" in message && message.type === type
  );
}

describe("runtime protocol fixtures", () => {
  it("validates runtime registration request fixture", () => {
    expect(runtimeRegistrationRequestSchema.parse(registerRequest).displayName).toBe(
      "Development MacBook Pro",
    );
  });

  it("validates runtime registration response fixture", () => {
    expect(runtimeRegistrationResponseSchema.parse(registerResponse).protocolVersion).toBe(
      "spark.runtime.v1alpha1",
    );
  });

  it("validates daemon device authorization messages", () => {
    expect(runtimeDeviceAuthorizationRequestSchema.parse(registerRequest).installationId).toBe(
      "dev-macbook-pro",
    );
    expect(
      runtimeDeviceAuthorizationResponseSchema.parse({
        deviceCode: `spark_device_${"a".repeat(43)}`,
        userCode: "ABCD-EFGH",
        verificationUri: "http://127.0.0.1:5173/daemon/authorize",
        verificationUriComplete: "http://127.0.0.1:5173/daemon/authorize?user_code=ABCD-EFGH",
        expiresIn: 600,
        interval: 5,
      }).interval,
    ).toBe(5);
    expect(
      runtimeDeviceTokenRequestSchema.parse({ deviceCode: `spark_device_${"a".repeat(43)}` })
        .deviceCode,
    ).toMatch(/^spark_device_/);
  });

  it("allows an installation-scoped runtime token to register another workspace", () => {
    const parsed = runtimeWorkspaceRegistrationRequestSchema.parse({
      workspaceRegistration: {
        localWorkspaceKey: "spore",
        localPath: "/Users/test/workspaces/spore",
        displayName: "Spore",
      },
    });

    expect(parsed.registrationToken).toBeUndefined();
    expect(parsed.workspaceRegistration.localPath).toBe("/Users/test/workspaces/spore");
  });

  it("validates runtime hello fixture", () => {
    const parsed = runtimeHelloEnvelopeSchema.parse(hello);
    expect(parsed.type).toBe("runtime.hello");
    expect(parsed.payload.supportedFeatures).toContain("workspace-clients-v1");
    expect(parsed.payload.supportedFeatures).toContain("executor-client-v1");
    expect(parsed.payload.workspaceBindings[0]?.borrowed?.borrowed).toBe(true);
    expect(parsed.payload.workspaceBindings[0]?.localPath).toBe("/Users/test/workspaces/local-dev");
    expect(parsed.payload.workspaceBindings[0]?.executor?.state).toBe("online");
  });

  it("validates runtime heartbeat fixture", () => {
    const parsed = runtimeHeartbeatEnvelopeSchema.parse(heartbeat);
    expect(parsed.payload.sequence).toBe(1);
    expect(parsed.payload.workspaceBindings?.[0]?.connection?.status).toBe("connected");
    expect(parsed.payload.workspaceBindings?.[0]?.localPath).toBe(
      "/Users/test/workspaces/local-dev",
    );
    expect(parsed.payload.workspaceBindings?.[0]?.workspaceClients?.[0]?.kind).toBe("interactive");
  });

  it("validates workspace control state fixtures", () => {
    const parsed = workspaceControlStates.map((message) =>
      workspaceSnapshotEnvelopeSchema.parse(message),
    );

    expect(parsed.map((message) => message.payload.borrowed?.borrowed)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(parsed.map((message) => message.payload.connection?.status)).toEqual([
      "connected",
      "connected",
      "connected",
      "disconnected",
    ]);
    expect(parsed.map((message) => message.payload.executor?.state)).toEqual([
      "online",
      "none",
      "starting",
      "unhealthy",
    ]);
    expect(parsed.map((message) => message.payload.control?.serverMutationAllowed)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("validates daemon/workspace typed control fixtures", () => {
    const parsed = typedControlMessages.map((message) =>
      runtimeMessageEnvelopeSchema.parse(message),
    );
    expect(parsed.map((message) => message.type)).toEqual([
      "server.command",
      "server.command",
      "runtime.command.ack",
      "runtime.command.reject",
      "runtime.command.result",
    ]);
    expect(parsed[0]).toMatchObject({ payload: { scope: "daemon" } });
    expect(parsed[0]).not.toHaveProperty("workspaceBindingId");
    expect(parsed[1]).toMatchObject({
      workspaceBindingId: "rtwb_20000000000000000000000000000000",
      payload: { scope: "workspace" },
    });
    expect(parsed[4]).toMatchObject({
      payload: { status: "succeeded", projection: { kind: "daemon.status" } },
    });
  });

  it("validates MVP protocol message fixtures", () => {
    const parsed = mvpMessages.map((message) => runtimeMessageEnvelopeSchema.parse(message));

    expect(parsed.map((message) => message.type)).toContain("human.request.created");
    expect(parsed.map((message) => message.type)).toContain("runtime.reconcile.report");
    expect(parsed.map((message) => message.type)).toContain("task_graph.snapshot");
    expect(parsed.map((message) => message.type)).toContain("artifact.projected");

    const reconcile = runtimeReconcileReportEnvelopeSchema.parse(
      mvpMessages.find((message) => hasMessageType(message, "runtime.reconcile.report")),
    );
    expect(reconcile.payload.activeAgentCount).toBe(0);
    expect(reconcile.payload.executor?.state).toBe("online");

    const snapshot = workspaceSnapshotEnvelopeSchema.parse(
      mvpMessages.find((message) => hasMessageType(message, "workspace.snapshot")),
    );
    expect(snapshot.payload.borrowed).toMatchObject({
      borrowed: true,
      interactiveClientCount: 1,
    });
    expect(snapshot.payload.executor).toMatchObject({
      state: "online",
      activeInvocationCount: 1,
      activeAgentCount: 2,
    });
    expect(snapshot.payload.control).toMatchObject({
      mode: "snapshot_only",
      reason: "borrowed",
      serverMutationAllowed: false,
    });
  });
});
