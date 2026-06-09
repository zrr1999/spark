import { createHash } from "node:crypto";
import { builtinRoleRef, runRole, type RoleRegistry, type RoleRunResult } from "pi-roles";
import {
  newRef,
  nowIso,
  type ArtifactRef,
  type ProjectRef,
  type RoleRef,
  type RunRef,
  type Task,
  type TaskRef,
} from "pi-extension-api";

export type ReviewTargetKind = "task" | "goal";
export type ReviewVerdictOutcome = "approved" | "needs_changes" | "blocked";

export interface TaskReviewInput {
  targetKind: "task";
  cwd: string;
  projectRef: ProjectRef;
  task: Task;
  requestedStatus: "done" | "failed" | "cancelled";
  summary?: string;
  evidenceRefs: ArtifactRef[];
  sessionKey?: string;
  forkFromSession?: string;
}

export interface GoalReviewInput {
  targetKind: "goal";
  cwd: string;
  projectRef?: ProjectRef;
  goalId: string;
  objective: string;
  status: "active" | "paused" | "complete";
  requestedStatus: "paused" | "complete";
  reason?: string;
  evidenceRefs: ArtifactRef[];
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
  remainingWork: string;
}

export type ReviewerVerdict = TaskReviewVerdict | GoalReviewVerdict;

export interface ReviewerRunRecord {
  runRef?: RunRef;
  roleRef: RoleRef;
  runName?: string;
  startedAt: string;
  finishedAt: string;
  stdout?: string;
  stderr?: string;
  jsonEvents?: unknown[];
}

export interface ReviewerRunResult {
  verdict: ReviewerVerdict;
  record: ReviewerRunRecord;
}

export interface ReviewerRunner {
  review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewerRunResult>;
}

export interface PiRolesReviewerRunnerOptions {
  registry: RoleRegistry;
  cwd: string;
  piCommand?: string;
  timeoutMs?: number;
  reviewerRoleRef?: RoleRef;
  model?: string;
  sessionDir?: string;
  now?: () => string;
}

const DEFAULT_REVIEWER_TIMEOUT_MS = 600_000;
const REVIEWER_JSON_SCHEMA = [
  "Return ONLY compact JSON with this shape:",
  "{",
  '  "outcome": "approved" | "needs_changes" | "blocked",',
  '  "summary": "one sentence",',
  '  "findings": ["actionable finding"],',
  '  "blockers": ["blocking issue"],',
  '  "confidence": "low" | "medium" | "high",',
  '  "achieved": true | false, // goal reviews only',
  '  "remainingWork": "what remains" // goal reviews only',
  "}",
].join("\n");

export class PiRolesReviewerRunner implements ReviewerRunner {
  readonly #registry: RoleRegistry;
  readonly #cwd: string;
  readonly #piCommand: string;
  readonly #timeoutMs: number;
  readonly #reviewerRoleRef: RoleRef;
  readonly #model?: string;
  readonly #sessionDir?: string;
  readonly #now: () => string;

  constructor(options: PiRolesReviewerRunnerOptions) {
    this.#registry = options.registry;
    this.#cwd = options.cwd;
    this.#piCommand = options.piCommand ?? "pi";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
    this.#reviewerRoleRef = options.reviewerRoleRef ?? builtinRoleRef("reviewer");
    this.#model = options.model;
    this.#sessionDir = options.sessionDir;
    this.#now = options.now ?? nowIso;
  }

  async review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewerRunResult> {
    const role = this.#registry.get(this.#reviewerRoleRef);
    const runRef = newRef("run");
    const startedAt = this.#now();
    const result = await runRole({
      runRef: runRef as `run:${string}`,
      roleRef: role.ref as `role:${string}`,
      systemPrompt: buildReadOnlyReviewerSystemPrompt(role.systemPrompt),
      model: this.#model,
      instruction: renderReviewerInstruction(input),
      runGuidance: REVIEWER_JSON_SCHEMA,
      mode: input.forkFromSession ? "forked" : "fresh",
      forkFromSession: input.forkFromSession,
      sessionDir: this.#sessionDir,
      piCommand: this.#piCommand,
      cwd: input.cwd || this.#cwd,
      timeoutMs: this.#timeoutMs,
      signal,
    });
    const finishedAt = result.record.finishedAt ?? this.#now();
    if (result.record.status !== "succeeded")
      return {
        verdict: failedReviewerRunVerdict(input, `reviewer role run ${result.record.status}`),
        record: roleRunRecord(result, startedAt, finishedAt),
      };
    return {
      verdict: parseReviewerVerdictForInput(input, result.stdout),
      record: roleRunRecord(result, startedAt, finishedAt),
    };
  }
}

export function buildReadOnlyReviewerSystemPrompt(basePrompt: string): string {
  return [
    basePrompt.trim(),
    "",
    "Spark reviewer gate constraints:",
    "- Read-only verdict role: inspect the provided state/evidence only.",
    "- Do not mutate tasks, goals, files, artifacts, recall, learning, asks, or project state.",
    "- Do not call task.finish, task.plan, task.claim, goal update, file edit, write, memory, recall, or learning mutation tools.",
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
          sessionKey: input.sessionKey,
        }
      : {
          targetKind: input.targetKind,
          projectRef: input.projectRef,
          goalId: input.goalId,
          objective: input.objective,
          status: input.status,
          requestedStatus: input.requestedStatus,
          reason: input.reason,
          evidenceRefs: input.evidenceRefs,
          sessionKey: input.sessionKey,
        };
  return [
    "Review this Spark state transition request.",
    "Approve only if the provided evidence and current packet satisfy the requested state transition.",
    "For requestedStatus=complete, approve only when the objective is achieved; set achieved accordingly.",
    "For requestedStatus=paused, approve only when the pause reason is valid and stopping without completion is appropriate; do not require achieved=true.",
    "If work remains or the requested transition is not justified, use outcome=needs_changes and list concrete blockers/findings.",
    REVIEWER_JSON_SCHEMA,
    "",
    "Review packet:",
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

export function parseReviewerVerdictForInput(input: ReviewInput, text: string): ReviewerVerdict {
  const value = parseJsonObjectFromText(text);
  const parsed = normalizeReviewerVerdictObject(value);
  if (input.targetKind === "task")
    return {
      ...parsed,
      targetKind: "task",
      taskRef: input.task.ref,
      approved: parsed.outcome === "approved",
    };
  const achieved =
    input.requestedStatus === "complete" &&
    parsed.outcome === "approved" &&
    (parseBooleanField(value, "achieved") ?? true);
  const remainingWork = stringField(value, "remainingWork") ?? (achieved ? "" : parsed.summary);
  return {
    ...parsed,
    targetKind: "goal",
    goalId: input.goalId,
    achieved,
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
    stdout: result.stdout,
    stderr: result.stderr,
    jsonEvents: result.jsonEvents,
  };
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

function parseJsonObjectFromText(text: string): Record<string, unknown> {
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
  if (fallback) return fallback;
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
  throw new Error("reviewer verdict outcome must be approved, needs_changes, or blocked");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function reviewerInputFingerprint(input: ReviewInput): string {
  return createHash("sha256").update(renderReviewerInstruction(input)).digest("hex");
}
