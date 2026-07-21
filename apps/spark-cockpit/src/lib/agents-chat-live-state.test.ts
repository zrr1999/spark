import { describe, expect, expectTypeOf, it } from "vitest";
import type { AgentsProductProjection } from "@zendev-lab/spark-cockpit-coordination/agents-product";
import {
  addOptimisticAgentsChatCommand,
  applyAgentsChatEvent,
  agentsCockpitSource,
  createAgentsChatLiveState,
  type AgentsChatCommandLive,
  type AgentsChatInvocationLive,
  type AgentsChatLogChunkLive,
  type AgentsChatSerializedEvent,
} from "./agents-chat-live-state";

const workspaceId = "ws_live";

function event(overrides: Partial<AgentsChatSerializedEvent> = {}): AgentsChatSerializedEvent {
  return {
    id: "evt_1",
    workspaceId,
    projectId: null,
    actorKind: "runtime",
    actorId: "rtwb_live",
    kind: "invocation.log_chunk",
    subjectKind: "invocation",
    subjectId: "inv_live",
    payload: {},
    createdAt: "2026-06-30T10:00:00.000Z",
    ...overrides,
  };
}

describe("agents chat live state", () => {
  it("uses the agents product projection rows as its live read model", () => {
    expectTypeOf<AgentsChatCommandLive>().toEqualTypeOf<
      AgentsProductProjection["commands"][number]
    >();
    expectTypeOf<AgentsChatInvocationLive>().toEqualTypeOf<
      AgentsProductProjection["invocations"][number]
    >();
    expectTypeOf<AgentsChatLogChunkLive>().toEqualTypeOf<
      AgentsProductProjection["logChunks"][number]
    >();
  });

  it("merges queued agents commands and ignores non-agents commands", () => {
    const state = createAgentsChatLiveState({
      workspaceId,
      commands: [],
      invocations: [],
      logChunks: [],
    });

    expect(
      applyAgentsChatEvent(
        state,
        event({
          id: "evt_cmd_other",
          kind: "command.queued",
          subjectKind: "command",
          subjectId: "cmd_other",
          payload: {
            command: {
              id: "cmd_other",
              kind: "task.start.request",
              title: "Other",
              payload: { kind: "task.start.request", payload: { source: "workspace-chat" } },
              status: "queued",
              deliveryStatus: "pending",
            },
          },
        }),
      ),
    ).toBe(false);

    expect(
      applyAgentsChatEvent(
        state,
        event({
          id: "evt_cmd_agents",
          kind: "command.queued",
          subjectKind: "command",
          subjectId: "cmd_agents",
          payload: {
            command: {
              id: "cmd_agents",
              kind: "task.start.request",
              title: "Agents",
              payload: {
                kind: "task.start.request",
                title: "Agents",
                payload: { source: agentsCockpitSource, prompt: "hello" },
              },
              status: "queued",
              deliveryStatus: "pending",
              createdAt: "2026-06-30T10:00:01.000Z",
            },
          },
          createdAt: "2026-06-30T10:00:01.000Z",
        }),
      ),
    ).toBe(true);

    expect(state.commands).toHaveLength(1);
    expect(state.commands[0]).toMatchObject({
      id: "cmd_agents",
      status: "queued",
      deliveryStatus: "pending",
    });
    expect(state.cursor).toBe("2026-06-30T10:00:01.000Z|evt_cmd_agents");
  });

  it("reconciles optimistic user commands when the server command arrives", () => {
    const state = createAgentsChatLiveState({
      workspaceId,
      commands: [],
      invocations: [],
      logChunks: [],
    });

    const optimisticId = addOptimisticAgentsChatCommand(state, {
      prompt: "hello optimistic",
      createdAt: "2026-06-30T10:00:00.000Z",
    });
    expect(optimisticId).toMatch(/^optimistic-/u);
    expect(state.commands).toHaveLength(1);

    expect(
      applyAgentsChatEvent(
        state,
        event({
          id: "evt_cmd_real",
          kind: "command.queued",
          subjectKind: "command",
          subjectId: "cmd_real",
          payload: {
            command: {
              id: "cmd_real",
              kind: "task.start.request",
              title: "Real",
              payload: {
                kind: "task.start.request",
                title: "Real",
                payload: { source: agentsCockpitSource, prompt: "hello optimistic" },
              },
              status: "queued",
              deliveryStatus: "pending",
            },
          },
          createdAt: "2026-06-30T10:00:01.000Z",
        }),
      ),
    ).toBe(true);

    expect(state.commands.map((command) => command.id)).toEqual(["cmd_real"]);
  });

  it("merges invocation updates and ordered assistant token chunks idempotently", () => {
    const state = createAgentsChatLiveState({
      workspaceId,
      commands: [
        {
          id: "cmd_agents",
          kind: "task.start.request",
          title: "Agents",
          payloadJson: JSON.stringify({
            payload: { source: agentsCockpitSource, runtimeTaskId: "task_live" },
          }),
          status: "acked",
          deliveryStatus: "acked",
          createdAt: "2026-06-30T10:00:00.000Z",
          updatedAt: "2026-06-30T10:00:00.000Z",
          attemptCount: null,
          lastAttemptAt: null,
          ackedAt: null,
          rejectedAt: null,
          rejectCode: null,
          rejectMessage: null,
          runtimeWorkspaceName: null,
          runtimeName: null,
          runtimeStatus: null,
        },
      ],
      invocations: [],
      logChunks: [],
    });

    expect(
      applyAgentsChatEvent(
        state,
        event({
          id: "evt_inv_running",
          kind: "invocation.updated",
          payload: {
            runtimeInvocationId: "inv_live",
            commandId: "cmd_agents",
            taskRuntimeId: "task_live",
            agentName: "spark-runtime",
            status: "running",
          },
          createdAt: "2026-06-30T10:00:02.000Z",
        }),
      ),
    ).toBe(true);

    const firstChunk = event({
      id: "evt_chunk_1",
      kind: "invocation.log_chunk",
      payload: {
        runtimeInvocationId: "inv_live",
        commandId: "cmd_agents",
        stream: "assistant",
        sequence: 1,
        content: "Hel",
      },
      createdAt: "2026-06-30T10:00:03.000Z",
    });
    expect(applyAgentsChatEvent(state, firstChunk)).toBe(true);
    expect(applyAgentsChatEvent(state, firstChunk)).toBe(false);
    expect(
      applyAgentsChatEvent(
        state,
        event({
          id: "evt_chunk_2",
          kind: "invocation.log_chunk",
          payload: {
            runtimeInvocationId: "inv_live",
            commandId: "cmd_agents",
            stream: "assistant",
            sequence: 2,
            content: "lo",
          },
          createdAt: "2026-06-30T10:00:04.000Z",
        }),
      ),
    ).toBe(true);

    expect(state.invocations).toMatchObject([
      { runtimeInvocationId: "inv_live", status: "running" },
    ]);
    expect(state.logChunks.map((chunk) => chunk.content)).toEqual(["Hel", "lo"]);
    expect(state.cursor).toBe("2026-06-30T10:00:04.000Z|evt_chunk_2");
  });

  it("ignores project-scoped or unrelated workspace events while still advancing cursor", () => {
    const state = createAgentsChatLiveState({
      workspaceId,
      commands: [],
      invocations: [],
      logChunks: [],
    });

    expect(
      applyAgentsChatEvent(
        state,
        event({
          id: "evt_project",
          projectId: "proj_other",
          kind: "command.queued",
          createdAt: "2026-06-30T10:00:05.000Z",
        }),
      ),
    ).toBe(false);

    expect(state.commands).toHaveLength(0);
    expect(state.cursor).toBe("2026-06-30T10:00:05.000Z|evt_project");
  });
});
