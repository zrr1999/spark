import { fail, redirect, error as kitError } from "@sveltejs/kit";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { hashSecret } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText, formTextList } from "$lib/server/form-data";
import { recordHumanResponse } from "$lib/server/projection-services";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { workspacePath } from "$lib/workspace-routes";
import type { Actions, PageServerLoad } from "./$types";

type HumanQuestion = {
  id: string;
  type: "single" | "multi" | "freeform" | "preview";
  prompt: string;
  required?: boolean;
  options?: Array<{ id: string; label: string; description?: string }>;
};

type InboxDetailRow = {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  kind: string;
  title: string;
  summary: string | null;
  urgency: string;
  status: string;
  resolvedAs: string | null;
  createdAt: string;
  updatedAt: string;
  humanRequestId: string;
  runtimeRequestId: string;
  requestKind: string;
  requestTitle: string;
  prompt: string;
  questionsJson: string;
  contextJson: string;
  requestStatus: string;
  projectId: string | null;
  projectName: string | null;
  runtimeWorkspaceBindingId: string;
  runtimeWorkspaceName: string | null;
  runtimeName: string | null;
};

export const load: PageServerLoad = ({ params }) => {
  const workspace = requireWorkspaceByRouteId(getDatabase(), params.workspaceId);
  const detail = loadInboxDetail(params.inboxItemId);
  if (detail.workspaceId !== workspace.id) {
    throw kitError(404, "Inbox item not found");
  }
  const latestResponses = getDatabase()
    .prepare(
      `SELECT id,
              answer_json AS answerJson,
              status,
              delivery_attempt_count AS deliveryAttemptCount,
              last_delivery_at AS lastDeliveryAt,
              acked_at AS ackedAt,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM human_responses
       WHERE human_request_id = ?
       ORDER BY created_at DESC`,
    )
    .all(detail.humanRequestId) as Array<{
    id: string;
    answerJson: string;
    status: string;
    deliveryAttemptCount: number;
    lastDeliveryAt: string | null;
    ackedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;

  return {
    item: {
      ...detail,
      questions: parseQuestions(detail.questionsJson),
      context: parseJsonObject(detail.contextJson),
    },
    latestResponses: latestResponses.map((response) => ({
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
    const workspace = requireWorkspaceByRouteId(db, params.workspaceId);
    const detail = loadInboxDetail(params.inboxItemId);
    if (detail.workspaceId !== workspace.id) {
      throw kitError(404, "Inbox item not found");
    }

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
        answeredByUserId: getCurrentUserId(locals.sessionToken),
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

function loadInboxDetail(inboxItemId: string) {
  const row = getDatabase()
    .prepare(
      `SELECT ii.id,
              ii.workspace_id AS workspaceId,
              w.slug AS workspaceSlug,
              ii.kind,
              ii.title,
              ii.summary,
              ii.urgency,
              ii.status,
              ii.resolved_as AS resolvedAs,
              ii.created_at AS createdAt,
              ii.updated_at AS updatedAt,
              hr.id AS humanRequestId,
              hr.runtime_request_id AS runtimeRequestId,
              hr.kind AS requestKind,
              hr.title AS requestTitle,
              hr.prompt,
              hr.questions_json AS questionsJson,
              hr.context_json AS contextJson,
              hr.status AS requestStatus,
              p.id AS projectId,
              p.name AS projectName,
              rb.id AS runtimeWorkspaceBindingId,
              rb.display_name AS runtimeWorkspaceName,
              rc.name AS runtimeName
       FROM inbox_items ii
       JOIN workspaces w ON w.id = ii.workspace_id
       JOIN human_requests hr ON hr.id = ii.human_request_id
       LEFT JOIN projects p ON p.id = ii.project_id
       JOIN runtime_workspace_bindings rb ON rb.id = hr.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rb.runtime_id
       WHERE ii.id = ?
       LIMIT 1`,
    )
    .get(inboxItemId) as InboxDetailRow | undefined;

  if (!row) {
    throw kitError(404, "Inbox item not found");
  }

  return row;
}

function getCurrentUserId(sessionToken: string | null) {
  if (!sessionToken) {
    return null;
  }

  const row = getDatabase()
    .prepare(
      `SELECT user_id AS userId
       FROM sessions
       WHERE token_hash = ? AND revoked_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(hashSecret(sessionToken)) as { userId: string } | undefined;

  return row?.userId ?? null;
}

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
