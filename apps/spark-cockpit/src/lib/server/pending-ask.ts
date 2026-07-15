import type { DatabaseSync } from "node:sqlite";
import { loadInboxDetailPage, loadInboxPage } from "@zendev-lab/spark-coordination/cockpit-queries";
import { parseHumanQuestions, type PendingWorkbenchAsk } from "../pending-ask";
import { workspacePath } from "../workspace-routes";

export function loadPendingWorkbenchAsk(
  db: DatabaseSync,
  workspaceRouteId: string,
): PendingWorkbenchAsk | null {
  const inboxPage = loadInboxPage(db, workspaceRouteId);
  if (!inboxPage) return null;

  for (const item of inboxPage.inboxItems) {
    if (
      item.kind !== "ask" ||
      item.status !== "pending" ||
      item.requestKind !== "ask_user" ||
      item.requestStatus !== "pending" ||
      !item.humanRequestId
    ) {
      continue;
    }

    const detailPage = loadInboxDetailPage(db, workspaceRouteId, item.id);
    const detail = detailPage?.detail;
    if (
      !detail ||
      detail.kind !== "ask" ||
      detail.status !== "pending" ||
      detail.requestKind !== "ask_user" ||
      detail.requestStatus !== "pending"
    ) {
      continue;
    }
    if (
      detailPage.latestResponses.some(
        (response) => response.status === "recorded" || response.status === "delivering",
      )
    ) {
      continue;
    }

    return {
      id: detail.id,
      workspaceId: detail.workspaceId,
      workspaceSlug: detail.workspaceSlug,
      title: detail.title,
      prompt: detail.prompt,
      questions: parseHumanQuestions(detail.questionsJson),
      detailHref: workspacePath(
        { slug: detail.workspaceSlug },
        `/inbox/${encodeURIComponent(detail.id)}`,
      ),
      createdAt: detail.createdAt,
    };
  }

  return null;
}
