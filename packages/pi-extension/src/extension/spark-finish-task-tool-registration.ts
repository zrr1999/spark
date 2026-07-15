import { Type } from "typebox";
import {
  defaultLearningStore,
  type LearningLocation,
  type LearningRecord,
} from "@zendev-lab/spark-learnings";
import { defaultArtifactStore, type Artifact } from "@zendev-lab/spark-artifacts";
import {
  DependencyError,
  isRef,
  nowIso,
  type ArtifactRef,
  type JsonValue,
  type ProjectRef,
  type RoleRef,
  type Task,
  type TaskCompletionReadiness,
  type TaskStatus,
} from "@zendev-lab/spark-extension-api";
import {
  defaultTaskGraphStore,
  isUnfinishedTaskStatus,
  taskCompletionReadiness,
  type TaskGraph,
} from "@zendev-lab/spark-tasks";
import { currentSparkProject, saveCurrentProjectRef, sparkSessionKey } from "./session-state.ts";
import { resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { compactTaskDetail, normalizeOptionalToolString } from "./task-plan-tool.ts";
import { compactLearningDetail } from "./learning-tools.ts";
import { truncateInline } from "./tool-rendering.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import type {
  GoalReviewEvidencePreview,
  ReviewerRunResult,
  ReviewerRunner,
  TaskReviewInput,
  TaskReviewVerdict,
} from "./reviewer-runner.ts";
import { withSparkReviewerLease } from "./spark-reviewer-lease.ts";
import { recordTaskSubjectReview } from "./subject-review-store.ts";

interface SparkFinishTaskToolDependencies {
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  createReviewerRunner?: (
    cwd: string,
    ctx: SparkToolContext,
  ) => ReviewerRunner | Promise<ReviewerRunner>;
}

interface NormalizedSparkFinishTaskInput {
  task?: string;
  status: "done" | "failed" | "cancelled";
  summary?: string;
  evidenceRefs: ArtifactRef[];
  evidence?: SparkFinishEvidenceInput;
}

interface SparkFinishEvidenceInput {
  title?: string;
  notes?: string;
  changedFiles: string[];
  sourceRefs: string[];
  validationCommands: string[];
}

interface FinishProjectCompletionCandidate {
  projectRef: ProjectRef;
  ready: boolean;
  unfinishedTaskCount: number;
  unfinishedTasks: Array<ReturnType<typeof compactTaskDetail>>;
  suggestedAction?: string;
}

interface FinishTaskSuccessResult {
  error?: undefined;
  task: Task;
  statusBefore: TaskStatus;
  statusAfter: TaskStatus;
  completionReadiness?: TaskCompletionReadiness;
  projectRef: ProjectRef;
  remainingReadyTasks: Task[];
  nextReady?: Task;
  projectCompletionCandidate: FinishProjectCompletionCandidate;
}

interface FinishTaskErrorResult {
  error: "no_project" | "no_matching_claimed_task";
}

type FinishCommitResult = FinishTaskSuccessResult | FinishTaskErrorResult;

interface FollowUpDispositionSignal {
  source: string;
  line: number;
  signal: string;
  excerpt: string;
}

interface FollowUpDispositionCheck {
  checked: boolean;
  ready: boolean;
  allowedDispositions: string[];
  undispositioned: FollowUpDispositionSignal[];
}

const FOLLOW_UP_DISPOSITIONS = [
  "created_task",
  "already_covered",
  "deferred",
  "rejected",
  "out_of_scope",
] as const;
const FOLLOW_UP_RESEARCH_KINDS = new Set(["research", "review", "plan"]);
const FOLLOW_UP_SIGNAL_TERMS = [
  "p0",
  "p1",
  "p2",
  "todo",
  "todos",
  "follow-up",
  "follow-ups",
  "follow up",
  "follow ups",
  "recommended-route",
  "recommended-routes",
  "recommended route",
  "recommended routes",
  "next action",
  "next actions",
  "action item",
  "action items",
];
const FOLLOW_UP_DISPOSITION_TERMS = [
  "created_task",
  "created task",
  "already_covered",
  "already covered",
  "deferred",
  "rejected",
  "out_of_scope",
  "out of scope",
];
const NO_FOLLOW_UP_PREFIXES = ["no", "none", "without"];

export function normalizeSparkFinishTaskInput(
  params: Record<string, unknown>,
): NormalizedSparkFinishTaskInput {
  return {
    task: normalizeOptionalToolString(params.task, "task"),
    status: normalizeSparkFinishStatus(params.status),
    summary: normalizeOptionalToolString(params.summary, "summary"),
    evidenceRefs: normalizeFinishEvidenceRefs(params.evidenceRefs),
    evidence: normalizeSparkFinishEvidenceInput(params.evidence),
  };
}

