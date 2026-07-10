import { describe, expect, it } from "vitest";
import {
  createServerCommandEnvelope,
  normalizeServerCommandForExecution,
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

  it("normalizes assignment.create.request into the task execution payload", () => {
    const assignment = {
      goal: "Review the assignment execution path.",
      target: {
        sessionId: "sess_runtime_assign",
        workspaceId: routing.workspaceId,
        role: "role:reviewer",
      },
      constraints: ["preserve assignment metadata"],
      evidence: ["runtime websocket"],
      source: { kind: "cockpit" },
      title: "Review assignment",
    };
    const envelope = createServerCommandEnvelope({
      ...routing,
      payload: {
        kind: "assignment.create.request",
        title: "Assign reviewer",
        payload: assignment,
      },
    });

    const result = normalizeServerCommandForExecution(envelope);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.envelope).toMatchObject({
      ...envelope,
      payload: {
        kind: "task.start.request",
        title: "Assign reviewer",
        payload: {
          ...assignment,
          prompt: assignment.goal,
          sessionId: assignment.target.sessionId,
          assignment,
        },
      },
    });
  });

  it("rejects invalid assignment.create.request payloads before execution normalization", () => {
    const envelope = createServerCommandEnvelope({
      ...routing,
      payload: {
        kind: "assignment.create.request",
        payload: {
          goal: "Invalid assignment",
          target: { sessionId: "sess_runtime_assign" },
          source: { kind: "legacy-chat" },
        },
      },
    });

    expect(normalizeServerCommandForExecution(envelope)).toMatchObject({
      ok: false,
      reasonCode: "ASSIGNMENT_INVALID",
      retryable: false,
    });
  });

  it("rejects blank assignment goals before deriving an execution title", () => {
    const envelope = createServerCommandEnvelope({
      ...routing,
      payload: {
        kind: "assignment.create.request",
        payload: {
          goal: "   ",
          target: { sessionId: "sess_runtime_assign" },
          source: { kind: "cockpit" },
        },
      },
    });

    expect(normalizeServerCommandForExecution(envelope)).toMatchObject({
      ok: false,
      reasonCode: "ASSIGNMENT_INVALID",
      message: "goal must be non-blank",
    });
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
