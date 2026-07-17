import { describe, expect, it } from "vitest";
import { createId } from "../refs.ts";
import { runtimeProtocolVersion } from "./envelope.ts";
import {
  humanQuestionOptionSchema,
  humanRequestCreatedPayloadSchema,
  humanResponseRecordedEnvelopeSchema,
  maxRuntimeCommandPayloadBytes,
  runtimeCommandResultEnvelopeSchema,
  runtimeMessageEnvelopeSchema,
  serverCommandEnvelopeSchema,
} from "./messages.ts";

function recordedChannelResponse() {
  return {
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "human.response.recorded" as const,
    sentAt: "2026-07-14T00:00:00.000Z",
    runtimeId: createId("rt"),
    workspaceBindingId: createId("rtwb"),
    workspaceId: createId("ws"),
    humanRequestId: createId("hreq"),
    humanResponseId: createId("hres"),
    payload: {
      source: "channel" as const,
      status: "answered" as const,
      answers: { scope: "mvp" },
      responseArtifactRefs: [],
    },
  };
}

describe("typed runtime control messages", () => {
  const base = {
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "server.command" as const,
    sentAt: "2026-07-15T00:00:00.000Z",
    runtimeId: createId("rt"),
    commandId: createId("cmd"),
  };

  it("parses explicit daemon and workspace command scopes", () => {
    expect(
      serverCommandEnvelopeSchema.parse({
        ...base,
        payload: { kind: "daemon.status.request", scope: "daemon" },
      }).payload.scope,
    ).toBe("daemon");
    expect(
      serverCommandEnvelopeSchema.parse({
        ...base,
        workspaceBindingId: createId("rtwb"),
        workspaceId: createId("ws"),
        payload: { kind: "workspace.snapshot.request", scope: "workspace" },
      }).payload.scope,
    ).toBe("workspace");
  });

  it("accepts explicit daemon and workspace session scopes with session routing", () => {
    const sessionId = "sess_runtime_control";
    expect(
      serverCommandEnvelopeSchema.parse({
        ...base,
        sessionId,
        payload: {
          kind: "session.get.request",
          scope: "daemon",
          payload: { sessionId },
        },
      }).sessionId,
    ).toBe(sessionId);
    expect(
      serverCommandEnvelopeSchema.parse({
        ...base,
        sessionId,
        workspaceBindingId: createId("rtwb"),
        workspaceId: createId("ws"),
        payload: {
          kind: "turn.submit.request",
          scope: "workspace",
          payload: { sessionId, prompt: "continue" },
        },
      }).payload.scope,
    ).toBe("workspace");
  });

  it("reports every missing workspace route at the envelope field", () => {
    const parsed = serverCommandEnvelopeSchema.safeParse({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "server.command",
      sentAt: "2026-07-15T00:00:00.000Z",
      payload: { kind: "workspace.snapshot.request", scope: "workspace" },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["runtimeId"],
          message: "server.command requires runtimeId",
        }),
        expect.objectContaining({
          path: ["commandId"],
          message: "server.command requires commandId",
        }),
        expect.objectContaining({
          path: ["workspaceBindingId"],
          message: "server.command requires workspaceBindingId",
        }),
        expect.objectContaining({
          path: ["workspaceId"],
          message: "server.command requires workspaceId",
        }),
      ]),
    );
  });

  it("rejects scope spoofing, unknown routes, secret payloads, RPC tunnels, and oversize input", () => {
    expect(
      serverCommandEnvelopeSchema.safeParse({
        ...base,
        payload: { kind: "daemon.status.request", scope: "workspace" },
      }).success,
    ).toBe(false);
    expect(
      serverCommandEnvelopeSchema.safeParse({
        ...base,
        runtimeId: createId("rt"),
        workspaceBindingId: createId("rtwb"),
        workspaceId: createId("ws"),
        payload: { kind: "daemon.status.request", scope: "daemon" },
      }).success,
    ).toBe(false);
    for (const payload of [
      { apiKey: "must-not-cross" },
      { nested: { refresh_token: "must-not-cross" } },
      { method: "daemon.status", params: {} },
      { content: "x".repeat(maxRuntimeCommandPayloadBytes + 1) },
    ]) {
      expect(
        serverCommandEnvelopeSchema.safeParse({
          ...base,
          payload: { kind: "daemon.status.request", scope: "daemon", payload },
        }).success,
      ).toBe(false);
    }
  });

  it("measures the command payload limit in encoded JSON bytes", () => {
    expect(
      serverCommandEnvelopeSchema.safeParse({
        ...base,
        payload: {
          kind: "daemon.status.request",
          scope: "daemon",
          payload: { content: "x".repeat(maxRuntimeCommandPayloadBytes / 2) },
        },
      }).success,
    ).toBe(true);

    const parsed = serverCommandEnvelopeSchema.safeParse({
      ...base,
      payload: {
        kind: "daemon.status.request",
        scope: "daemon",
        payload: { content: "界".repeat(maxRuntimeCommandPayloadBytes / 2) },
      },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["payload", "payload"],
        message: `Payload exceeds ${maxRuntimeCommandPayloadBytes} bytes`,
      }),
    );
  });

  it("parses one bounded terminal result and rejects secret or oversize results", () => {
    const result = {
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.result" as const,
      sentAt: "2026-07-15T00:00:01.000Z",
      runtimeId: base.runtimeId,
      commandId: base.commandId,
      ackOf: base.messageId,
      payload: {
        status: "succeeded" as const,
        result: { invocations: { running: 0 } },
        projection: { kind: "daemon.status" as const, data: { online: true } },
        completedAt: "2026-07-15T00:00:01.000Z",
      },
    };
    expect(runtimeCommandResultEnvelopeSchema.parse(result).payload.status).toBe("succeeded");
    expect(runtimeMessageEnvelopeSchema.parse(result).type).toBe("runtime.command.result");
    expect(
      runtimeCommandResultEnvelopeSchema.safeParse({ ...result, runtimeId: undefined }).success,
    ).toBe(false);
    expect(
      runtimeCommandResultEnvelopeSchema.safeParse({ ...result, commandId: undefined }).success,
    ).toBe(false);
    expect(
      runtimeCommandResultEnvelopeSchema.safeParse({
        ...result,
        payload: { ...result.payload, result: { accessToken: "must-not-cross" } },
      }).success,
    ).toBe(false);
    expect(
      runtimeCommandResultEnvelopeSchema.safeParse({
        ...result,
        payload: { ...result.payload, result: { content: "x".repeat(65_536) } },
      }).success,
    ).toBe(false);
  });
});