function normalizeFinishEvidenceRefs(value: unknown): ArtifactRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("evidenceRefs must be an array of artifact refs");
  return value.map((ref, index) => {
    if (!isRef(ref, "artifact")) throw new Error(`evidenceRefs[${index}] must be an artifact: ref`);
    return ref;
  });
}

function normalizeSparkFinishEvidenceInput(value: unknown): SparkFinishEvidenceInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("evidence must be an object");
  const evidence: SparkFinishEvidenceInput = {
    title: normalizeOptionalToolString(value.title, "evidence.title"),
    notes: normalizeOptionalToolString(value.notes, "evidence.notes"),
    changedFiles: normalizeFinishEvidenceStringArray(value.changedFiles, "evidence.changedFiles"),
    sourceRefs: normalizeFinishEvidenceStringArray(value.sourceRefs, "evidence.sourceRefs"),
    validationCommands: normalizeFinishEvidenceStringArray(
      value.validationCommands,
      "evidence.validationCommands",
    ),
  };
  if (
    !evidence.title &&
    !evidence.notes &&
    evidence.changedFiles.length === 0 &&
    evidence.sourceRefs.length === 0 &&
    evidence.validationCommands.length === 0
  )
    return undefined;
  return evidence;
}

function normalizeFinishEvidenceStringArray(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${path} must be an array of strings`);
  return value.map((item) => item.trim()).filter(Boolean);
}

function taskWithFinishEvidenceRefs(task: Task, evidenceRefs: ArtifactRef[]): Task {
  if (evidenceRefs.length === 0) return task;
  const outputArtifacts = [...task.outputArtifacts];
  for (const evidenceRef of evidenceRefs) {
    if (!outputArtifacts.includes(evidenceRef)) outputArtifacts.push(evidenceRef);
  }
  if (outputArtifacts.length === task.outputArtifacts.length) return task;
  return { ...task, outputArtifacts };
}

function attachFinishEvidenceRefs(
  graph: { attachOutputArtifact(taskRef: Task["ref"], artifactRef: ArtifactRef): Task },
  task: Task,
  evidenceRefs: ArtifactRef[],
): Task {
  let updated = task;
  for (const evidenceRef of evidenceRefs)
    updated = graph.attachOutputArtifact(updated.ref, evidenceRef);
  return updated;
}

export function registerSparkFinishTaskTool(
  registerSparkTool: SparkToolRegistrar,
  deps: SparkFinishTaskToolDependencies,
): void {
  registerSparkTool({
    name: "impl_finish_task",
    label: "Spark Finish Task",
    description:
      'Implementation for task_write({ action: "finish" }): finish this session\'s claimed Spark task as done, failed, or cancelled. Defaults to the current claimed task and status=done.',
    parameters: Type.Object({
      task: Type.Optional(
        Type.String({
          description:
            "Claimed task ref, @name/name, title, or title prefix. Defaults to current claimed task.",
        }),
      ),
      status: Type.Optional(
        Type.String({ description: "done | failed | cancelled. Default: done." }),
      ),
      summary: Type.Optional(Type.String({ description: "Short completion/failure summary." })),
      evidenceRefs: Type.Optional(
        Type.Array(Type.String({ description: "Artifact refs that evidence completion." })),
      ),
      evidence: Type.Optional(
        Type.Object({
          title: Type.Optional(Type.String({ description: "Evidence artifact title." })),
          notes: Type.Optional(Type.String({ description: "Bounded evidence notes." })),
          changedFiles: Type.Optional(
            Type.Array(Type.String({ description: "Changed file path." })),
          ),
          sourceRefs: Type.Optional(
            Type.Array(Type.String({ description: "Source file:line refs." })),
          ),
          validationCommands: Type.Optional(
            Type.Array(Type.String({ description: "Validation command and concise result." })),
          ),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const input = normalizeSparkFinishTaskInput(params);
      const store = defaultTaskGraphStore(cwd);
      let reviewArtifact: Artifact<JsonValue> | undefined;
      let reviewResult: ReviewerRunResult | undefined;
      let finishEvidenceRefs = input.evidenceRefs;
      let generatedEvidenceArtifact: Artifact<JsonValue> | undefined;
      if (input.status === "done") {
        let candidate = await resolveFinishReviewCandidate(store, cwd, ctx, input);
        if (isFinishTaskErrorResult(candidate)) {
          if (candidate.error === "no_project")
            return {
              content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
              details: { found: false },
            };
          return {
            content: [{ type: "text", text: "No matching claimed task for this session." }],
            details: { found: true, error: "no_matching_claimed_task" },
          };
        }
        const followUpDisposition = await checkResearchFollowUpDisposition(
          cwd,
          candidate.task,
          input.summary,
        );
        if (!followUpDisposition.ready) {
          await deps.refreshSparkWidget(cwd, ctx);
          return {
            content: [
              {
                type: "text",
                text: renderFollowUpDispositionBlockedMessage(candidate.task, followUpDisposition),
              },
            ],
            details: {
              found: true,
              error: "followup_disposition_required",
              task: compactTaskDetail(candidate.task),
              followUpDisposition,
            },
          };
        }
        const todoReadiness = taskCompletionReadiness(candidate.task);
        const openTodoIssue = todoReadiness.issues.find(
          (entry) => entry.kind === "open_plan_items",
        );
        if (openTodoIssue) {
          await deps.refreshSparkWidget(cwd, ctx);
          return {
            content: [
              {
                type: "text",
                text: renderOpenTaskPlanItemBlockedMessage(candidate.task, todoReadiness),
              },
            ],
            details: {
              found: true,
              error: "open_plan_items",
              task: compactTaskDetail(candidate.task),
              completionReadiness: todoReadiness,
            },
          };
        }
        if (input.evidence) {
          generatedEvidenceArtifact = await recordTaskFinishEvidenceArtifact(
            cwd,
            candidate.projectRef,
            candidate.persistedTask,
            input,
          );
          finishEvidenceRefs = [...finishEvidenceRefs, generatedEvidenceArtifact.ref];
          candidate = {
            ...candidate,
            task: taskWithFinishEvidenceRefs(candidate.task, [generatedEvidenceArtifact.ref]),
          };
        }
        const reviewInput: TaskReviewInput = {
          targetKind: "task",
          cwd,
          projectRef: candidate.projectRef,
          task: candidate.task,
          requestedStatus: "done",
          summary: input.summary,
          evidenceRefs: candidate.task.outputArtifacts,
          evidencePreviews: await buildTaskEvidencePreviews(cwd, candidate.task.outputArtifacts),
          sessionKey: sparkSessionKey(ctx),
          forkFromSession: ctx.sessionManager?.getSessionFile?.(),
        };
        const reviewerRunner = await deps.createReviewerRunner?.(cwd, ctx);
        if (!reviewerRunner)
          throw new Error("task_write finish requires a reviewer runner for done transitions");
        try {
          const leasedReview = await withSparkReviewerLease(cwd, ctx, () =>
            reviewerRunner.review(reviewInput, _signal),
          );
          if (!leasedReview.acquired) {
            reviewResult = failedTaskReviewerRunResult(
              reviewInput,
              "another Spark reviewer gate is already running for this session",
            );
          } else {
            if (!leasedReview.result) throw new Error("reviewer did not return a verdict");
            reviewResult = leasedReview.result;
          }
        } catch (error) {
          reviewResult = failedTaskReviewerRunResult(reviewInput, unknownErrorMessage(error));
        }
        const verdict = reviewResult.verdict as TaskReviewVerdict;
        reviewArtifact = await recordTaskReviewArtifact(
          cwd,
          candidate.projectRef,
          candidate.task,
          reviewResult,
        );
        if (!verdict.approved) {
          await deps.refreshSparkWidget(cwd, ctx);
          const progress = await readFinishProjectProgress(store, candidate.projectRef);
          return {
            content: [
              {
                type: "text",
                text: renderTaskReviewRejectedMessage(candidate.task, verdict, reviewArtifact.ref),
              },
            ],
            details: renderFinishTransitionDetails({
              error: "task_review_failed",
              projectRef: candidate.projectRef,
              requestedStatus: input.status,
              task: candidate.persistedTask,
              statusBefore: candidate.persistedTask.status,
              statusAfter: candidate.persistedTask.status,
              committed: false,
              transitionBlocker: "task_review_failed",
              completionReadiness: undefined,
              inputEvidenceRefs: finishEvidenceRefs,
              reviewEvidenceRefs: candidate.task.outputArtifacts,
              reviewRequired: true,
              review: verdict,
              reviewArtifactRef: reviewArtifact.ref,
              generatedEvidenceArtifactRef: generatedEvidenceArtifact?.ref,
              remainingReadyTasks: progress.remainingReadyTasks,
              projectCompletionCandidate: progress.projectCompletionCandidate,
            }),
          };
        }
      }

      let updated: Awaited<ReturnType<typeof store.update>>;
      try {
        updated = await commitFinishedTask(store, cwd, ctx, {
          ...input,
          evidenceRefs: finishEvidenceRefs,
        });
      } catch (error) {
        if (error instanceof DependencyError) {
          return {
            content: [{ type: "text", text: `Cannot finish Spark task: ${error.message}` }],
            details: { found: true, error: "task_dependency_error", message: error.message },
          };
        }
        throw error;
      }
      const finishResult = updated.result as FinishCommitResult;
      if (!updated.graph)
        return {
          content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
          details: { found: false },
        };
      if (isFinishTaskErrorResult(finishResult)) {
        if (finishResult.error === "no_project")
          return {
            content: [{ type: "text", text: NO_SPARK_PROJECT_FOUND_HINT }],
            details: { found: false },
          };
        return {
          content: [{ type: "text", text: "No matching claimed task for this session." }],
          details: { found: true, error: "no_matching_claimed_task" },
        };
      }
      const finishedResult = finishResult;
      await saveCurrentProjectRef(cwd, ctx, finishedResult.projectRef);
      await deps.refreshSparkWidget(cwd, ctx);
      const learningCandidate =
        input.status === "done" && input.summary
          ? await recordTaskLearningCandidate(cwd, finishedResult.task, input.summary)
          : undefined;
      const summarySuffix = input.summary ? ` — ${truncateInline(input.summary, 160)}` : "";
      const completionIssueSuffix =
        finishedResult.completionReadiness && !finishedResult.completionReadiness.ready
          ? `\nCompletion evidence warning: ${finishedResult.completionReadiness.issues
              .map((issue) => issue.message)
              .join("; ")}`
          : "";
      const candidateSuffix = learningCandidate
        ? `\nLearning candidate: ${learningCandidate.artifact.ref} — ${learningCandidate.artifact.body.title}`
        : "";
      const generatedEvidenceSuffix = generatedEvidenceArtifact
        ? `\nGenerated evidence artifact: ${generatedEvidenceArtifact.ref}`
        : "";
      const executionSuffix = renderFinishNextStepSuffix(finishedResult.nextReady, input.status);
      return {
        content: [
          {
            type: "text",
            text: `Finished Spark task: [${finishedResult.task.status}] @${finishedResult.task.name}: ${finishedResult.task.title}${summarySuffix}${completionIssueSuffix}${candidateSuffix}${generatedEvidenceSuffix}${executionSuffix}`,
          },
        ],
        details: renderFinishTransitionDetails({
          projectRef: finishedResult.projectRef,
          requestedStatus: input.status,
          task: finishedResult.task,
          statusBefore: finishedResult.statusBefore,
          statusAfter: finishedResult.statusAfter,
          committed: true,
          completionReadiness: finishedResult.completionReadiness,
          inputEvidenceRefs: finishEvidenceRefs,
          reviewEvidenceRefs: finishedResult.task.outputArtifacts,
          reviewRequired: input.status === "done",
          review: reviewResult?.verdict as TaskReviewVerdict | undefined,
          reviewArtifactRef: reviewArtifact?.ref,
          generatedEvidenceArtifactRef: generatedEvidenceArtifact?.ref,
          remainingReadyTasks: finishedResult.remainingReadyTasks,
          projectCompletionCandidate: finishedResult.projectCompletionCandidate,
          nextReadyTask: finishedResult.nextReady,
          learningCandidate,
        }),
      };
    },
  });
}

async function checkResearchFollowUpDisposition(
  cwd: string,
  task: Task,
  summary: string | undefined,
): Promise<FollowUpDispositionCheck> {
  if (!FOLLOW_UP_RESEARCH_KINDS.has(task.kind))
    return {
      checked: false,
      ready: true,
      allowedDispositions: [...FOLLOW_UP_DISPOSITIONS],
      undispositioned: [],
    };

  const sources: Array<{ source: string; text: string }> = [];
  if (summary) sources.push({ source: "finish summary", text: summary });
  const artifactStore = defaultArtifactStore(cwd);
  for (const artifactRef of task.outputArtifacts) {
    try {
      sources.push({ source: artifactRef, text: await artifactStore.getBody(artifactRef) });
    } catch {
      // Missing/unreadable artifacts are handled by the existing completion evidence warning path.
      // This gate only inspects available research/review output text for orphan follow-ups.
    }
  }

  const summaryText = summary ?? "";
  const undispositioned = sources.flatMap(({ source, text }) => {
    const signals = inspectFollowUpDispositionSource(source, text);
    if (source !== "finish summary" && sourceDispositionedInSummary(source, summaryText)) return [];
    return signals;
  });
  return {
    checked: true,
    ready: undispositioned.length === 0,
    allowedDispositions: [...FOLLOW_UP_DISPOSITIONS],
    undispositioned,
  };
}

function sourceDispositionedInSummary(source: string, summary: string): boolean {
  if (!summary || !isRef(source, "artifact")) return false;
  return summary
    .split(/\r?\n/)
    .some((line) => line.includes(source) && hasFollowUpDisposition(line));
}

function inspectFollowUpDispositionSource(
  source: string,
  text: string,
): FollowUpDispositionSignal[] {
  const signals: FollowUpDispositionSignal[] = [];
  const lines = text.split(/\r?\n/);
  let inFollowUpSection = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      inFollowUpSection = false;
      continue;
    }
    if (isFollowUpHeading(line)) {
      inFollowUpSection = true;
      continue;
    }
    const sectionItem = inFollowUpSection && isMarkdownListItem(line);
    const signal = firstFollowUpSignal(line);
    if (!signal && !sectionItem) continue;
    if (hasNoFollowUpSignal(line) || hasFollowUpDisposition(line)) continue;
    signals.push({
      source,
      line: index + 1,
      signal: signal ?? "follow-up section item",
      excerpt: truncateInline(trimmed, 180),
    });
  }
  return signals;
}

function firstFollowUpSignal(line: string): string | undefined {
  const normalized = normalizeFollowUpText(line);
  return FOLLOW_UP_SIGNAL_TERMS.find((term) => includesFollowUpTerm(normalized, term));
}

function hasFollowUpDisposition(line: string): boolean {
  const normalized = normalizeFollowUpText(line);
  return FOLLOW_UP_DISPOSITION_TERMS.some((term) => includesFollowUpTerm(normalized, term));
}

function hasNoFollowUpSignal(line: string): boolean {
  const normalized = normalizeFollowUpText(line).trimStart();
  const prefix = NO_FOLLOW_UP_PREFIXES.find((candidate) => normalized.startsWith(candidate + " "));
  if (!prefix) return false;
  const rest = normalized.slice(prefix.length).trimStart();
  const withoutOpen = rest.startsWith("open ") ? rest.slice("open ".length) : rest;
  return FOLLOW_UP_SIGNAL_TERMS.some((term) => includesFollowUpTerm(withoutOpen, term));
}

function isFollowUpHeading(line: string): boolean {
  let text = line.trim();
  while (text.startsWith("#")) text = text.slice(1).trimStart();
  if (text.endsWith(":")) text = text.slice(0, -1).trimEnd();
  return FOLLOW_UP_SIGNAL_TERMS.some((term) => normalizeFollowUpText(text) === term);
}

function isMarkdownListItem(line: string): boolean {
  const text = line.trimStart();
  if (!text) return false;
  const marker = text[0];
  if ((marker === "-" || marker === "*" || marker === "+") && text[1]?.trim() === "") {
    return text.slice(2).trim().length > 0;
  }
  let index = 0;
  while (index < text.length && text[index] >= "0" && text[index] <= "9") index += 1;
  if (index === 0) return false;
  const separator = text[index];
  if (separator !== "." && separator !== ")") return false;
  return text.slice(index + 1).trim().length > 0;
}

function normalizeFollowUpText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("‐", "-")
    .replaceAll("‑", "-")
    .replaceAll("–", "-")
    .replaceAll("—", "-");
}

function includesFollowUpTerm(value: string, term: string): boolean {
  const index = value.indexOf(term);
  if (index < 0) return false;
  return isFollowUpBoundary(value[index - 1]) && isFollowUpBoundary(value[index + term.length]);
}

function isFollowUpBoundary(char: string | undefined): boolean {
  return (
    !char ||
    !((char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_" || char === "-")
  );
}

function renderFollowUpDispositionBlockedMessage(
  task: Task,
  check: FollowUpDispositionCheck,
): string {
  const signals = check.undispositioned
    .slice(0, 5)
    .map((signal) => `- ${signal.source}:${signal.line} (${signal.signal}) ${signal.excerpt}`)
    .join("\n");
  const hidden =
    check.undispositioned.length > 5
      ? `\n- … ${check.undispositioned.length - 5} more undispositioned follow-up signal(s)`
      : "";
  return `Task finish blocked by follow-up disposition gate: @${task.name}: ${task.title}\nResearch/review output contains follow-up signals that are not explicitly dispositioned. Mark each follow-up as one of: ${check.allowedDispositions.join(", ")}.\nUndispositioned signals:\n${signals}${hidden}\nThe task was not marked done. Create/confirm/defer/reject/scope follow-up work, then call task_write({ action: "finish" }) again.`;
}

function renderOpenTaskPlanItemBlockedMessage(
  task: Task,
  readiness: TaskCompletionReadiness,
): string {
  const issue = readiness.issues.find((entry) => entry.kind === "open_plan_items");
  const items = issue?.openItems ?? [];
  const visible = items.slice(0, 8);
  const hidden = items.length - visible.length;
  const list =
    visible.length > 0
      ? [
          ...visible.map((label) => `- ${label}`),
          ...(hidden > 0 ? [`- … ${hidden} more open plan item(s)`] : []),
        ].join("\n")
      : "- (no detail)";
  return `Task finish blocked by open task plan items: @${task.name}: ${task.title}\nFinish or disposition (cancel/delete/done) the remaining task plan items before marking the task done.\nOpen plan items (${items.length}):\n${list}\nThe task was not marked done. Update task plan items with task_write({ action: "plan_update", scope: "task", ops: [...] }), then call task_write({ action: "finish" }) again.`;
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedTaskReviewerRunResult(input: TaskReviewInput, reason: string): ReviewerRunResult {
  const timestamp = nowIso();
  return {
    verdict: {
      targetKind: "task",
      taskRef: input.task.ref,
      approved: false,
      outcome: "blocked",
      summary: `reviewer failed: ${reason}`,
      findings: [],
      blockers: [reason],
      confidence: "low",
    },
    record: {
      roleRef: "role:builtin-reviewer" as RoleRef,
      runName: "reviewer-failed",
      startedAt: timestamp,
      finishedAt: timestamp,
    },
  };
}

function isFinishTaskErrorResult(
  result:
    | FinishCommitResult
    | { error?: undefined; projectRef: ProjectRef; task: Task }
    | { error: "no_project" | "no_matching_claimed_task" },
): result is FinishTaskErrorResult {
  return result.error === "no_project" || result.error === "no_matching_claimed_task";
}

async function resolveFinishReviewCandidate(
  store: ReturnType<typeof defaultTaskGraphStore>,
  cwd: string,
  ctx: SparkToolContext,
  input: NormalizedSparkFinishTaskInput,
): Promise<
  | { error: "no_project" | "no_matching_claimed_task" }
  | {
      error?: undefined;
      projectRef: ProjectRef;
      task: Task;
      persistedTask: Task;
    }
> {
  const graph = await store.load();
  if (!graph) return { error: "no_project" };
  const project = await currentSparkProject(cwd, ctx, graph);
  if (!project) return { error: "no_project" };
  const task = resolveSessionClaimedTask(graph, project.ref, sparkSessionKey(ctx), input.task);
  if (!task) return { error: "no_matching_claimed_task" };
  const candidateTask = taskWithFinishEvidenceRefs(task, input.evidenceRefs);
  return {
    projectRef: project.ref,
    task: candidateTask,
    persistedTask: task,
  };
}

async function commitFinishedTask(
  store: ReturnType<typeof defaultTaskGraphStore>,
  cwd: string,
  ctx: SparkToolContext,
  input: NormalizedSparkFinishTaskInput,
): Promise<Awaited<ReturnType<typeof store.update>>> {
  return store.update(
    async (graph) => {
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project) return { error: "no_project" as const };
      const sessionKey = sparkSessionKey(ctx);
      let task = resolveSessionClaimedTask(graph, project.ref, sessionKey, input.task);
      if (!task) return { error: "no_matching_claimed_task" as const };
      const statusBefore = task.status;
      task = attachFinishEvidenceRefs(graph, task, input.evidenceRefs);
      const finished = graph.setTaskStatus(task.ref, input.status);
      const completionReadiness =
        input.status === "done" ? taskCompletionReadiness(finished) : undefined;
      const progress = finishProjectProgress(graph, project.ref);
      const nextReady = input.status === "done" ? progress.remainingReadyTasks[0] : undefined;
      return {
        task: finished,
        statusBefore,
        statusAfter: finished.status,
        completionReadiness,
        projectRef: project.ref,
        remainingReadyTasks: progress.remainingReadyTasks,
        nextReady,
        projectCompletionCandidate: progress.projectCompletionCandidate,
      } satisfies FinishTaskSuccessResult;
    },
    { createIfMissing: false },
  );
}

interface FinishTransitionDetailsInput {
  error?: string;
  projectRef: ProjectRef;
  requestedStatus: "done" | "failed" | "cancelled";
  task: Task;
  statusBefore: TaskStatus;
  statusAfter: TaskStatus;
  committed: boolean;
  transitionBlocker?: string;
  completionReadiness?: TaskCompletionReadiness;
  inputEvidenceRefs: ArtifactRef[];
  reviewEvidenceRefs: ArtifactRef[];
  reviewRequired: boolean;
  review?: TaskReviewVerdict;
  reviewArtifactRef?: ArtifactRef;
  generatedEvidenceArtifactRef?: ArtifactRef;
  remainingReadyTasks: Task[];
  projectCompletionCandidate: FinishProjectCompletionCandidate;
  nextReadyTask?: Task;
  learningCandidate?: { artifact: Artifact<LearningRecord>; location: LearningLocation };
}

function renderFinishTransitionDetails(
  input: FinishTransitionDetailsInput,
): Record<string, unknown> {
  const learningCandidate = input.learningCandidate
    ? compactLearningDetail(input.learningCandidate.artifact, input.learningCandidate.location)
    : undefined;
  return {
    found: true,
    ...(input.error ? { error: input.error } : {}),
    projectRef: input.projectRef,
    requestedStatus: input.requestedStatus,
    statusBefore: input.statusBefore,
    statusAfter: input.statusAfter,
    transition: {
      requestedStatus: input.requestedStatus,
      statusBefore: input.statusBefore,
      statusAfter: input.statusAfter,
      committed: input.committed,
      ...(input.transitionBlocker ? { blocker: input.transitionBlocker } : {}),
    },
    task: compactTaskDetail(input.task),
    evidenceRefs: input.task.outputArtifacts,
    inputEvidenceRefs: input.inputEvidenceRefs,
    reviewEvidenceRefs: input.reviewEvidenceRefs,
    generatedEvidenceArtifact: input.generatedEvidenceArtifactRef,
    completionReadiness: input.completionReadiness,
    nextReadyTask: input.nextReadyTask ? compactTaskDetail(input.nextReadyTask) : undefined,
    remainingReadyTasks: input.remainingReadyTasks.map(compactTaskDetail),
    projectCompletionCandidate: input.projectCompletionCandidate,
    learningCandidate,
    reviewRequired: input.reviewRequired,
    review: input.review,
    reviewArtifact: input.reviewArtifactRef,
    reviewer: {
      required: input.reviewRequired,
      approved: input.review?.approved,
      outcome: input.review?.outcome,
      summary: input.review?.summary,
      findings: input.review?.findings,
      blockers: input.review?.blockers,
      confidence: input.review?.confidence,
      artifactRef: input.reviewArtifactRef,
      generatedEvidenceArtifactRef: input.generatedEvidenceArtifactRef,
    },
  };
}

async function readFinishProjectProgress(
  store: ReturnType<typeof defaultTaskGraphStore>,
  projectRef: ProjectRef,
): Promise<{
  remainingReadyTasks: Task[];
  projectCompletionCandidate: FinishProjectCompletionCandidate;
}> {
  const graph = await store.load();
  if (!graph) return emptyFinishProjectProgress(projectRef);
  return finishProjectProgress(graph, projectRef);
}

function finishProjectProgress(
  graph: TaskGraph,
  projectRef: ProjectRef,
): { remainingReadyTasks: Task[]; projectCompletionCandidate: FinishProjectCompletionCandidate } {
  void graph.getProject(projectRef);
  const unfinishedTasks = graph
    .tasks(projectRef)
    .filter((task) => isUnfinishedTaskStatus(task.status));
  const remainingReadyTasks = graph.readyTasks(projectRef);
  return {
    remainingReadyTasks,
    projectCompletionCandidate: {
      projectRef,
      ready: unfinishedTasks.length === 0,
      unfinishedTaskCount: unfinishedTasks.length,
      unfinishedTasks: unfinishedTasks.slice(0, 8).map(compactTaskDetail),
      ...(unfinishedTasks.length === 0
        ? {
            suggestedAction:
              'Review evidence and call goal({ action: "complete" }) if the session goal is achieved.',
          }
        : {}),
    },
  };
}

function emptyFinishProjectProgress(projectRef: ProjectRef): {
  remainingReadyTasks: Task[];
  projectCompletionCandidate: FinishProjectCompletionCandidate;
} {
  return {
    remainingReadyTasks: [],
    projectCompletionCandidate: {
      projectRef,
      ready: false,
      unfinishedTaskCount: 0,
      unfinishedTasks: [],
    },
  };
}

async function recordTaskFinishEvidenceArtifact(
  cwd: string,
  projectRef: ProjectRef,
  task: Task,
  input: NormalizedSparkFinishTaskInput,
): Promise<Artifact<JsonValue>> {
  const title = input.evidence?.title ?? `Task evidence for @${task.name}: ${task.title}`;
  const body = renderTaskFinishEvidenceMarkdown(task, input);
  return defaultArtifactStore(cwd).put({
    kind: "trace",
    title,
    format: "markdown",
    body,
    provenance: {
      producer: "task",
      projectRef,
      taskRef: task.ref,
    },
    links: [{ to: task.ref, relation: "output" }],
    curation: { status: "candidate", retention: "task" },
  });
}

function renderTaskFinishEvidenceMarkdown(
  task: Task,
  input: NormalizedSparkFinishTaskInput,
): string {
  const evidence = input.evidence;
  const lines = [
    `# ${evidence?.title ?? `Task evidence for @${task.name}: ${task.title}`}`,
    "",
    `Task: @${task.name}: ${task.title} (${task.ref})`,
    `Requested status: ${input.status}`,
  ];
  if (input.summary) lines.push(`Summary: ${input.summary}`);
  if (evidence?.notes) lines.push("", "## Notes", evidence.notes);
  appendEvidenceList(lines, "Changed files", evidence?.changedFiles ?? []);
  appendEvidenceList(lines, "Source refs", evidence?.sourceRefs ?? []);
  appendEvidenceList(lines, "Validation commands", evidence?.validationCommands ?? []);
  return lines.join("\n");
}

