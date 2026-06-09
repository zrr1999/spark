import { Type } from "typebox";
import { defaultArtifactStore } from "pi-artifacts";
import type { TaskGraph } from "pi-tasks";
import { nowIso, type JsonValue, type RoleRef } from "pi-extension-api";
import {
  clearSparkExecutionMode,
  currentSparkProject,
  loadSparkGraph,
  sparkSessionKey,
} from "./session-state.ts";
import {
  inferSessionGoalObjective,
  loadSessionGoal,
  normalizeGoalObjective,
  normalizeOptionalReason,
  sameGoalTarget,
  setSessionGoal,
  updateSessionGoalStatus,
  type SparkGoalScope,
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

export type SparkGoalToolAction = "status" | "infer" | "set" | "start" | "pause" | "complete";

interface SparkGoalToolDeps {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
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
      "Manage the current Pi session's durable goal state. Actions: status, infer, set, start, pause. Goal completion is reviewer-owned; legacy complete requests are rejected for the main agent.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description:
            "status | infer | set | start | pause. Defaults to status. Completion is reviewer-owned.",
        }),
      ),
      objective: Type.Optional(Type.String({ description: "Goal objective for set/start." })),
      reason: Type.Optional(Type.String({ description: "Reason for pause." })),
      scope: Type.Optional(
        Type.String({ description: "Goal scope: session or project. Defaults to session." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = normalizeSparkGoalAction(params.action);
      const cwd = ctx.cwd;
      const graph = await loadSparkGraph(cwd, ctx);
      const project = graph ? await currentSparkProject(cwd, ctx, graph) : undefined;

      const requestedScope = normalizeSparkGoalScope(params.scope);
      const requestedProjectRef = requestedScope === "project" ? project?.ref : undefined;

      if (action === "infer") {
        if (!graph)
          return {
            content: [
              {
                type: "text",
                text: "No Spark project/task state is available to infer a session goal.",
              },
            ],
            details: { found: false, action, error: "no_project_state" },
          };
        if (requestedScope === "project" && !project)
          return {
            content: [
              {
                type: "text",
                text: "No current Spark project is selected for a project-scoped goal.",
              },
            ],
            details: { found: false, action, error: "no_current_project", scope: requestedScope },
          };
        const objective = inferSessionGoalObjective(graph, project);
        return {
          content: [{ type: "text", text: objective }],
          details: {
            found: true,
            action,
            scope: requestedScope,
            projectRef: project?.ref,
            objective,
          },
        };
      }

      if (action === "status") {
        const goal = await loadSessionGoal(cwd, ctx);
        return goalResult(goal, action, goal ? renderGoalStatus(goal) : "No session goal is set.");
      }

      if (action === "set" || action === "start") {
        if (requestedScope === "project" && !requestedProjectRef)
          return {
            content: [
              {
                type: "text",
                text: 'No current Spark project is selected for a project-scoped goal. Select a Project with task({ action: "project_use" }) or use scope=session.',
              },
            ],
            details: { found: false, action, error: "no_current_project", scope: requestedScope },
          };
        const activeConflict = await activeGoalConflict(
          cwd,
          ctx,
          requestedScope,
          requestedProjectRef,
        );
        if (activeConflict)
          return goalConflictResult(activeConflict, action, requestedScope, requestedProjectRef);
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
          scope: requestedScope,
          projectRef: requestedProjectRef,
        });
        await clearSparkExecutionMode(cwd, ctx);
        await deps.refreshSparkWidget(cwd, ctx);
        return goalResult(
          goal,
          action,
          `Spark ${goal.scope} goal active: ${oneLine(goal.objective)}`,
        );
      }

      const existingGoal = await loadSessionGoal(cwd, ctx);
      if (
        existingGoal &&
        params.scope !== undefined &&
        !sameGoalTarget(existingGoal, requestedScope, requestedProjectRef)
      )
        return goalConflictResult(existingGoal, action, requestedScope, requestedProjectRef);
      if (action === "complete") {
        if (!existingGoal)
          return {
            content: [{ type: "text", text: "No session goal is set." }],
            details: { found: false, action, error: "no_goal" },
          };
        return reviewerOwnedGoalCompletionResult(existingGoal, action);
      }
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
      return goalResult(pauseResult.goal, action, renderGoalStatus(pauseResult.goal));
    },
  });
}

