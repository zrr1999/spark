import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * pi-extension-api — shared contract and generic primitive surface.
 *
 * This package centralises the ExtensionAPI shape that Pi extensions in this
 * workspace speak to. Both the upstream pi-coding-agent runtime and the Spark TUI native
 * pi-tui host implement (a superset of) this surface; extensions stay
 * portable as long as they only depend on the names exported from here.
 *
 * Runtime impact: intentionally tiny. Besides type declarations, this package
 * exposes dependency-light generic helpers for refs, stable IDs, JSON file IO,
 * and copy-language detection that used to live in spark-core.
 *
 * Design rules:
 *   - Every method is `optional` so extensions must guard each call. This lets
 *     a host implement only the slice it cares about while still satisfying the
 *     contract (e.g. a roles-only host might omit `registerTool`).
 *   - ExtensionContext is a union of capabilities observed across pi-coding-agent
 *     and spark-cli; consumers should only read what they need.
 *   - Adding a method here is a contract change. Update both hosts and the
 *     ExtensionAPI contract tests in the same change set.
 */

export interface ExtensionAPI {
  registerCommand?(name: string, config: CommandConfig): void;
  registerTool?(config: ToolConfig): void;
  registerShortcut?(shortcut: string, options: ShortcutConfig): void;
  on?(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
  /** Names of the tools currently active for the agent (a subset of getAllTools). */
  getActiveTools?(): string[];
  /** All configured tools, including ones that are currently inactive. */
  getAllTools?(): ToolInfo[];
  setActiveTools?(names: string[]): void;
  sendMessage?(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
  sendUserMessage?(
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp" | "nextTurn";
      streamingBehavior?: "steer" | "followUp";
    },
  ): void;
}

export interface CommandConfig {
  description: string;
  argumentHint?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) =>
    | Array<{ value: string; label: string; description?: string }>
    | null
    | Promise<Array<{ value: string; label: string; description?: string }> | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

export interface ShortcutConfig {
  description?: string;
  handler: (ctx: ExtensionContext) => unknown;
  isActive?: (ctx: ExtensionContext) => boolean;
}

export interface ToolConfig {
  name: string;
  label?: string;
  description: string;
  promptGuidelines?: string[];
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolRenderTheme,
    context: unknown,
  ) => ToolRenderComponent;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: ExtensionContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

export interface ToolRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface ToolRenderComponent {
  render(width: number): string[];
}

export interface ToolInfo {
  name: string;
}

export type ExtensionUiNotifyLevel = "info" | "warning" | "error" | "success";

export interface ExtensionInteractionRequest {
  kind: string;
  requestId: string;
  title: string;
  version?: string | number;
  prompt?: string;
  createdAt?: string;
  source?: "tui" | "web" | "daemon" | "extension" | "runtime" | "test" | (string & {});
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ExtensionInteractionResponse {
  kind: string;
  requestId: string;
  status: "answered" | "cancelled" | "blocked" | "error" | (string & {});
  message?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ExtensionUi {
  notify?: (message: string, level?: ExtensionUiNotifyLevel) => void;
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  selectWithCustom?: (
    title: string,
    input: { options: string[]; customLabel: string },
  ) => Promise<{ value?: string; customText?: string } | string | undefined>;
  /**
   * Protocol-shaped interaction bridge for host-rendered UI. Spark hosts pass
   * Spark interaction protocol payloads here; portable extensions should keep
   * requests structural and fall back to legacy primitives when a host returns
   * `blocked` or omits the hook.
   */
  interaction?: (request: ExtensionInteractionRequest) => Promise<ExtensionInteractionResponse>;
  setStatus?: (key: string, text: string | undefined) => void;
  setWidget?: (
    key: string,
    callback: unknown,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ) => void;
  setTitle?: (title: string) => void;
  custom?: (...args: unknown[]) => unknown;
}

export interface SessionModelRef {
  provider: string;
  id: string;
  api?: string;
}

export interface ExtensionContext {
  cwd?: string;
  model?: SessionModelRef;
  hasUI?: boolean;
  ui?: ExtensionUi;
  isIdle?: () => boolean;
}

export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle?: () => Promise<void>;
  sendUserMessage?: (content: string) => Promise<void>;
}

export type RefKind =
  | "spark"
  | "proj"
  | "task"
  | "role"
  | "artifact"
  | "run"
  | "review"
  | "ask"
  | "cue-job";

export type Ref<K extends RefKind> = `${K}:${string}` & { readonly __kind?: K };

export type SparkRef = Ref<"spark">;
export type ProjectRef = Ref<"proj">;
export type TaskRef = Ref<"task">;
export type RoleRef = Ref<"role">;
export type ArtifactRef = Ref<"artifact">;
export type RunRef = Ref<"run">;
export type ReviewRef = Ref<"review">;
export type AskRef = Ref<"ask">;
export type CueJobRef = Ref<"cue-job">;

export type AnyRef =
  | SparkRef
  | ProjectRef
  | TaskRef
  | RoleRef
  | ArtifactRef
  | RunRef
  | ReviewRef
  | AskRef
  | CueJobRef;

export type PiErrorCode =
  | "INVALID_REF"
  | "VALIDATION_ERROR"
  | "DEPENDENCY_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "POLICY_VIOLATION"
  | "RUNNER_ERROR";

export class PiError extends Error {
  readonly code: PiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PiError";
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends PiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class DependencyError extends PiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("DEPENDENCY_ERROR", message, details);
    this.name = "DependencyError";
  }
}

export class NotFoundError extends PiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export const DEFAULT_READY_TASK_MAX_CONCURRENCY = 4;
export const DEFAULT_READY_TASK_TIMEOUT_MS = 3_600_000;

export function newRef<K extends RefKind>(kind: K, id: string = randomUUID()): Ref<K> {
  if (!id || id.includes(":")) throw new PiError("INVALID_REF", `invalid ${kind} id: ${id}`);
  return `${kind}:${id}` as Ref<K>;
}

export function refKind(ref: string): RefKind {
  const [kind] = ref.split(":", 1);
  if (!isRefKind(kind)) throw new PiError("INVALID_REF", `unknown ref kind: ${ref}`);
  return kind;
}

export function refId(ref: AnyRef | string): string {
  const index = ref.indexOf(":");
  if (index < 0) throw new PiError("INVALID_REF", `invalid ref: ${ref}`);
  return ref.slice(index + 1);
}

export function isRefKind(value: string): value is RefKind {
  return ["spark", "proj", "task", "role", "artifact", "run", "review", "ask", "cue-job"].includes(
    value,
  );
}

export function isRef<K extends RefKind>(value: string, kind?: K): value is Ref<K> {
  const index = value.indexOf(":");
  if (index < 1 || index === value.length - 1) return false;
  const actual = value.slice(0, index);
  return isRefKind(actual) && (!kind || actual === kind);
}

export function assertRef<K extends RefKind>(value: string, kind: K): Ref<K> {
  if (!isRef(value, kind)) throw new PiError("INVALID_REF", `expected ${kind} ref`, { value });
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

export type CopyLanguage = "en" | "zh";

export function detectCopyLanguage(text: string): CopyLanguage {
  return /[\u4e00-\u9fff]/u.test(text) ? "zh" : "en";
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonFileFormatErrorFactory = (filePath: string, message: string) => Error;

export function parseJsonFileText(
  text: string,
  filePath: string,
  createFormatError: JsonFileFormatErrorFactory,
): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw createFormatError(
      filePath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function readJsonFileOptional(
  filePath: string,
  createFormatError: JsonFileFormatErrorFactory,
): Promise<unknown> {
  try {
    return parseJsonFileText(await readFile(filePath, "utf8"), filePath, createFormatError);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

export async function readJsonFileRequired(
  filePath: string,
  createFormatError: JsonFileFormatErrorFactory,
): Promise<unknown> {
  return parseJsonFileText(await readFile(filePath, "utf8"), filePath, createFormatError);
}

export function formatJsonFile(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new ValidationError("JSON file value must be serializable");
  return `${text}\n`;
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, formatJsonFile(value));
}

export async function writeTextFileAtomic(filePath: string, text: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await cleanupAtomicWriteTempFile(tempPath, error);
    throw error;
  }
}

async function cleanupAtomicWriteTempFile(tempPath: string, writeError: unknown): Promise<void> {
  try {
    await rm(tempPath, { force: true });
  } catch (cleanupError) {
    throw new Error(
      `atomic write failed and temporary file cleanup also failed: ${tempPath}; write error: ${unknownErrorMessage(writeError)}; cleanup error: ${unknownErrorMessage(cleanupError)}`,
    );
  }
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isFileNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

export type TaskStatus =
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

export type RoadmapRef = `roadmap:${string}`;
export type RoadmapItemRef = `roadmap-item:${string}`;

/** One roadmap owned by a single Project; items link to tasks only (no cross-project refs). */
export interface ProjectRoadmap {
  ref: RoadmapRef;
  title: string;
  status?: "active" | "done";
  activeItemRef?: RoadmapItemRef;
  items: RoadmapItem[];
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapItem {
  ref: RoadmapItemRef;
  title?: string;
  status?: "active" | "pending" | "blocked" | "done";
  objective: string;
  scope?: string | string[];
  constraints?: string[];
  successCriteria?: string[];
  acceptance?: string[];
  evidenceRequired?: string[];
  evidenceRefs?: string[];
  openQuestions?: string[];
  askRefs?: Array<AskRef | ArtifactRef | string>;
  taskRefs?: TaskRef[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Project {
  ref: ProjectRef;
  title: string;
  description: string;
  /** Durable project purpose; distinct from session goal pursuit. */
  purpose?: string;
  outputLanguage?: "zh" | "en";
  currentTaskRef?: TaskRef;
  roadmap: ProjectRoadmap;
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
  /** Session/main actor identity. Child runs are rendered as sessionId/runName. */
  sessionId?: string;
  /** Role spec attribution for hosts that execute tasks through reusable role specs. */
  roleRef?: RoleRef;
  /** Concrete child run name. Main-session completions should leave this unset. */
  runName?: string;
}

export interface TaskCancellation {
  at: string;
  by?: string;
  reason?: string;
}

export type TaskPlanItemStatus = TaskTodoStatus;

export interface TaskPlanItem {
  id: string;
  title: string;
  description?: string;
  status: TaskPlanItemStatus;
  notes?: string[];
  blockedBy?: string[];
  evidenceRefs?: ArtifactRef[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface TaskPlan {
  objective: string;
  contextRefs: string[];
  constraints: string[];
  nonGoals: string[];
  successCriteria: string[];
  evidenceRequired: string[];
  /** Active task progress truth. */
  items?: TaskPlanItem[];
  /** Legacy/import-only execution-step input retained for old snapshots and callers. */
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

export type TaskCompletionIssueKind = "missing_completion_evidence" | "open_plan_items";

export interface TaskPlanIssue {
  kind: TaskPlanIssueKind;
  severity: "warning" | "blocking";
  message: string;
  remediation: string;
}

export interface TaskPlanReadiness {
  ready: boolean;
  issues: TaskPlanIssue[];
}

export interface TaskCompletionIssue {
  kind: TaskCompletionIssueKind;
  severity: "warning" | "blocking";
  message: string;
  evidenceRequired?: string[];
  openItems?: string[];
}

export interface TaskCompletionReadiness {
  ready: boolean;
  issues: TaskCompletionIssue[];
}

export interface Task {
  ref: TaskRef;
  projectRef: ProjectRef;
  /** Simple handle used in TUI/tool references, rendered as @name. */
  name: string;
  title: string;
  description: string;
  kind: TaskKind;
  status: TaskStatus;
  roleRef?: RoleRef;
  /** Last actor that finished this task after active claims are cleared. */
  finishedBy?: TaskAttribution;
  /** Cancellation metadata when status is cancelled. */
  cancellation?: TaskCancellation;
  /** Replacement task refs that supersede this task, matching learning supersededBy shape. */
  supersededBy: TaskRef[];
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
  projectRef: ProjectRef;
  title: string;
  description: string;
  kind: TaskKind;
  proposedRoleRef?: RoleRef;
  dependsOn?: TaskRef[];
  rationale: string;
}

export type TaskRunFailureKind = "runtime_timeout" | "runtime_error" | "claim_stale";
export type TaskRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskRunCompletionSummary {
  runRef: RunRef;
  taskRef: TaskRef;
  roleRef?: RoleRef;
  runName?: string;
  status: TaskRunStatus;
  summary: string;
  artifactRefs: ArtifactRef[];
  createdAt: string;
}

export interface TaskRun {
  ref: RunRef;
  projectRef: ProjectRef;
  taskRef: TaskRef;
  roleRef?: RoleRef;
  /** Human-readable name for this concrete child run. */
  runName?: string;
  /** Session that owns this concrete child run, used for post-completion attribution. */
  ownerSessionId?: string;
  status: TaskRunStatus;
  failureKind?: TaskRunFailureKind;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  outputArtifacts: ArtifactRef[];
  completionSummary?: TaskRunCompletionSummary;
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
  projectRef?: ProjectRef;
  sparkMdArtifactRef?: ArtifactRef;
  taskRefs: TaskRef[];
  reviewRefs: ReviewRef[];
  askRefs: AskRef[];
  createdAt: string;
  updatedAt: string;
}

export function validateTask(task: Task): void {
  assertRef(task.ref, "task");
  assertRef(task.projectRef, "proj");
  assertNonEmpty(task.title, "task title");
  assertNonEmpty(task.description, "task description");
  if (task.roleRef) assertRef(task.roleRef, "role");
  for (const ref of task.supersededBy) assertRef(ref, "task");
  if (task.cancellation && !task.cancellation.at.trim()) {
    throw new ValidationError("task cancellation at is required");
  }
}

export function assertNonEmpty(value: unknown, label: string): void {
  if (typeof value !== "string") throw new ValidationError(`${label} must be a string`);
  if (!value.trim()) throw new ValidationError(`${label} is required`);
}
