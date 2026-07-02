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
      id: "queue_list",
      method: "daemon.queue",
      params: { state: "inbox" },
    });
    expect(status.kind).toBe("turn.status.request");
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
