import { createId } from "@zendev-lab/spark-protocol";
import { error, fail } from "@sveltejs/kit";
import {
  getCurrentUserIdBySessionToken,
  loadProjectPage,
  requireProjectForWorkspace,
} from "@zendev-lab/spark-server/cockpit-queries";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { titleFromPrompt } from "$lib/server/agents-product";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { submitServerCommand } from "$lib/server/command-submission";
import { buildProjectTaskAssignCommandPayload } from "$lib/server/project-task-assign";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const page = loadProjectPage(getDatabase(), params.workspaceId, params.projectId);
  if (!page) {
    throw error(404, "Project not found");
  }
  return page;
};

export const actions: Actions = {
  assignTask: async ({ cookies, locals, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).project.formMessages;
    const db = getDatabase();
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);
    const project = requireProjectForWorkspace(db, params.projectId, workspace.id);
    if (!project) throw error(404, "Project not found");
    const page = loadProjectPage(db, params.workspaceId, params.projectId);
    if (!page) throw error(404, "Project not found");

    const formData = await request.formData();
    const runtimeTaskId = formText(formData, "runtimeTaskId").trim();
    const task = page.tasks.find((candidate) => candidate.runtimeTaskId === runtimeTaskId);
    if (!task || !task.readyFrontier) {
      return fail(400, { message: t.queueFailed });
    }

    try {
      const command = submitServerCommand(db, {
        workspaceId: project.workspaceId,
        projectId: project.id,
        requestedByUserId: getCurrentUserIdBySessionToken(db, locals.sessionToken),
        idempotencyKey: createId("idem"),
        payload: buildProjectTaskAssignCommandPayload(task),
      });

      return {
        message: t.queued,
        queuedCommandId: command.id,
        assignedRuntimeTaskId: task.runtimeTaskId,
      };
    } catch (caught) {
      return fail(400, {
        message: caught instanceof Error ? caught.message : t.queueFailed,
      });
    }
  },

  startTask: async ({ cookies, locals, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).project.formMessages;
    const db = getDatabase();
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);
    const project = requireProjectForWorkspace(db, params.projectId, workspace.id);
    if (!project) throw error(404, "Project not found");

    const formData = await request.formData();
    const title =
      formText(formData, "title").trim() || titleFromPrompt(formText(formData, "prompt"));
    const prompt = formText(formData, "prompt").trim();

    if (!prompt) {
      return fail(400, {
        message: t.taskRequired,
        values: { title, prompt },
      });
    }

    try {
      const runtimeTaskId = createId("task");
      const command = submitServerCommand(db, {
        workspaceId: project.workspaceId,
        projectId: project.id,
        requestedByUserId: getCurrentUserIdBySessionToken(db, locals.sessionToken),
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

  cancelRun: async ({ cookies, locals, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).project.formMessages;
    const db = getDatabase();
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);
    const project = requireProjectForWorkspace(db, params.projectId, workspace.id);
    if (!project) throw error(404, "Project not found");

    const formData = await request.formData();
    const runtimeInvocationId = formText(formData, "runtimeInvocationId").trim();

    if (!runtimeInvocationId.startsWith("inv_")) {
      return fail(400, { message: t.cancelRequired });
    }

    try {
      const command = submitServerCommand(db, {
        workspaceId: project.workspaceId,
        projectId: project.id,
        requestedByUserId: getCurrentUserIdBySessionToken(db, locals.sessionToken),
        idempotencyKey: createId("idem"),
        payload: {
          kind: "invocation.cancel.request",
          title: t.cancelTitle,
          payload: {
            runtimeInvocationId,
            source: "project-cockpit",
          },
        },
      });

      return {
        message: t.cancelQueued,
        queuedCommandId: command.id,
      };
    } catch (caught) {
      return fail(400, {
        message: caught instanceof Error ? caught.message : t.cancelFailed,
      });
    }
  },
};
