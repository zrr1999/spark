import { describe, expect, it } from "vitest";
import { createServerCommandEnvelope } from "@zendev-lab/spark-protocol";
import {
  decideSparkDaemonCommandPolicy,
  sparkCommandFromLocalRpcRequest,
  sparkCommandFromServerCommandEnvelope,
} from "./command-dispatcher.ts";

describe("Spark daemon command dispatcher", () => {
  const route = {
    runtimeId: "rt_01234567890123456789012345678901",
    workspaceBindingId: "rtwb_01234567890123456789012345678901",
    workspaceId: "ws_01234567890123456789012345678901",
    projectId: "proj_01234567890123456789012345678901",
    commandId: "cmd_01234567890123456789012345678901",
  };

  it("adapts local RPC methods into SparkCommand intents", () => {
    const submit = sparkCommandFromLocalRpcRequest({
      id: "rpc_submit",
      method: "turn.submit",
      params: { sessionId: "session-a", prompt: "continue" },
    });
    expect(submit).toMatchObject({
      id: "rpc_submit",
      kind: "turn.submit.request",
      route: { sessionId: "session-a" },
      payload: { sessionId: "session-a", prompt: "continue" },
      transport: { kind: "local-rpc", method: "turn.submit", requestId: "rpc_submit" },
    });

    const status = sparkCommandFromLocalRpcRequest({
      id: "turn_status",
      method: "turn.status",
      params: { invocationId: "inv_01234567890123456789012345678901" },
    });
    expect(status).toMatchObject({
      kind: "turn.status.request",
      route: { invocationId: "inv_01234567890123456789012345678901" },
    });
    expect(() =>
      sparkCommandFromLocalRpcRequest({ id: "removed_queue", method: "daemon.queue" }),
    ).toThrow(/Unknown local RPC command method/u);

    const credential = sparkCommandFromLocalRpcRequest({
      id: "auth_key",
      method: "provider.auth.api-key.set",
      params: { providerName: "openai", apiKey: "must-not-enter-command-traces" },
    });
    expect(credential).toMatchObject({
      kind: "provider.auth.api_key.set.request",
      payload: {},
    });
  });

  it("adapts runtime server.command envelopes into SparkCommand intents", () => {
    const envelope = createServerCommandEnvelope({
      ...route,
      messageId: "msg_01234567890123456789012345678901",
      sentAt: "2026-07-02T00:00:00.000Z",
      payload: {
        kind: "task.start.request",
        title: "Run task",
        payload: { prompt: "inspect" },
      },
    });

    expect(sparkCommandFromServerCommandEnvelope(envelope)).toMatchObject({
      id: route.commandId,
      kind: "task.start.request",
      title: "Run task",
      route,
      payload: { prompt: "inspect" },
      requestedAt: "2026-07-02T00:00:00.000Z",
      transport: {
        kind: "runtime-ws",
        envelopeType: "server.command",
        messageId: "msg_01234567890123456789012345678901",
        sourceKind: "task.start.request",
      },
    });
  });

  it("applies the typed runtime control scope and mutation policy matrix", () => {
    const knownWorkspaceBindingIds = new Set([route.workspaceBindingId]);
    const task = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        payload: { kind: "task.start.request", payload: { prompt: "mutate" } },
      }),
    );
    const snapshot = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        commandId: "cmd_11111111111111111111111111111111",
        payload: { kind: "workspace.snapshot.request" },
      }),
    );
    const daemonStatus = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        runtimeId: route.runtimeId,
        commandId: "cmd_22222222222222222222222222222222",
        payload: { kind: "daemon.status.request" },
      }),
    );

    expect(
      decideSparkDaemonCommandPolicy({
        command: daemonStatus,
        runtimeId: route.runtimeId,
        expectedRuntimeId: route.runtimeId,
        knownWorkspaceBindingIds,
      }),
    ).toEqual({ accepted: true });
    expect(
      decideSparkDaemonCommandPolicy({
        command: daemonStatus,
        runtimeId: "rt_99999999999999999999999999999999",
        expectedRuntimeId: route.runtimeId,
        knownWorkspaceBindingIds,
      }),
    ).toMatchObject({ accepted: false, reasonCode: "RUNTIME_ID_MISMATCH" });
    expect(
      decideSparkDaemonCommandPolicy({
        command: task,
        workspaceBindingId: "rtwb_missing",
        knownWorkspaceBindingIds,
      }),
    ).toMatchObject({ accepted: false, reasonCode: "UNKNOWN_WORKSPACE_BINDING" });
    expect(
      decideSparkDaemonCommandPolicy({
        command: task,
        workspaceBindingId: route.workspaceBindingId,
        knownWorkspaceBindingIds,
        workspaceAccess: { borrowed: true },
      }),
    ).toMatchObject({ accepted: false, reasonCode: "WORKSPACE_BORROWED" });
    expect(
      decideSparkDaemonCommandPolicy({
        command: task,
        workspaceBindingId: route.workspaceBindingId,
        knownWorkspaceBindingIds,
        workspaceAccess: { detached: true },
      }),
    ).toMatchObject({ accepted: false, reasonCode: "WORKSPACE_DETACHED" });
    expect(
      decideSparkDaemonCommandPolicy({
        command: task,
        workspaceBindingId: route.workspaceBindingId,
        knownWorkspaceBindingIds,
        allowMutation: false,
      }),
    ).toMatchObject({ accepted: false, reasonCode: "MUTATION_NOT_ALLOWED" });
    expect(
      decideSparkDaemonCommandPolicy({
        command: snapshot,
        workspaceBindingId: route.workspaceBindingId,
        knownWorkspaceBindingIds,
        workspaceAccess: { borrowed: true, detached: true },
      }),
    ).toEqual({ accepted: true });
  });

  it("centralizes workspace ownership and borrowed-workspace decisions", () => {
    const knownWorkspaceBindingIds = new Set([route.workspaceBindingId]);
    const task = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        payload: { kind: "task.start.request", payload: { prompt: "mutate" } },
      }),
    );
    const snapshot = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        commandId: "cmd_11111111111111111111111111111111",
        payload: { kind: "workspace.snapshot.request" },
      }),
    );

    expect(
      decideSparkDaemonCommandPolicy({
        command: task,
        workspaceBindingId: route.workspaceBindingId,
        knownWorkspaceBindingIds,
        workspaceAccess: { borrowed: true },
      }),
    ).toMatchObject({ accepted: false, reasonCode: "WORKSPACE_BORROWED", retryable: true });
    expect(
      decideSparkDaemonCommandPolicy({
        command: snapshot,
        workspaceBindingId: route.workspaceBindingId,
        knownWorkspaceBindingIds,
        workspaceAccess: { borrowed: true },
      }).accepted,
    ).toBe(true);
    expect(
      decideSparkDaemonCommandPolicy({
        command: task,
        workspaceBindingId: "rtwb_missing",
        knownWorkspaceBindingIds,
      }),
    ).toMatchObject({ accepted: false, reasonCode: "UNKNOWN_WORKSPACE_BINDING" });
  });
});
