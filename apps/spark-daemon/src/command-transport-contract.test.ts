import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createId, createServerCommandEnvelope } from "@zendev-lab/spark-protocol";
import {
  decideSparkDaemonCommandPolicy,
  sparkCommandFromLocalRpcRequest,
  sparkCommandFromServerCommandEnvelope,
} from "./command-dispatcher.ts";

const route = {
  runtimeId: "rt_01234567890123456789012345678901",
  workspaceBindingId: "rtwb_01234567890123456789012345678901",
  workspaceId: "ws_01234567890123456789012345678901",
  projectId: "proj_01234567890123456789012345678901",
  commandId: "cmd_01234567890123456789012345678901",
};
const knownWorkspaceBindingIds = new Set([route.workspaceBindingId]);

describe("turn command transport contract", () => {
  it("normalizes local socket submit/cancel/status to SparkCommand", () => {
    expect(
      sparkCommandFromLocalRpcRequest({ id: "local_restart", method: "daemon.restart" }).kind,
    ).toBe("daemon.restart.request");
    expect(
      sparkCommandFromLocalRpcRequest({
        id: "local_side_thread",
        method: "side-thread.ensure",
        params: { parentSessionId: "session-a" },
      }),
    ).toMatchObject({ kind: "side-thread.ensure.request", route: { sessionId: "session-a" } });

    expect(
      sparkCommandFromLocalRpcRequest({
        id: "local_submit",
        method: "turn.submit",
        params: { sessionId: "session-a", prompt: "continue" },
      }),
    ).toMatchObject({ kind: "turn.submit.request", route: { sessionId: "session-a" } });

    expect(
      sparkCommandFromLocalRpcRequest({
        id: "local_cancel",
        method: "turn.cancel",
        params: { invocationId: "inv_01234567890123456789012345678901", reason: "stop" },
      }),
    ).toMatchObject({
      kind: "turn.cancel.request",
      route: { invocationId: "inv_01234567890123456789012345678901" },
    });

    expect(
      sparkCommandFromLocalRpcRequest({
        id: "local_status",
        method: "turn.status",
        params: { invocationId: "inv_01234567890123456789012345678901" },
      }).kind,
    ).toBe("turn.status.request");
    expect(() =>
      sparkCommandFromLocalRpcRequest({ id: "removed_queue", method: "daemon.queue" }),
    ).toThrow(/Unknown local RPC command method/u);
  });

  it("normalizes runtime WebSocket submit/cancel/status to SparkCommand", () => {
    const submit = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        payload: { kind: "task.start.request", payload: { prompt: "run" } },
      }),
    );
    expect(submit).toMatchObject({ kind: "task.start.request", route });

    const cancel = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        commandId: "cmd_11111111111111111111111111111111",
        payload: {
          kind: "invocation.cancel.request",
          payload: { runtimeInvocationId: "inv_01234567890123456789012345678901" },
        },
      }),
    );
    expect(cancel).toMatchObject({
      kind: "invocation.cancel.request",
      payload: { runtimeInvocationId: "inv_01234567890123456789012345678901" },
    });

    const status = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        commandId: "cmd_22222222222222222222222222222222",
        payload: { kind: "workspace.snapshot.request" },
      }),
    );
    expect(status.kind).toBe("workspace.snapshot.request");
  });

  it("normalizes session create/bind/archive and turn submit/cancel across both transports", () => {
    const sessionId = "sess_transport_contract";
    for (const [method, kind, params] of [
      [
        "session.create",
        "session.create.request",
        { sessionId, scope: { kind: "daemon" }, title: "Transport contract" },
      ],
      [
        "session.bind",
        "session.bind.request",
        { sessionId, externalKey: "infoflow:user:transport" },
      ],
      ["session.archive", "session.archive.request", { sessionId }],
      ["turn.submit", "turn.submit.request", { sessionId, prompt: "continue" }],
    ] as const) {
      const local = sparkCommandFromLocalRpcRequest({
        id: `local_${kind}`,
        method,
        params,
      });
      const runtime = sparkCommandFromServerCommandEnvelope(
        createServerCommandEnvelope({
          runtimeId: route.runtimeId,
          sessionId,
          commandId: createId("cmd"),
          payload: { kind, scope: "daemon", payload: params },
        }),
      );
      expect(local).toMatchObject({ kind, route: { sessionId }, payload: params });
      expect(runtime).toMatchObject({ kind, route: { sessionId }, payload: params });
      expect(
        decideSparkDaemonCommandPolicy({
          command: runtime,
          runtimeId: route.runtimeId,
          expectedRuntimeId: route.runtimeId,
          allowMutation: true,
        }),
      ).toEqual({ accepted: true });
    }

    const cancelParams = {
      invocationId: "inv_01234567890123456789012345678901",
      reason: "stop",
    };
    const localCancel = sparkCommandFromLocalRpcRequest({
      id: "local_session_cancel",
      method: "turn.cancel",
      params: cancelParams,
    });
    const runtimeCancel = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        runtimeId: route.runtimeId,
        sessionId,
        commandId: createId("cmd"),
        payload: {
          kind: "turn.cancel.request",
          scope: "daemon",
          payload: cancelParams,
        },
      }),
    );
    expect(localCancel).toMatchObject({ kind: "turn.cancel.request", payload: cancelParams });
    expect(runtimeCancel).toMatchObject({
      kind: "turn.cancel.request",
      route: { sessionId },
      payload: cancelParams,
    });
  });

  it("uses one daemon policy path for transport-independent errors", () => {
    const submit = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        payload: { kind: "task.start.request", payload: { prompt: "run" } },
      }),
    );
    const cancel = sparkCommandFromServerCommandEnvelope(
      createServerCommandEnvelope({
        ...route,
        commandId: "cmd_33333333333333333333333333333333",
        payload: {
          kind: "invocation.cancel.request",
          payload: { runtimeInvocationId: "inv_01234567890123456789012345678901" },
        },
      }),
    );

    expect(
      decideSparkDaemonCommandPolicy({
        command: submit,
        workspaceBindingId: route.workspaceBindingId,
        knownWorkspaceBindingIds,
        workspaceAccess: { borrowed: true },
      }),
    ).toMatchObject({ accepted: false, reasonCode: "WORKSPACE_BORROWED", retryable: true });
    expect(
      decideSparkDaemonCommandPolicy({
        command: cancel,
        workspaceBindingId: route.workspaceBindingId,
        knownWorkspaceBindingIds,
        workspaceAccess: { borrowed: true, detached: true },
      }).accepted,
    ).toBe(true);
    expect(
      decideSparkDaemonCommandPolicy({
        command: submit,
        workspaceBindingId: "rtwb_missing",
        knownWorkspaceBindingIds,
      }),
    ).toMatchObject({ accepted: false, reasonCode: "UNKNOWN_WORKSPACE_BINDING" });
  });

  it("keeps runtime WebSocket control schema-only without RPC or HTTP tunneling", () => {
    const daemonSource = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
    const dispatcherSource = readFileSync(
      new URL("./command-dispatcher.ts", import.meta.url),
      "utf8",
    );

    expect(daemonSource).toContain("serverCommandEnvelopeSchema.safeParse");
    expect(daemonSource).not.toContain("command.payload.scope ??");
    expect(daemonSource).toContain('reasonCode: "WORKSPACE_ROUTE_MISMATCH"');
    for (const source of [daemonSource, dispatcherSource]) {
      expect(source).not.toMatch(/requestSparkDaemonLocalRpcWire/u);
      expect(source).not.toMatch(/from ["']node:http["']/u);
      expect(source).not.toMatch(/command\.payload\.(?:method|params)/u);
    }
  });

  it("keeps the turn spec aligned with canonical fixture vocabulary", () => {
    const spec = readFileSync(
      fileURLToPath(new URL("../../../docs/specs/turn.md", import.meta.url)),
      "utf8",
    );
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../packages/spark-protocol/src/fixtures/command-events-v1/vocabulary-samples.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as { commands: Array<{ kind: string }>; events: Array<{ kind: string }> };

    for (const command of fixture.commands) expect(spec).toContain(command.kind);
    for (const event of fixture.events) expect(spec).toContain(event.kind);
    expect(spec).toContain("SparkCommand");
    expect(spec).toContain("SparkEvent");
  });
});
