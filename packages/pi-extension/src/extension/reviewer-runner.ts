import { createHash } from "node:crypto";
import {
  builtinRoleRef,
  defaultProjectRoleModelSettingsStore,
  defaultUserRoleModelSettingsStore,
  resolveRoleModelSetting,
  runRole,
  type RoleRegistry,
  type RoleRunResult,
  type RoleThinkingLevel,
} from "@zendev-lab/spark-roles";
import {
  newRef,
  nowIso,
  type ArtifactRef,
  type ExtensionRoleRunner,
  type ProjectRef,
  type RoleRef,
  type RunRef,
  type Task,
  type TaskRef,
} from "@zendev-lab/spark-extension-api";

export type ReviewTargetKind = "task" | "goal";
export type ReviewVerdictOutcome = "approved" | "needs_changes" | "blocked";
export type ReviewerThinkingLevel = RoleThinkingLevel;

export interface TaskReviewInput {
  targetKind: "task";
  cwd: string;
  projectRef: ProjectRef;
  task: Task;
  requestedStatus: "done" | "failed" | "cancelled";
  summary?: string;
  evidenceRefs: ArtifactRef[];
  evidencePreviews?: GoalReviewEvidencePreview[];
  sessionKey?: string;
  forkFromSession?: string;
}

export interface GoalReviewEvidencePreview {
  ref: ArtifactRef;
  title?: string;
  kind?: string;
  format?: string;
  provenance?: Record<string, unknown>;
  bodyPreview?: string;
  error?: string;
}

export interface GoalReviewInput {
  targetKind: "goal";
  cwd: string;
  projectRef?: ProjectRef;
  currentProjectSelected?: boolean;
  projectEvidenceSource?: "current_project" | "project_evidence_fallback" | "none";
  projectStatus?: {
    ref: ProjectRef;
    title: string;
    taskCounts: {
      total: number;
      unfinished: number;
      claimed: number;
      statusCounts: Record<string, number>;
    };
    readyTasks?: Array<{ ref: string; name?: string; title: string; status: string; kind: string }>;
    unfinishedTasks?: Array<{
      ref: string;
      name?: string;
      title: string;
      status: string;
      kind: string;
    }>;
  };
  goalId: string;
  /** Immutable user goal captured when the goal was started/set. Reviewers must compare completion claims against this, not only against derived task descriptions. */
  originalObjective?: string;
  /** Current objective text after any approved edits; must remain equivalent to originalObjective. */
  objective: string;
  status: "active" | "paused" | "complete";
  requestedStatus: "paused" | "complete" | "edited";
  reason?: string;
  proposedObjective?: string;
  evidenceRefs: ArtifactRef[];
  evidencePreviews?: GoalReviewEvidencePreview[];
  sessionKey?: string;
  forkFromSession?: string;
}

export type ReviewInput = TaskReviewInput | GoalReviewInput;

export interface ReviewVerdict {
  outcome: ReviewVerdictOutcome;
  summary: string;
  findings: string[];
  blockers: string[];
  confidence: "low" | "medium" | "high";
}

export interface TaskReviewVerdict extends ReviewVerdict {
  targetKind: "task";
  taskRef: TaskRef;
  approved: boolean;
}

export interface GoalReviewVerdict extends ReviewVerdict {
  targetKind: "goal";
  goalId: string;
  achieved: boolean;
  /** Whether cited commands/files/tests are real and support the completion claim as evidence. */
  evidenceValid?: boolean;
  /** Whether the validated evidence semantically satisfies the immutable original user goal. */
  objectiveSatisfied?: boolean;
  remainingWork: string;
}

export type ReviewerVerdict = TaskReviewVerdict | GoalReviewVerdict;

export interface ReviewerRunRecord {
  runRef?: RunRef;
  roleRef: RoleRef;
  runName?: string;
  startedAt: string;
  finishedAt: string;
  thinking?: ReviewerThinkingLevel;
  stdout?: string;
  stderr?: string;
  jsonEvents?: unknown[];
}

export interface ReviewerRunResult {
  verdict: ReviewerVerdict;
  record: ReviewerRunRecord;
}

const REVIEWER_FORBIDDEN_TOOLS = new Set([
  "ask",
  "ask_user",
  "ask_flow",
  "task",
  "task_write",
  "goal",
  "assign",
  "role",
  "workflow",
  "graft_patch",
  "patch",
]);

