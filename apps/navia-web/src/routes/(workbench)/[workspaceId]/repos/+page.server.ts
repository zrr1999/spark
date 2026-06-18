import { createId } from "@navia-dev/protocol";
import { fail, redirect } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

type ResourceKind = "repo" | "doc" | "url" | "file" | "secret_ref" | "tool" | "other";

const resourceKinds = new Set<ResourceKind>([
  "repo",
  "doc",
  "url",
  "file",
  "secret_ref",
  "tool",
  "other",
]);

export const load: PageServerLoad = ({ params }) => {
  const db = getDatabase();
  const workspace = requireWorkspaceByRouteId(db, params.workspaceId);

  const resources = db
    .prepare(
      `SELECT r.id,
              r.kind,
              r.name,
              r.uri,
              r.status,
              r.config_json AS configJson,
              r.created_at AS createdAt,
              r.updated_at AS updatedAt,
              COUNT(pr.project_id) AS projectCount
       FROM resources r
       LEFT JOIN project_resources pr ON pr.resource_id = r.id
       WHERE r.workspace_id = ?
       GROUP BY r.id
       ORDER BY CASE r.status WHEN 'available' THEN 0 WHEN 'degraded' THEN 1 WHEN 'unavailable' THEN 2 ELSE 3 END,
                r.updated_at DESC`,
    )
    .all(workspace.id) as Array<{
    id: string;
    kind: string;
    name: string;
    uri: string | null;
    status: string;
    configJson: string;
    createdAt: string;
    updatedAt: string;
    projectCount: number;
  }>;

  const counts = resources.reduce(
    (acc, resource) => {
      acc.total += 1;
      if (resource.kind === "repo") acc.repo += 1;
      if (resource.status === "available") acc.available += 1;
      if (resource.status === "archived") acc.archived += 1;
      return acc;
    },
    { total: 0, repo: 0, available: 0, archived: 0 },
  );

  return { workspace, resources, counts };
};

export const actions: Actions = {
  createResource: async ({ cookies, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).repos.formMessages;
    const db = getDatabase();
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);

    const formData = await request.formData();
    const kind = formText(formData, "kind", "repo") as ResourceKind;
    const name = formText(formData, "name").trim();
    const uri = formText(formData, "uri").trim() || null;
    const notes = formText(formData, "notes").trim();

    if (!resourceKinds.has(kind)) {
      return fail(400, { message: t.unsupportedKind });
    }
    if (!name) {
      return fail(400, { message: t.nameRequired });
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO resources
        (id, workspace_id, kind, name, uri, status, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
    ).run(
      createId("res"),
      workspace.id,
      kind,
      name,
      uri,
      JSON.stringify({ notes: notes || undefined }),
      now,
      now,
    );

    redirect(303, workspacePath(workspace, "/repos"));
  },

  archiveResource: async ({ cookies, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).repos.formMessages;
    const workspace = requireWorkspaceByRouteId(getDatabase(), params.workspaceId);
    const formData = await request.formData();
    const resourceId = formText(formData, "resourceId");
    if (!resourceId) {
      return fail(400, { message: t.missingId });
    }

    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        "UPDATE resources SET status = 'archived', updated_at = ? WHERE id = ? AND workspace_id = ?",
      )
      .run(now, resourceId, workspace.id);

    redirect(303, workspacePath(workspace, "/repos"));
  },

  restoreResource: async ({ cookies, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).repos.formMessages;
    const workspace = requireWorkspaceByRouteId(getDatabase(), params.workspaceId);
    const formData = await request.formData();
    const resourceId = formText(formData, "resourceId");
    if (!resourceId) {
      return fail(400, { message: t.missingId });
    }

    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        "UPDATE resources SET status = 'available', updated_at = ? WHERE id = ? AND workspace_id = ?",
      )
      .run(now, resourceId, workspace.id);

    redirect(303, workspacePath(workspace, "/repos"));
  },
};