export function normalizeSparkGoalAction(value: unknown): SparkGoalToolAction {
  if (value === undefined || value === null || value === "") return "status";
  if (
    value === "status" ||
    value === "infer" ||
    value === "set" ||
    value === "start" ||
    value === "pause" ||
    value === "complete"
  ) {
    return value;
  }
  throw new Error("goal action must be status, infer, set, start, pause, or complete");
}

export function normalizeSparkGoalScope(value: unknown): SparkGoalScope {
  if (value === undefined || value === null || value === "") return "session";
  if (value === "session" || value === "project") return value;
  throw new Error("goal scope must be session or project");
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
  await clearSparkExecutionMode(cwd, ctx);
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
  await clearSparkExecutionMode(cwd, ctx);
  return updateSessionGoalStatus(cwd, ctx, "paused", { reason });
}

interface ReviewedGoalPauseResult {
  goal?: SparkSessionGoal;
  approved: boolean;
  review?: ReviewerRunResult;
  reviewArtifactRef?: string;
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
    projectRef: existingGoal.projectRef,
    goalId: existingGoal.goalId,
    objective: existingGoal.objective,
    status: existingGoal.status,
    requestedStatus: "paused",
    reason,
    evidenceRefs: existingGoal.lastReview?.artifactRef
      ? [existingGoal.lastReview.artifactRef as `artifact:${string}`]
      : [],
    sessionKey: sparkSessionKey(ctx),
    forkFromSession: ctx.sessionManager?.getSessionFile?.(),
  };
  const review = await runPauseReviewer(cwd, ctx, reviewerRunner, reviewInput, signal);
  const verdict = review.verdict as GoalReviewVerdict;
  const artifact = await recordGoalPauseReviewArtifact(cwd, existingGoal, review, reason);
  if (verdict.outcome !== "approved")
    return {
      goal: existingGoal,
      approved: false,
      review,
      reviewArtifactRef: artifact.ref,
    };
  await clearSparkExecutionMode(cwd, ctx);
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
  await deps.refreshSparkWidget(cwd, ctx);
  return { goal, approved: true, review, reviewArtifactRef: artifact.ref };
}

