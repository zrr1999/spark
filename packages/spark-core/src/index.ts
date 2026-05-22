import { randomUUID, createHash } from "node:crypto";

export type RefKind =
  | "spark"
  | "thread"
  | "task"
  | "role"
  | "artifact"
  | "run"
  | "review"
  | "ask"
  | "cue-job";

export type Ref<K extends RefKind> = `${K}:${string}` & { readonly __kind?: K };

export type SparkRef = Ref<"spark">;
export type ThreadRef = Ref<"thread">;
export type TaskRef = Ref<"task">;
export type RoleRef = Ref<"role">;
export type ArtifactRef = Ref<"artifact">;
export type RunRef = Ref<"run">;
export type ReviewRef = Ref<"review">;
export type AskRef = Ref<"ask">;
export type CueJobRef = Ref<"cue-job">;

export type AnyRef =
  | SparkRef
  | ThreadRef
  | TaskRef
  | RoleRef
  | ArtifactRef
  | RunRef
  | ReviewRef
  | AskRef
  | CueJobRef;

export type SparkErrorCode =
  | "INVALID_REF"
  | "VALIDATION_ERROR"
  | "DEPENDENCY_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "POLICY_VIOLATION"
  | "RUNNER_ERROR";

export class SparkError extends Error {
  readonly code: SparkErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: SparkErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SparkError";
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends SparkError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class DependencyError extends SparkError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("DEPENDENCY_ERROR", message, details);
    this.name = "DependencyError";
  }
}

export class NotFoundError extends SparkError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export function newRef<K extends RefKind>(kind: K, id: string = randomUUID()): Ref<K> {
  if (!id || id.includes(":")) throw new SparkError("INVALID_REF", `invalid ${kind} id: ${id}`);
  return `${kind}:${id}` as Ref<K>;
}

export function refKind(ref: string): RefKind {
  const [kind] = ref.split(":", 1);
  if (!isRefKind(kind)) throw new SparkError("INVALID_REF", `unknown ref kind: ${ref}`);
  return kind;
}

export function refId(ref: AnyRef | string): string {
  const index = ref.indexOf(":");
  if (index < 0) throw new SparkError("INVALID_REF", `invalid ref: ${ref}`);
  return ref.slice(index + 1);
}

export function isRefKind(value: string): value is RefKind {
  return [
    "spark",
    "thread",
    "task",
    "role",
    "agent",
    "artifact",
    "run",
    "review",
    "ask",
    "cue-job",
  ].includes(value);
}

export function isRef<K extends RefKind>(value: string, kind?: K): value is Ref<K> {
  const index = value.indexOf(":");
  if (index < 1 || index === value.length - 1) return false;
  const actual = value.slice(0, index);
  return isRefKind(actual) && (!kind || actual === kind);
}

export function assertRef<K extends RefKind>(value: string, kind: K): Ref<K> {
  if (!isRef(value, kind)) throw new SparkError("INVALID_REF", `expected ${kind} ref`, { value });
  return value;
}

