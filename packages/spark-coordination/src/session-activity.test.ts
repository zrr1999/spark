import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import { loadSessionActivity } from "./session-activity";
import {
  appendEvent,
  createWorkspaceWithOwnerBinding,
  queueCommandForWorkspaceOwner,
  recordInvocationLogChunk,
  recordInvocationUpdate,
} from "./projection-services";

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
  return { db, workspace, runtimeWorkspaceBindingId };
}

describe("session activity projection", () => {
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
        kind: "artifact.trace",
        role: "assistant",
        status: "blocked",
        text: "Blocked: missing browser evidence.",
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
        kind: "artifact.update",
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
