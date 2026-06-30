import { Type } from "typebox";
import { defaultArtifactStore } from "@zendev-lab/pi-artifacts";
import type { TaskGraph } from "@zendev-lab/pi-tasks";
import { nowIso, type JsonValue, type RoleRef } from "@zendev-lab/pi-extension-api";
import { currentSparkProject, loadSparkGraph, sparkSessionKey } from "./session-state.ts";
import {
  requestGoalCompletionReview,
  type GoalCompletionReviewOutcome,
} from "./spark-goal-completion-review.ts";
import {
  clearSessionGoal,
  editSessionGoalObjective,
  inferSessionGoalObjective,
  loadSessionGoal,
  normalizeGoalObjective,
  normalizeOptionalReason,
  setSessionGoal,
  updateSessionGoalStatus,
  type SparkSessionGoal,
  type SparkSessionGoalSource,
} from "./spark-session-goals.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import type {
  GoalReviewInput,
  GoalReviewVerdict,
  ReviewerRunResult,
  ReviewerRunner,
} from "./reviewer-runner.ts";
import { withSparkReviewerLease } from "./spark-reviewer-lease.ts";
import { recordGoalSubjectReview } from "./subject-review-store.ts";

export type SparkGoalToolAction =
  | "status"
  | "set"
  | "start"
  | "pause"
  | "resume"
  | "clear"
  | "edit"
  | "complete";

interface SparkGoalToolDeps {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  syncAskAutoAnswerPolicy?: (ctx: SparkToolContext) => Promise<void>;
  createReviewerRunner?: (
    cwd: string,
    ctx: SparkToolContext,
  ) => ReviewerRunner | Promise<ReviewerRunner>;
}