const REVIEWER_EXECUTION_TOOLS = new Set([
  "cue_exec",
  "cue_run",
  "cue_script",
  "script_run",
  "script_eval",
  "cue_jobs",
]);

const REVIEWER_LOW_COST_READ_TOOLS = new Set(["read", "grep", "find", "task_read", "artifact"]);

export interface AskAutoAnswerInput {
  cwd: string;
  request: unknown;
  sessionKey?: string;
  forkFromSession?: string;
}

export interface AskAutoAnswerResult {
  answers?: Record<
    string,
    { values?: string[]; customText?: string; notes?: string; comment?: string }
  >;
  blocked?: boolean;
  reason?: string;
}

export interface ReviewerRunner {
  review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewerRunResult>;
  answerAsk?(input: AskAutoAnswerInput, signal?: AbortSignal): Promise<AskAutoAnswerResult>;
}

export interface PiRolesReviewerRunnerOptions {
  registry: RoleRegistry;
  cwd: string;
  piCommand?: string;
  timeoutMs?: number;
  reviewerRoleRef?: RoleRef;
  model?: string;
  sessionModel?: string;
  sessionDir?: string;
  env?: NodeJS.ProcessEnv;
  reviewerThinkingLevel?: ReviewerThinkingLevel;
  nativeExecutor?: ExtensionRoleRunner;
  now?: () => string;
  /** Maximum retry attempts for transient failures (timeout, overloaded). Default: 2. */
  maxRetries?: number;
  /** Base delay between retries in milliseconds. Default: 5000. Exponential backoff applied. */
  retryBaseDelayMs?: number;
}

const REVIEWER_TIMEOUT_MS_ENV = "SPARK_REVIEWER_TIMEOUT_MS";
const DEFAULT_REVIEWER_TIMEOUT_MS = 1_200_000;
export const DEFAULT_REVIEWER_THINKING_LEVEL: ReviewerThinkingLevel = "medium";

const REVIEWER_THINKING_RANK: Record<ReviewerThinkingLevel, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
};

export function capReviewerThinkingLevel(value: unknown): ReviewerThinkingLevel {
  if (!isReviewerThinkingLevel(value)) return DEFAULT_REVIEWER_THINKING_LEVEL;
  return REVIEWER_THINKING_RANK[value] <= REVIEWER_THINKING_RANK.medium
    ? value
    : DEFAULT_REVIEWER_THINKING_LEVEL;
}

function isReviewerThinkingLevel(value: unknown): value is ReviewerThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

const REVIEWER_JSON_SCHEMA = [
  "Return ONLY one valid JSON object. Do not include markdown, prose, comments, or tool calls.",
  'Use outcome exactly one of: "approved", "needs_changes", "blocked".',
  'Use confidence exactly one of: "low", "medium", "high".',
  "For task reviews, omit achieved, remainingWork, evidence_valid, and objective_satisfied.",
  "For goal completion reviews, include achieved, evidence_valid, objective_satisfied, and remainingWork. Approve only when evidence_valid=true and objective_satisfied=true.",
  "Task review example:",
  '{"outcome":"approved","summary":"one sentence","findings":[],"blockers":[],"confidence":"high"}',
  "Goal review example:",
  '{"outcome":"needs_changes","summary":"one sentence","findings":["actionable finding"],"blockers":["blocking issue"],"confidence":"medium","achieved":false,"evidence_valid":true,"objective_satisfied":false,"remainingWork":"what remains"}',
].join("\n");

const ASK_AUTO_ANSWER_JSON_SCHEMA = [
  "Return ONLY compact JSON with this shape:",
  "{",
  '  "answers": { "questionId": { "values": ["option_value"], "customText": "freeform text", "notes": "brief rationale" } },',
  '  "blocked": false,',
  '  "reason": "why blocked or why these answers were chosen"',
  "}",
  "Use options[].value exactly. For single/preview choose at most one value. For freeform use customText.",
  "Answer every required question when the packet and options make the answer clear; otherwise set blocked=true and explain reason.",
  "If the packet is ambiguous or evidence is insufficient, set blocked=true and explain reason instead of omitting answers.",
].join("\n");