export function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function contentHash(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PackageCapability {
  packageName: string;
  version?: string;
  provides: Array<"spark" | "core" | "artifacts" | "ask" | "cue" | "roles" | "review" | "tasks">;
  tools?: string[];
  commands?: string[];
}

export interface Provenance {
  producer: "spark" | "role" | "task" | "review" | "ask" | "cue" | "user";
  runRef?: RunRef;
  threadRef?: ThreadRef;
  taskRef?: TaskRef;
  roleRef?: RoleRef;
  parentArtifactRefs?: ArtifactRef[];
  note?: string;
}

export type ArtifactKind =
  | "spark-md"
  | "research"
  | "plan"
  | "task-breakdown"
  | "role-plan"
  | "handoff"
  | "review"
  | "cue-output"
  | "role-run"
  | "role-spec-proposal"
  | "ask-answer"
  | "run-trace";

export type ArtifactFormat = "markdown" | "json" | "text";

export interface Artifact<T extends JsonValue | string = JsonValue | string> {
  ref: ArtifactRef;
  kind: ArtifactKind;
  title: string;
  format: ArtifactFormat;
  body: T;
  hash?: string;
  blobPath?: string;
  links: ArtifactLink[];
  provenance: Provenance;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactLink {
  from: ArtifactRef;
  to: ArtifactRef | ThreadRef | TaskRef | RoleRef | RunRef | ReviewRef | AskRef | CueJobRef;
  relation: "parent" | "input" | "output" | "review-of" | "answer-to" | "trace-of" | "derived-from";
}

export type TaskStatus =
  | "proposed"
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";
export type TaskKind =
  | "research"
  | "plan"
  | "implement"
  | "review"
  | "ask"
  | "cue"
  | "interaction"
  | "generic";
export type TaskTodoStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked"
  | "cancelled"
  | "deleted";

/** Durable TODO item shape. TODOs are stored separately from Task snapshots. */
export interface TaskTodo {
  id: string;
  taskRef: TaskRef;
  content: string;
  status: TaskTodoStatus;
  notes?: string[];
  blockedBy?: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export type ThreadStatus = "active" | "done";

export interface Thread {
  ref: ThreadRef;
  title: string;
  description: string;
  status: ThreadStatus;
  outputLanguage?: "zh" | "en";
  currentTaskRef?: TaskRef;
  createdAt: string;
  updatedAt: string;
}

export type TaskClaimKind = "main" | "role-run";

export interface TaskClaim {
  kind: TaskClaimKind;
  claimedBy: string;
  roleRef?: RoleRef;
  /** Human-readable name for the concrete running role instance. */
  runName?: string;
  sessionId?: string;
  runRef?: RunRef;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface TaskAttribution {
  /** Session/main actor identity. Role runs are rendered as sessionId/runName. */
  sessionId?: string;
  /** Concrete role spec used for this completion, when completed by a role run. */
  roleRef?: RoleRef;
  /** Concrete role-run name. Main-session completions should leave this unset. */
  runName?: string;
}

export interface TaskPlan {
  objective: string;
  contextRefs: string[];
  constraints: string[];
  nonGoals: string[];
  successCriteria: string[];
  evidenceRequired: string[];
  steps: string[];
  decompositionRationale?: string;
  riskLevel?: "trivial" | "normal" | "high";
  openQuestions: string[];
  askRefs: Array<AskRef | ArtifactRef>;
}

export type TaskPlanIssueKind =
  | "missing_plan"
  | "missing_objective"
  | "missing_success_criteria"
  | "missing_evidence_required"
  | "missing_steps"
  | "open_questions";

export interface TaskPlanIssue {
  kind: TaskPlanIssueKind;
  severity: "warning" | "blocking";
  message: string;
}

export interface TaskPlanReadiness {
  ready: boolean;
  issues: TaskPlanIssue[];
}

export interface Task {
  ref: TaskRef;
  threadRef: ThreadRef;
  /** Simple handle used in TUI/tool references, rendered as @name. */
  name: string;
  title: string;
  description: string;
  kind: TaskKind;
  status: TaskStatus;
  roleRef?: RoleRef;
  /** @deprecated use claim.sessionId / claim.claimedBy. */
  claimedBySession?: string;
  /** Last actor that finished this task after active claims are cleared. */
  finishedBy?: TaskAttribution;
  claim?: TaskClaim;
  inputArtifacts: ArtifactRef[];
  outputArtifacts: ArtifactRef[];
  plan?: TaskPlan;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDependency {
  taskRef: TaskRef;
  dependsOn: TaskRef;
}

export interface TaskProposal {
  threadRef: ThreadRef;
  title: string;
  description: string;
  kind: TaskKind;
  proposedRoleRef?: RoleRef;
  dependsOn?: TaskRef[];
  rationale: string;
}

export type TaskRunFailureKind = "runtime_timeout" | "runtime_error" | "claim_stale";

export interface TaskRun {
  ref: RunRef;
  threadRef: ThreadRef;
  taskRef: TaskRef;
  roleRef?: RoleRef;
  /** Human-readable name for this concrete role run; roleRef remains the reusable definition. */
  runName?: string;
  /** Session that owns this concrete role run, used for post-completion attribution. */
  ownerSessionId?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  failureKind?: TaskRunFailureKind;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  outputArtifacts: ArtifactRef[];
}

export type AskKind = "clarification" | "decision" | "approval" | "unblock";

export interface AskOption {
  id: string;
  label: string;
  description: string;
  preview?: string;
}

export interface AskRequest {
  ref: AskRef;
  kind: AskKind;
  question: string;
  options: AskOption[];
  multiSelect?: boolean;
  defaultOptionId?: string;
}

export interface AskAnswer {
  requestRef: AskRef;
  selectedOptionIds: string[];
  freeform?: string;
  answeredAt: string;
}

export type ReviewOutcome = "approved" | "needs_changes" | "blocked";
export type GatePolicy = "required" | "advisory" | "blocking";

export interface ReviewGate {
  ref: ReviewRef;
  subject: TaskRef | ArtifactRef | RoleRef;
  lens: "task-completion" | "artifact" | "role-spec" | "readiness";
  policy: GatePolicy;
  outcome: ReviewOutcome;
  summary: string;
  artifactRef?: ArtifactRef;
  createdAt: string;
}

export interface SparkRunTrace {
  ref: SparkRef;
  idea: string;
  threadRef?: ThreadRef;
  sparkMdArtifactRef?: ArtifactRef;
  taskRefs: TaskRef[];
  reviewRefs: ReviewRef[];
  askRefs: AskRef[];
  createdAt: string;
  updatedAt: string;
}

export function validateArtifact(artifact: Artifact): void {
  assertRef(artifact.ref, "artifact");
  assertNonEmpty(artifact.title, "artifact title");
  if (!["markdown", "json", "text"].includes(artifact.format)) {
    throw new ValidationError(`invalid artifact format: ${artifact.format}`);
  }
}

export function validateTask(task: Task): void {
  assertRef(task.ref, "task");
  assertRef(task.threadRef, "thread");
  assertNonEmpty(task.title, "task title");
  assertNonEmpty(task.description, "task description");
  if (task.roleRef) assertRef(task.roleRef, "role");
}

export function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new ValidationError(`${label} is required`);
}
