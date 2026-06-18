import { createId } from "@zendev-lab/navia-protocol";
import { error, fail } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { hashSecret } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { loadProjectCockpit } from "$lib/server/project-cockpit";
import { queueCommandForWorkspaceOwner } from "$lib/server/projection-services";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const db = getDatabase();
  const workspace = requireWorkspaceByRouteId(db, params.workspaceId);
  const cockpit = loadProjectCockpit(db, params.projectId);

  if (!cockpit || cockpit.project.workspaceId !== workspace.id) {
    throw error(404, "Project not found");
  }

  return cockpit;
};

export const actions: Actions = {
  startTask: async ({ cookies, locals, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).project.formMessages;
    const db = getDatabase();
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);
    const project = db
      .prepare(
        `SELECT id, workspace_id AS workspaceId
         FROM projects
         WHERE id = ?
         LIMIT 1`,
      )
      .get(params.projectId) as { id: string; workspaceId: string } | undefined;

    if (!project || project.workspaceId !== workspace.id) {
      throw error(404, "Project not found");
    }

    const formData = await request.formData();
    const title = formText(formData, "title").trim();
    const prompt = formText(formData, "prompt").trim();

    if (!title || !prompt) {
      return fail(400, {
        message: t.taskRequired,
        values: { title, prompt },
      });
    }

    try {
      const runtimeTaskId = createId("task");
      const command = queueCommandForWorkspaceOwner(db, {
        workspaceId: project.workspaceId,
        projectId: project.id,
        requestedByUserId: getCurrentUserId(db, locals.sessionToken),
        idempotencyKey: createId("idem"),
        payload: {
          kind: "task.start.request",
          title,
          payload: {
            prompt,
            runtimeTaskId,
            source: "project-cockpit",
          },
        },
      });

      return {
        message: t.queued,
        queuedCommandId: command.id,
      };
    } catch (caught) {
      return fail(400, {
        message: caught instanceof Error ? caught.message : t.queueFailed,
        values: { title, prompt },
      });
    }
  },
};

function getCurrentUserId(db: ReturnType<typeof getDatabase>, sessionToken: string | null) {
  if (!sessionToken) {
    return null;
  }

  const session = db
    .prepare(
      `SELECT user_id AS userId
       FROM sessions
       WHERE token_hash = ? AND revoked_at IS NULL
       LIMIT 1`,
    )
    .get(hashSecret(sessionToken)) as { userId: string } | undefined;

  return session?.userId ?? null;
}