function appendEvidenceList(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push("", `## ${title}`);
  for (const item of items.slice(0, 40)) lines.push(`- ${truncateInline(item, 300)}`);
  if (items.length > 40) lines.push(`- … ${items.length - 40} more item(s) omitted`);
}

async function recordTaskReviewArtifact(
  cwd: string,
  projectRef: ProjectRef,
  task: Task,
  review: ReviewerRunResult,
): Promise<Artifact<JsonValue>> {
  const verdict = review.verdict as TaskReviewVerdict;
  const reviewerRun = {
    ...(review.record.runRef ? { runRef: review.record.runRef } : {}),
    roleRef: review.record.roleRef,
    ...(review.record.runName ? { runName: review.record.runName } : {}),
    startedAt: review.record.startedAt,
    finishedAt: review.record.finishedAt,
    ...(review.record.thinking ? { thinking: review.record.thinking } : {}),
    ...(review.record.stdout
      ? { stdoutPreview: truncateReviewRunOutput(review.record.stdout, 4_000) }
      : {}),
    ...(review.record.stderr
      ? { stderrPreview: truncateReviewRunOutput(review.record.stderr, 4_000) }
      : {}),
  };
  const artifact = await defaultArtifactStore(cwd).put({
    kind: "record",
    title: `Task finish review for @${task.name}: ${task.title}`,
    format: "json",
    body: {
      taskRef: task.ref,
      projectRef,
      verdict,
      reviewerRun,
      recordedAt: nowIso(),
    } as unknown as JsonValue,
    provenance: {
      producer: "review",
      projectRef,
      taskRef: task.ref,
      roleRef: review.record.roleRef as RoleRef | undefined,
      runRef: review.record.runRef,
    },
    links: [{ to: task.ref, relation: "review-of" }],
  });
  await recordTaskSubjectReview(cwd, projectRef, task, artifact, review);
  return artifact;
}

function truncateReviewRunOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `…${value.slice(value.length - Math.max(0, maxChars - 1)).trimStart()}`;
}

function renderTaskReviewRejectedMessage(
  task: Task,
  verdict: TaskReviewVerdict,
  artifactRef: ArtifactRef,
): string {
  const findings = verdict.findings.length
    ? `\nFindings: ${formatReviewerList(verdict.findings)}`
    : "";
  const blockers = verdict.blockers.length
    ? `\nBlockers: ${formatReviewerList(verdict.blockers)}`
    : "";
  return `Task finish blocked by reviewer: @${task.name}: ${task.title}\nReview outcome: ${verdict.outcome}\nReview summary: ${verdict.summary}${findings}${blockers}\nReview artifact: ${artifactRef}\nThe task was not marked done. Address the reviewer feedback, keep or update evidence, then call task_write({ action: "finish" }) again.`;
}

function formatReviewerList(items: readonly string[]): string {
  const visible = items.slice(0, 5);
  const hidden = items.length - visible.length;
  return `${visible.join("; ")}${hidden > 0 ? `; … ${hidden} more` : ""}`;
}

function renderFinishNextStepSuffix(
  nextReady: Task | undefined,
  status: "done" | "failed" | "cancelled",
): string {
  if (status !== "done") return "";
  return nextReady
    ? "\nImplementation phase can continue. Next ready task: @" +
        nextReady.name +
        ": " +
        nextReady.title +
        ". Inspect current status, claim the next ready task, and continue until blocked."
    : '\nNo ready task remains; inspect blockers, plan missing work, or request goal({ action: "complete" }) when the objective is fully evidenced.';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSparkFinishStatus(value: unknown): "done" | "failed" | "cancelled" {
  if (value === undefined || value === null) return "done";
  if (value === "done" || value === "failed" || value === "cancelled") return value;
  throw new Error("status must be done, failed, or cancelled");
}

async function recordTaskLearningCandidate(
  cwd: string,
  task: Task,
  summary: string,
): Promise<{ artifact: Artifact<LearningRecord>; location: LearningLocation }> {
  const store = defaultLearningStore(cwd);
  const artifact = await store.record({
    title: `Candidate from @${task.name}: ${task.title}`,
    statement: summary,
    category: "workflow",
    status: "candidate",
    applicability: "Review this task-derived candidate before applying it to future Spark work.",
    evidenceRefs: [task.ref],
    tags: ["task-finish", task.kind],
    confidence: 0.4,
    sourceContent: [
      `Task: @${task.name}: ${task.title} (${task.ref})`,
      `Kind: ${task.kind}`,
      "",
      task.description,
      "",
      `Completion summary: ${summary}`,
    ].join("\n"),
  });
  return { artifact, location: store.location };
}

async function buildTaskEvidencePreviews(
  cwd: string,
  artifactRefs: ArtifactRef[],
): Promise<GoalReviewEvidencePreview[]> {
  if (!artifactRefs.length) return [];
  const store = defaultArtifactStore(cwd);
  return Promise.all(
    artifactRefs.slice(-10).map(async (ref) => {
      try {
        const artifact = await store.get(ref);
        const bodyText =
          typeof artifact.body === "string"
            ? artifact.body
            : JSON.stringify(artifact.body, null, 2);
        const bodyPreview =
          artifact.bodyPreview ??
          (bodyText.length > 2000 ? bodyText.slice(0, 2000) + "…" : bodyText);
        return {
          ref,
          title: artifact.title,
          kind: artifact.kind,
          format: artifact.format,
          provenance: artifact.provenance as unknown as Record<string, unknown>,
          bodyPreview,
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