export class PiRolesReviewerRunner implements ReviewerRunner {
  readonly #registry: RoleRegistry;
  readonly #cwd: string;
  readonly #piCommand: string;
  readonly #timeoutMs: number;
  readonly #reviewerRoleRef: RoleRef;
  readonly #model?: string;
  readonly #sessionModel?: string;
  readonly #sessionDir?: string;
  readonly #env?: NodeJS.ProcessEnv;
  readonly #reviewerThinkingLevel: ReviewerThinkingLevel;
  readonly #nativeExecutor?: ExtensionRoleRunner;
  readonly #now: () => string;

  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;

  constructor(options: PiRolesReviewerRunnerOptions) {
    this.#registry = options.registry;
    this.#cwd = options.cwd;
    this.#piCommand = options.piCommand ?? "pi";
    this.#timeoutMs = options.timeoutMs ?? reviewerTimeoutMsFromEnv(process.env);
    this.#reviewerRoleRef = options.reviewerRoleRef ?? builtinRoleRef("reviewer");
    this.#model = options.model;
    this.#sessionModel = options.sessionModel;
    this.#sessionDir = options.sessionDir;
    this.#env = options.env;
    this.#reviewerThinkingLevel = options.reviewerThinkingLevel ?? DEFAULT_REVIEWER_THINKING_LEVEL;
    this.#nativeExecutor = options.nativeExecutor;
    this.#now = options.now ?? nowIso;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 5_000;
  }

  async review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewerRunResult> {
    let lastResult: ReviewerRunResult | undefined;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (signal?.aborted) break;
      if (attempt > 0) {
        const delayMs = this.#retryBaseDelayMs * Math.pow(2, attempt - 1);
        await sleep(delayMs, signal);
        if (signal?.aborted) break;
      }
      const result = await this.#singleReviewAttempt(input, signal);
      if (isRetriableReviewerFailure(result)) {
        lastResult = result;
        continue;
      }
      return result;
    }
    return (
      lastResult ?? {
        verdict: failedReviewerRunVerdict(input, "reviewer aborted before any attempt completed"),
        record: { roleRef: this.#reviewerRoleRef, startedAt: this.#now(), finishedAt: this.#now() },
      }
    );
  }

  async #singleReviewAttempt(input: ReviewInput, signal?: AbortSignal): Promise<ReviewerRunResult> {
    const role = this.#registry.get(this.#reviewerRoleRef);
    const runRef = newRef("run");
    const startedAt = this.#now();
    const roleModel = await resolveRoleModelSetting({
      roleRef: role.ref,
      roleId: role.id,
      roleName: role.id,
      projectStore: defaultProjectRoleModelSettingsStore(input.cwd || this.#cwd),
      userStore: defaultUserRoleModelSettingsStore(),
    });
    const resolvedModel = this.#model ?? roleModel?.model ?? this.#sessionModel;
    let result: RoleRunResult;
    try {
      result = await runRole({
        runRef: runRef as `run:${string}`,
        roleRef: role.ref as `role:${string}`,
        systemPrompt: buildReadOnlyReviewerSystemPrompt(role.systemPrompt),
        model: resolvedModel,
        thinking: this.#reviewerThinkingLevel,
        instruction: renderReviewerInstruction(input),
        runGuidance: REVIEWER_JSON_SCHEMA,
        allowedTools: reviewerGateAllowedTools(role.allowedTools),
        noSession: true,
        noExtensions: true,
        launch: "fresh",
        sessionDir: this.#sessionDir,
        env: this.#env,
        piCommand: this.#piCommand,
        cwd: input.cwd || this.#cwd,
        timeoutMs: this.#timeoutMs,
        signal,
        stdinMode: "ignore",
        nativeExecutor: this.#nativeExecutor,
      });
    } catch (error) {
      const finishedAt = this.#now();
      return {
        verdict: failedReviewerRunVerdict(
          input,
          `reviewer role run error: ${unknownErrorMessage(error)}`,
        ),
        record: { runRef, roleRef: role.ref as RoleRef, startedAt, finishedAt },
      };
    }
    const finishedAt = result.record.finishedAt ?? this.#now();
    if (result.record.status !== "succeeded")
      return {
        verdict: failedReviewerRunVerdict(input, `reviewer role run ${result.record.status}`),
        record: roleRunRecord(result, startedAt, finishedAt),
      };
    const record = roleRunRecord(result, startedAt, finishedAt);
    try {
      return {
        verdict: parseReviewerVerdictForInput(input, result.stdout),
        record,
      };
    } catch (error) {
      return {
        verdict: failedReviewerRunVerdict(
          input,
          `reviewer verdict parse failed: ${unknownErrorMessage(error)}`,
        ),
        record,
      };
    }
  }

