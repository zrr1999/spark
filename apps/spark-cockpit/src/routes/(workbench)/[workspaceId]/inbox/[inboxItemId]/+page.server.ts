import { fail, redirect, error as kitError } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import {
  buildApprovalDecisionPayload,
  buildApprovalDeliveryCommandPayload,
  describeApprovalCenterItem,
  type ApprovalDecision,
} from "@zendev-lab/spark-server/approval-center";
import {
  getCurrentUserIdBySessionToken,
  loadInboxDetailPage,
  type HumanQuestion,
} from "@zendev-lab/spark-server/cockpit-queries";
import { submitServerCommand } from "$lib/server/command-submission";
import { getDatabase } from "$lib/server/db";
import { formText, formTextList } from "$lib/server/form-data";
import { recordHumanResponse } from "$lib/server/projection-services";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ params }) => {
  const page = loadInboxDetailPage(getDatabase(), params.workspaceId, params.inboxItemId);
  if (!page) throw kitError(404, "Inbox item not found");
  const context = parseJsonObject(page.detail.contextJson);
  return {
    item: {
      ...page.detail,
      questions: parseQuestions(page.detail.questionsJson),
      context,
      approval: describeApprovalCenterItem({
        requestKind: page.detail.requestKind,
        title: page.detail.title,
        prompt: page.detail.prompt,
        context,
      }),
    },
    latestResponses: page.latestResponses.map((response) => ({
      ...response,
      answer: parseJsonObject(response.answerJson),
    })),
  };
};

export const actions: Actions = {
  decide: async ({ cookies, locals, params, request }) => {
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
    const decision = formText(formData, "decision") as ApprovalDecision;
    if (decision !== "approve" && decision !== "reject") {
      return fail(400, { message: t.unsupportedStatus });
    }
    const operatorNote = formText(formData, "operatorNote").trim();
    const context = parseJsonObject(detail.contextJson);
    const approval = describeApprovalCenterItem({
      requestKind: detail.requestKind,
      title: detail.title,
      prompt: detail.prompt,
      context,
    });
    const answeredByUserId = getCurrentUserIdBySessionToken(db, locals.sessionToken);
    const payload = buildApprovalDecisionPayload({ approval, decision, operatorNote });

    try {
      const response = recordHumanResponse(db, {
        humanRequestId: detail.humanRequestId,
        answeredByUserId,
        payload,
      });
      submitServerCommand(db, {
        workspaceId: detail.workspaceId,
        projectId: detail.projectId,
        requestedByUserId: answeredByUserId,
        idempotencyKey: `approval:${detail.humanRequestId}:${decision}`,
        payload: buildApprovalDeliveryCommandPayload({
          approval,
          decision,
          humanRequestId: detail.humanRequestId,
          humanResponseId: response.humanResponseId,
          runtimeRequestId: detail.runtimeRequestId,
          response: payload,
        }),
      });
    } catch (caught) {
      return fail(400, {
        message: caught instanceof Error ? caught.message : t.recordFailed,
      });
    }

    redirect(303, workspacePath(workspace, `/inbox/${params.inboxItemId}`));
  },

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

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
