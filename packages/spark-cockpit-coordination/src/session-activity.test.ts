import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import { loadSessionActivity } from "./session-activity";
import {
  appendEvent,
  createWorkspaceWithOwnerBinding,
  queueCommandForWorkspaceOwner,
  recordInvocationLogChunk,
  recordInvocationUpdate,
} from "./projection-services";
import { recordRuntimeControlCommandResult, submitRuntimeControlCommand } from "./runtime-control";
import { recordRuntimeSessionControlProjection } from "./runtime-session-control";

function setupWorkspace() {
  const db = openMemoryDatabase();
  migrate(db);
  const now = "2026-07-09T00:00:00.000Z";
  const runtimeId = createId("rt");
  const runtimeWorkspaceBindingId = createId("rtwb");
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, ?, 'Runtime', 'online', ?, '{}', '{}', ?, ?)`,
  ).run(runtimeId, "install", runtimeProtocolVersion, now, now);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'spore', 'Spore workspace', 'available', '{}', '{}', ?, ?)`,
  ).run(runtimeWorkspaceBindingId, runtimeId, now, now);
  const workspace = createWorkspaceWithOwnerBinding(db, {
    slug: "spore",
    name: "spore",
    runtimeWorkspaceBindingId,
    createdAt: now,
  });
  return { db, workspace, runtimeId, runtimeWorkspaceBindingId };
}

function projectRuntimeSession(
  db: ReturnType<typeof openMemoryDatabase>,
  input: {
    runtimeId: string;
    runtimeWorkspaceBindingId: string;
    workspaceId: string;
    sessionId: string;
    createdAt: string;
  },
) {
  db.prepare(
    `INSERT OR IGNORE INTO runtime_session_projections
      (runtime_id, session_id, scope, workspace_id, runtime_workspace_binding_id, status,
       record_json, projected_at)
     VALUES (?, ?, 'workspace', ?, ?, 'ready', ?, ?)`,
  ).run(
    input.runtimeId,
    input.sessionId,
    input.workspaceId,
    input.runtimeWorkspaceBindingId,
    JSON.stringify({
      sessionId: input.sessionId,
      scope: { kind: "workspace", workspaceId: input.workspaceId },
      workspaceId: input.workspaceId,
      title: input.sessionId,
      status: "ready",
      bindings: [],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    }),
    input.createdAt,
  );
}

function submitProjectedTurn(
  db: ReturnType<typeof openMemoryDatabase>,
  input: {
    runtimeId: string;
    runtimeWorkspaceBindingId: string;
    workspaceId: string;
    sessionId: string;
    invocationId: string;
    prompt: string;
    status: "queued" | "running";
    createdAt: string;
    startedAt?: string;
  },
) {
  projectRuntimeSession(db, input);
  const command = submitRuntimeControlCommand(db, {
    runtimeId: input.runtimeId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    payload: {
      kind: "turn.submit.request",
      scope: "workspace",
      payload: { sessionId: input.sessionId, prompt: input.prompt },
    },
    createdAt: input.createdAt,
  });
  recordRuntimeControlCommandResult(db, {
    runtimeId: input.runtimeId,
    commandId: command.commandId,
    messageId: createId("msg"),
    payload: {
      status: "succeeded",
      result: {
        invocationId: input.invocationId,
        status: "queued",
        acceptedAt: input.createdAt,
      },
      completedAt: input.createdAt,
    },
    project: (persisted, result) => recordRuntimeSessionControlProjection(db, persisted, result),
  });
  if (input.status === "running") {
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId: input.runtimeWorkspaceBindingId,
      workspaceId: input.workspaceId,
      payload: {
        runtimeInvocationId: input.invocationId,
        sequence: 1,
        status: "running",
        startedAt: input.startedAt ?? input.createdAt,
        payload: {},
      },
      updatedAt: input.startedAt ?? input.createdAt,
    });
  }
  return command;
}

