import { fail, redirect } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName, resolveRequestLocale } from "$lib/i18n";
import { titleFromPrompt } from "$lib/server/agents-product";
import {
  cancelConversationTurnForCockpit,
  submitConversationTurnForCockpit,
} from "$lib/server/conversation-control";
import { formText } from "$lib/server/form-data";
import {
  archiveManagedSessionForCockpit,
  createManagedSessionForCockpit,
  getManagedSessionForCockpit,
  listManagedSessionsForCockpit,
} from "$lib/server/managed-sessions";
import {
  loadModelControlForCockpit,
  modelValue,
  parseModelValue,
  setSessionModelForCockpit,
} from "$lib/server/model-control";
import { workspaceIdForWorkbenchSession } from "../../../lib/workbench-session-scope";
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
  startConversation: async ({ cookies, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const workspaceId = formText(formData, "workspaceId").trim();
    const scopeKind = formText(formData, "scopeKind").trim() === "daemon" ? "daemon" : "workspace";
    const message = formText(formData, "message").trim();
    const model = formText(formData, "model").trim();
    const values = { scopeKind, workspaceId, message, model };

    if (scopeKind === "workspace" && !workspaceId) {
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
      session = await createManagedSessionForCockpit(
        scopeKind === "daemon"
          ? {
              scope: { kind: "daemon" },
              title: titleFromPrompt(message),
            }
          : {
              scope: { kind: "workspace", workspaceId },
              workspaceId,
              title: titleFromPrompt(message),
            },
      );
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
      await submitConversationMessage({
        workspaceId: workspaceIdForWorkbenchSession(session) ?? undefined,
        sessionId: session.sessionId,
        message,
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

  sendMessage: async ({ cookies, request }) => {
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
      const turn = await submitConversationMessage({
        workspaceId: workspaceIdForWorkbenchSession(session) ?? undefined,
        sessionId,
        message,
      });

      return {
        intent: "sendMessage",
        success: true,
        message: t.assignQueued,
        queuedTurnId: turn.turnId,
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

  cancelTurn: async ({ cookies, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();
    const turnId = formText(formData, "turnId").trim();
    const values = { sessionId, turnId };

    if (!sessionId) {
      return fail(400, {
        intent: "cancelTurn",
        success: false,
        error: t.cancelSessionRequired,
        message: t.cancelSessionRequired,
        values,
      });
    }
    if (!turnId) {
      return fail(400, {
        intent: "cancelTurn",
        success: false,
        error: t.cancelTurnRequired,
        message: t.cancelTurnRequired,
        values,
      });
    }

    let session;
    try {
      session = await getManagedSessionForCockpit(sessionId);
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : t.cancelTurnFailed;
      return fail(400, {
        intent: "cancelTurn",
        success: false,
        error,
        message: error,
        values,
      });
    }
    if (!session) {
      return fail(400, {
        intent: "cancelTurn",
        success: false,
        error: t.cancelSessionRequired,
        message: t.cancelSessionRequired,
        values,
      });
    }
    if (session.status === "archived") {
      return fail(400, {
        intent: "cancelTurn",
        success: false,
        error: t.cancelTurnArchived,
        message: t.cancelTurnArchived,
        values,
      });
    }

    try {
      const result = await cancelConversationTurnForCockpit({ sessionId, turnId });
      if (!result.cancelled) {
        return fail(409, {
          intent: "cancelTurn",
          success: false,
          cancelled: false,
          error: t.cancelTurnUnavailable,
          message: t.cancelTurnUnavailable,
          daemonMessage: result.message,
          values,
        });
      }
      return {
        intent: "cancelTurn",
        success: true,
        cancelled: true,
        message: result.outcome === "dequeued" ? t.cancelTurnDequeued : t.cancelTurnSucceeded,
        daemonMessage: result.message,
        cancelledTurnId: result.turnId,
        values: { sessionId, turnId: result.turnId },
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : t.cancelTurnFailed;
      return fail(400, {
        intent: "cancelTurn",
        success: false,
        cancelled: false,
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
      const updatedSession = await setSessionModelForCockpit(sessionId, parseModelValue(model));
      if (!updatedSession.model) {
        throw new Error(
          isZh
            ? "Spark daemon 未返回会话的有效模型。"
            : "The Spark daemon did not return an effective conversation model.",
        );
      }
      const effectiveModel = modelValue(updatedSession.model);
      return {
        intent: "selectModel",
        success: true,
        message: isZh
          ? `已切换到 ${effectiveModel}，将用于之后发送的消息。`
          : `Switched to ${effectiveModel}. It will be used for future messages.`,
        model: effectiveModel,
        values: { sessionId, model: effectiveModel },
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

async function submitConversationMessage(input: {
  workspaceId?: string;
  sessionId: string;
  message: string;
}) {
  const title = titleFromPrompt(input.message);
  return await submitConversationTurnForCockpit({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    prompt: input.message,
    title,
  });
}
