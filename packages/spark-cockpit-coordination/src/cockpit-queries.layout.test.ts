import { describe, expect, it } from "vitest";
import {
  createId,
  runtimeProtocolVersion,
  type RuntimeRegistrationRequest,
} from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import {
  isReservedWorkbenchPathSegment,
  loadArtifactDetailPage,
  loadArtifactsPage,
  loadEvidencePage,
  loadInboxDetailPage,
  loadInboxPage,
  loadWorkbenchLayout,
  loadWorkspaceDashboard,
  loadWorkspaceRegistrationPage,
  loadWorkspaceSettings,
  resolvePendingWorkspaceBinding,
  resolvePendingWorkspaceRuntimeState,
  updateWorkspaceSettings,
} from "./cockpit-queries";
import {
  createProject,
  createWorkspaceWithOwnerBinding,
  queueCommandForWorkspaceOwner,
  recordHumanRequestFromRuntime,
  recordInvocationUpdate,
} from "./projection-services";
import { createRuntimeEnrollmentToken, registerRuntime } from "./runtime-registration";

function setupWorkspace(slug = "spore") {
  const db = openMemoryDatabase();
  migrate(db);
  const now = "2026-07-09T00:00:00.000Z";
  const runtimeId = createId("rt");
  const bindingId = createId("rtwb");
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, ?, 'Runtime', 'online', ?, '{}', '{}', ?, ?)`,
  ).run(runtimeId, "install", runtimeProtocolVersion, now, now);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, local_path, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'local-default', ?, 'Local default', 'available', '{}', '{}', ?, ?)`,
  ).run(bindingId, runtimeId, `/Users/test/workspaces/${slug}`, now, now);
  const workspace = createWorkspaceWithOwnerBinding(db, {
    slug,
    name: slug,
    runtimeWorkspaceBindingId: bindingId,
    createdAt: now,
  });
  createProject(db, {
    workspaceId: workspace.id,
    slug: "mvp",
    name: "MVP",
    createdAt: now,
  });
  return { db, workspace, bindingId };
}

describe("loadWorkbenchLayout", () => {
  it("falls back to preferred or latest workspace on global routes", () => {
    const { db } = setupWorkspace("spore");
    const secondRuntimeId = createId("rt");
    const secondBindingId = createId("rtwb");
    const now = "2026-07-09T01:00:00.000Z";
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, ?, 'Runtime 2', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(secondRuntimeId, "install-2", runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local-2', 'Local 2', 'available', '{}', '{}', ?, ?)`,
    ).run(secondBindingId, secondRuntimeId, now, now);
    createWorkspaceWithOwnerBinding(db, {
      slug: "other",
      name: "other",
      runtimeWorkspaceBindingId: secondBindingId,
      createdAt: now,
    });

    const fromPath = loadWorkbenchLayout(db, "/sessions");
    expect(fromPath.activeWorkspace?.slug).toBe("other");

    const preferred = loadWorkbenchLayout(db, "/sessions", {
      preferredWorkspaceSlug: "spore",
    });
    expect(preferred.activeWorkspace?.slug).toBe("spore");

    const scoped = loadWorkbenchLayout(db, "/spore/inbox");
    expect(scoped.activeWorkspace?.slug).toBe("spore");
    db.close();
  });

  it("ignores archived workspaces for active and switcher lists", () => {
    const { db, workspace } = setupWorkspace("active-ws");
    db.prepare(`UPDATE workspaces SET status = 'archived' WHERE id = ?`).run(workspace.id);
    const secondRuntimeId = createId("rt");
    const secondBindingId = createId("rtwb");
    const now = "2026-07-09T02:00:00.000Z";
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, ?, 'Runtime 2', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(secondRuntimeId, "install-2", runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local-2', 'Local 2', 'available', '{}', '{}', ?, ?)`,
    ).run(secondBindingId, secondRuntimeId, now, now);
    createWorkspaceWithOwnerBinding(db, {
      slug: "live",
      name: "live",
      runtimeWorkspaceBindingId: secondBindingId,
      createdAt: now,
    });

    const layout = loadWorkbenchLayout(db, "/sessions", {
      preferredWorkspaceSlug: "active-ws",
    });
    expect(layout.activeWorkspace?.slug).toBe("live");
    expect(layout.workspaces.map((item) => item.slug)).toEqual(["live"]);
    db.close();
  });

  it("shows only the workspace granted to a remote browser session", () => {
    const { db, workspace } = setupWorkspace("spore");
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    const now = "2026-07-09T03:00:00.000Z";
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, ?, 'Other runtime', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, "install-other", runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'other', 'Other', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    createWorkspaceWithOwnerBinding(db, {
      slug: "other",
      name: "other",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });

    const layout = loadWorkbenchLayout(db, "/other/sessions", {
      preferredWorkspaceSlug: "other",
      authorizedWorkspaceId: workspace.id,
    });
    expect(layout.workspaces.map((item) => item.slug)).toEqual(["spore"]);
    expect(layout.activeWorkspace?.id).toBe(workspace.id);
    db.close();
  });
});