describe("session activity projection", () => {
  it("retains the structured run kind on daemon run reports", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const sessionId = "sess_session_run";
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: sessionId,
      payload: {
        type: "daemon.view_event",
        sessionId,
        view: {
          type: "run.update",
          sessionId,
          run: {
            id: `${sessionId}:run:1`,
            kind: "session",
            status: "succeeded",
          },
        },
      },
      createdAt: "2026-07-09T00:01:00.000Z",
    });

    expect(loadSessionActivity(db, { workspaceId: workspace.id, sessionId }).reports).toEqual([
      expect.objectContaining({
        id: `${sessionId}:run:1`,
        kind: "run.update",
        runKind: "session",
      }),
    ]);
    db.close();
  });

  it("retains the daemon invocation correlation on projected user messages", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const sessionId = "sess_correlated_user";
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: sessionId,
      payload: {
        type: "daemon.view_event",
        sessionId,
        invocationId: "inv_correlated_user",
        view: {
          type: "session.message",
          sessionId,
          message: {
            id: `${sessionId}:message:user:live:1`,
            role: "user",
            text: "Repeatable prompt",
            status: "done",
            metadata: {},
          },
        },
      },
      createdAt: "2026-07-09T00:01:00.000Z",
    });

    const activity = loadSessionActivity(db, { workspaceId: workspace.id, sessionId });

    expect(activity.reports).toEqual([
      expect.objectContaining({
        kind: "session.message",
        message: expect.objectContaining({
          role: "user",
          metadata: { invocationId: "inv_correlated_user" },
        }),
      }),
    ]);
    db.close();
  });

  it("folds a live user projection into its direct turn without merging equal text across turns", () => {
    const { db, workspace, runtimeId, runtimeWorkspaceBindingId } = setupWorkspace();
    const sessionId = "sess_correlated_direct_turn";
    const prompt = "Repeatable prompt";
    const invocationId = "inv_correlateddirectturn";
    submitProjectedTurn(db, {
      runtimeId,
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      sessionId,
      invocationId,
      prompt,
      status: "running",
      createdAt: "2026-07-09T00:01:00.000Z",
    });
    for (const [eventInvocationId, createdAt] of [
      [invocationId, "2026-07-09T00:01:01.000Z"],
      ["inv_differentturn", "2026-07-09T00:01:02.000Z"],
    ] as const) {
      appendEvent(db, {
        workspaceId: workspace.id,
        actorKind: "runtime",
        actorId: runtimeWorkspaceBindingId,
        kind: "daemon.view_event",
        subjectKind: "view_model",
        subjectId: sessionId,
        payload: {
          type: "daemon.view_event",
          sessionId,
          invocationId: eventInvocationId,
          view: {
            type: "session.message",
            sessionId,
            message: {
              id: `${sessionId}:message:user:${eventInvocationId}`,
              role: "user",
              text: prompt,
              status: "done",
              metadata: {},
            },
          },
        },
        createdAt,
      });
    }

    const activity = loadSessionActivity(db, { workspaceId: workspace.id, sessionId });
    const userReports = activity.reports.filter((report) => report.role === "user");

    expect(userReports).toHaveLength(2);
    expect(userReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "turn.submit.prompt",
          invocationId,
          text: prompt,
        }),
        expect.objectContaining({
          kind: "session.message",
          invocationId: "inv_differentturn",
          text: prompt,
        }),
      ]),
    );
    expect(userReports).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "session.message",
          invocationId,
        }),
      ]),
    );
    db.close();
  });

  it("shows assigned work and daemon reports for one session", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const sessionId = "sess_ui";
    const otherSessionId = "sess_other";
    const command = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      createdAt: "2026-07-09T00:01:00.000Z",
      payload: {
        kind: "assignment.create.request",
        title: "Improve the web UI",
        payload: {
          goal: "Improve the web UI and report back.",
          target: { sessionId, workspaceId: workspace.id },
          source: { kind: "cockpit" },
        },
      },
    });
    queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      createdAt: "2026-07-09T00:02:00.000Z",
      payload: {
        kind: "assignment.create.request",
        title: "Other session",
        payload: {
          goal: "Do not include this.",
          target: { sessionId: otherSessionId, workspaceId: workspace.id },
          source: { kind: "cockpit" },
        },
      },
    });
    recordInvocationLogChunk(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      payload: {
        runtimeInvocationId: "inv_ui",
        stream: "agent",
        sequence: 1,
        content: "Implemented the UI update.",
      },
      createdAt: "2026-07-09T00:03:00.000Z",
    });
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      payload: {
        runtimeInvocationId: "inv_ui",
        status: "succeeded",
        agentName: "spark-runtime",
        payload: {},
      },
      updatedAt: "2026-07-09T00:04:00.000Z",
    });
    const invocation = db
      .prepare("SELECT id FROM mirrored_invocations WHERE command_id = ?")
      .get(command.id) as { id: string };
    db.prepare(
      `INSERT INTO artifacts
        (id, workspace_id, project_id, scope, kind, title, format, source, runtime_workspace_binding_id,
         invocation_id, human_request_id, content_ref_json, provenance_json, created_at, updated_at)
       VALUES (?, ?, NULL, 'workspace', 'trace', ?, 'json', 'runtime', ?, ?, NULL, ?, '{}', ?, ?)`,
    ).run(
      "art_ui",
      workspace.id,
      "Role run report",
      runtimeWorkspaceBindingId,
      invocation.id,
      JSON.stringify({ assistantTextPreview: "Blocked: missing browser evidence." }),
      "2026-07-09T00:04:30.000Z",
      "2026-07-09T00:04:30.000Z",
    );
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: sessionId,
      payload: {
        type: "daemon.view_event",
        sessionId,
        view: {
          type: "session.message",
          sessionId,
          message: {
            id: "msg_done",
            role: "assistant",
            text: "UI improvement is still streaming…",
            status: "streaming",
          },
        },
      },
      createdAt: "2026-07-09T00:04:45.000Z",
    });
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: sessionId,
      payload: {
        type: "daemon.view_event",
        sessionId,
        view: {
          type: "session.message",
          sessionId,
          message: {
            id: "msg_done",
            role: "assistant",
            text: "UI improvement completed and verified.",
            status: "done",
            parts: [
              {
                id: "msg_done:part:0",
                type: "text",
                text: "Checking the UI.",
                phase: "commentary",
                status: "complete",
              },
              {
                id: "msg_done:part:1",
                type: "tool-call",
                toolCallId: "call-ui",
                toolName: "browser_check",
                status: "complete",
              },
              {
                id: "msg_done:part:2",
                type: "text",
                text: "UI improvement completed and verified.",
                phase: "final_answer",
                status: "complete",
              },
            ],
          },
        },
      },
      createdAt: "2026-07-09T00:05:00.000Z",
    });

    const activity = loadSessionActivity(db, { workspaceId: workspace.id, sessionId });

    expect(activity.commands).toEqual([
      expect.objectContaining({
        id: command.id,
        goal: "Improve the web UI and report back.",
        invocationId: "inv_ui",
        invocationStatus: "succeeded",
        latestLog: "Implemented the UI update.",
      }),
    ]);
    expect(activity.reports).toEqual([
      expect.objectContaining({
        id: "message:msg_done",
        kind: "session.message",
        role: "assistant",
        text: "UI improvement completed and verified.",
        message: expect.objectContaining({
          id: "msg_done",
          parts: [
            expect.objectContaining({ type: "text", phase: "commentary" }),
            expect.objectContaining({ type: "tool-call", toolName: "browser_check" }),
            expect.objectContaining({ type: "text", phase: "final_answer" }),
          ],
        }),
      }),
      expect.objectContaining({
        id: "art_ui",
        kind: "evidence.trace",
        role: "assistant",
        status: "blocked",
        text: "Blocked: missing browser evidence.",
        title: "Role run report",
      }),
    ]);
    db.close();
  });

  it("queries the selected session directly instead of truncating through workspace activity", () => {
    const { db, workspace } = setupWorkspace();
    const selectedSessionId = "sess_long_running";
    const selected = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      createdAt: "2026-07-09T00:00:30.000Z",
      payload: {
        kind: "assignment.create.request",
        title: "Keep this older turn",
        payload: {
          goal: "Keep the complete conversation visible.",
          target: { sessionId: selectedSessionId, workspaceId: workspace.id },
          source: { kind: "cockpit" },
        },
      },
    });

    for (let index = 0; index < 90; index += 1) {
      queueCommandForWorkspaceOwner(db, {
        workspaceId: workspace.id,
        createdAt: new Date(Date.UTC(2026, 6, 9, 1, index)).toISOString(),
        payload: {
          kind: "assignment.create.request",
          title: `Other session ${index}`,
          payload: {
            goal: `Do not include ${index}.`,
            target: { sessionId: `sess_other_${index}`, workspaceId: workspace.id },
            source: { kind: "cockpit" },
          },
        },
      });
    }

    for (let index = 0; index < 24; index += 1) {
      queueCommandForWorkspaceOwner(db, {
        workspaceId: workspace.id,
        createdAt: new Date(Date.UTC(2026, 6, 10, 1, index)).toISOString(),
        payload: {
          kind: "assignment.create.request",
          title: `Selected turn ${index}`,
          payload: {
            goal: `Selected conversation turn ${index}.`,
            target: { sessionId: selectedSessionId, workspaceId: workspace.id },
            source: { kind: "cockpit" },
          },
        },
      });
    }

    const activity = loadSessionActivity(db, {
      workspaceId: workspace.id,
      sessionId: selectedSessionId,
    });

    expect(activity.commands).toHaveLength(25);
    expect(activity.commands.some((command) => command.id === selected.id)).toBe(true);
    expect(
      activity.commands.every(
        (command) => command.goal?.includes("Selected") || command.id === selected.id,
      ),
    ).toBe(true);
    db.close();
  });

  it("projects queued and running direct turns in FIFO order with workspace and session isolation", () => {
    const { db, workspace, runtimeId, runtimeWorkspaceBindingId } = setupWorkspace();
    const sessionId = "sess_queue";
    const running = submitProjectedTurn(db, {
      runtimeId,
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      sessionId,
      invocationId: "inv_queuerunning",
      prompt: "Inspect the current running turn.",
      status: "running",
      createdAt: "2026-07-09T00:01:00.000Z",
      startedAt: "2026-07-09T00:01:30.000Z",
    });
    const queued = submitProjectedTurn(db, {
      runtimeId,
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      sessionId,
      invocationId: "inv_queuefollowup",
      prompt: "Then run the queued follow-up.",
      status: "queued",
      createdAt: "2026-07-09T00:02:00.000Z",
    });

    const terminal = submitProjectedTurn(db, {
      runtimeId,
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      sessionId,
      invocationId: "inv_queuestale",
      prompt: "Do not retain a command whose latest invocation is terminal.",
      status: "queued",
      createdAt: "2026-07-09T00:03:00.000Z",
    });
    db.prepare(
      `INSERT INTO runtime_invocation_projections
        (runtime_id, runtime_invocation_id, session_id, scope, workspace_id,
         runtime_workspace_binding_id, command_id, status, event_cursor, completed_at,
         payload_json, created_at, updated_at)
       VALUES (?, ?, ?, 'workspace', ?, ?, ?, 'succeeded', 2, ?, '{}', ?, ?)`,
    ).run(
      runtimeId,
      "inv_queueterminal",
      sessionId,
      workspace.id,
      runtimeWorkspaceBindingId,
      terminal.commandId,
      "2026-07-09T00:04:00.000Z",
      "2026-07-09T00:03:30.000Z",
      "2026-07-09T00:04:00.000Z",
    );

    submitProjectedTurn(db, {
      runtimeId,
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      sessionId: "sess_queue_other",
      invocationId: "inv_othersession",
      prompt: "Do not include another session.",
      status: "queued",
      createdAt: "2026-07-09T00:00:30.000Z",
    });

    const otherRuntimeId = createId("rt");
    const otherRuntimeWorkspaceBindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
         created_at, updated_at)
       VALUES (?, ?, 'Other runtime', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(
      otherRuntimeId,
      "other-install",
      runtimeProtocolVersion,
      "2026-07-09T00:00:00.000Z",
      "2026-07-09T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
         diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'other', 'Other workspace', 'available', '{}', '{}', ?, ?)`,
    ).run(
      otherRuntimeWorkspaceBindingId,
      otherRuntimeId,
      "2026-07-09T00:00:00.000Z",
      "2026-07-09T00:00:00.000Z",
    );
    const otherWorkspace = createWorkspaceWithOwnerBinding(db, {
      slug: "other",
      name: "other",
      runtimeWorkspaceBindingId: otherRuntimeWorkspaceBindingId,
      createdAt: "2026-07-09T00:00:00.000Z",
    });
    submitProjectedTurn(db, {
      runtimeId: otherRuntimeId,
      runtimeWorkspaceBindingId: otherRuntimeWorkspaceBindingId,
      workspaceId: otherWorkspace.id,
      sessionId,
      invocationId: "inv_otherworkspace",
      prompt: "Do not include another workspace.",
      status: "queued",
      createdAt: "2026-07-09T00:00:15.000Z",
    });

    const activity = loadSessionActivity(db, { workspaceId: workspace.id, sessionId });

    expect(activity.queuedTurns).toEqual([
      {
        commandId: running.commandId,
        invocationId: "inv_queuerunning",
        prompt: "Inspect the current running turn.",
        status: "running",
        createdAt: "2026-07-09T00:01:00.000Z",
        startedAt: "2026-07-09T00:01:30.000Z",
      },
      {
        commandId: queued.commandId,
        invocationId: "inv_queuefollowup",
        prompt: "Then run the queued follow-up.",
        status: "queued",
        createdAt: "2026-07-09T00:02:00.000Z",
        startedAt: null,
      },
    ]);
    expect(activity.queuedTurns.map((turn) => turn.invocationId)).not.toContain("inv_queuestale");
    expect(activity.queuedTurns.map((turn) => turn.invocationId)).not.toContain("inv_othersession");
    expect(activity.queuedTurns.map((turn) => turn.invocationId)).not.toContain(
      "inv_otherworkspace",
    );
    db.close();
  });

  it("reloads direct turn prompts and terminal failures without duplicating daemon failure reports", () => {
    const { db, workspace, runtimeId, runtimeWorkspaceBindingId } = setupWorkspace();
    const sessionId = "sess_direct_failure";
    const createdAt = "2026-07-09T00:01:00.000Z";
    db.prepare(
      `INSERT INTO runtime_session_projections
        (runtime_id, session_id, scope, workspace_id, runtime_workspace_binding_id, status,
         record_json, projected_at)
       VALUES (?, ?, 'workspace', ?, ?, 'ready', ?, ?)`,
    ).run(
      runtimeId,
      sessionId,
      workspace.id,
      runtimeWorkspaceBindingId,
      JSON.stringify({
        sessionId,
        scope: { kind: "workspace", workspaceId: workspace.id },
        workspaceId: workspace.id,
        title: "Direct failure",
        status: "ready",
        bindings: [],
        createdAt,
        updatedAt: createdAt,
      }),
      createdAt,
    );
    const command = submitRuntimeControlCommand(db, {
      runtimeId,
      workspaceId: workspace.id,
      sessionId,
      payload: {
        kind: "turn.submit.request",
        scope: "workspace",
        payload: { sessionId, prompt: "Explain why the provider is unavailable." },
      },
      createdAt,
    });
    const invocationId = createId("inv");
    recordRuntimeControlCommandResult(db, {
      runtimeId,
      commandId: command.commandId,
      messageId: createId("msg"),
      payload: {
        status: "succeeded",
        result: { invocationId, status: "queued", acceptedAt: createdAt },
        completedAt: "2026-07-09T00:01:01.000Z",
      },
      project: (persisted, result) => recordRuntimeSessionControlProjection(db, persisted, result),
    });
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      payload: {
        runtimeInvocationId: invocationId,
        sequence: 4,
        status: "failed",
        completedAt: "2026-07-09T00:01:04.000Z",
        terminalReason: `503 provider connection failed.<html><head><title>503 Service Unavailable</title></head><body><svg>${"unsafe".repeat(
          5_000,
        )}</svg></body></html>`,
        payload: {},
      },
      updatedAt: "2026-07-09T00:01:04.000Z",
    });

    const activity = loadSessionActivity(db, { workspaceId: workspace.id, sessionId });
    expect(activity.reports).toEqual([
      expect.objectContaining({
        id: `message:invocation:${invocationId}:failure`,
        kind: "session.message",
        role: "system",
        status: "failed",
        text: "503 provider connection failed. — 503 Service Unavailable",
      }),
      expect.objectContaining({
        id: `turn-submit:${command.commandId}:prompt`,
        kind: "turn.submit.prompt",
        role: "user",
        text: "Explain why the provider is unavailable.",
      }),
    ]);

    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: sessionId,
      payload: {
        type: "daemon.view_event",
        sessionId,
        invocationId,
        view: {
          type: "session.message",
          sessionId,
          message: {
            id: `invocation:${invocationId}:failure`,
            role: "system",
            text: "Provider connection failed.",
            status: "error",
          },
        },
      },
      createdAt: "2026-07-09T00:01:05.000Z",
    });

    const reloaded = loadSessionActivity(db, { workspaceId: workspace.id, sessionId });
    const failures = reloaded.reports.filter(
      (report) => report.id === `message:invocation:${invocationId}:failure`,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      status: "error",
      message: { id: `invocation:${invocationId}:failure`, status: "error" },
    });
    expect(JSON.stringify(activity)).not.toMatch(/<html|<svg|unsafe/iu);
    db.close();
  });

  it("reloads task, artifact, and interaction view state from daemon events", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const sessionId = "sess_reload";

    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: sessionId,
      payload: {
        type: "daemon.view_event",
        sessionId,
        view: {
          type: "run.update",
          run: {
            id: "run:reload",
            title: "Reload-safe run",
            summary: "The older run projection.",
            status: "running",
          },
        },
      },
      createdAt: "2026-07-09T00:05:00.000Z",
    });
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: sessionId,
      payload: {
        type: "daemon.view_event",
        sessionId,
        view: {
          type: "run.update",
          run: {
            id: "run:reload",
            title: "Reload-safe run",
            summary: "The latest run projection wins.",
            status: "succeeded",
          },
        },
      },
      createdAt: "2026-07-09T00:05:30.000Z",
    });
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: sessionId,
      payload: {
        type: "daemon.view_event",
        sessionId,
        view: {
          type: "task.update",
          task: {
            ref: "task:reload",
            title: "Verify the reload path",
            description: "Keep daemon-owned task state visible after a browser reload.",
            status: "in_progress",
          },
        },
      },
      createdAt: "2026-07-09T00:06:00.000Z",
    });
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: sessionId,
      payload: {
        type: "daemon.view_event",
        sessionId,
        view: {
          type: "task.update",
          task: {
            ref: "task:reload",
            title: "Verify the reload path",
            description: "The latest task projection wins.",
            status: "done",
          },
        },
      },
      createdAt: "2026-07-09T00:06:30.000Z",
    });
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: sessionId,
      payload: {
        type: "daemon.view_event",
        sessionId,
        view: {
          type: "artifact.update",
          artifact: {
            ref: "artifact:reload-report",
            title: "Reload report",
            kind: "document",
            format: "markdown",
            status: "ready",
            producer: "spark-runtime",
            preview: "The persisted activity projection is available.",
          },
        },
      },
      createdAt: "2026-07-09T00:07:00.000Z",
    });
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.interaction.request",
      subjectKind: "daemon_event",
      subjectId: sessionId,
      payload: {
        type: "daemon.interaction.request",
        sessionId,
        request: {
          requestId: "interaction:reload",
          kind: "confirmation",
          title: "Confirm the next step",
          prompt: "Review the generated report.",
        },
      },
      createdAt: "2026-07-09T00:08:00.000Z",
    });
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.interaction.response",
      subjectKind: "daemon_event",
      subjectId: sessionId,
      payload: {
        type: "daemon.interaction.response",
        sessionId,
        response: {
          requestId: "interaction:reload",
          kind: "confirmation",
          status: "answered",
          approved: true,
        },
      },
      createdAt: "2026-07-09T00:09:00.000Z",
    });
    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "daemon.view_event",
      subjectKind: "view_model",
      subjectId: "sess_other",
      payload: {
        type: "daemon.view_event",
        sessionId: "sess_other",
        view: {
          type: "task.update",
          task: { ref: "task:other", title: "Other task", status: "done" },
        },
      },
      createdAt: "2026-07-09T00:10:00.000Z",
    });

    const activity = loadSessionActivity(db, { workspaceId: workspace.id, sessionId });

    expect(activity.reports).toEqual([
      expect.objectContaining({
        kind: "daemon.interaction.response",
        status: "answered",
        interaction: { requestId: "interaction:reload", kind: "confirmation" },
      }),
      expect.objectContaining({
        kind: "daemon.interaction.request",
        title: "Confirm the next step",
        text: "Review the generated report.",
        interaction: { requestId: "interaction:reload", kind: "confirmation" },
      }),
      {
        id: "artifact:reload-report",
        kind: "evidence.update",
        title: "Reload report",
        text: "The persisted activity projection is available.",
        role: "spark-runtime",
        status: "ready",
        createdAt: "2026-07-09T00:07:00.000Z",
      },
      {
        id: "task:reload",
        kind: "task.update",
        title: "Verify the reload path",
        text: "The latest task projection wins.",
        role: null,
        status: "done",
        createdAt: "2026-07-09T00:06:30.000Z",
      },
      {
        id: "run:reload",
        kind: "run.update",
        title: "Reload-safe run",
        text: "The latest run projection wins.",
        role: null,
        status: "succeeded",
        createdAt: "2026-07-09T00:05:30.000Z",
      },
    ]);
    expect(activity.reports.some((report) => report.id === "task:other")).toBe(false);
    db.close();
  });
});
