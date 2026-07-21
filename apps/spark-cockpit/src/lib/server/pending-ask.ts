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

  let firstAsk: Omit<PendingWorkbenchAsk, "pendingCount"> | null = null;
  let pendingCount = 0;
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

    pendingCount += 1;
    firstAsk ??= {
      id: detail.id,
      workspaceId: detail.workspaceId,
      workspaceSlug: detail.workspaceSlug,
      sessionId: detail.sessionId ?? item.sessionId ?? null,
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

  return firstAsk ? { ...firstAsk, pendingCount } : null;
}
