import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * spark-core — Spark host contract + lightweight primitives.
 *
 * This package centralises the SparkHostAPI shape that Spark extension hosts
 * and retained Pi-compatible adapters in this workspace speak to. Both the
 * upstream pi-coding-agent runtime and the Spark native host family implement
 * (a superset of) this surface; extensions stay portable as long as they only
 * depend on the names exported from here.
 *
 * Runtime impact: intentionally tiny. Besides type declarations, this package
 * exposes dependency-light generic helpers for refs, stable IDs, JSON file IO,
 * and copy-language detection. This is not a revival of the retired spark-core
 * capability bag — only the host contract and those small primitives live here.
 *
 * Design rules:
 *   - Every method is `optional` so extensions must guard each call. This lets
 *     a host implement only the slice it cares about while still satisfying the
 *     contract (e.g. a roles-only host might omit `registerTool`).
 *   - SparkHostContext is a union of capabilities observed across pi-coding-agent
 *     and Spark native hosts; consumers should only read what they need.
 *   - Adding a method here is a contract change. Update both hosts and the
 *     SparkHostAPI contract tests in the same change set.
 */

export interface SparkHostAPI {
  registerCommand?(name: string, config: CommandConfig): void;
  registerTool?(config: ToolConfig): void;
  registerShortcut?(shortcut: string, options: ShortcutConfig): void;
  on?(
    event: string,
    handler: (event: unknown, ctx: SparkHostContext) => unknown,
    options?: SparkHostHookOptions,
  ): void;
  /** Names of the tools currently active for the agent (a subset of getAllTools). */
  getActiveTools?(): string[];
  /** All configured tools, including ones that are currently inactive. */
  getAllTools?(): ToolInfo[];
  setActiveTools?(names: string[]): void;
  sendMessage?(
    message: SparkHostRuntimeMessage,
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

/**
 * Authority carried by extension-originated runtime messages. The safe default
 * is runtime data; only repo-owned control paths should opt into trusted
 * runtime control explicitly.
 */
export type SparkHostRuntimeMessageAuthority = "runtime_control" | "runtime_data";
export type SparkHostRuntimeMessageTrust = "trusted" | "untrusted";

export interface SparkHostRuntimeMessage {
  customType: string;
  /** Stable producer-supplied identity used for idempotent outbox delivery. */
  deliveryId?: string;
  content: string;
  display?: boolean;
  details?: Record<string, unknown>;
  authority?: SparkHostRuntimeMessageAuthority;
  trust?: SparkHostRuntimeMessageTrust;
}

export type CommandSource = "system" | "extension" | (string & {});
export type CommandPlane = "daemon" | "server" | "tui" | "system" | (string & {});

export interface CommandMetadata {
  source?: CommandSource;
  extensionId?: string;
  plane?: CommandPlane;
  resource?: string;
  verbs?: string[];
  canonicalCliTarget?: string;
  deprecatedAliasFor?: string;
}

export interface CommandConfig {
  description: string;
  argumentHint?: string;
  metadata?: CommandMetadata;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) =>
    | Array<{ value: string; label: string; description?: string }>
    | null
    | Promise<Array<{ value: string; label: string; description?: string }> | null>;
  handler: (args: string, ctx: SparkHostCommandContext) => void | Promise<void>;
}

export interface ShortcutConfig {
  description?: string;
  handler: (ctx: SparkHostContext) => unknown;
  isActive?: (ctx: SparkHostContext) => boolean;
}

/** Observable side-effect class used by Spark host execution policy. */
export type ToolEffect = "read" | "local_write" | "external_write" | "destructive";

/**
 * Static effect declaration for an extension lifecycle hook. A host with an
 * effect allowlist dispatches a hook only when every declared effect is
 * allowed. Omit this on a hook whose effects cannot be proven; restricted
 * hosts deliberately treat an omitted or malformed declaration as unknown.
 */
export interface SparkHostHookOptions {
  effects?: readonly ToolEffect[];
}

/** Pi-compatible per-tool sibling-call execution mode. */
export type ToolExecutionMode = "sequential" | "parallel";

/** Static approval requirement declared by the tool owner. */
export type ToolApprovalPolicy = "none" | "required";

/**
 * Declarative tool policy owned by the package that implements the tool.
 * Domain and phase values are intentionally opaque strings: the shared
 * extension contract carries policy data but does not own product routing.
 */
export interface ToolPolicy {
  readonly effect?: ToolEffect;
  readonly executionMode?: ToolExecutionMode;
  readonly domains?: readonly string[];
  readonly phases?: readonly string[];
  readonly approval?: ToolApprovalPolicy;
}

export type ResolvedToolEffect = ToolEffect | "unknown";

/** Normalized, immutable policy snapshot exposed by Spark hosts. */
export interface ResolvedToolPolicy {
  readonly effect: ResolvedToolEffect;
  readonly executionMode: ToolExecutionMode;
  readonly domains: readonly string[];
  readonly phases: readonly string[];
  readonly approval: ToolApprovalPolicy;
}

export interface ToolConfig {
  name: string;
  label?: string;
  description: string;
  promptGuidelines?: string[];
  parameters: unknown;
  /** Canonical composable policy declaration for Spark hosts. */
  policy?: ToolPolicy;
  /**
   * Side-effect classification owned by the tool implementation. Hosts must
   * treat an omitted value as unknown, never infer it from the tool name.
   * @deprecated Declare `policy.effect`; retained for Pi and existing tools.
   */
  effect?: ToolEffect;
  /**
   * Whether sibling calls may execute concurrently. Spark only honors
   * `parallel` for tools also classified as `effect: "read"`; omitted values
   * fail closed to sequential execution. This field matches Pi's tool contract.
   * @deprecated Declare `policy.executionMode`; retained for Pi compatibility.
   */
  executionMode?: ToolExecutionMode;
  /**
   * When true, the host turn loop must satisfy the session `approvalMethod`
   * (`skip` | `human` | `auto`) before executing this tool.
   * @deprecated Declare `policy.approval`; retained for existing hosts.
   */
  requiresApproval?: boolean;
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
    ctx: SparkHostContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

/**
 * Resolve canonical and legacy declarations into one fail-closed snapshot.
 * Missing legacy approval remains `none` for backwards compatibility, while
 * malformed values or conflicting declarations never grant concurrency or
 * suppress approval.
 */
export function resolveToolPolicy(config: ToolConfig): ResolvedToolPolicy {
  const policyValue: unknown = config.policy;
  const policy = isRecord(policyValue) ? policyValue : undefined;
  const malformedPolicy =
    (policyValue !== undefined && !policy) ||
    !isOptionalToolEffect(policy?.effect) ||
    !isOptionalToolEffect(config.effect) ||
    declarationsConflict(policy?.effect, config.effect) ||
    !isOptionalToolExecutionMode(policy?.executionMode) ||
    !isOptionalToolExecutionMode(config.executionMode) ||
    declarationsConflict(policy?.executionMode, config.executionMode) ||
    !isOptionalToolApproval(policy?.approval) ||
    (config.requiresApproval !== undefined && typeof config.requiresApproval !== "boolean") ||
    !isOptionalPolicyLabels(policy?.domains) ||
    !isOptionalPolicyLabels(policy?.phases);

  const canonicalEffect = policy?.effect;
  const legacyEffect: unknown = config.effect;
  const effect = resolveToolEffect(canonicalEffect, legacyEffect, malformedPolicy);

  const approval = resolveToolApproval(policy?.approval, config.requiresApproval, malformedPolicy);
  const requestedExecutionMode = resolveToolExecutionMode(
    policy?.executionMode,
    config.executionMode,
    malformedPolicy,
  );
  const executionMode =
    requestedExecutionMode === "parallel" && effect === "read" && approval === "none"
      ? "parallel"
      : "sequential";

  return Object.freeze({
    effect,
    executionMode,
    domains: Object.freeze(normalizePolicyLabels(policy?.domains)),
    phases: Object.freeze(normalizePolicyLabels(policy?.phases)),
    approval,
  });
}

function resolveToolEffect(
  canonical: unknown,
  legacy: unknown,
  malformedPolicy: boolean,
): ResolvedToolEffect {
  if (malformedPolicy || !isOptionalToolEffect(canonical) || !isOptionalToolEffect(legacy)) {
    return "unknown";
  }
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) return "unknown";
  return canonical ?? legacy ?? "unknown";
}

function resolveToolExecutionMode(
  canonical: unknown,
  legacy: unknown,
  malformedPolicy: boolean,
): ToolExecutionMode {
  if (
    malformedPolicy ||
    !isOptionalToolExecutionMode(canonical) ||
    !isOptionalToolExecutionMode(legacy)
  ) {
    return "sequential";
  }
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) return "sequential";
  return canonical ?? legacy ?? "sequential";
}