export function registerSparkGoalTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkGoalToolDeps,
): void {
  registerSparkTool({
    name: "goal",
    label: "Spark Goal",
    description:
      "Manage the current Pi session's durable goal state. Actions: status, set, start, pause, resume, clear, edit, complete. Active goals are autonomous foreground drivers: reviewer-backed ask auto-answer may resolve material decisions during goal work, while final goal completion remains reviewer-gated (main session requests, reviewer audits, Spark applies approved transition). Autonomous pause is rejected; blockers must be resolved instead of pausing.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description:
            "status | set | start | pause | resume | clear | edit | complete. Defaults to status. Active goal work may use reviewer-backed ask auto-answer; completion requests are reviewer-gated and autonomous pause requests are rejected.",
        }),
      ),
      objective: Type.Optional(
        Type.String({
          description:
            "Goal objective for set/start/edit. For edit, this must correct a description or direction error without lowering difficulty.",
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description:
            "Required for edit: explain the description/direction error being corrected. Pause reasons are not accepted for autonomous goal work.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = normalizeSparkGoalAction(params.action);
      const cwd = ctx.cwd;
      const graph = await loadSparkGraph(cwd, ctx);
      const project = graph ? await currentSparkProject(cwd, ctx, graph) : undefined;

      if (action === "status") {
        const goal = await loadSessionGoal(cwd, ctx);
        const relationship = describeGoalProjectRelationship(goal, graph, project);
        return goalResult(
          goal,
          action,
          goal ? renderGoalStatus(goal, relationship) : renderNoGoalStatus(relationship),
          { goalProjectRelationship: relationship },
        );
      }

      if (action === "set" || action === "start") {
        const objective = resolveGoalObjective(action, params.objective, graph, project);
        if (!objective)
          return {
            content: [
              {
                type: "text",
                text: "No Spark project/task state is available to infer a session goal. Provide objective for start/set.",
              },
            ],
            details: { found: false, action, error: "no_inferable_goal" },
          };
        const source: SparkSessionGoalSource =
          params.objective === undefined ? "inferred" : "explicit";
        const goal = await setSessionGoal(cwd, ctx, {
          objective,
          source,
          status: "active",
        });
        await refreshGoalRuntimeState(cwd, ctx, deps);
        return goalResult(goal, action, renderGoalActivationResult(goal, graph, project));
      }

      const existingGoal = await loadSessionGoal(cwd, ctx);
      if (!existingGoal)
        return {
          content: [{ type: "text", text: "No session goal is set." }],
          details: { found: false, action, error: "no_goal" },
        };
      if (action === "complete") {
        const completion = await requestGoalCompletionReview(
          ctx,
          deps,
          { graph: graph ?? undefined, project, goal: existingGoal },
          { trigger: "tool" },
        );
        await deps.syncAskAutoAnswerPolicy?.(ctx);
        return goalCompletionResult(existingGoal, action, completion);
      }
      if (action === "clear") {
        await clearSessionGoal(cwd, ctx);
        await refreshGoalRuntimeState(cwd, ctx, deps);
        return {
          content: [
            {
              type: "text" as const,
              text: `Cleared Spark session goal: ${oneLine(existingGoal.objective)}`,
            },
          ],
          details: { found: true, action, clearedGoal: existingGoal, goal: null },
        };
      }
      if (action === "resume") {
        if (existingGoal.status === "complete")
          return {
            content: [
              {
                type: "text" as const,
                text: `Cannot resume completed Spark session goal: ${oneLine(existingGoal.objective)}. Start a new goal instead.`,
              },
            ],
            details: { found: true, action, error: "goal_already_complete", goal: existingGoal },
          };
        const resumed = await updateSessionGoalStatus(cwd, ctx, "active", { retryState: null });
        await refreshGoalRuntimeState(cwd, ctx, deps);
        const relationship = describeGoalProjectRelationship(
          resumed ?? existingGoal,
          graph,
          project,
        );
        return goalResult(
          resumed,
          action,
          renderGoalStatus(resumed ?? existingGoal, relationship),
          { goalProjectRelationship: relationship },
        );
      }
      if (action === "edit") {
        const objective = normalizeGoalObjective(params.objective);
        const reason = normalizeOptionalReason(params.reason);
        const editResult = await reviewedEditCurrentSessionGoal(
          cwd,
          ctx,
          deps,
          objective,
          reason,
          _signal,
        );
        if (!editResult.approved)
          return {
            content: [
              {
                type: "text",
                text: renderGoalEditRejectedMessage(existingGoal, editResult),
              },
            ],
            details: {
              found: true,
              action,
              error: "goal_edit_review_failed",
              goal: existingGoal,
              proposedObjective: objective,
              review: editResult.review?.verdict,
              reviewArtifact: editResult.reviewArtifactRef,
            },
          };
        const relationship = describeGoalProjectRelationship(
          editResult.goal ?? existingGoal,
          graph,
          project,
        );
        return goalResult(
          editResult.goal,
          action,
          renderGoalStatus(editResult.goal ?? existingGoal, relationship),
          { goalProjectRelationship: relationship },
        );
      }
      const autonomousPauseGuard = forbiddenAutonomousPauseResult(ctx, existingGoal, action);
      if (autonomousPauseGuard) return autonomousPauseGuard;
      const reason = normalizeOptionalReason(params.reason);
      const pauseResult = await reviewedPauseCurrentSessionGoal(cwd, ctx, deps, reason, _signal);
      if (!pauseResult.goal)
        return {
          content: [{ type: "text", text: "No session goal is set." }],
          details: { found: false, action, error: "no_goal" },
        };
      if (!pauseResult.approved)
        return {
          content: [
            {
              type: "text",
              text: renderGoalPauseRejectedMessage(pauseResult.goal, pauseResult),
            },
          ],
          details: {
            found: true,
            action,
            error: "goal_pause_review_failed",
            goal: pauseResult.goal,
            review: pauseResult.review?.verdict,
            reviewArtifact: pauseResult.reviewArtifactRef,
          },
        };
      const relationship = describeGoalProjectRelationship(pauseResult.goal, graph, project);
      return goalResult(
        pauseResult.goal,
        action,
        renderGoalStatus(pauseResult.goal, relationship),
        { goalProjectRelationship: relationship },
      );
    },
  });
}