describe("loadWorkspaceRegistrationPage", () => {
  it("projects the connected directory path", () => {
    const { db } = setupWorkspace("spore");

    const page = loadWorkspaceRegistrationPage(db, "spore");

    expect(page?.runnerBindings).toHaveLength(1);
    expect(page?.runnerBindings[0]?.localPath).toBe("/Users/test/workspaces/spore");
    expect(page?.workspace.localPath).toBe("/Users/test/workspaces/spore");
    db.close();
  });
});

describe("loadWorkspaceDashboard", () => {
  it("scopes runtime health to the workspace owner binding", () => {
    const { db } = setupWorkspace("spore");
    const unrelatedRuntimeId = createId("rt");
    const now = "2026-07-09T00:05:00.000Z";
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, ?, 'Unbound online runtime', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(unrelatedRuntimeId, "install-unbound", runtimeProtocolVersion, now, now);

    const page = loadWorkspaceDashboard(db, "spore");

    expect(page?.runnerConnections.map((runtime) => runtime.name)).toEqual(["Runtime"]);
    db.close();
  });
});

describe("workspace settings slug guards", () => {
  it("rejects reserved and duplicate slugs", () => {
    const { db, workspace } = setupWorkspace("spore");
    expect(
      updateWorkspaceSettings(db, {
        workspaceId: workspace.id,
        name: "spore",
        slug: "settings",
        description: null,
      }),
    ).toBe("reserved_slug");
    expect(isReservedWorkbenchPathSegment("Sessions")).toBe(true);

    const secondRuntimeId = createId("rt");
    const secondBindingId = createId("rtwb");
    const now = "2026-07-09T03:00:00.000Z";
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, ?, 'Runtime 2', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(secondRuntimeId, "install-2", runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local-2', 'Local 2', 'available', '{}', '{}', ?, ?)`,
    ).run(secondBindingId, secondRuntimeId, now, now);
    createWorkspaceWithOwnerBinding(db, {
      slug: "other",
      name: "other",
      runtimeWorkspaceBindingId: secondBindingId,
      createdAt: now,
    });

    expect(
      updateWorkspaceSettings(db, {
        workspaceId: workspace.id,
        name: "spore",
        slug: "other",
        description: null,
      }),
    ).toBe("duplicate_slug");
    db.close();
  });

  it("exposes owner-binding localPath and keeps name aligned with the directory", () => {
    const { db, workspace } = setupWorkspace("spore");
    const settings = loadWorkspaceSettings(db, "spore");
    expect(settings?.localPath).toBe("/Users/test/workspaces/spore");

    const layout = loadWorkbenchLayout(db, "/spore/settings");
    expect(layout.activeWorkspace).toMatchObject({
      slug: "spore",
      name: "spore",
      localPath: "/Users/test/workspaces/spore",
    });

    expect(
      updateWorkspaceSettings(db, {
        workspaceId: workspace.id,
        name: "renamed-away-from-path",
        slug: "spore",
        description: null,
      }),
    ).toBe("ok");

    const updated = loadWorkspaceSettings(db, "spore");
    expect(updated).toMatchObject({
      name: "spore",
      localPath: "/Users/test/workspaces/spore",
    });
    const binding = db
      .prepare(
        `SELECT display_name AS displayName
         FROM runtime_workspace_bindings
         WHERE id = (
           SELECT runtime_workspace_binding_id
           FROM workspace_leases
           WHERE workspace_id = ? AND ended_at IS NULL
           LIMIT 1
         )`,
      )
      .get(workspace.id) as { displayName: string };
    expect(binding.displayName).toBe("spore");
    db.close();
  });
});