  async answerAsk(input: AskAutoAnswerInput, signal?: AbortSignal): Promise<AskAutoAnswerResult> {
    let lastResult: AskAutoAnswerResult | undefined;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (signal?.aborted) break;
      if (attempt > 0) {
        const delayMs = this.#retryBaseDelayMs * Math.pow(2, attempt - 1);
        await sleep(delayMs, signal);
        if (signal?.aborted) break;
      }
      const result = await this.#singleAskAttempt(input, signal);
      if (isRetriableAskFailure(result)) {
        lastResult = result;
        continue;
      }
      return result;
    }
    return lastResult ?? { blocked: true, reason: "reviewer aborted before any attempt completed" };
  }

  async #singleAskAttempt(
    input: AskAutoAnswerInput,
    signal?: AbortSignal,
  ): Promise<AskAutoAnswerResult> {
    const role = this.#registry.get(this.#reviewerRoleRef);
    const runRef = newRef("run");
    const roleModel = await resolveRoleModelSetting({
      roleRef: role.ref,
      roleId: role.id,
      roleName: role.id,
      projectStore: defaultProjectRoleModelSettingsStore(input.cwd || this.#cwd),
      userStore: defaultUserRoleModelSettingsStore(),
    });
    const resolvedModel = this.#model ?? roleModel?.model ?? this.#sessionModel;
    let result: RoleRunResult;
    try {
      result = await runRole({
        runRef: runRef as `run:${string}`,
        roleRef: role.ref as `role:${string}`,
        systemPrompt: buildReadOnlyReviewerSystemPrompt(role.systemPrompt),
        model: resolvedModel,
        thinking: this.#reviewerThinkingLevel,
        instruction: renderAskAutoAnswerInstruction(input),
        runGuidance: ASK_AUTO_ANSWER_JSON_SCHEMA,
        allowedTools: reviewerGateAllowedTools(role.allowedTools),
        noSession: true,
        noExtensions: true,
        launch: "fresh",
        sessionDir: this.#sessionDir,
        env: this.#env,
        piCommand: this.#piCommand,
        cwd: input.cwd || this.#cwd,
        timeoutMs: this.#timeoutMs,
        signal,
        stdinMode: "ignore",
        nativeExecutor: this.#nativeExecutor,
      });
    } catch (error) {
      return { blocked: true, reason: `reviewer role run blocked: ${unknownErrorMessage(error)}` };
    }
    if (result.record.status !== "succeeded")
      return { blocked: true, reason: `reviewer role run ${result.record.status}` };
    return parseAskAutoAnswerResult(result.stdout);
  }
}

