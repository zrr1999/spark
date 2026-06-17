import { defaultArtifactStore } from "@zendev-lab/pi-artifacts";
import {
  isActiveSessionTodo,
  isUnfinishedTaskStatus,
  type SessionTodoEntry,
  type TaskGraph,
} from "@zendev-lab/pi-tasks";
import {
  nowIso,
  type ArtifactRef,
  type JsonValue,
  type ProjectRef,
  type RoleRef,
} from "@zendev-lab/pi-extension-api";
import { loadIndependentTodos } from "./session-todos.ts";
import { updateSessionGoalStatus, type SparkSessionGoal } from "./spark-session-goals.ts";
import type {
  GoalReviewEvidencePreview,
  GoalReviewInput,
  GoalReviewVerdict,
  ReviewerRunResult,
  ReviewerRunner,
} from "./reviewer-runner.ts";
import { withSparkReviewerLease } from "./spark-reviewer-lease.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

type SparkProjectLike = ReturnType<TaskGraph["projects"]>[number];

const GOAL_COMPLETION_TODO_BLOCKER_LIMIT = 3;

export interface GoalCompletionReviewDeps {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  createReviewerRunner?: (
    cwd: string,
    ctx: SparkToolContext,
  ) => ReviewerRunner | Promise<ReviewerRunner>;
}

export interface GoalCompletionReviewActive {
  graph?: TaskGraph;
  project?: SparkProjectLike;
  goal: SparkSessionGoal;
}

export type GoalCompletionReviewTrigger = "loop" | "tool";

export type GoalCompletionReviewOutcome =
  | {
      outcome: "completed";
      goal?: SparkSessionGoal;
      review: ReviewerRunResult;
      artifactRef: ArtifactRef;
      reason: string;
    }
  | {
      outcome: "blocked";
      goal?: SparkSessionGoal;
      reason: string;
      remainingWork?: string;
      blockers: string[];
      review?: ReviewerRunResult;
      artifactRef?: ArtifactRef;
    }
  | {
      outcome: "deferred";
      reason: string;
    }
  | {
      outcome: "unavailable";
      reason: string;
    };

