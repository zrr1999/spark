import { describe, expect, it } from "vitest";
import {
  createServerCommandEnvelope,
  parseServerCommandEnvelope,
  serializeServerCommandEnvelope,
} from "./command-delivery.ts";
import {
  DAEMON_OWNED_SCOPES,
  COCKPIT_OUTBOX_SCOPES,
  isDaemonOwnedScope,
} from "./state-ownership.ts";
import {
  SPARK_PROTOCOL_VERSION,
  SPARK_RUNTIME_PROTOCOL_VERSION,
  assertSparkProtocolVersion,
  assertSparkRuntimeProtocolVersion,
  currentSparkProtocolVersions,
  isSparkRuntimeProtocolVersion,
} from "./version.ts";

describe("spark protocol version", () => {
  it("exposes aligned view-model and runtime versions", () => {
    expect(currentSparkProtocolVersions()).toEqual({
      viewModelVersion: 1,
      runtimeVersion: "spark.runtime.v1alpha1",
    });
    expect(SPARK_PROTOCOL_VERSION).toBe(1);
    expect(SPARK_RUNTIME_PROTOCOL_VERSION).toBe("spark.runtime.v1alpha1");
  });

  it("asserts supported protocol versions", () => {
    expect(() => assertSparkProtocolVersion(1)).not.toThrow();
    expect(() => assertSparkProtocolVersion(2)).toThrow(/unsupported Spark protocol version/u);
    expect(() => assertSparkRuntimeProtocolVersion("spark.runtime.v1alpha1")).not.toThrow();
    expect(isSparkRuntimeProtocolVersion("spark.runtime.v1alpha1")).toBe(true);
    expect(isSparkRuntimeProtocolVersion("spark.runtime.v2")).toBe(false);
  });
});

describe("server command delivery", () => {
  const routing = {
    runtimeId: "rt_01234567890123456789012345678901",
    workspaceBindingId: "rtwb_01234567890123456789012345678901",
    workspaceId: "ws_01234567890123456789012345678901",
    projectId: "proj_01234567890123456789012345678901",
    commandId: "cmd_01234567890123456789012345678901",
  };

  it("creates and parses canonical server.command envelopes", () => {
    const envelope = createServerCommandEnvelope({
      ...routing,
      payload: {
        kind: "task.start.request",
        title: "Start task",
        payload: { taskRuntimeId: "task-1" },
      },
    });
    expect(envelope.type).toBe("server.command");
    expect(envelope.protocolVersion).toBe("spark.runtime.v1alpha1");
    expect(envelope.payload.kind).toBe("task.start.request");

    const roundTrip = parseServerCommandEnvelope(envelope);
    expect(roundTrip.commandId).toBe(routing.commandId);

    const serialized = serializeServerCommandEnvelope({
      ...routing,
      messageId: envelope.messageId,
      sentAt: envelope.sentAt,
      payload: envelope.payload,
    });
    expect(JSON.parse(serialized)).toEqual(envelope);
  });
});

describe("state ownership", () => {
  it("classifies daemon-owned and cockpit outbox scopes", () => {
    expect(DAEMON_OWNED_SCOPES).toContain("task_graph");
    expect(COCKPIT_OUTBOX_SCOPES).toContain("commands");
    expect(isDaemonOwnedScope("artifacts")).toBe(true);
    expect(isDaemonOwnedScope("commands")).toBe(false);
  });
});