describe("artifact conversation provenance", () => {
  it("lists only issue/pr/preview on the workspace artifacts page", () => {
    const { db, workspace, bindingId } = setupWorkspace("spore");
    const now = "2026-07-09T04:00:00.000Z";
    db.prepare(
      `INSERT INTO artifacts
        (id, workspace_id, project_id, scope, kind, title, format, source,
         runtime_workspace_binding_id, invocation_id, human_request_id,
         content_ref_json, provenance_json, created_at, updated_at)
       VALUES
         ('art_trace', ?, NULL, 'workspace', 'trace', 'Run dump', 'json',
          'runtime', ?, NULL, NULL, '{}', '{}', ?, ?),
         ('art_doc', ?, NULL, 'workspace', 'document', 'Plan', 'markdown',
          'runtime', ?, NULL, NULL, '{}', '{}', ?, ?),
         ('art_preview', ?, NULL, 'workspace', 'preview', 'UI draft', 'markdown',
          'runtime', ?, NULL, NULL, '{}', '{}', ?, ?)`,
    ).run(
      workspace.id,
      bindingId,
      now,
      now,
      workspace.id,
      bindingId,
      now,
      now,
      workspace.id,
      bindingId,
      now,
      now,
    );

    const page = loadArtifactsPage(db, "spore");
    expect(page?.artifacts.map((artifact) => artifact.id)).toEqual(["art_preview"]);
    db.close();
  });

  it("lists document/record/knowledge via the internal evidence query (not a user page)", () => {
    const { db, workspace, bindingId } = setupWorkspace("spore");
    const now = "2026-07-09T04:00:00.000Z";
    db.prepare(
      `INSERT INTO artifacts
        (id, workspace_id, project_id, scope, kind, title, format, source,
         runtime_workspace_binding_id, invocation_id, human_request_id,
         content_ref_json, provenance_json, created_at, updated_at)
       VALUES
         ('art_trace', ?, NULL, 'workspace', 'trace', 'Run dump', 'json',
          'runtime', ?, NULL, NULL, '{}', '{}', ?, ?),
         ('art_doc', ?, NULL, 'workspace', 'document', 'Plan', 'markdown',
          'runtime', ?, NULL, NULL, '{}', '{}', ?, ?)`,
    ).run(workspace.id, bindingId, now, now, workspace.id, bindingId, now, now);

    const page = loadEvidencePage(db, "spore");
    expect(page?.artifacts.map((artifact) => artifact.id)).toEqual(["art_doc"]);
    db.close();
  });

  it("links an invocation artifact back to its owning conversation", () => {
    const { db, workspace, bindingId } = setupWorkspace("spore");
    const sessionId = "sess_artifact_context";
    const command = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      payload: {
        kind: "assignment.create.request",
        title: "Produce evidence",
        payload: {
          goal: "Produce evidence",
          target: { sessionId, workspaceId: workspace.id },
          source: { kind: "cockpit" },
        },
      },
    });
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId: bindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      payload: {
        runtimeInvocationId: "inv_artifact_context",
        status: "succeeded",
        payload: {},
      },
    });
    const invocation = db
      .prepare("SELECT id FROM mirrored_invocations WHERE command_id = ?")
      .get(command.id) as { id: string };
    const now = "2026-07-09T04:00:00.000Z";
    db.prepare(
      `INSERT INTO artifacts
        (id, workspace_id, project_id, scope, kind, title, format, source,
         runtime_workspace_binding_id, invocation_id, human_request_id,
         content_ref_json, provenance_json, created_at, updated_at)
       VALUES ('art_conversation', ?, NULL, 'workspace', 'trace', 'Evidence', 'json',
               'runtime', ?, ?, NULL, '{}', '{}', ?, ?)`,
    ).run(workspace.id, bindingId, invocation.id, now, now);

    const page = loadArtifactDetailPage(db, "spore", "art_conversation");
    expect(page?.artifact.sessionId).toBe(sessionId);
    db.close();
  });
});

