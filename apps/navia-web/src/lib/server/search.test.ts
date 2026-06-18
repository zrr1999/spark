import { describe, expect, it } from "vitest";
import { migrate, openMemoryDatabase } from "@navia-dev/db";
import { createProject } from "./projection-services";
import { searchProjects } from "./search";

const now = "2026-05-22T00:00:00.000Z";

describe("search projects", () => {
  it("finds projects and returns workspace-scoped links", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertWorkspace(db, { id: "ws_alpha", slug: "alpha", name: "Alpha" });
    const project = createProject(db, {
      workspaceId: "ws_alpha",
      slug: "agent-review",
      name: "Agent Review",
      description: "Project search smoke target",
      createdAt: now,
    });

    const results = searchProjects(db, "review", { activeWorkspaceId: "ws_alpha" });

    expect(results).toMatchObject([
      {
        id: project.id,
        type: "project",
        title: "Agent Review",
        href: `/alpha/projects/${project.id}`,
        workspaceId: "ws_alpha",
        workspaceSlug: "alpha",
      },
    ]);
    db.close();
  });

  it("boosts projects from the active workspace", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertWorkspace(db, { id: "ws_first", slug: "first", name: "First" });
    insertWorkspace(db, { id: "ws_second", slug: "second", name: "Second" });
    createProject(db, {
      workspaceId: "ws_first",
      slug: "shared",
      name: "Shared Project",
      createdAt: "2026-05-22T00:00:00.000Z",
    });
    const activeProject = createProject(db, {
      workspaceId: "ws_second",
      slug: "shared",
      name: "Shared Project",
      createdAt: "2026-05-21T00:00:00.000Z",
    });

    const results = searchProjects(db, "shared", { activeWorkspaceId: "ws_second" });

    expect(results[0]?.id).toBe(activeProject.id);
    db.close();
  });

  it("excludes archived projects and workspaces", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertWorkspace(db, { id: "ws_active", slug: "active", name: "Active" });
    insertWorkspace(db, {
      id: "ws_archived",
      slug: "archived",
      name: "Archived",
      status: "archived",
    });
    createProject(db, {
      workspaceId: "ws_active",
      slug: "hidden",
      name: "Hidden Project",
      createdAt: now,
    });
    db.prepare("UPDATE projects SET status = 'archived' WHERE workspace_id = ?").run("ws_active");
    createProject(db, {
      workspaceId: "ws_archived",
      slug: "visible-name",
      name: "Visible Name",
      createdAt: now,
    });

    const results = searchProjects(db, "project");

    expect(results).toEqual([]);
    db.close();
  });

  it("treats LIKE wildcards as literal query text", () => {
    const db = openMemoryDatabase();
    migrate(db);
    insertWorkspace(db, { id: "ws_alpha", slug: "alpha", name: "Alpha" });
    createProject(db, {
      workspaceId: "ws_alpha",
      slug: "normal",
      name: "Normal Project",
      createdAt: now,
    });

    const results = searchProjects(db, "%");

    expect(results).toEqual([]);
    db.close();
  });
});

function insertWorkspace(
  db: ReturnType<typeof openMemoryDatabase>,
  input: {
    id: string;
    slug: string;
    name: string;
    status?: "active" | "archived";
  },
) {
  db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, description, status, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, '{}', ?, ?)`,
  ).run(input.id, input.slug, input.name, input.status ?? "active", now, now);
}