export function buildReadOnlyReviewerSystemPrompt(basePrompt: string): string {
  return [
    basePrompt.trim(),
    "",
    "Spark reviewer gate constraints:",
    "- Read-only verdict role: inspect the provided state/evidence only.",
    "- Do not mutate tasks, goals, files, artifacts, recall, learning, asks, or project state.",
    "- Do not call task_write, goal update, assign, role, workflow, file edit, write, memory, recall, ask, or learning mutation tools.",
    "- Never ask interactively. If a question is required, return outcome=needs_changes or outcome=blocked and put the concrete question in findings/blockers.",
    "- Return verdict JSON only; the Spark tool that invoked you will apply any state transition.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderReviewerInstruction(input: ReviewInput): string {
  const packet =
    input.targetKind === "task"
      ? {
          targetKind: input.targetKind,
          projectRef: input.projectRef,
          task: compactTaskForReview(input.task),
          requestedStatus: input.requestedStatus,
          summary: input.summary,
          evidenceRefs: input.evidenceRefs,
          ...(input.evidencePreviews?.length ? { evidencePreviews: input.evidencePreviews } : {}),
          sessionKey: input.sessionKey,
        }
      : {
          targetKind: input.targetKind,
          projectRef: input.projectRef,
          currentProjectSelected: input.currentProjectSelected,
          projectEvidenceSource: input.projectEvidenceSource,
          projectStatus: input.projectStatus,
          goalId: input.goalId,
          originalObjective: input.originalObjective ?? input.objective,
          objective: input.objective,
          status: input.status,
          requestedStatus: input.requestedStatus,
          reason: input.reason,
          proposedObjective: input.proposedObjective,
          evidenceRefs: input.evidenceRefs,
          evidencePreviews: input.evidencePreviews,
          sessionKey: input.sessionKey,
        };
  const transitionGuidance =
    input.targetKind === "task"
      ? [
          "For targetKind=task, review only the selected task's requestedStatus, task plan/scope, summary, and evidenceRefs.",
          "Do not reject a task finish merely because sibling, downstream, or final-integration tasks in the same project are unfinished; dependency chains require scoped leaf tasks to close before downstream work can run.",
          "Reject a task finish when the selected task's own plan items, scope, or evidence remain incomplete, or when the evidence defers work that belongs to the selected task rather than to an explicitly separate downstream task.",
        ]
      : [
          "For targetKind=goal, review semantic satisfaction of the immutable original user goal, not only whether evidence supports a task description, intermediate artifact, or latest completion wording.",
          "For requestedStatus=complete, first answer internally: what was the user's original goal, does the current completion definition strictly cover it, and has anything been downgraded into an intermediate artifact, simulation, summary, manifest, wrapper, deterministic packaging result, or fixed-point-looking substitute?",
          "For requestedStatus=complete, return evidence_valid=true only when the cited commands/files/tests are real and support the factual completion claim; return objective_satisfied=true only when that valid evidence satisfies originalObjective without scope drift or semantic laundering. Approve only if both are true.",
          "For requestedStatus=complete, provide a plain-language assessment in summary/findings of what works now, what still cannot be done, and any Rust/native/trusted dependency that remains. If the packet lacks enough plain-language claim or evidence to answer honestly, use needs_changes.",
          "Adversarial check: identify the most likely concept substitution in the completion claim and how a user would independently verify the original goal was truly implemented; if this cannot be ruled out, use needs_changes.",
          "For compiler, self-hosting, bootstrap, interpreter, VM, or execution-engine goals, require core execution path proof: command/call trace, code that executed the core logic, Rust/native/trusted boundary list, and host-implementation dependencies. If trusted/native code still performs the core goal, do not claim self-host/self-compile completion.",
          "For self-hosting/bootstrap goals, ask negative-counterexample questions: did the new compiler actually execute a compile function written in the target language; is a Rust helper/native primitive still doing core compilation; could byte-identical output be deterministic packaging; and if the Rust runner/helper is disabled, can stage1 still compile itself? If evidence does not answer these, use needs_changes.",
          'Treat evidence terms such as "image runner", "summary", "trusted native", "manifest", "mock", "snapshot", "fixed point", or "wrapper" as high-risk naming-misleading indicators; verify they are not packaging around a weaker substitute before approving.',
          "For requestedStatus=complete, require a user-reproducible acceptance command or equivalent direct validation that tests the original goal, not merely an internal task/subgoal. If only project task graph completion is shown but the original goal is not semantically met, use needs_changes and say the task graph is insufficient/create additional tasks/do not complete goal.",
          'For requestedStatus=complete, a goal may complete without a current project only when evidenceRefs/projectStatus directly cover originalObjective. Otherwise, currentProjectSelected=false or projectEvidenceSource=project_evidence_fallback means the next step is research/plan: create/select a project with task_write({ action: "project_use", title, description }) and plan concrete tasks with task_write({ action: "plan" }); never use "no current project", "project cleared", or "all historical tasks are done" as the completion rationale.',
          "If projectStatus.taskCounts.unfinished > 0, default to needs_changes unless originalObjective explicitly says this is planning-only/readiness-only and does not ask for project/task implementation completion.",
          "When unfinished project work remains, include concrete remainingWork using projectStatus.readyTasks and unfinishedTasks instead of treating planning evidence as implementation completion.",
          "For requestedStatus=paused, reject main-agent autonomous pauses; blockers should be resolved by doing or planning blocking work, not by pausing the goal.",
          "For requestedStatus=edited, approve only when the proposed objective corrects a material description error or wrong direction in the current objective and does not reduce difficulty, remove required outcomes, narrow scope, or turn implementation work into planning-only/readiness-only work; compare proposedObjective against originalObjective.",
        ];
  return [
    "Review this Spark state transition request.",
    "Approve only if the provided evidence and current packet satisfy the requested state transition.",
    ...transitionGuidance,
    "If work remains or the requested transition is not justified, use outcome=needs_changes and list concrete blockers/findings.",
    "Always return the required compact JSON verdict, even when rejecting.",
    "Review packet:",
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

export function renderAskAutoAnswerInstruction(input: AskAutoAnswerInput): string {
  return [
    "Answer this ask packet as a read-only reviewer for an autonomous goal turn.",
    "Choose only when the request context and options make the next action clear.",
    "Return option values, not labels. Do not mutate state or call tools.",
    "Always return the required compact JSON answer packet, even when blocked.",
    "Ask packet:",
    JSON.stringify({ request: input.request, sessionKey: input.sessionKey }, null, 2),
  ].join("\n");
}

export function parseAskAutoAnswerResult(text: string): AskAutoAnswerResult {
  const value = parseAskAutoAnswerObjectFromText(text);
  const output: AskAutoAnswerResult = {};
  if (typeof value.reason === "string") output.reason = value.reason;
  if (value.blocked === true) output.blocked = true;
  if (value.answers && typeof value.answers === "object" && !Array.isArray(value.answers)) {
    output.answers = {};
    for (const [questionId, rawAnswer] of Object.entries(value.answers)) {
      if (!rawAnswer || typeof rawAnswer !== "object" || Array.isArray(rawAnswer)) continue;
      const answer = rawAnswer as Record<string, unknown>;
      output.answers[questionId] = {
        ...(Array.isArray(answer.values)
          ? { values: answer.values.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(typeof answer.customText === "string" ? { customText: answer.customText } : {}),
        ...(typeof answer.notes === "string" ? { notes: answer.notes } : {}),
        ...(typeof answer.comment === "string" ? { comment: answer.comment } : {}),
      };
    }
  }
  return output;
}

function parseAskAutoAnswerObjectFromText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("reviewer ask auto-answer must be non-empty JSON");
  let fallback: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      fallback = parsed;
      const answer = findAskAutoAnswerRecord(parsed);
      if (answer) return answer;
    }
  } catch {
    // Fall through to JSON-object extraction for role output wrappers.
  }
  for (const objectText of extractJsonObjects(trimmed)) {
    try {
      const parsed = JSON.parse(objectText);
      if (!isRecord(parsed)) continue;
      fallback ??= parsed;
      const answer = findAskAutoAnswerRecord(parsed);
      if (answer) return answer;
    } catch {
      // Keep scanning later objects; role stdout can contain protocol JSON and text fragments.
    }
  }
  if (fallback) return fallback;
  throw new Error("reviewer ask auto-answer must be a JSON object");
}

function findAskAutoAnswerRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (isAskAutoAnswerRecord(record)) return record;
  for (const text of reviewerVerdictTextCandidates(record)) {
    const found = findAskAutoAnswerRecordInText(text);
    if (found) return found;
  }
  return undefined;
}

function findAskAutoAnswerRecordInText(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const found = findAskAutoAnswerRecord(parsed);
      if (found) return found;
    }
  } catch {
    // Continue with object extraction below.
  }
  for (const objectText of extractJsonObjects(trimmed)) {
    try {
      const parsed = JSON.parse(objectText);
      if (!isRecord(parsed)) continue;
      const found = findAskAutoAnswerRecord(parsed);
      if (found) return found;
    } catch {
      // Keep scanning; assistant content can include prose plus JSON.
    }
  }
  return undefined;
}