export async function requestGoalCompletionReview(
  ctx: SparkToolContext,
  deps: GoalCompletionReviewDeps,
  active: GoalCompletionReviewActive,
  _options: { trigger: GoalCompletionReviewTrigger },
): Promise<GoalCompletionReviewOutcome> {
  const independentTodos = await loadIndependentTodos(ctx.cwd, ctx);
  const unresolvedSessionTodos = independentTodos
    .filter(isActiveSessionTodo)
    .filter(isUnresolvedSessionTodoBlocker);
  if (unresolvedSessionTodos.length > 0) {
    const reviewedAt = nowIso();
    const blockers = activeSessionTodoBlockers(unresolvedSessionTodos);
    const reason = `Goal completion blocked by ${unresolvedSessionTodos.length} unresolved session TODO(s).`;
    const updated = await updateSessionGoalStatus(ctx.cwd, ctx, "active", {
      review: {
        achieved: false,
        confidence: "deterministic-blocker",
        reason,
        remainingWork: `${reason} Resolve or disposition them before completing the goal.`,
        blockers,
        reviewedAt,
      },
      expectedGoalId: active.goal.goalId,
    });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    return {
      outcome: "blocked",
      goal: updated,
      reason,
      remainingWork: `${reason} Resolve or disposition them before completing the goal.`,
      blockers,
    };
  }

  const reviewContext = await goalReviewContext(ctx, active, independentTodos);
  if (!reviewContext.projectRef && reviewContext.evidenceRefs.length === 0) {
    const reviewedAt = nowIso();
    const reason = "Goal progress needs a current Spark project before completion review.";
    const remainingWork =
      'Create or select a project with task_write({ action: "project_use", title, description }) using the goal objective as the project intent, then plan initial concrete tasks with task_write({ action: "plan" }).';
    const blockers = ["missing_current_project"];
    const updated = await updateSessionGoalStatus(ctx.cwd, ctx, "active", {
      review: {
        achieved: false,
        confidence: "deterministic-blocker",
        reason,
        remainingWork,
        blockers,
        reviewedAt,
      },
      expectedGoalId: active.goal.goalId,
    });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    return { outcome: "blocked", goal: updated, reason, remainingWork, blockers };
  }

  const preReviewBlocker = goalCompletionDeterministicBlocker(
    active.goal.objective,
    reviewContext.projectStatus,
    reviewContext.evidenceRefs,
  );
  if (preReviewBlocker) {
    const reviewedAt = nowIso();
    const updated = await updateSessionGoalStatus(ctx.cwd, ctx, "active", {
      review: {
        achieved: false,
        confidence: "deterministic-blocker",
        reason: preReviewBlocker.reason,
        remainingWork: preReviewBlocker.remainingWork,
        blockers: preReviewBlocker.blockers,
        reviewedAt,
      },
      expectedGoalId: active.goal.goalId,
    });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    return {
      outcome: "blocked",
      goal: updated,
      reason: preReviewBlocker.reason,
      remainingWork: preReviewBlocker.remainingWork,
      blockers: preReviewBlocker.blockers,
    };
  }

  const reviewerRunner = await deps.createReviewerRunner?.(ctx.cwd, ctx);
  if (!reviewerRunner) {
    return {
      outcome: "unavailable",
      reason: "goal completion review requires a reviewer runner",
    };
  }
  const reviewInput: GoalReviewInput = {
    targetKind: "goal",
    cwd: ctx.cwd,
    projectRef: reviewContext.projectRef,
    currentProjectSelected: reviewContext.currentProjectSelected,
    projectEvidenceSource: reviewContext.projectEvidenceSource,
    projectStatus: reviewContext.projectStatus,
    goalId: active.goal.goalId,
    objective: active.goal.objective,
    status: active.goal.status,
    requestedStatus: "complete",
    evidenceRefs: reviewContext.evidenceRefs,
    evidencePreviews: reviewContext.evidencePreviews,
    sessionKey: active.goal.sessionKey,
    forkFromSession: ctx.sessionManager?.getSessionFile?.(),
  };
  const leasedReview = await withSparkReviewerLease(ctx.cwd, ctx, () =>
    runGoalCompletionReviewer(reviewerRunner, reviewInput),
  );
  if (!leasedReview.acquired || !leasedReview.result) {
    return {
      outcome: "deferred",
      reason: "another Spark reviewer gate is already running for this session",
    };
  }
  const review = leasedReview.result;
  const verdict = review.verdict as GoalReviewVerdict;
  const artifact = await recordGoalReviewArtifact(ctx.cwd, active, review, reviewInput);
  const reviewedAt = review.record.finishedAt || nowIso();
  const postReviewBlocker = goalCompletionDeterministicBlocker(
    active.goal.objective,
    reviewInput.projectStatus,
    reviewInput.evidenceRefs,
  );
  const effectiveAchieved = verdict.achieved && !postReviewBlocker;
  const reviewSummary = {
    achieved: effectiveAchieved,
    confidence: postReviewBlocker ? "deterministic-blocker" : verdict.confidence,
    reason: postReviewBlocker?.reason ?? verdict.summary,
    remainingWork: postReviewBlocker?.remainingWork ?? verdict.remainingWork,
    blockers: postReviewBlocker?.blockers ?? verdict.blockers,
    artifactRef: artifact.ref,
    reviewedAt,
  };
  if (effectiveAchieved) {
    const updated = await updateSessionGoalStatus(ctx.cwd, ctx, "complete", {
      reason: reviewSummary.reason,
      review: reviewSummary,
      retryState: null,
      expectedGoalId: active.goal.goalId,
    });
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    return {
      outcome: "completed",
      goal: updated,
      review,
      artifactRef: artifact.ref,
      reason: reviewSummary.reason,
    };
  }
  const updated = await updateSessionGoalStatus(ctx.cwd, ctx, "active", {
    review: reviewSummary,
    expectedGoalId: active.goal.goalId,
  });
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  return {
    outcome: "blocked",
    goal: updated,
    reason: reviewSummary.reason,
    remainingWork: reviewSummary.remainingWork,
    blockers: reviewSummary.blockers,
    review,
    artifactRef: artifact.ref,
  };
}

