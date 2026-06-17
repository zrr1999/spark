import { Type } from "typebox";
import {
  defaultLearningStore,
  type LearningLocation,
  type LearningRecord,
} from "@zendev-lab/pi-learnings";
import { defaultArtifactStore, type Artifact } from "@zendev-lab/pi-artifacts";
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
  type TaskTodo,
} from "@zendev-lab/pi-extension-api";
import { defaultTaskGraphStore, taskCompletionReadiness } from "@zendev-lab/pi-tasks";
import { currentSparkProject, sparkSessionKey, sparkTodoStore } from "./session-state.ts";
import { resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { compactTaskDetail, normalizeOptionalToolString } from "./task-plan-tool.ts";
import { compactLearningDetail } from "./learning-tools.ts";
import { truncateInline } from "./tool-rendering.ts";
import { NO_SPARK_PROJECT_FOUND_HINT } from "./spark-project-guidance.ts";
import type { SparkToolContext, SparkToolRegistrar } from "./spark-tool-registration.ts";
import type {
  ReviewerRunResult,
  ReviewerRunner,
  TaskReviewInput,
  TaskReviewVerdict,
} from "./reviewer-runner.ts";
import { withSparkReviewerLease } from "./spark-reviewer-lease.ts";

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
}

interface FinishTaskSuccessResult {
  error?: undefined;
  task: Task;
  completionReadiness?: TaskCompletionReadiness;
  projectRef: ProjectRef;
  nextReady?: Task;
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
    name: "spark_finish_task",
    label: "Spark Finish Task",
    description:
      'Compatibility surface for task_write({ action: "finish" }): finish this session\'s claimed Spark task as done, failed, or cancelled. Defaults to the current claimed task and status=done.',
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const input = normalizeSparkFinishTaskInput(params);
      const store = defaultTaskGraphStore(cwd);
      let reviewArtifact: Artifact<JsonValue> | undefined;
      let reviewResult: ReviewerRunResult | undefined;
      if (input.status === "done") {
        const candidate = await resolveFinishReviewCandidate(store, cwd, ctx, input);
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
        const todoReadiness = taskCompletionReadiness(candidate.task, {
          openTodos: candidate.openTodos,
        });
        const openTodoIssue = todoReadiness.issues.find(
          (entry) => entry.kind === "open_task_todos",
        );
        if (openTodoIssue) {
          await deps.refreshSparkWidget(cwd, ctx);
          return {
            content: [
              {
                type: "text",
                text: renderOpenTaskTodoBlockedMessage(candidate.task, todoReadiness),
              },
            ],
            details: {
              found: true,
              error: "open_task_todos",
              task: compactTaskDetail(candidate.task),
              completionReadiness: todoReadiness,
            },
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
          sessionKey: sparkSessionKey(ctx),
          forkFromSession: ctx.sessionManager?.getSessionFile?.(),
        };
        const reviewerRunner = await deps.createReviewerRunner?.(cwd, ctx);
        if (!reviewerRunner)
          throw new Error("spark_finish_task requires a reviewer runner for done transitions");
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
          return {
            content: [
              {
                type: "text",
                text: renderTaskReviewRejectedMessage(candidate.task, verdict, reviewArtifact.ref),
              },
            ],
            details: {
              found: true,
              error: "task_review_failed",
              task: compactTaskDetail(candidate.task),
              review: verdict,
              reviewArtifact: reviewArtifact.ref,
            },
          };
        }
      }

