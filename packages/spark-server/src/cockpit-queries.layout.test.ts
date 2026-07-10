import { describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-db";
import {
  isReservedWorkbenchPathSegment,
  loadArtifactDetailPage,
  loadWorkbenchLayout,
  updateWorkspaceSettings,
} from "./cockpit-queries";
import {
  createProject,
  createWorkspaceWithOwnerBinding,
  queueCommandForWorkspaceOwner,
  recordInvocationUpdate,
} from "./projection-services";

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
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'local-default', 'Local default', 'available', '{}', '{}', ?, ?)`,
  ).run(bindingId, runtimeId, now, now);
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
});

describe("artifact conversation provenance", () => {
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