function isAskAutoAnswerRecord(record: Record<string, unknown>): boolean {
  return (
    (record.answers !== undefined && isRecord(record.answers)) ||
    record.blocked === true ||
    record.blocked === false
  );
}

export function parseReviewerVerdictForInput(input: ReviewInput, text: string): ReviewerVerdict {
  const value = parseJsonObjectFromText(text, { requireReviewerVerdict: true });
  const parsed = normalizeReviewerVerdictObject(value);
  if (input.targetKind === "task")
    return {
      ...parsed,
      targetKind: "task",
      taskRef: input.task.ref,
      approved: parsed.outcome === "approved",
    };
  const evidenceValid = parseBooleanAliasField(value, "evidence_valid", "evidenceValid");
  const objectiveSatisfied = parseBooleanAliasField(
    value,
    "objective_satisfied",
    "objectiveSatisfied",
  );
  const missingRequiredApprovalFields =
    input.requestedStatus === "complete" &&
    parsed.outcome === "approved" &&
    (evidenceValid !== true || objectiveSatisfied !== true);
  const outcome = missingRequiredApprovalFields ? "needs_changes" : parsed.outcome;
  const blockers = missingRequiredApprovalFields
    ? [
        ...parsed.blockers,
        "goal completion approval must explicitly set evidence_valid=true and objective_satisfied=true",
      ]
    : parsed.blockers;
  const achieved =
    input.requestedStatus === "complete" &&
    outcome === "approved" &&
    (parseBooleanField(value, "achieved") ?? true) &&
    evidenceValid === true &&
    objectiveSatisfied === true;
  const summary = missingRequiredApprovalFields
    ? "goal completion approval missing required evidence_valid/objective_satisfied semantic gate"
    : parsed.summary;
  const remainingWork = stringField(value, "remainingWork") ?? (achieved ? "" : summary);
  return {
    ...parsed,
    outcome,
    summary,
    blockers,
    targetKind: "goal",
    goalId: input.goalId,
    achieved,
    evidenceValid,
    objectiveSatisfied,
    remainingWork,
  };
}

