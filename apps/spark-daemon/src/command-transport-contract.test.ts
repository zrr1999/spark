import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerCommandEnvelope } from "@zendev-lab/spark-protocol";
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
        params: { invocationId: "turn-file.json", reason: "stop" },
      }),
    ).toMatchObject({ kind: "turn.cancel.request", route: { invocationId: "turn-file.json" } });

    expect(
      sparkCommandFromLocalRpcRequest({
        id: "local_status",
        method: "daemon.queue",
        params: { state: "inbox" },
      }).kind,
    ).toBe("turn.status.request");
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

  it("keeps the turn spec aligned with canonical fixture vocabulary", () => {
    const spec = readFileSync(resolve("../..", "docs/specs/turn.md"), "utf8");
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          "../..",
          "packages/spark-protocol/src/fixtures/command-events-v1/vocabulary-samples.json",
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
