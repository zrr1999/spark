import { createId } from "@zendev-lab/spark-protocol";
import { fail, redirect } from "@sveltejs/kit";
import { getCurrentUserIdBySessionToken } from "@zendev-lab/spark-server/cockpit-queries";
import { getRequestDictionary, localeCookieName, resolveRequestLocale } from "$lib/i18n";
import { titleFromPrompt } from "$lib/server/agents-product";
import { submitServerCommand } from "$lib/server/command-submission";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import {
  archiveManagedSessionForCockpit,
  createManagedSessionForCockpit,
  getManagedSessionForCockpit,
  listManagedSessionsForCockpit,
} from "$lib/server/managed-sessions";
import {
  loadModelControlForCockpit,
  parseModelValue,
  setSessionModelForCockpit,
} from "$lib/server/model-control";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
  const [sessions, modelControl] = await Promise.all([
    listManagedSessionsForCockpit(),
    loadModelControlForCockpit(),
  ]);
  return {
    sessions,
    selectedSessionId: null as string | null,
    sessionActivity: null,
    modelControl,
  };
};

export const actions: Actions = {
  startConversation: async ({ cookies, locals, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const workspaceId = formText(formData, "workspaceId").trim();
    const message = formText(formData, "message").trim();
    const model = formText(formData, "model").trim();
    const values = { workspaceId, message, model };

    if (!workspaceId) {
      return fail(400, {
        intent: "startConversation",
        success: false,
        error: t.createWorkspaceRequired,
        message: t.createWorkspaceRequired,
        values,
      });
    }
    if (!message) {
      return fail(400, {
        intent: "startConversation",
        success: false,
        error: t.assignGoalRequired,
        message: t.assignGoalRequired,
        values,
      });
    }

    let session;
    try {
      session = await createManagedSessionForCockpit({
        workspaceId,
        title: titleFromPrompt(message),
      });
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : t.createFailed;
      return fail(400, {
        intent: "startConversation",
        success: false,
        error,
        message: error,
        values,
      });
    }

    try {
      if (model) await setSessionModelForCockpit(session.sessionId, parseModelValue(model));
      submitConversationMessage({
        workspaceId,
        sessionId: session.sessionId,
        message,
        requestedByUserId: getCurrentUserIdBySessionToken(getDatabase(), locals.sessionToken),
      });
    } catch (caught) {
      try {
        await archiveManagedSessionForCockpit(session.sessionId);
      } catch {
        // Preserve the queueing failure. The session remains recoverable in the registry if
        // best-effort cleanup itself fails.
      }
      const error = caught instanceof Error ? caught.message : t.assignFailed;
      return fail(400, {
        intent: "startConversation",
        success: false,
        error,
        message: error,
        values,
      });
    }

    redirect(303, `/sessions/${session.sessionId}`);
  },

  sendMessage: async ({ cookies, locals, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();
    const message = formText(formData, "message").trim();
    const values = { sessionId, message };

    if (!sessionId) {
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error: t.assignSessionRequired,
        message: t.assignSessionRequired,
        values,
      });
    }
    if (!message) {
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error: t.assignGoalRequired,
        message: t.assignGoalRequired,
        values,
      });
    }

    let session;
    try {
      session = await getManagedSessionForCockpit(sessionId);
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : t.assignFailed;
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error,
        message: error,
        values,
      });
    }
    if (!session) {
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error: t.assignSessionRequired,
        message: t.assignSessionRequired,
        values,
      });
    }
    if (session.status === "archived") {
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error: t.assignArchived,
        message: t.assignArchived,
        values,
      });
    }

    try {
      const command = submitConversationMessage({
        workspaceId: session.workspaceId,
        sessionId,
        message,
        requestedByUserId: getCurrentUserIdBySessionToken(getDatabase(), locals.sessionToken),
      });

      return {
        intent: "sendMessage",
        success: true,
        message: t.assignQueued,
        queuedCommandId: command.id,
        values: { sessionId, message: "" },
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : t.assignFailed;
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error,
        message: error,
        values,
      });
    }
  },

  selectModel: async ({ cookies, request }) => {
    const formData = await request.formData();
    const isZh = resolveRequestLocale({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    })
      .toLowerCase()
      .startsWith("zh");
    const sessionId = formText(formData, "sessionId").trim();
    const model = formText(formData, "model").trim();
    if (!sessionId || !model) {
      return fail(400, {
        intent: "selectModel",
        success: false,
        message: isZh ? "请选择对话和模型。" : "Select a conversation and model.",
      });
    }
    try {
      await setSessionModelForCockpit(sessionId, parseModelValue(model));
      return {
        intent: "selectModel",
        success: true,
        message: isZh ? "会话模型已更新。" : "Conversation model updated.",
        values: { sessionId, model },
      };
    } catch (caught) {
      return fail(400, {
        intent: "selectModel",
        success: false,
        message:
          caught instanceof Error
            ? caught.message
            : isZh
              ? "无法更新模型。"
              : "Could not update the model.",
        values: { sessionId, model },
      });
    }
  },

  archiveSession: async ({ cookies, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();

    if (!sessionId) {
      return fail(400, {
        intent: "archiveSession",
        message: t.archiveSessionRequired,
      });
    }

    try {
      await archiveManagedSessionForCockpit(sessionId);
    } catch (caught) {
      return fail(400, {
        intent: "archiveSession",
        message: caught instanceof Error ? caught.message : t.archiveFailed,
      });
    }

    redirect(303, "/sessions");
  },
};

function submitConversationMessage(input: {
  workspaceId: string;
  sessionId: string;
  message: string;
  requestedByUserId: string | null;
}) {
  const title = titleFromPrompt(input.message);
  return submitServerCommand(getDatabase(), {
    workspaceId: input.workspaceId,
    requestedByUserId: input.requestedByUserId,
    idempotencyKey: createId("idem"),
    payload: {
      kind: "assignment.create.request",
      title,
      payload: {
        goal: input.message,
        title,
        target: { sessionId: input.sessionId, workspaceId: input.workspaceId },
        constraints: [],
        evidence: [],
        source: { kind: "cockpit" },
      },
    },
  });
}