describe("inbox conversation provenance", () => {
  it("uses the Ask session id without command provenance and preserves command fallback", () => {
    const { db, workspace, bindingId } = setupWorkspace("spore");
    const sessionId = "sess_inbox_context";
    const request = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId: bindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "runtime-request-inbox-context",
      payload: {
        kind: "ask_user",
        sessionId,
        title: "Choose scope",
        prompt: "Which scope should Spark use?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
    });

    const inboxPage = loadInboxPage(db, "spore");
    const page = loadInboxDetailPage(db, "spore", request.inboxItemId);

    expect(inboxPage?.inboxItems[0]?.sessionId).toBe(sessionId);
    expect(page?.detail.sessionId).toBe(sessionId);
    expect(JSON.parse(page!.detail.contextJson)).not.toHaveProperty("commandId");

    const fallbackSessionId = "sess_inbox_command_fallback";
    const fallbackCommand = queueCommandForWorkspaceOwner(db, {
      workspaceId: workspace.id,
      payload: {
        kind: "assignment.create.request",
        title: "Ask from command",
        payload: {
          goal: "Ask from command",
          target: { sessionId: fallbackSessionId, workspaceId: workspace.id },
          source: { kind: "cockpit" },
        },
      },
    });
    const fallbackRequest = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId: bindingId,
      workspaceId: workspace.id,
      commandId: fallbackCommand.id,
      runtimeRequestId: "runtime-request-command-fallback",
      payload: {
        kind: "ask_user",
        title: "Choose fallback",
        prompt: "Use command provenance?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
    });

    expect(
      loadInboxPage(db, "spore")?.inboxItems.find((item) => item.id === fallbackRequest.inboxItemId)
        ?.sessionId,
    ).toBe(fallbackSessionId);
    expect(loadInboxDetailPage(db, "spore", fallbackRequest.inboxItemId)?.detail.sessionId).toBe(
      fallbackSessionId,
    );
    db.close();
  });
});

describe("resolvePendingWorkspaceRuntimeState", () => {
  const registrationRequest = {
    installationId: "install-pending",
    displayName: "Pending daemon",
    runtimeVersion: "0.1.0-test",
    supportedFeatures: ["ws-control-v1"],
    labels: {},
  } satisfies RuntimeRegistrationRequest;

  it("returns null before any runtime registers against the enrollment token", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db, {
      workspaceName: "Pending WS",
      workspaceSlug: "pending-ws",
    });
    const setup = {
      name: "Pending WS",
      slug: "pending-ws",
      enrollmentTokenId: enrollment.id,
    };
    expect(resolvePendingWorkspaceBinding(db, setup)).toBeNull();
    expect(resolvePendingWorkspaceRuntimeState(db, setup)).toBeNull();
    db.close();
  });

  it("reports the offline runtime once HTTP registration created an offline binding", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const enrollment = createRuntimeEnrollmentToken(db, {
      workspaceName: "Pending WS",
      workspaceSlug: "pending-ws",
    });
    const registered = registerRuntime(
      db,
      {
        ...registrationRequest,
        workspaceRegistration: {
          localWorkspaceKey: "pending-ws",
          displayName: "Pending WS",
        },
      },
      enrollment.refreshToken,
    );
    const setup = {
      name: "Pending WS",
      slug: "pending-ws",
      enrollmentTokenId: enrollment.id,
    };

    // Fresh registration leaves the runtime connection 'offline' until its
    // WebSocket connects, so the ready-binding lookup filters it out...
    expect(resolvePendingWorkspaceBinding(db, setup)).toBeNull();
    // ...but the pending-runtime probe surfaces the offline diagnostic.
    const pending = resolvePendingWorkspaceRuntimeState(db, setup);
    expect(pending).toMatchObject({
      runtimeName: "Pending daemon",
      runtimeStatus: "offline",
      bindingStatus: "available",
      bindingDisplayName: "Pending WS",
    });

    // Once the runtime connection is online, the ready binding resolves and the
    // pending probe goes quiet.
    db.prepare("UPDATE runtime_connections SET status = 'online' WHERE id = ?").run(
      registered.runtimeId,
    );
    expect(resolvePendingWorkspaceRuntimeState(db, setup)).toBeNull();
    expect(resolvePendingWorkspaceBinding(db, setup)?.runtimeStatus).toBe("online");
    db.close();
  });
});
