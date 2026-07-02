import { fail, redirect, error as kitError } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import {
  getCurrentUserIdBySessionToken,
  loadInboxDetailPage,
  type HumanQuestion,
} from "@zendev-lab/spark-server/cockpit-queries";
import { getDatabase } from "$lib/server/db";
import { formText, formTextList } from "$lib/server/form-data";
import { recordHumanResponse } from "$lib/server/projection-services";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const page = loadInboxDetailPage(getDatabase(), params.workspaceId, params.inboxItemId);
  if (!page) throw kitError(404, "Inbox item not found");
  return {
    item: {
      ...page.detail,
      questions: parseQuestions(page.detail.questionsJson),
      context: parseJsonObject(page.detail.contextJson),
    },
    latestResponses: page.latestResponses.map((response) => ({
      ...response,
      answer: parseJsonObject(response.answerJson),
    })),
  };
};

export const actions: Actions = {
  respond: async ({ cookies, locals, params, request }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).inboxDetail.formMessages;
    const db = getDatabase();
    const page = loadInboxDetailPage(db, params.workspaceId, params.inboxItemId);
    if (!page) throw kitError(404, "Inbox item not found");
    const { workspace, detail } = page;

    if (detail.status !== "pending" || detail.requestStatus !== "pending") {
      return fail(409, { message: t.alreadyResolved });
    }

    const formData = await request.formData();
    const status = formText(formData, "status", "answered");
    if (status !== "answered" && status !== "cancelled" && status !== "archived") {
      return fail(400, { message: t.unsupportedStatus });
    }

    const questions = parseQuestions(detail.questionsJson);
    const answers: Record<string, unknown> = {};
    const missingRequired = [];

    for (const question of questions) {
      if (question.type === "preview") {
        continue;
      }

      const key = `answer:${question.id}`;
      if (question.type === "multi") {
        const values = formTextList(formData, key).filter(Boolean);
        if (question.required && values.length === 0) {
          missingRequired.push(question.prompt);
        }
        answers[question.id] = values;
        continue;
      }

      const value = formText(formData, key).trim();
      if (question.required && !value) {
        missingRequired.push(question.prompt);
      }
      answers[question.id] = value;
    }

    if (questions.length === 0) {
      const message = formText(formData, "answer:message").trim();
      if (!message && status === "answered") {
        return fail(400, { message: t.answerRequired });
      }
      answers.message = message;
    }

    const operatorNote = formText(formData, "operatorNote").trim();
    if (operatorNote) {
      answers.operatorNote = operatorNote;
    }

    if (missingRequired.length > 0 && status === "answered") {
      return fail(400, { message: `${t.missingRequiredPrefix} ${missingRequired[0]}` });
    }

    try {
      recordHumanResponse(db, {
        humanRequestId: detail.humanRequestId,
        answeredByUserId: getCurrentUserIdBySessionToken(db, locals.sessionToken),
        payload: {
          status,
          answers,
          responseArtifactRefs: [],
        },
      });
    } catch (caught) {
      return fail(400, {
        message: caught instanceof Error ? caught.message : t.recordFailed,
      });
    }

    redirect(303, workspacePath(workspace, `/inbox/${params.inboxItemId}`));
  },
};

function parseQuestions(value: string): HumanQuestion[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isHumanQuestion);
}

function isHumanQuestion(value: unknown): value is HumanQuestion {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { id?: unknown; type?: unknown; prompt?: unknown };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.prompt === "string" &&
    (candidate.type === "single" ||
      candidate.type === "multi" ||
      candidate.type === "freeform" ||
      candidate.type === "preview")
  );
}

function parseJsonObject(value: string) {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}
