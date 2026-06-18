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
} from "./index.js";

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
    expect(runtimeHelloEnvelopeSchema.parse(hello).type).toBe("runtime.hello");
  });

  it("validates runtime heartbeat fixture", () => {
    expect(runtimeHeartbeatEnvelopeSchema.parse(heartbeat).payload.sequence).toBe(1);
  });

  it("validates MVP protocol message fixtures", () => {
    const parsed = mvpMessages.map((message) => runtimeMessageEnvelopeSchema.parse(message));

    expect(parsed.map((message) => message.type)).toContain("human.request.created");
    expect(parsed.map((message) => message.type)).toContain("runtime.reconcile.report");
    expect(parsed.map((message) => message.type)).toContain("task_graph.snapshot");
    expect(parsed.map((message) => message.type)).toContain("artifact.projected");
  });
});