export function normalizeSparkGoalAction(value: unknown): SparkGoalToolAction {
  if (value === undefined || value === null || value === "") return "status";
  if (
    value === "status" ||
    value === "set" ||
    value === "start" ||
    value === "pause" ||
    value === "resume" ||
    value === "clear" ||
    value === "edit" ||
    value === "complete"
  ) {
    return value;
  }
  throw new Error(
    "goal action must be status, set, start, pause, resume, clear, edit, or complete",
  );
}

export async function startOrInferSessionGoal(
  cwd: string,
  ctx: SparkToolContext,
  graph: TaskGraph | null,
  explicitObjective?: string,
): Promise<SparkSessionGoal | undefined> {
  const project = graph ? await currentSparkProject(cwd, ctx, graph) : undefined;
  const objective =
    explicitObjective?.trim() || (graph ? inferSessionGoalObjective(graph, project) : undefined);
  if (!objective) return undefined;
  return setSessionGoal(cwd, ctx, {
    objective,
    source: explicitObjective?.trim() ? "explicit" : "inferred",
    status: "active",
  });
}

export async function pauseCurrentSessionGoal(
  cwd: string,
  ctx: SparkToolContext,
  reason?: string,
): Promise<SparkSessionGoal | undefined> {
  return updateSessionGoalStatus(cwd, ctx, "paused", { reason });
}

interface ReviewedGoalPauseResult {
  goal?: SparkSessionGoal;
  approved: boolean;
  review?: ReviewerRunResult;
  reviewArtifactRef?: string;
}

interface ReviewedGoalEditResult {
  goal?: SparkSessionGoal;
  approved: boolean;
  review?: ReviewerRunResult;
  reviewArtifactRef?: string;
}

async function reviewedEditCurrentSessionGoal(
  cwd: string,
  ctx: SparkToolContext,
  deps: SparkGoalToolDeps,
  proposedObjective: string,
  reason: string | undefined,
  signal?: AbortSignal,
): Promise<ReviewedGoalEditResult> {
  const existingGoal = await loadSessionGoal(cwd, ctx);
  if (!existingGoal) return { approved: false };
  const reviewerRunner = await deps.createReviewerRunner?.(cwd, ctx);
  if (!reviewerRunner) throw new Error("goal edit requires a reviewer runner");
  const reviewInput: GoalReviewInput = {
    targetKind: "goal",
    cwd,
    goalId: existingGoal.goalId,
    objective: existingGoal.objective,
    status: existingGoal.status,
    requestedStatus: "edited",
    proposedObjective,
    reason,
    evidenceRefs: existingGoal.lastReviewArtifactRef ? [existingGoal.lastReviewArtifactRef] : [],
    sessionKey: sparkSessionKey(ctx),
    forkFromSession: ctx.sessionManager?.getSessionFile?.(),
  };
  const review = await runGoalReviewer(cwd, ctx, reviewerRunner, reviewInput, signal);
  const verdict = review.verdict as GoalReviewVerdict;
  const artifact = await recordGoalTransitionReviewArtifact(
    cwd,
    existingGoal,
    review,
    reviewInput,
    {
      requestedStatus: "edited",
      proposedObjective,
      reason,
    },
  );
  if (verdict.outcome !== "approved")
    return { goal: existingGoal, approved: false, review, reviewArtifactRef: artifact.ref };
  const edited = await editSessionGoalObjective(cwd, ctx, proposedObjective);
  await refreshGoalRuntimeState(cwd, ctx, deps);
  return { goal: edited, approved: true, review, reviewArtifactRef: artifact.ref };
}