export function parseReviewerVerdict(text: string): ReviewVerdict {
  return normalizeReviewerVerdictObject(parseJsonObjectFromText(text));
}

function normalizeReviewerVerdictObject(value: Record<string, unknown>): ReviewVerdict {
  const outcome = normalizeReviewOutcome(value.outcome);
  return {
    outcome,
    summary: stringField(value, "summary") ?? defaultReviewSummary(outcome),
    findings: stringArrayField(value, "findings"),
    blockers: stringArrayField(value, "blockers"),
    confidence: normalizeReviewConfidence(value.confidence),
  };
}

function reviewerGateAllowedTools(allowedTools: string[] | undefined): string[] {
  const candidates = allowedTools?.length ? allowedTools : Array.from(REVIEWER_LOW_COST_READ_TOOLS);
  return candidates.filter(
    (tool) =>
      REVIEWER_LOW_COST_READ_TOOLS.has(tool) &&
      !REVIEWER_FORBIDDEN_TOOLS.has(tool) &&
      !REVIEWER_EXECUTION_TOOLS.has(tool),
  );
}

function reviewerTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[REVIEWER_TIMEOUT_MS_ENV]?.trim();
  if (!raw) return DEFAULT_REVIEWER_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REVIEWER_TIMEOUT_MS;
  return Math.floor(parsed);
}

function roleRunRecord(
  result: RoleRunResult,
  fallbackStartedAt: string,
  fallbackFinishedAt: string,
): ReviewerRunRecord {
  return {
    runRef: result.record.ref as RunRef,
    roleRef: result.record.roleRef as RoleRef,
    runName: result.record.runName,
    startedAt: result.record.startedAt ?? fallbackStartedAt,
    finishedAt: result.record.finishedAt ?? fallbackFinishedAt,
    thinking: result.record.thinking,
    stdout: result.stdout,
    stderr: result.stderr,
    jsonEvents: result.jsonEvents,
  };
}

const RETRIABLE_FAILURE_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /overloaded/i,
  /empty response/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /network/i,
  /role run failed/i,
  /role run error/i,
];

function isRetriableReviewerFailure(result: ReviewerRunResult): boolean {
  if (result.verdict.outcome !== "blocked") return false;
  const reason = result.verdict.summary;
  return RETRIABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(reason));
}