async function runPauseReviewer(
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

async function recordGoalPauseReviewArtifact(
  cwd: string,
  goal: SparkSessionGoal,
  review: ReviewerRunResult,
  reason: string | undefined,
) {
  const reviewerRun = {
    ...(review.record.runRef ? { runRef: review.record.runRef } : {}),
    roleRef: review.record.roleRef,
    ...(review.record.runName ? { runName: review.record.runName } : {}),
    startedAt: review.record.startedAt,
    finishedAt: review.record.finishedAt,
  };
  return defaultArtifactStore(cwd).put({
    kind: "review",
    title: `Goal pause review for ${goal.scope} goal: ${oneLine(goal.objective)}`,
    format: "json",
    body: {
      goalId: goal.goalId,
      scope: goal.scope,
      ...(goal.projectRef ? { projectRef: goal.projectRef } : {}),
      objective: goal.objective,
      requestedStatus: "paused",
      reason,
      verdict: review.verdict,
      reviewerRun,
      recordedAt: nowIso(),
    } as unknown as JsonValue,
    provenance: {
      producer: "review",
      projectRef: goal.projectRef,
      roleRef: review.record.roleRef,
      runRef: review.record.runRef,
    },
    links: goal.projectRef ? [{ to: goal.projectRef, relation: "review-of" }] : undefined,
  });
}

function renderGoalPauseRejectedMessage(
  goal: SparkSessionGoal,
  result: ReviewedGoalPauseResult,
): string {
  const verdict = result.review?.verdict as GoalReviewVerdict | undefined;
  const summary = verdict?.summary ?? "reviewer did not approve pausing this goal";
  const blockers = verdict?.blockers?.length ? `\nBlockers: ${verdict.blockers.join("; ")}` : "";
  const artifact = result.reviewArtifactRef ? `\nReview artifact: ${result.reviewArtifactRef}` : "";
  return `Goal pause blocked by reviewer for ${renderGoalTarget(goal.scope, goal.projectRef)} goal: ${oneLine(goal.objective)}\nReview outcome: ${verdict?.outcome ?? "blocked"}\nReview summary: ${summary}${blockers}${artifact}`;
}

async function activeGoalConflict(
  cwd: string,
  ctx: SparkToolContext,
  requestedScope: SparkGoalScope,
  requestedProjectRef: SparkSessionGoal["projectRef"],
): Promise<SparkSessionGoal | undefined> {
  const existing = await loadSessionGoal(cwd, ctx);
  if (!existing || existing.status !== "active") return undefined;
  return sameGoalTarget(existing, requestedScope, requestedProjectRef) ? undefined : existing;
}

function goalConflictResult(
  activeGoal: SparkSessionGoal,
  action: SparkGoalToolAction,
  requestedScope: SparkGoalScope,
  requestedProjectRef: SparkSessionGoal["projectRef"],
) {
  const activeTarget = renderGoalTarget(activeGoal.scope, activeGoal.projectRef);
  const requestedTarget = renderGoalTarget(requestedScope, requestedProjectRef);
  return {
    content: [
      {
        type: "text" as const,
        text: `Cannot ${action} ${requestedTarget} goal because ${activeTarget} goal is already active: ${oneLine(activeGoal.objective)}. Pause the active goal first, wait for reviewer completion, or explicitly continue that same goal target.`,
      },
    ],
    details: {
      found: true,
      action,
      error: "active_goal_conflict",
      requested: { scope: requestedScope, projectRef: requestedProjectRef },
      activeGoal,
      guidance: [
        'Use goal({ action: "pause" }) on the active goal before starting another scope, or wait for the reviewer loop to complete the active goal.',
        "Use the same scope/project target if you intend to update the currently active goal.",
      ],
    },
  };
}

function reviewerOwnedGoalCompletionResult(goal: SparkSessionGoal, action: SparkGoalToolAction) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Goal completion is reviewer-owned for ${renderGoalTarget(goal.scope, goal.projectRef)} goal: ${oneLine(goal.objective)}. The main agent cannot mark goals complete; keep evidence/status accurate and wait for the Spark reviewer loop to apply an achieved verdict, or pause the goal if blocked.`,
      },
    ],
    details: {
      found: true,
      action,
      error: "goal_completion_reviewer_only",
      goal,
      guidance: [
        "The main agent must not request goal completion directly.",
        "The Spark reviewer loop completes goals internally after an achieved verdict.",
        'Use goal({ action: "pause" }) only when the goal is blocked or should stop without completion.',
      ],
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

function goalResult(goal: SparkSessionGoal | undefined, action: string, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { found: Boolean(goal), action, goal },
  };
}

function renderGoalStatus(goal: SparkSessionGoal): string {
  const reason = goal.pauseReason ?? goal.completedReason;
  const reasonText = reason ? ` Reason: ${reason}` : "";
  return `Spark ${renderGoalTarget(goal.scope, goal.projectRef)} goal ${goal.status}: ${oneLine(goal.objective)}${reasonText}`;
}

function renderGoalTarget(
  scope: SparkGoalScope,
  projectRef: SparkSessionGoal["projectRef"],
): string {
  return scope === "project" ? `project (${projectRef})` : "session";
}

function oneLine(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}