export async function reviewedPauseCurrentSessionGoal(
  cwd: string,
  ctx: SparkToolContext,
  deps: SparkGoalToolDeps,
  reason?: string,
  signal?: AbortSignal,
): Promise<ReviewedGoalPauseResult> {
  const existingGoal = await loadSessionGoal(cwd, ctx);
  if (!existingGoal) return { approved: false };
  const reviewerRunner = await deps.createReviewerRunner?.(cwd, ctx);
  if (!reviewerRunner) throw new Error("goal pause requires a reviewer runner");
  const reviewInput: GoalReviewInput = {
    targetKind: "goal",
    cwd,
    goalId: existingGoal.goalId,
    objective: existingGoal.objective,
    status: existingGoal.status,
    requestedStatus: "paused",
    reason,
    evidenceRefs: existingGoal.lastReviewArtifactRef ? [existingGoal.lastReviewArtifactRef] : [],
    sessionKey: sparkSessionKey(ctx),
    forkFromSession: ctx.sessionManager?.getSessionFile?.(),
  };
  const review = await runGoalReviewer(cwd, ctx, reviewerRunner, reviewInput, signal);
  const verdict = review.verdict as GoalReviewVerdict;
  const artifact = await recordGoalTransitionReviewArtifact(
    cwd,
    existingGoal,
    review,
    reviewInput,
    {
      requestedStatus: "paused",
      reason,
    },
  );
  if (verdict.outcome !== "approved")
    return {
      goal: existingGoal,
      approved: false,
      review,
      reviewArtifactRef: artifact.ref,
    };
  const goal = await updateSessionGoalStatus(cwd, ctx, "paused", {
    reason,
    review: {
      achieved: false,
      confidence: verdict.confidence,
      reason: verdict.summary,
      remainingWork: verdict.remainingWork,
      blockers: verdict.blockers,
      artifactRef: artifact.ref,
      reviewedAt: review.record.finishedAt || nowIso(),
    },
  });
  await refreshGoalRuntimeState(cwd, ctx, deps);
  return { goal, approved: true, review, reviewArtifactRef: artifact.ref };
}

async function refreshGoalRuntimeState(
  cwd: string,
  ctx: SparkToolContext,
  deps: SparkGoalToolDeps,
): Promise<void> {
  await deps.syncAskAutoAnswerPolicy?.(ctx);
  await deps.refreshSparkWidget(cwd, ctx);
}