      let updated: Awaited<ReturnType<typeof store.update>>;
      try {
        updated = await commitFinishedTask(store, cwd, ctx, input);
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
        ? `\nLearning candidate: ${learningCandidate.artifact.ref}`
        : "";
      const executionSuffix = renderFinishNextStepSuffix(finishedResult.nextReady, input.status);
      return {
        content: [
          {
            type: "text",
            text: `Finished Spark task: [${finishedResult.task.status}] @${finishedResult.task.name}: ${finishedResult.task.title}${summarySuffix}${completionIssueSuffix}${candidateSuffix}${executionSuffix}`,
          },
        ],
        details: {
          task: compactTaskDetail(finishedResult.task),
          completionReadiness: finishedResult.completionReadiness,
          nextReadyTask: finishedResult.nextReady
            ? compactTaskDetail(finishedResult.nextReady)
            : undefined,
          learningCandidate: learningCandidate
            ? compactLearningDetail(learningCandidate.artifact, learningCandidate.location)
            : undefined,
          review: reviewResult?.verdict,
          reviewArtifact: reviewArtifact?.ref,
        },
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

function renderOpenTaskTodoBlockedMessage(task: Task, readiness: TaskCompletionReadiness): string {
  const issue = readiness.issues.find((entry) => entry.kind === "open_task_todos");
  const todos = issue?.openTodos ?? [];
  const list = todos.length > 0 ? todos.map((label) => `- ${label}`).join("\n") : "- (no detail)";
  return `Task finish blocked by open task TODOs: @${task.name}: ${task.title}\nFinish or disposition (cancel/delete/done) the remaining task TODOs before marking the task done.\nOpen TODOs:\n${list}\nThe task was not marked done. Update task TODOs with task_write({ action: "todo_update", scope: "task", ops: [...] }), then call task_write({ action: "finish" }) again.`;
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
  | { error?: undefined; projectRef: ProjectRef; task: Task; openTodos: TaskTodo[] }
> {
  const updated = await store.update(
    async (graph) => {
      await sparkTodoStore(cwd, ctx).hydrate(graph);
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project) return { error: "no_project" as const };
      const task = resolveSessionClaimedTask(graph, project.ref, sparkSessionKey(ctx), input.task);
      if (!task) return { error: "no_matching_claimed_task" as const };
      const candidateTask = taskWithFinishEvidenceRefs(task, input.evidenceRefs);
      return { projectRef: project.ref, task: candidateTask, openTodos: graph.taskTodos(task.ref) };
    },
    { createIfMissing: false },
  );
  if (!updated.graph) return { error: "no_project" };
  return updated.result as
    | { error: "no_project" | "no_matching_claimed_task" }
    | { error?: undefined; projectRef: ProjectRef; task: Task; openTodos: TaskTodo[] };
}

async function commitFinishedTask(
  store: ReturnType<typeof defaultTaskGraphStore>,
  cwd: string,
  ctx: SparkToolContext,
  input: NormalizedSparkFinishTaskInput,
): Promise<Awaited<ReturnType<typeof store.update>>> {
  return store.update(
    async (graph) => {
      await sparkTodoStore(cwd, ctx).hydrate(graph);
      const project = await currentSparkProject(cwd, ctx, graph);
      if (!project) return { error: "no_project" as const };
      const sessionKey = sparkSessionKey(ctx);
      let task = resolveSessionClaimedTask(graph, project.ref, sessionKey, input.task);
      if (!task) return { error: "no_matching_claimed_task" as const };
      task = attachFinishEvidenceRefs(graph, task, input.evidenceRefs);
      const finished = graph.setTaskStatus(task.ref, input.status);
      const completionReadiness =
        input.status === "done"
          ? taskCompletionReadiness(finished, {
              openTodos: graph.taskTodos(finished.ref),
            })
          : undefined;
      const nextReady = input.status === "done" ? graph.readyTasks(project.ref)[0] : undefined;
      await sparkTodoStore(cwd, ctx).save(graph);
      return {
        task: finished,
        completionReadiness,
        projectRef: project.ref,
        nextReady,
      } satisfies FinishTaskSuccessResult;
    },
    { createIfMissing: false },
  );
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
    ...(review.record.stdout
      ? { stdoutPreview: truncateReviewRunOutput(review.record.stdout, 4_000) }
      : {}),
    ...(review.record.stderr
      ? { stderrPreview: truncateReviewRunOutput(review.record.stderr, 4_000) }
      : {}),
  };
  return defaultArtifactStore(cwd).put({
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
  const findings = verdict.findings.length ? `\nFindings: ${verdict.findings.join("; ")}` : "";
  const blockers = verdict.blockers.length ? `\nBlockers: ${verdict.blockers.join("; ")}` : "";
  return `Task finish blocked by reviewer: @${task.name}: ${task.title}\nReview outcome: ${verdict.outcome}\nReview summary: ${verdict.summary}${findings}${blockers}\nReview artifact: ${artifactRef}\nThe task was not marked done. Address the reviewer feedback, keep or update evidence, then call task_write({ action: "finish" }) again.`;
}

function renderFinishNextStepSuffix(
  nextReady: Task | undefined,
  status: "done" | "failed" | "cancelled",
): string {
  if (status !== "done") return "";
  return nextReady
    ? "\nImplementation mode stopped after one task. Next ready task: @" +
        nextReady.name +
        ": " +
        nextReady.title +
        ". Run /implement to take one more step, or /goal to continue autonomously."
    : "\nImplementation mode stopped after one task. No ready task remains; inspect blockers or finish the project.";
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