function isRetriableAskFailure(result: AskAutoAnswerResult): boolean {
  if (!result.blocked || !result.reason) return false;
  return RETRIABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(result.reason!));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function failedReviewerRunVerdict(input: ReviewInput, reason: string): ReviewerVerdict {
  const base: ReviewVerdict = {
    outcome: "blocked",
    summary: reason,
    findings: [],
    blockers: [reason],
    confidence: "low",
  };
  if (input.targetKind === "task")
    return { ...base, targetKind: "task", taskRef: input.task.ref, approved: false };
  return {
    ...base,
    targetKind: "goal",
    goalId: input.goalId,
    achieved: false,
    remainingWork: reason,
  };
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactTaskForReview(task: Task): Record<string, unknown> {
  return {
    ref: task.ref,
    name: task.name,
    title: task.title,
    description: task.description,
    status: task.status,
    kind: task.kind,
    plan: task.plan,
    outputArtifacts: task.outputArtifacts,
  };
}

function parseJsonObjectFromText(
  text: string,
  options: { requireReviewerVerdict?: boolean } = {},
): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("reviewer verdict must be non-empty JSON");
  let fallback: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      fallback = parsed;
      const verdict = findReviewerVerdictRecord(parsed);
      if (verdict) return verdict;
    }
  } catch {
    // Fall through to JSON-object extraction for role output wrappers.
  }
  for (const objectText of extractJsonObjects(trimmed)) {
    try {
      const parsed = JSON.parse(objectText);
      if (!isRecord(parsed)) continue;
      fallback ??= parsed;
      const verdict = findReviewerVerdictRecord(parsed);
      if (verdict) return verdict;
    } catch {
      // Keep scanning later objects; role stdout can contain protocol JSON and text fragments.
    }
  }
  if (fallback) {
    if (options.requireReviewerVerdict)
      throw new Error("reviewer output did not contain a verdict JSON object with outcome");
    return fallback;
  }
  throw new Error("reviewer verdict must be a JSON object");
}

function findReviewerVerdictRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof record.outcome === "string") return record;
  for (const text of reviewerVerdictTextCandidates(record)) {
    const found = findReviewerVerdictRecordInText(text);
    if (found) return found;
  }
  return undefined;
}

function findReviewerVerdictRecordInText(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const found = findReviewerVerdictRecord(parsed);
      if (found) return found;
    }
  } catch {
    // Continue with object extraction below.
  }
  for (const objectText of extractJsonObjects(trimmed)) {
    try {
      const parsed = JSON.parse(objectText);
      if (!isRecord(parsed)) continue;
      const found = findReviewerVerdictRecord(parsed);
      if (found) return found;
    } catch {
      // Keep scanning; assistant content can include prose plus JSON.
    }
  }
  return undefined;
}

function reviewerVerdictTextCandidates(record: Record<string, unknown>): string[] {
  return [
    assistantMessageText(record.message),
    ...eventMessages(record).map(assistantMessageText),
    assistantMessageText(record.assistantMessageEvent),
  ].filter((value): value is string => Boolean(value));
}

function eventMessages(record: Record<string, unknown>): unknown[] {
  return Array.isArray(record.messages) ? record.messages : [];
}

function assistantMessageText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const role = message.role;
  if (role !== undefined && role !== "assistant") return undefined;
  return messageContentText(message.content) ?? stringField(message, "text");
}

function messageContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => {
      if (!isRecord(block)) return "";
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("")
    .trim();
  return text || undefined;
}

function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start < 0) break;
    const end = findJsonObjectEnd(text, start);
    if (end === undefined) {
      searchFrom = start + 1;
      continue;
    }
    objects.push(text.slice(start, end + 1));
    searchFrom = end + 1;
  }
  return objects;
}

function findJsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function normalizeReviewOutcome(value: unknown): ReviewVerdictOutcome {
  if (value === "approved" || value === "needs_changes" || value === "blocked") return value;
  if (typeof value === "string") {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/gu, "_");
    if (["approve", "approved", "accept", "accepted", "pass", "passed"].includes(normalized))
      return "approved";
    if (
      [
        "change_requested",
        "changes_requested",
        "need_changes",
        "needs_change",
        "needs_changes",
        "not_approved",
        "not_met",
        "not_ready",
        "reject",
        "rejected",
        "revise",
        "revision_required",
      ].includes(normalized)
    )
      return "needs_changes";
    if (["block", "blocked", "blocking"].includes(normalized)) return "blocked";
  }
  throw new Error(
    `reviewer verdict outcome must be approved, needs_changes, or blocked; got ${JSON.stringify(
      value,
    )}`,
  );
}

function normalizeReviewConfidence(value: unknown): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function defaultReviewSummary(outcome: ReviewVerdictOutcome): string {
  if (outcome === "approved") return "review approved";
  if (outcome === "needs_changes") return "review needs changes";
  return "review blocked";
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayField(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function parseBooleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === "boolean" ? value : undefined;
}

function parseBooleanAliasField(
  record: Record<string, unknown>,
  ...fields: string[]
): boolean | undefined {
  for (const field of fields) {
    const value = parseBooleanField(record, field);
    if (value !== undefined) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function reviewerInputFingerprint(input: ReviewInput): string {
  return createHash("sha256").update(renderReviewerInstruction(input)).digest("hex");
}