function goalCompletionDeterministicBlocker(
  objective: string,
  projectStatus: GoalReviewInput["projectStatus"] | undefined,
  evidenceRefs: readonly ArtifactRef[],
): { reason: string; remainingWork: string; blockers: string[] } | undefined {
  const unfinishedTasks = projectStatus?.unfinishedTasks ?? [];
  const unfinished = unfinishedTasks.length || (projectStatus?.taskCounts.unfinished ?? 0);
  if (unfinished <= 0) return undefined;
  if (isPlanningOnlyGoalObjective(objective)) return undefined;
  const relevantUnfinished = unfinishedTasks.filter((task) =>
    goalObjectiveTaskLikelyRelated(objective, task),
  );
  if (evidenceRefs.length > 0 && relevantUnfinished.length === 0) return undefined;
  const blockingTasks = relevantUnfinished.length > 0 ? relevantUnfinished : unfinishedTasks;
  const blockingTaskRefs = new Set(blockingTasks.map((task) => task.ref));
  const readyTasks = (projectStatus?.readyTasks ?? []).filter((task) =>
    blockingTaskRefs.size === 0 ? true : blockingTaskRefs.has(task.ref),
  );
  const readyText = readyTasks.length
    ? readyTasks.map((task) => `@${task.name ?? task.ref}: ${task.title}`).join("; ")
    : "no ready task; inspect dependencies";
  const blockedCount = blockingTasks.length || unfinished;
  const reason = `Goal completion blocked by ${blockedCount} unfinished project task(s).`;
  return {
    reason,
    remainingWork: `${reason} Next ready frontier: ${readyText}. Continue by claiming a ready task with task-local TODOs, or narrow the goal objective if only planning readiness is intended.`,
    blockers: [`unfinished_project_tasks=${blockedCount}`, `ready_frontier=${readyText}`],
  };
}

function goalObjectiveTaskLikelyRelated(
  objective: string,
  task: NonNullable<NonNullable<GoalReviewInput["projectStatus"]>["unfinishedTasks"]>[number],
): boolean {
  const objectiveTokens = meaningfulGoalTokens(objective);
  if (objectiveTokens.size === 0) return false;
  const taskTokens = meaningfulGoalTokens(
    [task.name, task.title, task.kind].filter((item): item is string => Boolean(item)).join(" "),
  );
  for (const token of objectiveTokens) {
    if (taskTokens.has(token)) return true;
  }
  return false;
}

function meaningfulGoalTokens(value: string): Set<string> {
  const stopwords = new Set([
    "active",
    "complete",
    "completion",
    "driver",
    "foreground",
    "goal",
    "implement",
    "implementation",
    "project",
    "ready",
    "review",
    "spark",
    "status",
    "task",
    "tasks",
  ]);
  return new Set(
    value
      .toLocaleLowerCase()
      .match(/[\p{Letter}\p{Number}]+/gu)
      ?.filter((token) => token.length >= 4 && !stopwords.has(token)) ?? [],
  );
}

function isPlanningOnlyGoalObjective(objective: string): boolean {
  return (
    /\b(planning-only|readiness-only|plan-only)\b/i.test(objective) ||
    /仅规划|只规划|计划就绪|规划就绪/u.test(objective)
  );
}

function isUnresolvedSessionTodoBlocker(todo: SessionTodoEntry): boolean {
  if (todo.status === "blocked") return !todo.blockedBy?.length;
  return true;
}

function activeSessionTodoBlockers(todos: SessionTodoEntry[]): string[] {
  const visible = todos.slice(0, GOAL_COMPLETION_TODO_BLOCKER_LIMIT).map((todo) => {
    const id = todo.id ? `${todo.id}: ` : "";
    return `${id}${todo.content} [${todo.status}]`;
  });
  const hidden = todos.length - visible.length;
  return hidden > 0 ? [...visible, `… ${hidden} more unresolved session TODO(s)`] : visible;
}

async function runGoalCompletionReviewer(
  reviewerRunner: ReviewerRunner,
  input: GoalReviewInput,
): Promise<ReviewerRunResult> {
  try {
    return await reviewerRunner.review(input);
  } catch (error) {
    const timestamp = nowIso();
    const reason = error instanceof Error ? error.message : String(error);
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
        runName: "goal-reviewer-failed",
        startedAt: timestamp,
        finishedAt: timestamp,
      },
    };
  }
}

async function goalReviewContext(
  ctx: SparkToolContext,
  active: GoalCompletionReviewActive,
  independentTodos: SessionTodoEntry[],
): Promise<{
  projectRef?: ProjectRef;
  currentProjectSelected: boolean;
  projectEvidenceSource: NonNullable<GoalReviewInput["projectEvidenceSource"]>;
  projectStatus?: GoalReviewInput["projectStatus"];
  evidenceRefs: ArtifactRef[];
  evidencePreviews: GoalReviewEvidencePreview[];
}> {
  if (isSessionTodoDispositionGoal(active.goal)) {
    const evidence = await recordSessionTodoDispositionEvidence(
      ctx.cwd,
      active.goal,
      independentTodos,
    );
    return {
      currentProjectSelected: Boolean(active.project),
      projectEvidenceSource: "session_todo_disposition",
      evidenceRefs: [evidence.ref],
      evidencePreviews: await goalReviewEvidencePreviews(ctx.cwd, [evidence.ref]),
    };
  }
  const project = goalReviewEvidenceProject(active);
  const evidenceRefs =
    project && active.graph
      ? await projectGoalEvidenceRefs(ctx.cwd, active.graph, project.ref)
      : [];
  return {
    projectRef: project?.ref,
    currentProjectSelected: Boolean(active.project),
    projectEvidenceSource: goalReviewEvidenceSource(active, project),
    projectStatus:
      project && active.graph ? projectGoalReviewStatus(active.graph, project) : undefined,
    evidenceRefs,
    evidencePreviews: await goalReviewEvidencePreviews(ctx.cwd, evidenceRefs),
  };
}