async function runGoalReviewer(
  cwd: string,
  ctx: SparkToolContext,
  reviewerRunner: ReviewerRunner,
  input: GoalReviewInput,
  signal?: AbortSignal,
): Promise<ReviewerRunResult> {
  try {
    const leasedReview = await withSparkReviewerLease(cwd, ctx, () =>
      reviewerRunner.review(input, signal),
    );
    if (!leasedReview.acquired || !leasedReview.result)
      return failedGoalPauseReviewerRunResult(
        input,
        "another Spark reviewer gate is already running for this session",
      );
    return leasedReview.result;
  } catch (error) {
    return failedGoalPauseReviewerRunResult(
      input,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function failedGoalPauseReviewerRunResult(
  input: GoalReviewInput,
  reason: string,
): ReviewerRunResult {
  const timestamp = nowIso();
  return {
    verdict: {
      targetKind: "goal",
      goalId: input.goalId,
      achieved: false,
      outcome: "blocked",
      summary: `reviewer failed: ${reason}`,
      remainingWork: reason,
      findings: [],
      blockers: [reason],
      confidence: "low",
    },
    record: {
      roleRef: "role:builtin-reviewer" as RoleRef,
      runName: "goal-pause-reviewer-failed",
      startedAt: timestamp,
      finishedAt: timestamp,
    },
  };
}

async function recordGoalTransitionReviewArtifact(
  cwd: string,
  goal: SparkSessionGoal,
  review: ReviewerRunResult,
  input: GoalReviewInput,
  request: { requestedStatus: "paused" | "edited"; reason?: string; proposedObjective?: string },
) {
  const reviewerRun = {
    ...(review.record.runRef ? { runRef: review.record.runRef } : {}),
    roleRef: review.record.roleRef,
    ...(review.record.runName ? { runName: review.record.runName } : {}),
    startedAt: review.record.startedAt,
    finishedAt: review.record.finishedAt,
  };
  const artifact = await defaultArtifactStore(cwd).put({
    kind: "record",
    title: `Goal ${request.requestedStatus} review for session goal: ${oneLine(goal.objective)}`,
    format: "json",
    body: {
      goalId: goal.goalId,
      objective: goal.objective,
      requestedStatus: request.requestedStatus,
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.proposedObjective ? { proposedObjective: request.proposedObjective } : {}),
      verdict: review.verdict,
      reviewerRun,
      recordedAt: nowIso(),
    } as unknown as JsonValue,
    provenance: {
      producer: "review",
      roleRef: review.record.roleRef,
      runRef: review.record.runRef,
    },
  });
  await recordGoalSubjectReview(cwd, goal, artifact, review, input);
  return artifact;
}

function forbiddenAutonomousPauseResult(
  ctx: SparkToolContext,
  goal: SparkSessionGoal,
  action: SparkGoalToolAction,
) {
  if (ctx.sparkAutonomousGoalTurn?.goalId !== goal.goalId) return undefined;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Autonomous goal pause is not allowed for session goal: ${oneLine(goal.objective)}\n` +
          'If progress is blocked, resolve the blocker first: inspect tasks, create or revise concrete blocking work with task_write({ action: "plan" }), claim/finish the blocking task, or use ask({ autoAnswer: "reviewer" }) only for reviewer-backed decisions when the host provides it. Do not reduce the goal or pause it to avoid hard work.',
      },
    ],
    details: {
      found: true,
      action,
      error: "autonomous_goal_pause_forbidden",
      goal,
      guidance: [
        "Autonomous goal mode must not pause itself.",
        "Resolve blockers by doing or planning blocking work before continuing the goal.",
        "Only correct a goal objective when the current wording is materially wrong and the correction does not lower difficulty.",
      ],
    },
  };
}

function renderGoalEditRejectedMessage(
  goal: SparkSessionGoal,
  result: ReviewedGoalEditResult,
): string {
  const verdict = result.review?.verdict as GoalReviewVerdict | undefined;
  const summary =
    verdict?.summary ??
    "reviewer did not approve editing this goal; autonomous edits must correct a material description or direction error without lowering difficulty";
  const findings = verdict?.findings?.length
    ? `\nFindings: ${formatGoalReviewList(verdict.findings)}`
    : "";
  const blockers = verdict?.blockers?.length
    ? `\nBlockers: ${formatGoalReviewList(verdict.blockers)}`
    : "";
  const artifact = result.reviewArtifactRef ? `\nReview artifact: ${result.reviewArtifactRef}` : "";
  return `Goal edit blocked by reviewer for session goal: ${oneLine(goal.objective)}\nReview outcome: ${verdict?.outcome ?? "blocked"}\nReview summary: ${summary}${findings}${blockers}${artifact}`;
}

function renderGoalPauseRejectedMessage(
  goal: SparkSessionGoal,
  result: ReviewedGoalPauseResult,
): string {
  const verdict = result.review?.verdict as GoalReviewVerdict | undefined;
  const summary = verdict?.summary ?? "reviewer did not approve pausing this goal";
  const blockers = verdict?.blockers?.length
    ? `\nBlockers: ${formatGoalReviewList(verdict.blockers)}`
    : "";
  const artifact = result.reviewArtifactRef ? `\nReview artifact: ${result.reviewArtifactRef}` : "";
  return `Goal pause blocked by reviewer for session goal: ${oneLine(goal.objective)}\nReview outcome: ${verdict?.outcome ?? "blocked"}\nReview summary: ${summary}${blockers}${artifact}`;
}

function formatGoalReviewList(items: readonly string[]): string {
  const visible = items.slice(0, 5);
  const hidden = items.length - visible.length;
  return `${visible.join("; ")}${hidden > 0 ? `; … ${hidden} more` : ""}`;
}

function goalCompletionResult(
  originalGoal: SparkSessionGoal,
  action: SparkGoalToolAction,
  result: GoalCompletionReviewOutcome,
) {
  if (result.outcome === "completed") {
    const goal = result.goal ?? originalGoal;
    return {
      content: [
        {
          type: "text" as const,
          text: `Goal completion approved by reviewer for session goal: ${oneLine(originalGoal.objective)}\nReview summary: ${oneLine(result.reason)}\nReview artifact: ${result.artifactRef}`,
        },
      ],
      details: {
        found: true,
        action,
        goal,
        outcome: result.outcome,
        review: result.review.verdict,
        reviewArtifact: result.artifactRef,
      },
    };
  }
  if (result.outcome === "blocked") {
    const blockers = result.blockers.length
      ? `\nBlockers: ${formatGoalReviewList(result.blockers)}`
      : "";
    const remainingWork = result.remainingWork ? `\nRemaining work: ${result.remainingWork}` : "";
    const artifact = result.artifactRef ? `\nReview artifact: ${result.artifactRef}` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `Goal completion request needs changes for session goal: ${oneLine(originalGoal.objective)}\nReason: ${result.reason}${remainingWork}${blockers}${artifact}`,
        },
      ],
      details: {
        found: true,
        action,
        error: "goal_completion_needs_changes",
        goal: result.goal ?? originalGoal,
        outcome: result.outcome,
        blockers: result.blockers,
        remainingWork: result.remainingWork,
        review: result.review?.verdict,
        reviewArtifact: result.artifactRef,
      },
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text:
          result.outcome === "deferred"
            ? `Goal completion review is already running for this session goal: ${oneLine(originalGoal.objective)}. Retry after the active reviewer gate finishes.`
            : `Goal completion review is unavailable for session goal: ${oneLine(originalGoal.objective)}. ${result.reason}`,
      },
    ],
    details: {
      found: true,
      action,
      error:
        result.outcome === "deferred"
          ? "goal_completion_review_deferred"
          : "goal_completion_reviewer_unavailable",
      goal: originalGoal,
      outcome: result.outcome,
      reason: result.reason,
    },
  };
}

function resolveGoalObjective(
  action: SparkGoalToolAction,
  value: unknown,
  graph: TaskGraph | null,
  project: Awaited<ReturnType<typeof currentSparkProject>>,
): string | undefined {
  if (value !== undefined || action === "set") return normalizeGoalObjective(value);
  return graph ? inferSessionGoalObjective(graph, project) : undefined;
}

function goalResult(
  goal: SparkSessionGoal | undefined,
  action: string,
  text: string,
  extraDetails: Record<string, unknown> = {},
) {
  return {
    content: [{ type: "text" as const, text }],
    details: { found: Boolean(goal), action, goal, ...extraDetails },
  };
}

function renderGoalActivationResult(
  goal: SparkSessionGoal,
  graph: TaskGraph | null,
  project: Awaited<ReturnType<typeof currentSparkProject>>,
): string {
  const lines = ["Spark session goal active."];
  if (!graph || !project) {
    lines.push(
      "No current Spark project is selected for this goal yet.",
      'Next autonomous step: create or select a project with task_write({ action: "project_use", title, description }), using the goal objective as the project intent; then plan initial concrete tasks with task_write({ action: "plan" }).',
      `Goal objective: ${oneLine(goal.objective)}`,
    );
  }
  return lines.join("\n");
}

interface GoalProjectRelationshipDetail {
  hasGoal: boolean;
  durableState: "active" | "paused" | "complete" | "none";
  currentProject?: {
    ref: string;
    title: string;
    unfinishedTaskCount: number;
    readyTaskCount: number;
  };
  binding: "current_project" | "no_current_project";
  note: string;
  recommendedAction?: string;
}

function describeGoalProjectRelationship(
  goal: SparkSessionGoal | undefined,
  graph: TaskGraph | null,
  project: Awaited<ReturnType<typeof currentSparkProject>>,
): GoalProjectRelationshipDetail {
  const currentProject =
    graph && project
      ? {
          ref: project.ref,
          title: project.title,
          unfinishedTaskCount: graph
            .tasks(project.ref)
            .filter((task) => task.status !== "done" && task.status !== "cancelled").length,
          readyTaskCount: graph.readyTasks(project.ref).length,
        }
      : undefined;
  const hasGoal = Boolean(goal);
  const durableState = goal?.status ?? "none";
  if (!currentProject) {
    return {
      hasGoal,
      durableState,
      binding: "no_current_project",
      note: hasGoal
        ? "Durable goal exists, but no current project is selected; inspect, select, or create a project before claiming project tasks."
        : "No durable goal exists and no current project is selected; use current project/task context only as background hints.",
      recommendedAction: hasGoal
        ? 'task_write({ action: "project_use", project }) or task_write({ action: "project_use", title, description })'
        : 'Inspect projects with task_read({ action: "project_list" }) or start a goal with goal({ action: "start", objective }).',
    };
  }
  return {
    hasGoal,
    durableState,
    currentProject,
    binding: "current_project",
    note: hasGoal
      ? "Goal is session-scoped; use the selected project as context and evidence while working toward the objective."
      : "No durable goal exists; the selected project can seed a new session goal when its purpose matches the user objective.",
    recommendedAction: hasGoal
      ? 'Continue goal work; when the objective is substantively achieved with evidence, request goal({ action: "complete" }).'
      : 'Use goal({ action: "start" }) to infer from the current project, or goal({ action: "set", objective }) for an explicit goal.',
  };
}

function renderNoGoalStatus(relationship: GoalProjectRelationshipDetail): string {
  const lines = [
    "No session goal is set in durable session state.",
    "Use historical compact summaries only as background context.",
  ];
  if (relationship.currentProject) {
    const project = relationship.currentProject;
    lines.push(
      `Current project: ${oneLine(project.title)} (${project.ref}) unfinishedTasks=${project.unfinishedTaskCount} readyTasks=${project.readyTaskCount}.`,
    );
  } else {
    lines.push("Current project: none selected; no recent project binding is available.");
  }
  lines.push(
    `Goal/project relationship: ${relationship.note}`,
    `Recommended next action: ${relationship.recommendedAction}`,
  );
  return lines.join("\n");
}

function renderGoalStatus(
  goal: SparkSessionGoal,
  relationship: GoalProjectRelationshipDetail,
): string {
  const lines = [`Spark session goal ${goal.status}`, `Goal: ${oneLine(goal.objective)}`];
  const reason = goal.pauseReason ?? goal.completedReason;
  if (reason) lines.push(`Reason: ${reason}`);
  if (goal.lastReviewRef || goal.lastReviewArtifactRef || goal.lastReviewedAt)
    lines.push(
      `Last review: ${goal.lastReviewRef ?? "unrecorded"}${goal.lastReviewArtifactRef ? ` artifact=${goal.lastReviewArtifactRef}` : ""}${goal.lastReviewedAt ? ` at ${goal.lastReviewedAt}` : ""}`,
    );
  if (goal.retryState?.consecutiveFailures)
    lines.push(
      `Retry state: ${goal.retryState.consecutiveFailures} failure(s), nextDelayMs=${goal.retryState.nextDelayMs ?? "unknown"}.`,
    );
  if (relationship.currentProject) {
    const project = relationship.currentProject;
    lines.push(
      `Current project: ${oneLine(project.title)} (${project.ref}) unfinishedTasks=${project.unfinishedTaskCount} readyTasks=${project.readyTaskCount}.`,
    );
  } else {
    lines.push("Current project: none selected for this session goal.");
  }
  lines.push(`Goal/project relationship: ${relationship.note}`);
  if (relationship.recommendedAction)
    lines.push(`Recommended next action: ${relationship.recommendedAction}`);
  lines.push(
    'Actions: goal({ action: "status" }), goal({ action: "resume" }), goal({ action: "edit", objective, reason }), goal({ action: "complete" }), goal({ action: "clear" }), goal({ action: "start" }); active goal work may use reviewer-backed ask auto-answer for decisions, completion is reviewer-gated (main session requests, reviewer audits, Spark applies approved state), and autonomous pause is forbidden.',
  );
  return lines.join("\n");
}

function oneLine(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}