describe("runtime human response messages", () => {
  it("accepts a routed channel response as an already-recorded runtime fact", () => {
    const envelope = recordedChannelResponse();

    expect(humanResponseRecordedEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(runtimeMessageEnvelopeSchema.parse(envelope).type).toBe("human.response.recorded");
  });

  it("accepts a daemon-originated cancellation as an already-recorded runtime fact", () => {
    const envelope = recordedChannelResponse();
    expect(
      humanResponseRecordedEnvelopeSchema.parse({
        ...envelope,
        payload: {
          ...envelope.payload,
          source: "daemon",
          status: "cancelled",
          answers: {},
        },
      }).payload,
    ).toMatchObject({ source: "daemon", status: "cancelled" });
  });

  it("rejects non-channel sources for runtime-recorded responses", () => {
    const envelope = recordedChannelResponse();

    expect(
      humanResponseRecordedEnvelopeSchema.safeParse({
        ...envelope,
        payload: { ...envelope.payload, source: "cockpit" },
      }).success,
    ).toBe(false);
  });
});

describe("human question option identity", () => {
  it("normalizes canonical value and legacy id to the ask option value field", () => {
    expect(humanQuestionOptionSchema.parse({ value: "mvp", label: "MVP" })).toEqual({
      value: "mvp",
      label: "MVP",
    });
    expect(humanQuestionOptionSchema.parse({ id: "legacy", label: "Legacy" })).toEqual({
      value: "legacy",
      label: "Legacy",
    });
    expect(
      humanRequestCreatedPayloadSchema.parse({
        kind: "ask_user",
        title: "Scope",
        prompt: "Pick a scope",
        questions: [
          {
            id: "scope",
            type: "single",
            prompt: "Scope?",
            options: [{ id: "mvp", label: "MVP" }],
          },
        ],
      }).questions[0]?.options,
    ).toEqual([{ value: "mvp", label: "MVP" }]);
  });
});