function isSessionTodoDispositionGoal(goal: SparkSessionGoal): boolean {
  return /session TODO/i.test(goal.objective);
}

async function recordSessionTodoDispositionEvidence(
  cwd: string,
  goal: SparkSessionGoal,
  todos: SessionTodoEntry[],
): Promise<{ ref: ArtifactRef }> {
  const unresolvedBlockers = todos
    .filter(isActiveSessionTodo)
    .filter(isUnresolvedSessionTodoBlocker);
  const statusCounts = todos.reduce<Record<string, number>>((counts, todo) => {
    counts[todo.status] = (counts[todo.status] ?? 0) + 1;
    return counts;
  }, {});
  const artifact = await defaultArtifactStore(cwd).put({
    kind: "record",
    title: `Session TODO disposition snapshot for goal: ${compactInline(goal.objective)}`,
    format: "json",
    body: {
      goalId: goal.goalId,
      objective: goal.objective,
      sessionKey: goal.sessionKey,
      recordedAt: nowIso(),
      statusCounts,
      unresolvedBlockerCount: unresolvedBlockers.length,
      unresolvedBlockers: unresolvedBlockers.map(sessionTodoEvidenceEntry),
      todos: todos.map(sessionTodoEvidenceEntry),
    } as unknown as JsonValue,
    provenance: {
      producer: "task",
      note: "Current session TODO disposition evidence for goal completion review.",
    },
  });
  return { ref: artifact.ref };
}

function sessionTodoEvidenceEntry(todo: SessionTodoEntry): JsonValue {
  return {
    ...(todo.id ? { id: todo.id } : {}),
    content: todo.content,
    status: todo.status,
    ...(todo.blockedBy?.length ? { blockedBy: [...todo.blockedBy] } : {}),
    ...(todo.notes?.length ? { notes: [...todo.notes] } : {}),
    ...(todo.updatedAt ? { updatedAt: todo.updatedAt } : {}),
  };
}

function goalReviewEvidenceProject(
  active: GoalCompletionReviewActive,
): SparkProjectLike | undefined {
  if (!active.graph) return active.project;
  if (active.project) return active.project;
  const projectsWithEvidence = active.graph
    .projects()
    .filter((project) => projectTaskEvidenceRefs(active.graph!, project.ref).length > 0);
  const completedProjects = projectsWithEvidence.filter((project) => project.status === "done");
  return (
    mostRecentlyUpdatedProject(completedProjects) ??
    mostRecentlyUpdatedProject(projectsWithEvidence)
  );
}

function goalReviewEvidenceSource(
  active: GoalCompletionReviewActive,
  project: SparkProjectLike | undefined,
): NonNullable<GoalReviewInput["projectEvidenceSource"]> {
  if (active.project && project?.ref === active.project.ref) return "current_project";
  if (project) return "project_evidence_fallback";
  return "none";
}

function compactProjectTaskForGoalReview(task: ReturnType<TaskGraph["tasks"]>[number]) {
  return {
    ref: task.ref,
    name: task.name,
    title: task.title,
    status: task.status,
    kind: task.kind,
  };
}

async function projectGoalEvidenceRefs(
  cwd: string,
  graph: TaskGraph,
  projectRef: ProjectRef,
): Promise<ArtifactRef[]> {
  const taskEvidenceRefs = projectTaskEvidenceRefs(graph, projectRef);
  const projectReviewRefs = (
    await defaultArtifactStore(cwd).list({ producer: "review", projectRef })
  ).map((artifact) => artifact.ref);
  return [...new Set([...taskEvidenceRefs, ...projectReviewRefs])].slice(-20);
}

