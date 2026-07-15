import { fail, redirect } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
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
  parseThinkingLevelValue,
  setSessionModelForCockpit,
  setSessionThinkingLevelForCockpit,
} from "$lib/server/model-control";
import {
  sessionsForWorkbench,
  workspaceIdForWorkbenchSession,
} from "../../../lib/workbench-session-scope";
import { sessionHasChannelBinding } from "../../../lib/channel-session-title";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent, url }) => {
  const parentData = await parent();
  const newSessionScope: "workspace" | "daemon" =
    url.searchParams.get("new") === "daemon" ? "daemon" : "workspace";
  const [managedSessions, modelControl] = await Promise.all([
    listManagedSessionsForCockpit(),
    loadModelControlForCockpit(),
  ]);
  return {
    sessions: sessionsForWorkbench(managedSessions.sessions, parentData.activeWorkspace?.id),
    sessionsAvailable: managedSessions.available,
    selectedSessionId: null as string | null,
    sessionActivity: null,
    modelControl,
    newSessionScope,
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
    const thinkingLevel = formText(formData, "thinkingLevel").trim();
    const values = { scopeKind, workspaceId, message, model, thinkingLevel };

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
          ? { scope: { kind: "daemon" } }
          : {
              scope: { kind: "workspace", workspaceId },
              workspaceId,
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
      if (thinkingLevel) {
        await setSessionThinkingLevelForCockpit(
          session.sessionId,
          parseThinkingLevelValue(thinkingLevel),
        );
      }
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
    const workspaceId = workspaceIdForWorkbenchSession(session);
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
        workspaceId: workspaceId ?? undefined,
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
      if (!result.cancelRequested && result.status !== "cancelled") {
        return fail(409, {
          intent: "cancelTurn",
          success: false,
          cancelled: false,
          error: t.cancelTurnUnavailable,
          message: t.cancelTurnUnavailable,
          invocationStatus: result.status,
          values,
        });
      }
      return {
        intent: "cancelTurn",
        success: true,
        cancelled: true,
        message: t.cancelTurnSucceeded,
        invocationStatus: result.status,
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
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();
    const model = formText(formData, "model").trim();
    if (!sessionId || !model) {
      return fail(400, {
        intent: "selectModel",
        success: false,
        message: t.selectModelRequired,
      });
    }
    try {
      const updatedSession = await setSessionModelForCockpit(sessionId, parseModelValue(model));
      if (!updatedSession.model) {
        return fail(400, {
          intent: "selectModel",
          success: false,
          message: t.effectiveModelMissing,
          values: { sessionId, model },
        });
      }
      const effectiveModel = modelValue(updatedSession.model);
      return {
        intent: "selectModel",
        success: true,
        message: t.workbench.modelUpdated,
        model: effectiveModel,
        values: { sessionId, model: effectiveModel },
      };
    } catch {
      return fail(400, {
        intent: "selectModel",
        success: false,
        message: t.workbench.modelFailed,
        values: { sessionId, model },
      });
    }
  },

  selectThinking: async ({ cookies, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();
    const thinkingLevel = formText(formData, "thinkingLevel").trim();
    if (!sessionId || !thinkingLevel) {
      return fail(400, {
        intent: "selectThinking",
        success: false,
        message: t.selectThinkingRequired,
      });
    }
    try {
      const updatedSession = await setSessionThinkingLevelForCockpit(
        sessionId,
        parseThinkingLevelValue(thinkingLevel),
      );
      const level = updatedSession.thinkingLevel ?? thinkingLevel;
      return {
        intent: "selectThinking",
        success: true,
        message: t.workbench.thinkingUpdated,
        thinkingLevel: level,
        values: { sessionId, thinkingLevel: level },
      };
    } catch {
      return fail(400, {
        intent: "selectThinking",
        success: false,
        message: t.workbench.thinkingFailed,
        values: { sessionId, thinkingLevel },
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

    const session = await getManagedSessionForCockpit(sessionId);
    if (session && sessionHasChannelBinding(session)) {
      return fail(409, {
        intent: "archiveSession",
        message: t.archiveChannelBound,
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
