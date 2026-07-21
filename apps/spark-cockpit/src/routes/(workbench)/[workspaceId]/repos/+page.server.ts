import { fail, redirect, error as kitError } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import {
  createWorkspaceResource,
  loadReposPage,
  updateWorkspaceResourceStatus,
} from "@zendev-lab/spark-cockpit-coordination/cockpit-queries";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

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
  const page = loadReposPage(getDatabase(), params.workspaceId);
  if (!page) throw kitError(404, "Workspace not found.");
  return page;
};

async function updateResourceStatus(
  { cookies, params, request }: RequestEvent,
  status: "archived" | "available",
) {
  const t = getRequestDictionary({
    cookieLocale: cookies.get(localeCookieName),
    acceptLanguage: request.headers.get("accept-language"),
  }).repos.formMessages;
  const db = getDatabase();
  const workspace = requireWorkspaceByRouteId(db, params.workspaceId);
  const formData = await request.formData();
  const resourceId = formText(formData, "resourceId");
  if (!resourceId) {
    return fail(400, { message: t.missingId });
  }

  updateWorkspaceResourceStatus(db, { workspaceId: workspace.id, resourceId, status });

  redirect(303, workspacePath(workspace, "/repos"));
}

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

    createWorkspaceResource(db, { workspaceId: workspace.id, kind, name, uri, notes });

    redirect(303, workspacePath(workspace, "/repos"));
  },

  archiveResource: async (event) => {
    return await updateResourceStatus(event, "archived");
  },

  restoreResource: async (event) => {
    return await updateResourceStatus(event, "available");
  },
};