async function goalReviewEvidencePreviews(
  cwd: string,
  evidenceRefs: ArtifactRef[],
): Promise<GoalReviewEvidencePreview[]> {
  const store = defaultArtifactStore(cwd);
  return Promise.all(
    evidenceRefs.map(async (ref) => {
      try {
        const artifact = await store.get(ref);
        return {
          ref,
          title: artifact.title,
          kind: artifact.kind,
          format: artifact.format,
          provenance: artifact.provenance as unknown as Record<string, unknown>,
          bodyPreview: boundedEvidenceBodyPreview(artifact.body, artifact.bodyPreview),
        };
      } catch (error) {
        return {
          ref,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

function boundedEvidenceBodyPreview(
  body: JsonValue | string,
  bodyPreview: string | undefined,
): string {
  const serialized =
    bodyPreview ?? (typeof body === "string" ? body : JSON.stringify(body, null, 2));
  const normalized = serialized.replace(/\s+/gu, " ").trim();
  return normalized.length > 1_500 ? `${normalized.slice(0, 1_497)}...` : normalized;
}

function projectTaskEvidenceRefs(graph: TaskGraph, projectRef: ProjectRef): ArtifactRef[] {
  return [...new Set(graph.tasks(projectRef).flatMap((task) => task.outputArtifacts))].slice(-20);
}

function projectGoalReviewStatus(
  graph: TaskGraph,
  project: SparkProjectLike,
): GoalReviewInput["projectStatus"] {
  const tasks = graph.tasks(project.ref);
  const statusCounts = tasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});
  return {
    ref: project.ref,
    title: project.title,
    status: project.status,
    taskCounts: {
      total: tasks.length,
      unfinished: tasks.filter((task) => isUnfinishedTaskStatus(task.status)).length,
      claimed: tasks.filter((task) => Boolean(task.claim)).length,
      statusCounts,
    },
    readyTasks: graph.readyTasks(project.ref).slice(0, 5).map(compactProjectTaskForGoalReview),
    unfinishedTasks: tasks
      .filter((task) => isUnfinishedTaskStatus(task.status))
      .slice(0, 10)
      .map(compactProjectTaskForGoalReview),
  };
}

function mostRecentlyUpdatedProject(projects: SparkProjectLike[]): SparkProjectLike | undefined {
  return [...projects].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  )[0];
}

async function recordGoalReviewArtifact(
  cwd: string,
  active: GoalCompletionReviewActive,
  review: ReviewerRunResult,
  input: GoalReviewInput,
) {
  const verdict = review.verdict as GoalReviewVerdict;
  const reviewerRun = {
    ...(review.record.runRef ? { runRef: review.record.runRef } : {}),
    roleRef: review.record.roleRef,
    ...(review.record.runName ? { runName: review.record.runName } : {}),
    startedAt: review.record.startedAt,
    finishedAt: review.record.finishedAt,
  };
  const store = defaultArtifactStore(cwd);
  const ref = goalReviewArtifactRef(active.goal.goalId);
  const recordedAt = nowIso();
  const reviewPacket = {
    ...(input.projectRef ? { projectRef: input.projectRef } : {}),
    currentProjectSelected: input.currentProjectSelected ?? false,
    projectEvidenceSource: input.projectEvidenceSource ?? "none",
    ...(input.projectStatus ? { projectStatus: input.projectStatus } : {}),
    evidenceRefs: input.evidenceRefs,
    evidencePreviews: input.evidencePreviews ?? [],
  };
  const previous = await store.tryGet(ref);
  const reviews = [
    ...goalReviewHistoryEntries(previous?.body).slice(-9),
    { verdict, reviewerRun, reviewPacket, recordedAt } as unknown as JsonValue,
  ];
  return store.put({
    ref,
    kind: "record",
    title: `Goal review for session goal: ${compactInline(active.goal.objective)}`,
    format: "json",
    body: {
      goalId: active.goal.goalId,
      ...(input.projectRef ? { projectRef: input.projectRef } : {}),
      objective: active.goal.objective,
      reviewPacket,
      verdict,
      reviewerRun,
      reviews,
      recordedAt,
    } as unknown as JsonValue,
    provenance: {
      producer: "review",
      projectRef: input.projectRef,
      roleRef: review.record.roleRef,
      runRef: review.record.runRef,
    },
    links: input.projectRef ? [{ to: input.projectRef, relation: "review-of" }] : undefined,
  });
}

function goalReviewArtifactRef(goalId: string): ArtifactRef {
  return `artifact:goal-review-${goalId.replace(/[^a-zA-Z0-9_-]/gu, "-")}` as ArtifactRef;
}

function goalReviewHistoryEntries(value: unknown): JsonValue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const reviews = (value as { reviews?: unknown }).reviews;
  return Array.isArray(reviews) ? (reviews as JsonValue[]) : [];
}

function compactInline(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}
