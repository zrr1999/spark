import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createId,
  runtimeProtocolVersion,
  serverCommandEnvelopeSchema,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sideThreadControl: vi.fn() }));

vi.mock("./side-thread-control.ts", () => ({
  executeSparkDaemonSideThreadControl: mocks.sideThreadControl,
}));

import { executeClaimedCommand } from "./claimed-command.ts";
import type { MessageContext, ServerSocket } from "./daemon.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";

const roots: string[] = [];

afterEach(() => {
  mocks.sideThreadControl.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class CapturingSocket implements ServerSocket {
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

function makeContext(): {
  context: MessageContext;
  workspace: ReturnType<typeof registerWorkspace>;
} {
  const root = mkdtempSync(join(tmpdir(), "spark-claimed-side-thread-"));
  roots.push(root);
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  const db = openSparkDaemonDatabase(paths);
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const workspace = registerWorkspace(db, {
    serverUrl: "https://cockpit.example.test/",
    serverWorkspaceId: "ws_22222222222222222222222222222222",
    serverBindingId: "rtwb_22222222222222222222222222222222",
    localWorkspaceKey: "side-thread-workspace",
    displayName: "Side Thread workspace",
    workspaceName: "Side Thread workspace",
    workspaceSlug: "side-thread-workspace",
    localPath: workspacePath,
  });
  return {
    context: {
      paths,
      config: { installationId: "claimed-side-thread-test", displayName: "Test daemon" },
      db,
      runtimeId: "rt_11111111111111111111111111111111",
      runtimeSessionId: undefined,
      setRuntimeSessionId() {},
      ensureHeartbeat() {},
      runSparkCommand: async () => {
        throw new Error("side-thread commands must not reach the task command bridge");
      },
      cancelSparkInvocation: async () => ({
        invocationId: "inv_unused",
        cancelled: false,
        message: "unused",
      }),
    },
    workspace,
  };
}

function command(input: {
  kind:
    | "side-thread.ensure.request"
    | "side-thread.snapshot.request"
    | "side-thread.submit.request"
    | "side-thread.reset.request"
    | "side-thread.configure.request"
    | "side-thread.handoff.request";
  payload: Record<string, unknown>;
  workspace: { bindingId: string; workspaceId: string };
}) {
  return serverCommandEnvelopeSchema.parse({
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "server.command",
    sentAt: new Date().toISOString(),
    runtimeId: "rt_11111111111111111111111111111111",
    workspaceBindingId: input.workspace.bindingId,
    workspaceId: input.workspace.workspaceId,
    commandId: createId("cmd"),
    sessionId: "parent-session",
    payload: { kind: input.kind, payload: input.payload },
  });
}

describe("claimed runtime Side Thread commands", () => {
  it.each([
    ["side-thread.ensure.request", { parentSessionId: "parent-session" }],
    ["side-thread.snapshot.request", { parentSessionId: "parent-session" }],
    [
      "side-thread.submit.request",
      {
        parentSessionId: "parent-session",
        expectedGeneration: 1,
        prompt: "investigate safely",
        idempotencyKey: "submit-one",
      },
    ],
    [
      "side-thread.reset.request",
      { parentSessionId: "parent-session", expectedGeneration: 1, mode: "tangent" },
    ],
    [
      "side-thread.configure.request",
      { parentSessionId: "parent-session", expectedGeneration: 1, thinkingOverride: null },
    ],
    [
      "side-thread.handoff.request",
      {
        parentSessionId: "parent-session",
        expectedGeneration: 1,
        expectedHeadExchangeId: "entry-one",
        kind: "summary",
        idempotencyKey: "handoff-one",
      },
    ],
  ] as const)("routes %s through the dedicated controller", async (kind, payload) => {
    const { context, workspace } = makeContext();
    const ws = new CapturingSocket();
    mocks.sideThreadControl.mockResolvedValue({
      result: { snapshot: { parentSessionId: "parent-session", generation: 1 } },
      ...(kind === "side-thread.submit.request" || kind === "side-thread.handoff.request"
        ? { invocationId: "inv_01234567890123456789012345678901" }
        : {}),
    });

    await executeClaimedCommand(
      ws,
      command({
        kind,
        payload,
        workspace: { bindingId: workspace.id, workspaceId: workspace.serverWorkspaceId! },
      }),
      context,
    );

    expect(mocks.sideThreadControl).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: context.paths,
        db: context.db,
        sessionRegistry: undefined,
        modelControl: undefined,
        actor: "spark-daemon-runtime-ws",
      }),
      {
        kind,
        scope: "workspace",
        workspaceId: workspace.serverWorkspaceId,
        workspaceBindingId: workspace.id,
        payload,
      },
    );
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0]).toMatchObject({
      type: "runtime.command.ack",
      ...(kind === "side-thread.submit.request" || kind === "side-thread.handoff.request"
        ? { invocationId: "inv_01234567890123456789012345678901" }
        : {}),
    });
    expect(ws.sent[1]).toMatchObject({
      type: "runtime.command.result",
      payload: { status: "succeeded", result: { snapshot: { generation: 1 } } },
    });
    if (kind === "side-thread.submit.request" || kind === "side-thread.handoff.request") {
      expect(ws.sent[1]).toMatchObject({ invocationId: "inv_01234567890123456789012345678901" });
    }
    context.db.close();
  });

  it("preserves workspace scope and binding authorization inputs", async () => {
    const { context, workspace } = makeContext();
    const ws = new CapturingSocket();
    mocks.sideThreadControl.mockResolvedValue({ result: { snapshot: {} } });

    await executeClaimedCommand(
      ws,
      command({
        kind: "side-thread.snapshot.request",
        payload: { parentSessionId: "parent-session" },
        workspace: { bindingId: workspace.id, workspaceId: workspace.serverWorkspaceId! },
      }),
      context,
    );

    expect(mocks.sideThreadControl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: "workspace",
        workspaceId: workspace.serverWorkspaceId,
        workspaceBindingId: workspace.id,
      }),
    );
    expect(ws.sent).toHaveLength(2);
    context.db.close();
  });
});
