import { createId } from "@zendev-lab/spark-protocol";
import { fail, error as kitError } from "@sveltejs/kit";
import { agentsCockpitSource, titleFromPrompt } from "$lib/server/agents-product";
import {
  getCurrentUserIdBySessionToken,
  loadArtifactsPage,
} from "@zendev-lab/spark-server/cockpit-queries";
import { submitServerCommand } from "$lib/server/command-submission";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const page = loadArtifactsPage(getDatabase(), params.workspaceId);
  if (!page) throw kitError(404, "Workspace not found.");
  return page;
};

export const actions: Actions = {
  sendChat: async ({ cookies, locals, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).agents.formMessages;
    const db = getDatabase();
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);
    const formData = await request.formData();
    const prompt = formText(formData, "prompt").trim();

    if (!prompt) {
      return fail(400, { intent: "chat", message: t.chatRequired, values: { prompt } });
    }

    try {
      const runtimeTaskId = createId("task");
      const command = submitServerCommand(db, {
        workspaceId: workspace.id,
        projectId: null,
        requestedByUserId: getCurrentUserIdBySessionToken(db, locals.sessionToken),
        idempotencyKey: createId("idem"),
        payload: {
          kind: "task.start.request",
          title: titleFromPrompt(prompt),
          payload: {
            prompt,
            runtimeTaskId,
            source: agentsCockpitSource,
            context: { kind: "artifacts-agent-product", workspaceId: workspace.id },
          },
        },
      });

      return {
        intent: "chat",
        message: t.chatQueued,
        queuedCommandId: command.id,
      };
    } catch (caught) {
      return fail(400, {
        intent: "chat",
        message: caught instanceof Error ? caught.message : t.chatQueueFailed,
        values: { prompt },
      });
    }
  },

  cancelRun: async ({ cookies, locals, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).agents.formMessages;
    const db = getDatabase();
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);
    const formData = await request.formData();
    const runtimeInvocationId = formText(formData, "runtimeInvocationId").trim();

    if (!runtimeInvocationId.startsWith("inv_")) {
      return fail(400, { intent: "chat", message: t.cancelRequired });
    }

    try {
      const command = submitServerCommand(db, {
        workspaceId: workspace.id,
        projectId: null,
        requestedByUserId: getCurrentUserIdBySessionToken(db, locals.sessionToken),
        idempotencyKey: createId("idem"),
        payload: {
          kind: "invocation.cancel.request",
          title: t.cancelTitle,
          payload: {
            runtimeInvocationId,
            source: agentsCockpitSource,
            context: { kind: "artifacts-agent-product", workspaceId: workspace.id },
          },
        },
      });

      return {
        intent: "chat",
        message: t.cancelQueued,
        queuedCommandId: command.id,
      };
    } catch (caught) {
      return fail(400, {
        intent: "chat",
        message: caught instanceof Error ? caught.message : t.cancelFailed,
      });
    }
  },
};
