import {
  nowIso,
  type TaskRunCompletionSummary,
  type ProjectRef,
} from "@zendev-lab/pi-extension-api";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import {
  loadHiddenRoleRunInboxState,
  saveHiddenRoleRunInboxState,
} from "./hidden-role-run-inbox.ts";
import { sparkSessionOwnerKey, type SparkSessionContext } from "./session-identity.ts";
import { loadSparkGraph } from "./session-state.ts";
import { shortRoleLabel } from "./task-ownership.ts";
import { truncateInline } from "./tool-rendering.ts";

const DEFAULT_SPARK_HIDDEN_INBOX_COMPLETIONS_LIMIT = 5;
const SPARK_HIDDEN_INBOX_RECENT_MS = 7 * 24 * 60 * 60 * 1_000;
const SPARK_HIDDEN_INBOX_MAX_DELIVERED = 1_000;

export interface HiddenRoleRunInbox {
  summaries: TaskRunCompletionSummary[];
  remaining: number;
}

export function collectRecentRoleRunCompletions(input: {
  graph: TaskGraph;
  projectRef?: ProjectRef;
  limit: number;
}): TaskRunCompletionSummary[] {
  return input.graph
    .runs(input.projectRef)
    .flatMap((run) => (run.completionSummary ? [run.completionSummary] : []))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, input.limit)
    .map(cloneTaskRunCompletionSummary);
}

export async function collectUnreadHiddenRoleRunInbox(
  cwd: string,
  ctx: SparkSessionContext | undefined,
): Promise<HiddenRoleRunInbox> {
  const graph = await loadSparkGraph(cwd, ctx);
  if (!graph) return { summaries: [], remaining: 0 };
  const ownerSessionId = sparkSessionOwnerKey(ctx);
  const deliveredRunRefs = new Set(
    (await loadHiddenRoleRunInboxState(cwd, ctx)).delivered.map((entry) => entry.runRef),
  );
  const recentCutoffMs = Date.now() - SPARK_HIDDEN_INBOX_RECENT_MS;
  const unread = graph
    .runs()
    .filter((run) => run.ownerSessionId === ownerSessionId)
    .flatMap((run) => {
      if (!run.completionSummary || deliveredRunRefs.has(run.ref)) return [];
      const createdAtMs = Date.parse(run.completionSummary.createdAt);
      if (Number.isFinite(createdAtMs) && createdAtMs < recentCutoffMs) return [];
      return [run.completionSummary];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const summaries = unread
    .slice(0, DEFAULT_SPARK_HIDDEN_INBOX_COMPLETIONS_LIMIT)
    .map(cloneTaskRunCompletionSummary);
  return { summaries, remaining: Math.max(0, unread.length - summaries.length) };
}

export function formatHiddenRoleRunInbox(input: HiddenRoleRunInbox): string {
  const lines = ["Recent unread background role-run results:"];
  for (const summary of input.summaries) {
    const nextAction = hiddenRoleRunNextAction(summary);
    lines.push(`${formatRoleRunCompletionLine(summary)}; next=${nextAction}`);
  }
  if (input.remaining > 0)
    lines.push(`- ${input.remaining} more unread result(s) remain for a later turn.`);
  lines.push(
    'Use artifact refs or task({ action: "run_status", runAction: "inspect" }) for full details if needed.',
  );
  return lines.join("\n");
}

export async function markHiddenRoleRunInboxDelivered(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  summaries: TaskRunCompletionSummary[],
): Promise<void> {
  const state = await loadHiddenRoleRunInboxState(cwd, ctx);
  const deliveredAt = nowIso();
  const byRunRef = new Map(state.delivered.map((entry) => [entry.runRef, entry]));
  for (const summary of summaries)
    byRunRef.set(summary.runRef, { runRef: summary.runRef, deliveredAt });
  state.delivered = [...byRunRef.values()]
    .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt))
    .slice(0, SPARK_HIDDEN_INBOX_MAX_DELIVERED);
  await saveHiddenRoleRunInboxState(cwd, ctx, state);
}

export function appendRecentRoleRunCompletionLines(
  lines: string[],
  summaries: TaskRunCompletionSummary[],
): void {
  lines.push("Recent role-run completions:");
  for (const summary of summaries) lines.push(`  ${formatRoleRunCompletionLine(summary)}`);
}

function formatRoleRunCompletionLine(summary: TaskRunCompletionSummary): string {
  const role = summary.roleRef ? ` role=${shortRoleLabel(summary.roleRef)}` : "";
  const runName = summary.runName ? ` name=${summary.runName}` : "";
  const artifacts =
    summary.artifactRefs.length > 0
      ? ` artifacts=${summary.artifactRefs.join(",")}`
      : " artifacts=none";
  return `- [${summary.status}] task=${summary.taskRef} run=${summary.runRef}${role}${runName} — ${truncateInline(summary.summary, 180)}${artifacts}`;
}

function hiddenRoleRunNextAction(summary: TaskRunCompletionSummary): string {
  if (summary.status === "failed") {
    return `inspect with task({ action: "run_status", runAction: "inspect", runRef: "${summary.runRef}" }); fix the failure cause, then rerun the ready frontier`;
  }
  if (summary.status === "cancelled") {
    return `inspect with task({ action: "run_status", runAction: "inspect", runRef: "${summary.runRef}" }); decide whether to requeue, supersede, or acknowledge cancellation`;
  }
  return "continue parent task using this compact summary and artifact refs";
}

function cloneTaskRunCompletionSummary(
  summary: TaskRunCompletionSummary,
): TaskRunCompletionSummary {
  return { ...summary, artifactRefs: [...summary.artifactRefs] };
}
