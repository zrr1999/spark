import { describe, expect, it } from "vitest";
import mvpMessages from "./fixtures/runtime-v1/mvp-messages.ws.json" with { type: "json" };
import registerRequest from "./fixtures/runtime-v1/register-runtime.request.json" with { type: "json" };
import registerResponse from "./fixtures/runtime-v1/register-runtime.response.json" with { type: "json" };
import heartbeat from "./fixtures/runtime-v1/runtime-heartbeat.ws.json" with { type: "json" };
import hello from "./fixtures/runtime-v1/runtime-hello.ws.json" with { type: "json" };
import {
  runtimeHeartbeatEnvelopeSchema,
  runtimeHelloEnvelopeSchema,
  runtimeMessageEnvelopeSchema,
  runtimeRegistrationRequestSchema,
  runtimeRegistrationResponseSchema,
  runtimeReconcileReportEnvelopeSchema,
  workspaceSnapshotEnvelopeSchema,
} from "./index.ts";

describe("runtime protocol fixtures", () => {
  it("validates runtime registration request fixture", () => {
    expect(runtimeRegistrationRequestSchema.parse(registerRequest).displayName).toBe(
      "Development MacBook Pro",
    );
  });

  it("validates runtime registration response fixture", () => {
    expect(runtimeRegistrationResponseSchema.parse(registerResponse).protocolVersion).toBe(
      "navia.runtime.v1alpha1",
    );
  });

  it("validates runtime hello fixture", () => {
    const parsed = runtimeHelloEnvelopeSchema.parse(hello);
    expect(parsed.type).toBe("runtime.hello");
    expect(parsed.payload.supportedFeatures).toContain("workspace-clients-v1");
    expect(parsed.payload.supportedFeatures).toContain("executor-client-v1");
    expect(parsed.payload.workspaceBindings[0]?.borrowed?.borrowed).toBe(true);
    expect(parsed.payload.workspaceBindings[0]?.executor?.state).toBe("online");
  });

  it("validates runtime heartbeat fixture", () => {
    const parsed = runtimeHeartbeatEnvelopeSchema.parse(heartbeat);
    expect(parsed.payload.sequence).toBe(1);
    expect(parsed.payload.workspaceBindings?.[0]?.connection?.status).toBe("connected");
    expect(parsed.payload.workspaceBindings?.[0]?.workspaceClients?.[0]?.kind).toBe("interactive");
  });

  it("validates MVP protocol message fixtures", () => {
    const parsed = mvpMessages.map((message) => runtimeMessageEnvelopeSchema.parse(message));

    expect(parsed.map((message) => message.type)).toContain("human.request.created");
    expect(parsed.map((message) => message.type)).toContain("runtime.reconcile.report");
    expect(parsed.map((message) => message.type)).toContain("task_graph.snapshot");
    expect(parsed.map((message) => message.type)).toContain("artifact.projected");

    const reconcile = runtimeReconcileReportEnvelopeSchema.parse(
      mvpMessages.find((message) => message.type === "runtime.reconcile.report"),
    );
    expect(reconcile.payload.activeAgentCount).toBe(0);
    expect(reconcile.payload.executor?.state).toBe("online");

    const snapshot = workspaceSnapshotEnvelopeSchema.parse(
      mvpMessages.find((message) => message.type === "workspace.snapshot"),
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
