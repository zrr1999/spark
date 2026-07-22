import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import {
  createWorkspaceWithOwnerBinding,
  recordHumanRequestFromRuntime,
  recordHumanResponse,
} from "@zendev-lab/spark-cockpit-coordination/projection-services";
import { describe, expect, it } from "vitest";
import { loadPendingWorkbenchAsk } from "./pending-ask";

describe("pending Workbench ask projection", () => {
  it("recovers the first pending ask from the database until it is answered", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-14T00:00:00.000Z";
    const runtimeId = createId("rt");
    const runtimeWorkspaceBindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, ?, ?, 'online', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, "install-test", "Test runtime", runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local-default', 'Local default', 'available', '{}', '{}', ?, ?)`,
    ).run(runtimeWorkspaceBindingId, runtimeId, now, now);
    const workspace = createWorkspaceWithOwnerBinding(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const request = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "ask-global-dialog",
      payload: {
        kind: "ask_user",
        delivery: "blocking",
        title: "Choose scope",
        prompt: "How should Spark proceed?",
        questions: [
          {
            id: "scope",
            type: "single",
            prompt: "Scope?",
            required: true,
            options: [{ value: "mvp", label: "MVP" }],
          },
          {
            id: "targets",
            type: "multi",
            prompt: "Targets?",
            required: true,
            options: [
              { value: "web", label: "Web" },
              { value: "chat", label: "Chat" },
            ],
          },
          {
            id: "notes",
            type: "freeform",
            prompt: "Notes?",
            required: false,
          },
        ],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });
    const olderRequest = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "ask-global-dialog-older",
      payload: {
        kind: "ask_user",
        delivery: "blocking",
        title: "Choose fallback",
        prompt: "What should Spark do if the first choice is unavailable?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: "2026-07-13T23:59:00.000Z",
    });
    recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "review-newer-than-ask",
      payload: {
        kind: "review",
        delivery: "async",
        title: "Review output",
        prompt: "Review this artifact",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: "2026-07-14T00:01:00.000Z",
    });

    const firstLoad = loadPendingWorkbenchAsk(db, workspace.id);
    const refreshLoad = loadPendingWorkbenchAsk(db, "local-default");

    expect(firstLoad).toMatchObject({
      id: request.inboxItemId,
      workspaceId: workspace.id,
      workspaceSlug: "local-default",
      title: "Choose scope",
      prompt: "How should Spark proceed?",
      detailHref: `/local-default/inbox/${request.inboxItemId}`,
      pendingCount: 2,
      questions: [
        { id: "scope", type: "single" },
        { id: "targets", type: "multi" },
        { id: "notes", type: "freeform" },
      ],
    });
    expect(refreshLoad).toEqual(firstLoad);

    recordHumanResponse(db, {
      humanRequestId: request.humanRequestId,
      payload: {
        status: "answered",
        answers: { scope: "mvp", targets: ["web"], notes: "" },
        responseArtifactRefs: [],
      },
      createdAt: "2026-07-14T00:02:00.000Z",
    });

    expect(loadPendingWorkbenchAsk(db, workspace.id)).toMatchObject({
      id: olderRequest.inboxItemId,
      pendingCount: 1,
    });

    recordHumanResponse(db, {
      humanRequestId: olderRequest.humanRequestId,
      payload: {
        status: "answered",
        answers: { message: "Continue without it" },
        responseArtifactRefs: [],
      },
      createdAt: "2026-07-14T00:03:00.000Z",
    });

    expect(loadPendingWorkbenchAsk(db, workspace.id)).toBeNull();
    db.close();
  });
});