function resolveToolApproval(
  canonical: unknown,
  legacy: unknown,
  malformedPolicy: boolean,
): ToolApprovalPolicy {
  if (malformedPolicy || (legacy !== undefined && typeof legacy !== "boolean")) return "required";
  if (legacy === true || canonical === "required") return "required";
  if (canonical === undefined || canonical === "none") return "none";
  return "required";
}

function normalizePolicyLabels(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return [];
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function isOptionalToolEffect(value: unknown): value is ToolEffect | undefined {
  return (
    value === undefined ||
    value === "read" ||
    value === "local_write" ||
    value === "external_write" ||
    value === "destructive"
  );
}

function isOptionalToolExecutionMode(value: unknown): value is ToolExecutionMode | undefined {
  return value === undefined || value === "sequential" || value === "parallel";
}

function isOptionalToolApproval(value: unknown): value is ToolApprovalPolicy | undefined {
  return value === undefined || value === "none" || value === "required";
}

function isOptionalPolicyLabels(value: unknown): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function declarationsConflict(canonical: unknown, legacy: unknown): boolean {
  return canonical !== undefined && legacy !== undefined && canonical !== legacy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  /** Resolved policy when the host supports Spark policy normalization. */
  policy?: ResolvedToolPolicy;
}

export type ExtensionUiNotifyLevel = "info" | "warning" | "error" | "success";

/**
 * Host-facing interaction request contract.
 *
 * Structurally aligned with `@zendev-lab/spark-protocol`'s
 * `sparkInteractionRequestSchema` discriminated union. Wire validation stays in
 * protocol (zod); this type is the portable `ExtensionUi.interaction` surface.
 * Keep both in lockstep — protocol type tests assert assignability.
 */
export type ExtensionInteractionSource =
  | "tui"
  | "web"
  | "daemon"
  | "extension"
  | "runtime"
  | "test";

export type ExtensionInteractionResponseStatus =
  | "answered"
  | "pending"
  | "cancelled"
  | "blocked"
  | "error";

export interface ExtensionAskOptionView {
  value: string;
  label: string;
  description?: string | undefined;
  preview?: string | undefined;
}

export interface ExtensionAskQuestionView {
  id: string;
  prompt: string;
  header?: string | undefined;
  type?: "single" | "multi" | "preview" | "freeform" | undefined;
  required?: boolean | undefined;
  defaultValues?: string[] | undefined;
  options?: ExtensionAskOptionView[] | undefined;
}

export interface ExtensionInteractionRequestBase {
  version?: number | undefined;
  requestId: string;
  title: string;
  prompt?: string | undefined;
  createdAt?: string | undefined;
  source?: ExtensionInteractionSource | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ExtensionAskFlowInteractionRequest extends ExtensionInteractionRequestBase {
  kind: "askFlow";
  delivery?: "blocking" | "async" | undefined;
  timeoutMs?: number | undefined;
  mode?: "clarification" | "decision" | "approval" | "unblock" | undefined;
  flow?: string | undefined;
  questions: ExtensionAskQuestionView[];
  allowElaborate?: boolean | undefined;
}

export interface ExtensionModelRef {
  providerName: string;
  modelId: string;
  providerLabel?: string | undefined;
  modelLabel?: string | undefined;
}

export interface ExtensionModelSelectOption extends ExtensionModelRef {
  value: string;
  description?: string | undefined;
  active?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ExtensionModelSelectInteractionRequest extends ExtensionInteractionRequestBase {
  kind: "modelSelect";
  active?: ExtensionModelRef | undefined;
  options?: ExtensionModelSelectOption[] | undefined;
}

export interface ExtensionWorkflowPickerOption {
  selector: string;
  label: string;
  description?: string | undefined;
  phaseCount?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ExtensionWorkflowPickerInteractionRequest extends ExtensionInteractionRequestBase {
  kind: "workflowPicker";
  options?: ExtensionWorkflowPickerOption[] | undefined;
}

export interface ExtensionConfirmationInteractionRequest extends ExtensionInteractionRequestBase {
  kind: "confirmation";
  severity?: "info" | "warning" | "danger" | undefined;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
}

export interface ExtensionDiffApprovalInteractionRequest extends ExtensionInteractionRequestBase {
  kind: "diffApproval";
  filePath?: string | undefined;
  diff: string;
  summary?: string | undefined;
  approveLabel?: string | undefined;
  rejectLabel?: string | undefined;
}

export interface ExtensionToolApprovalInteractionRequest extends ExtensionInteractionRequestBase {
  kind: "toolApproval";
  toolName: string;
  toolCallId?: string | undefined;
  arguments?: unknown;
  reason?: string | undefined;
  approveLabel?: string | undefined;
  rejectLabel?: string | undefined;
}

export type ExtensionInteractionRequest =
  | ExtensionAskFlowInteractionRequest
  | ExtensionModelSelectInteractionRequest
  | ExtensionWorkflowPickerInteractionRequest
  | ExtensionConfirmationInteractionRequest
  | ExtensionDiffApprovalInteractionRequest
  | ExtensionToolApprovalInteractionRequest;

export interface ExtensionInteractionResponseBase {
  version?: number | undefined;
  requestId: string;
  status: ExtensionInteractionResponseStatus;
  message?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ExtensionAskFlowInteractionResponse extends ExtensionInteractionResponseBase {
  kind: "askFlow";
  humanRequestId?: string | undefined;
  answers?: Record<string, unknown> | undefined;
  nextAction?: "resume" | "block" | "cancel" | undefined;
}

export interface ExtensionModelSelectInteractionResponse extends ExtensionInteractionResponseBase {
  kind: "modelSelect";
  selection?: ExtensionModelRef | undefined;
}

export interface ExtensionWorkflowPickerInteractionResponse extends ExtensionInteractionResponseBase {
  kind: "workflowPicker";
  selector?: string | undefined;
}

export interface ExtensionApprovalInteractionResponse extends ExtensionInteractionResponseBase {
  kind: "confirmation" | "diffApproval" | "toolApproval";
  approved?: boolean | undefined;
  note?: string | undefined;
}

export type ExtensionInteractionResponse =
  | ExtensionAskFlowInteractionResponse
  | ExtensionModelSelectInteractionResponse
  | ExtensionWorkflowPickerInteractionResponse
  | ExtensionApprovalInteractionResponse;

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

/**
 * Stable, credential-free reason codes for a degraded leaf capability call.
 * Hosts must never derive these from raw provider error text.
 */
export type LeafDegradeReason =
  | "aborted"
  | "no-model"
  | "model-binding-unavailable"
  | "route-unavailable"
  | "model-call-failed"
  | "host-unsupported";

/**
 * A bounded, single-shot model call requested by a high-level tool. A leaf owns
 * no task, session, tools, or recursion: the calling tool stays responsible for
 * verifying the advisory result and for any fallback.
 */
export interface LeafCapabilityRequest {
  /** Stable leaf capability id, e.g. "web-researcher" or "memory-reranker". */
  role: string;
  /** System-level brief describing exactly the bounded transformation to run. */
  brief: string;
  /** Prepared, caller-gathered input payload (treated as untrusted data). */
  input: string;
  /** Explicit model override ("provider/model" or a model id). */
  model?: string;
  /** Session model to use when no explicit override is provided. */
  sessionModel?: string;
  /** Bounded output ceiling for the single completion. */
  maxTokens?: number;
  /** Request a reasoning-capable route when available. */
  reasoning?: boolean;
  signal?: AbortSignal;
}

export interface LeafCapabilityResult {
  /** True when the leaf could not run a model and the caller must fall back. */
  degraded: boolean;
  /** Advisory model output text; empty when degraded. */
  text: string;
  /** Resolved model id for the completion, when one ran. */
  model?: string;
  /** Stable, credential-free reason code when degraded. */
  reasonCode?: LeafDegradeReason;
}

/**
 * Host-provided single-shot leaf runner. Optional on SparkHostContext: portable
 * extensions and non-Spark hosts may omit it, and tools must degrade gracefully
 * when it is absent.
 */
export type LeafCapabilityRunner = (
  request: LeafCapabilityRequest,
) => Promise<LeafCapabilityResult>;

/**
 * Shared production seam consumer for high-level tools. Calls the optional
 * host `ctx.runLeaf` and, when the host does not provide it, returns a stable
 * degraded result (reasonCode "host-unsupported") instead of throwing, so every
 * leaf-backed tool degrades identically to mechanical output. Tools should call
 * this rather than touching `ctx.runLeaf` directly.
 */
export async function callLeafOrDegrade(
  ctx: Pick<SparkHostContext, "runLeaf">,
  request: LeafCapabilityRequest,
): Promise<LeafCapabilityResult> {
  const result = await ctx.runLeaf?.(request);
  if (!result) return { degraded: true, text: "", reasonCode: "host-unsupported" };
  return result;
}

export type ExtensionRoleLaunchMode = "fresh" | "forked";
export type ExtensionRoleRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_started";

export type RoleRunCompletionOutcomeKind = "completed" | "blocked" | "failed" | "cancelled";

export interface RoleRunCompletionOutcome {
  kind: RoleRunCompletionOutcomeKind;
  /** Stable machine-readable terminal code; never infer this from display text. */
  code: string;
  reason: string;
  nextAction?: string;
}

export interface ExtensionRoleRunInputController {
  send(text: string): void | Promise<void>;
}

export interface ExtensionRoleRunInputControl {
  register(controller: ExtensionRoleRunInputController): () => void;
}

export interface ExtensionRoleRunRequest {
  role: {
    ref: RoleRef;
    id: string;
    systemPrompt: string;
    allowedTools?: string[];
  };
  instruction: {
    roleRef: RoleRef;
    instruction: string;
    inputs?: string[];
  };
  record: {
    ref: RunRef;
    roleRef: RoleRef;
    runName?: string;
    instruction: string;
    status: ExtensionRoleRunStatus;
    startedAt?: string;
    finishedAt?: string;
    launch?: ExtensionRoleLaunchMode;
    model?: string;
    sessionDir?: string;
    forkFromSession?: string;
    noSession?: boolean;
    sessionPersistence?: "anonymous" | "persistent";
    outcome?: RoleRunCompletionOutcome;
  };
  cwd: string;
  timeoutMs: number;
  phase?: "plan" | "implement";
  requireStructuredOutcome?: boolean;
  signal?: AbortSignal;
  sessionDir?: string;
  runName?: string;
  launch?: ExtensionRoleLaunchMode;
  forkFromSession?: string;
  model?: string;
  noSession?: boolean;
  sessionPersistence?: "anonymous" | "persistent";
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: unknown) => void | Promise<void>;
  inputControl?: ExtensionRoleRunInputControl;
}

export interface ExtensionRoleRunResult {
  record: ExtensionRoleRunRequest["record"];
  outcome?: RoleRunCompletionOutcome;
  stdout: string;
  stderr: string;
  jsonEvents: unknown[];
}

export type ExtensionRoleRunner = (
  request: ExtensionRoleRunRequest,
) => Promise<ExtensionRoleRunResult>;

export type SparkSessionMessageSource = "tui" | "web" | "channel" | "daemon" | "session";

export interface SparkHostDriverContext {
  driverId: string;
  kind: "goal" | "loop" | "repro" | "implement" | "workflow" | "session_todo";
  generation: number;
  ownerSessionId: string;
  stateOwnerSessionId: string;
  schedule(input: {
    delayMs?: number;
    dueAt?: string;
    reason?: string;
    prompt?: string;
  }): Promise<unknown>;
  stop(input?: { reason?: string }): Promise<unknown>;
}

export type SparkRuntimeDriverKind =
  | "goal"
  | "loop"
  | "repro"
  | "implement"
  | "workflow"
  | "session_todo";

/** Capability-owned cadence/retry policy consumed by the generic daemon runtime. */
export interface SparkDriverPolicyDefinition {
  kind: SparkRuntimeDriverKind;
  success: { status: "scheduled"; delayMs: number } | { status: "dormant" };
  retryDelaysMs: readonly number[];
}

export interface SparkHostContext {
  cwd?: string;
  /** Current Spark view/session identity for session-scoped extension state. */
  sessionId?: string;
  /** Optional absolute path to the Spark state root directory (`.../.spark`). */
  sparkStateRoot?: string;
  /** Execution surface policy supplied by the host for this session. */
  sessionSurface?: "local" | "channel";
  /** Origin label for hidden session-message metadata. */
  sessionSource?: SparkSessionMessageSource;
  /** Current daemon invocation, available only in daemon-owned headless turns. */
  invocationId?: string;
  /** Present only inside a daemon-owned autonomous driver tick. */
  driver?: SparkHostDriverContext;
  /** Session IDs already participating in a synchronous question chain. */
  sessionQuestionChain?: string[];
  model?: SessionModelRef;
  hasUI?: boolean;
  ui?: ExtensionUi;
  isIdle?: () => boolean;
  /**
   * Optional single-shot spark-ai leaf runner supplied by Spark hosts. High-level
   * tools call `ctx.runLeaf?.(request)` to add bounded reasoning (synthesis,
   * rerank, extraction) and fall back to mechanical output when it is absent or
   * returns `{ degraded: true }`.
   */
  runLeaf?: LeafCapabilityRunner;
  /**
   * Optional daemon-native role runner supplied by Spark hosts. Role tools use
   * this instead of spawning a nested `pi` process and fail loudly when absent.
   */
  runRole?: ExtensionRoleRunner;
}

export interface SparkHostCommandContext extends SparkHostContext {
  waitForIdle?: () => Promise<void>;
  sendUserMessage?: (content: string) => Promise<void>;
}

/**
 * Agent/domain ref kinds (`kind:id`, e.g. `task:…`, `proj:…`).
 *
 * This is the in-process graph / memory / tool identity vocabulary owned by
 * spark-core. It is intentionally separate from the daemon/Cockpit wire id
 * vocabulary in `@zendev-lab/spark-protocol` (`prefix_hex`, see
 * `packages/spark-protocol/src/refs.ts`). Do not invent a third id scheme —
 * map at the boundary when crossing from domain refs to wire ids (or vice versa).
 */
export type RefKind =
  | "spark"
  | "proj"
  | "task"
  | "role"
  | "artifact"
  | "evidence"
  | "run"
  | "review"
  | "ask"
  | "cue-job";

export type Ref<K extends RefKind> = `${K}:${string}` & { readonly __kind?: K };

export type SparkRef = Ref<"spark">;
export type ProjectRef = Ref<"proj">;
export type TaskRef = Ref<"task">;
export type RoleRef = Ref<"role">;
/** Stable artifact identity; evidence writes may use `evidence:` while remaining artifact-shaped. */
export type ArtifactRef = Ref<"artifact"> | Ref<"evidence">;
export type EvidenceRef = Ref<"evidence">;
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
  | EvidenceRef
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
    if (details !== undefined) this.details = details;
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
  const kind = ref.split(":", 1)[0];
  if (!kind || !isRefKind(kind)) throw new PiError("INVALID_REF", `unknown ref kind: ${ref}`);
  return kind;
}

export function refId(ref: AnyRef | string): string {
  const index = ref.indexOf(":");
  if (index < 0) throw new PiError("INVALID_REF", `invalid ref: ${ref}`);
  return ref.slice(index + 1);
}

export function isRefKind(value: string): value is RefKind {
  return [
    "spark",
    "proj",
    "task",
    "role",
    "artifact",
    "evidence",
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

export const TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: string | undefined | null): value is TaskStatus {
  return value != null && (TASK_STATUSES as readonly string[]).includes(value);
}
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
  /** Project workflow/display kind. Defaults to generic when omitted by older snapshots. */
  kind?: string;
  /** Kind-specific structured state consumed by the kind registry. */
  kindState?: JsonValue;
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
  | "weak_objective"
  | "unverifiable_success_criteria"
  | "weak_evidence_required"
  | "weak_plan_items"
  | "low_ambition_plan"
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

export type TaskRunFailureKind =
  | "runtime_timeout"
  | "runtime_error"
  | "runtime_cancelled"
  | "claim_stale"
  | "blocked"
  | "provider_failure";
export type TaskRunStatus = "queued" | "running" | "succeeded" | "blocked" | "failed" | "cancelled";

export interface TaskRunCompletionSummary {
  runRef: RunRef;
  taskRef: TaskRef;
  roleRef?: RoleRef;
  runName?: string;
  status: TaskRunStatus;
  summary: string;
  artifactRefs: ArtifactRef[];
  outcome?: RoleRunCompletionOutcome;
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
  outcome?: RoleRunCompletionOutcome;
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
