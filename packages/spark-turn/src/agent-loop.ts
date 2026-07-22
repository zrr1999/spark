/**
 * SparkAgentLoop — orchestrate one or more LLM turns on top of SparkHostRuntime.
 *
 * Design goals:
 *
 *   1. **Stream-agnostic.** The loop is parameterised on a `streamFunction`
 *      with the same shape as `pi-ai`'s `stream(model, context, options)`.
 *      The default wiring will plug in the real `stream` import; tests pass a
 *      fake stream so the loop can be exercised without a network call.
 *
 *   2. **One claim per host.** Holds the current system prompt and message
 *      log. Producers call `submit(content)` to enqueue a user message; the
 *      loop runs turns until `stopReason !== "toolUse"` (or abort/error).
 *
 *   3. **Tool dispatch through the host.** On `toolcall_end` events the loop
 *      looks up the tool via `host.getTool(name)` and invokes its `execute`
 *      with the runtime's `SparkHostContext`. The `ToolResult` is appended
 *      to the message log before the next turn.
 *
 *   4. **Outbox drain.** Between turns we drain `host.drainOutbox()` and turn
 *      pending custom/user envelopes into either follow-up user messages
 *      (`kind: "user"`) or assistant-visible `system`-style notices
 *      (`kind: "custom"`).
 *
 *   5. **Abort.** `abort()` cancels the in-flight stream via `AbortController`
 *      and sets the loop back to idle. Producers may call `abort()` from any
 *      thread (Esc handling, Ctrl-C, etc.).
 *
 *   6. **Subscribers.** Both the TUI and tests subscribe to a small typed
 *      event surface (`onEvent`) so streaming progress can be rendered. The
 *      events mirror the underlying pi-ai event protocol so wiring is one
 *      pass-through call.
 *
 * Wiring to a real model and provider lives in `provider-config-and-pi-ai-wiring`
 * (config schema + provider plugin loader) and `model-selector-ui` (Ctrl-L
 * picker). This file does not perform any I/O and remains test-friendly.
 */

export type SparkTurnContentPart = { type: string; [key: string]: unknown };
export type SparkTurnUserContent = string | Array<{ type: string }>;

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  StreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@zendev-lab/spark-ai";

export type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  StreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@zendev-lab/spark-ai";

import { createHash } from "node:crypto";

import type { SparkHostContext } from "@zendev-lab/spark-core";
export { compactToolResultContent } from "./tool-result-compaction.ts";

import {
  compactToolResultContent,
  shouldRecordRawToolResultArtifact,
  type SparkToolResultRawRecoveryDecision,
} from "./tool-result-compaction.ts";
import {
  cloneSparkPromptItem,
  lowerSparkPromptItems,
  sparkPromptItemText,
  sparkRuntimePromptItem,
  type SparkPromptItem,
} from "./prompt-items.ts";
import { buildSparkPromptManifest, type SparkPromptManifest } from "./prompt-manifest.ts";
export {
  SPARK_PROMPT_ITEM_METADATA_KEY,
  cloneSparkPromptItem,
  lowerSparkPromptItem,
  lowerSparkPromptItems,
  parseSparkPromptItemMetadata,
  sparkPromptItemFromProviderMessage,
  sparkPromptItemMetadata,
  sparkPromptItemText,
  sparkRuntimePromptItem,
} from "./prompt-items.ts";
export type {
  SparkPromptAuthority,
  SparkPromptItem,
  SparkPromptItemContent,
  SparkPromptItemMetadata,
  SparkPromptPersistence,
  SparkPromptProviderMessage,
  SparkPromptRuntimeContent,
  SparkPromptTrust,
  SparkPromptVisibility,
} from "./prompt-items.ts";
export { buildSparkPromptManifest, SPARK_PROMPT_MANIFEST_VERSION } from "./prompt-manifest.ts";
export type {
  BuildSparkPromptManifestInput,
  SparkPromptManifest,
  SparkPromptManifestTool,
  SparkPromptManifestToolEffect,
  SparkPromptManifestToolInput,
} from "./prompt-manifest.ts";
import {
  SPARK_PROTOCOL_VERSION,
  type SparkAgentLoopEventType,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
  type SparkMessageView,
  type SparkRunOutcomeStatus,
  type SparkRunView,
  type SparkViewModelEvent,
} from "@zendev-lab/spark-protocol";

import {
  appendRawRecoveryHint,
  artifactRefFromToolResult,
  collectToolCalls,
  errorToolResult,
  isPlainRecord,
  mergeToolResultDetails,
  normalizeApprovalMethod,
  normalizeApprovalRejectAction,
  rawToolOutputProducer,
  rawToolResultArtifactBody,
  rawToolResultRecoveryPath,
  resolvedRegisteredToolPolicy,
  safeSelectedSkills,
  toToolDefinition,
  toolRequiresApproval,
  type ToolResultRawRecoveryRecord,
} from "./tool-dispatch.ts";
import {
  asProviderMessageItem,
  beforeAgentStartPromptItems,
  loopTerminalAssistant,
  normalizePositiveInteger,
  normalizeTimeoutMs,
  numberField,
  orderedParallelMap,
  relayAbort,
  runWithAbort,
  runWithTimeout,
  safeGetModel,
  throwIfSignalAborted,
} from "./run-turns.ts";
import {
  assistantToMessageView,
  entityViewsFromToolDetails,
  jsonMetadata,
  messageToView,
  nextViewMessageId,
  runStatusForStopReason,
  taskViewsFromToolDetails,
  toolCallToMessageView,
  toolResultToMessageView,
  toolUpdateToMessageView,
} from "./view-projection.ts";
import { displaySafeAssistantText } from "./conversation-parts.ts";
import type {
  SparkToolApprovalMethod,
  SparkToolApprovalRejectAction,
  SparkTurnRegisteredTool,
} from "./turn-types.ts";
export type {
  SparkToolApprovalMethod,
  SparkToolApprovalRejectAction,
  SparkTurnRegisteredTool,
} from "./turn-types.ts";

export type SparkAgentStreamFunction = (
  model: Model<string>,
  context: Context,
  options?: StreamOptions,
) => AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export type SparkAgentLoopState = "idle" | "streaming" | "tooling" | "aborting";
export type SparkAgentPhase = "plan" | "implement";
export type SparkAgentLifecycleSource = "agentLoop" | "triggerTurn";

export interface SparkTurnOutboxEnvelope {
  kind: "custom" | "user";
  sessionId?: string;
  customType?: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  display?: boolean;
  details?: Record<string, unknown>;
  authority?: "runtime_control" | "runtime_data";
  trust?: "trusted" | "untrusted";
  options: {
    deliverAs?: "steer" | "followUp" | "nextTurn";
    streamingBehavior?: "steer" | "followUp";
    triggerTurn?: boolean;
  };
  enqueuedAt: number;
}

export interface SparkTurnHost {
  setTriggerTurnHandler(handler: (() => void | Promise<void>) | undefined): void;
  setSessionId?(sessionId: string | undefined): void;
  emit(event: string, payload: unknown): Promise<unknown[]>;
  getTool(name: string): SparkTurnRegisteredTool | undefined;
  makeContext(extra?: Partial<SparkHostContext>): SparkHostContext;
  requestInteraction(request: SparkInteractionRequest): Promise<SparkInteractionResponse>;
  listTools(): SparkTurnRegisteredTool[];
  drainOutbox(): SparkTurnOutboxEnvelope[];
  setIdle(idle: boolean): void;
  publishView(event: SparkViewModelEvent): void;
}

export const DEFAULT_SPARK_AGENT_LOOP_STREAM_TIMEOUT_MS = 0;
/** Abort a model stream only after this long with no stream events (hang detection). */
export const DEFAULT_SPARK_AGENT_LOOP_STREAM_IDLE_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_SPARK_AGENT_LOOP_TOOL_TIMEOUT_MS = 300_000;
export const DEFAULT_SPARK_AGENT_LOOP_INTERACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_SPARK_AGENT_LOOP_MAX_PARALLEL_TOOL_CALLS = 4;

export type SparkToolApprovalReviewOutcome = "approved" | "needs_changes" | "blocked";

export type SparkRunOutcome =
  | {
      status: Extract<SparkRunOutcomeStatus, "completed">;
      assistant: AssistantMessage;
      roundtrips: number;
    }
  | {
      status: Extract<SparkRunOutcomeStatus, "aborted">;
      assistant: AssistantMessage;
      roundtrips: number;
      reason: string;
    }
  | {
      status: Extract<SparkRunOutcomeStatus, "failed">;
      assistant: AssistantMessage;
      roundtrips: number;
      errorMessage: string;
    };

export interface SparkToolApprovalReviewRequest {
  toolName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface SparkToolApprovalReviewResult {
  outcome: SparkToolApprovalReviewOutcome;
  summary: string;
}

export interface SparkPromptCacheOptions {
  enabled?: boolean;
  checkpoint?: string;
  keyPrefix?: string;
  env?: Record<string, string | undefined>;
}

export interface SparkPromptCacheSnapshot {
  stablePrompt: string;
  dynamicPrompt: string;
  stableHash: string;
  dynamicHash: string;
  promptCacheKey?: string;
  disabledReason?: "option" | "env" | "empty_stable_prompt";
}

export interface SparkPromptManifestOptions {
  /** Stable rollout identifier for comparing prompt/tool behavior over time. */
  promptVersion?: string;
  /** Names only. Skill bodies and user input are never retained in the manifest. */
  getSelectedSkills?: () => readonly string[];
}

export interface SparkAgentLoopOptions {
  host: SparkTurnHost;
  /** pi-ai stream function. Pass the production `stream` import or a test fake. */
  streamFunction: SparkAgentStreamFunction;
  /** Resolves the current model. May be replaced at runtime via setModel. */
  getModel: () => Model<string>;
  systemPrompt?: string;
  promptCache?: SparkPromptCacheOptions;
  /** Privacy-safe per-round prompt/tool diagnostics. Enabled by default. */
  promptManifest?: SparkPromptManifestOptions;
  /** Wall-clock timeout for one model stream pass. Defaults to disabled (0); <=0 disables. */
  streamTimeoutMs?: number;
  /**
   * Abort a model stream after this long with no stream events.
   * Defaults to 45 minutes; <=0 disables idle hang detection.
   */
  streamIdleTimeoutMs?: number;
  /** Wall-clock timeout for one tool execution. Defaults to 5 minutes; <=0 disables. */
  toolTimeoutMs?: number;
  /** Wall-clock timeout for one host interaction/approval wait. Defaults to 60s; <=0 disables. */
  interactionTimeoutMs?: number;
  /** Maximum concurrent calls in an explicitly safe read-only tool batch. Defaults to 4. */
  maxParallelToolCalls?: number;
  /**
   * Session/host method for tools with `requiresApproval`.
   * Defaults to `auto`. Local TUI should pass `skip`; channel sessions keep `auto`.
   */
  approvalMethod?: SparkToolApprovalMethod;
  /**
   * When `approvalMethod` is `auto` and the reviewer does not approve.
   * Defaults to `ask` (escalate to human / toolApproval).
   */
  approvalRejectAction?: SparkToolApprovalRejectAction;
  /**
   * Auto-review hook (same conceptual channel as goal completion reviewer).
   * When omitted under `auto`, the call is treated as blocked and follows
   * `approvalRejectAction`.
   */
  reviewToolApproval?: (
    request: SparkToolApprovalReviewRequest,
    signal: AbortSignal,
  ) => Promise<SparkToolApprovalReviewResult>;
  /**
   * Optional thinking/reasoning intensity for model streams.
   * When set, forwarded as `options.reasoning` (including `"off"`).
   */
  getReasoning?: () => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
}

/**
 * Turn-loop subscriber events. Discriminants are single-sourced in
 * `@zendev-lab/spark-protocol` (`SPARK_AGENT_LOOP_EVENT_TYPES`). AI message
 * payloads use spark-ai / pi-ai types (not protocol view projections);
 * `view_event` carries protocol `SparkViewModelEvent`.
 */
export type SparkAgentLoopEvent =
  | { type: Extract<SparkAgentLoopEventType, "stream_event">; event: AssistantMessageEvent }
  | { type: Extract<SparkAgentLoopEventType, "user_message">; message: Message }
  | { type: Extract<SparkAgentLoopEventType, "runtime_message">; item: SparkPromptItem }
  | { type: Extract<SparkAgentLoopEventType, "prompt_manifest">; manifest: SparkPromptManifest }
  | { type: Extract<SparkAgentLoopEventType, "tool_result">; message: ToolResultMessage }
  | {
      type: Extract<SparkAgentLoopEventType, "turn_complete">;
      assistant: AssistantMessage;
      reason: AssistantMessage["stopReason"];
    }
  | { type: Extract<SparkAgentLoopEventType, "run_outcome">; outcome: SparkRunOutcome }
  | { type: Extract<SparkAgentLoopEventType, "view_event">; event: SparkViewModelEvent }
  | { type: Extract<SparkAgentLoopEventType, "abort">; reason: string }
  | { type: Extract<SparkAgentLoopEventType, "error">; message: string };

export class SparkAgentLoop {
  readonly host: SparkTurnHost;
  private readonly streamFunction: SparkAgentStreamFunction;
  private readonly getModel: () => Model<string>;
  private readonly streamTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly interactionTimeoutMs: number;
  private readonly maxParallelToolCalls: number;
  private approvalMethod: SparkToolApprovalMethod;
  private approvalRejectAction: SparkToolApprovalRejectAction;
  private readonly reviewToolApproval:
    | ((
        request: SparkToolApprovalReviewRequest,
        signal: AbortSignal,
      ) => Promise<SparkToolApprovalReviewResult>)
    | undefined;
  private readonly getReasoning:
    | (() => "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined)
    | undefined;
  private systemPrompt: string;
  private readonly promptCacheOptions: SparkPromptCacheOptions;
  private readonly promptManifestOptions: SparkPromptManifestOptions;
  private readonly promptItems: SparkPromptItem[] = [];
  private readonly deferredOutboxBySession = new Map<string, SparkTurnOutboxEnvelope[]>();
  private readonly deferredTriggerOutbox: SparkTurnOutboxEnvelope[] = [];
  private state: SparkAgentLoopState = "idle";
  private currentPhase: SparkAgentPhase | undefined;
  private currentAbort: AbortController | undefined;
  private currentAbortReason: string | undefined;
  private lastOutcome: SparkRunOutcome | undefined;
  private lastPromptManifest: SparkPromptManifest | undefined;
  private userSubmitPreparationActive = false;
  private triggerTurnRunning = false;
  private triggerTurnDeferred = false;
  private viewSessionId = "spark-agent";
  private viewRunCounter = 0;
  private currentViewRunId: string | undefined;
  private currentViewRunUsage: SparkRunUsageTotals | undefined;
  private currentAssistantMessageId: string | undefined;
  private currentAssistantPartial?: AssistantMessage;
  private currentAssistantProjection?: SparkMessageView;
  private readonly subscribers = new Set<(event: SparkAgentLoopEvent) => void>();

  constructor(options: SparkAgentLoopOptions) {
    this.host = options.host;
    this.streamFunction = options.streamFunction;
    this.getModel = options.getModel;
    this.systemPrompt = options.systemPrompt ?? "";
    this.promptCacheOptions = options.promptCache ?? {};
    this.promptManifestOptions = options.promptManifest ?? {};
    this.streamTimeoutMs = normalizeTimeoutMs(
      options.streamTimeoutMs,
      DEFAULT_SPARK_AGENT_LOOP_STREAM_TIMEOUT_MS,
    );
    this.streamIdleTimeoutMs = normalizeTimeoutMs(
      options.streamIdleTimeoutMs,
      DEFAULT_SPARK_AGENT_LOOP_STREAM_IDLE_TIMEOUT_MS,
    );
    this.toolTimeoutMs = normalizeTimeoutMs(
      options.toolTimeoutMs,
      DEFAULT_SPARK_AGENT_LOOP_TOOL_TIMEOUT_MS,
    );
    this.interactionTimeoutMs = normalizeTimeoutMs(
      options.interactionTimeoutMs,
      DEFAULT_SPARK_AGENT_LOOP_INTERACTION_TIMEOUT_MS,
    );
    this.maxParallelToolCalls = normalizePositiveInteger(
      options.maxParallelToolCalls,
      DEFAULT_SPARK_AGENT_LOOP_MAX_PARALLEL_TOOL_CALLS,
    );
    this.approvalMethod = normalizeApprovalMethod(options.approvalMethod);
    this.approvalRejectAction = normalizeApprovalRejectAction(options.approvalRejectAction);
    this.reviewToolApproval = options.reviewToolApproval;
    this.getReasoning = options.getReasoning;
    this.host.setSessionId?.(this.viewSessionId);
    this.host.setTriggerTurnHandler(() => this.triggerNextTurn());
  }

  setApprovalMethod(method: SparkToolApprovalMethod): void {
    this.approvalMethod = normalizeApprovalMethod(method);
  }

  setApprovalRejectAction(action: SparkToolApprovalRejectAction): void {
    this.approvalRejectAction = normalizeApprovalRejectAction(action);
  }

  /**
   * Select the transient tool profile for subsequent model/tool turns.
   * Undefined preserves compatibility by allowing every host-active tool.
   */
  setCurrentPhase(phase: SparkAgentPhase | undefined): void {
    this.currentPhase = phase;
  }

  getCurrentPhase(): SparkAgentPhase | undefined {
    return this.currentPhase;
  }

  /** Reserve idle prompt state while a native host prepares a real user submit. */
  protected beginUserSubmitPreparation(): void {
    if (this.state !== "idle" || this.triggerTurnRunning || this.userSubmitPreparationActive) {
      const busyState = this.triggerTurnRunning
        ? "triggerTurn"
        : this.userSubmitPreparationActive
          ? "preparing"
          : this.state;
      throw new Error(
        `SparkAgentLoop.submit refused: agent is not idle (state=${busyState}). ` +
          "Use SparkNativeSession queueing or wait for the current turn to finish.",
      );
    }
    this.userSubmitPreparationActive = true;
  }

  /** Release prompt preparation and replay one coalesced background wakeup. */
  protected endUserSubmitPreparation(): void {
    if (!this.userSubmitPreparationActive) return;
    this.userSubmitPreparationActive = false;
    if (!this.triggerTurnDeferred) return;
    this.triggerTurnDeferred = false;
    queueMicrotask(() => void this.triggerNextTurn());
  }

  // ── Public API ─────────────────────────────────────────────────────────

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setViewSessionId(sessionId: string | undefined): void {
    const normalized = sessionId?.trim();
    this.viewSessionId = normalized || "spark-agent";
    this.host.setSessionId?.(this.viewSessionId);
  }

  getViewSessionId(): string {
    return this.viewSessionId;
  }

  /** Snapshot of the current message log. Useful for sessions/branches. */
  getMessages(): readonly Message[] {
    return lowerSparkPromptItems(this.promptItems) as Message[];
  }

  /** Host-owned prompt items before provider compatibility lowering. */
  getPromptItems(): readonly SparkPromptItem[] {
    return this.promptItems.map(cloneSparkPromptItem);
  }

  /** Replace the message log when resuming a persisted Spark session. */
  replaceMessages(messages: readonly Message[]): void {
    this.replacePromptItems(messages.map((message) => asProviderMessageItem(message)));
  }

  /** Replace the host-owned prompt log when replaying a persisted session. */
  replacePromptItems(items: readonly SparkPromptItem[]): void {
    if (this.state !== "idle") {
      throw new Error(
        `SparkAgentLoop.replacePromptItems refused: agent is not idle (state=${this.state})`,
      );
    }
    this.promptItems.splice(
      0,
      this.promptItems.length,
      ...items.map((item) => cloneSparkPromptItem(item)),
    );
    this.lastOutcome = undefined;
    this.lastPromptManifest = undefined;
  }

  getState(): SparkAgentLoopState {
    return this.state;
  }

  getLastOutcome(): SparkRunOutcome | undefined {
    return this.lastOutcome;
  }

  getLastPromptManifest(): SparkPromptManifest | undefined {
    return this.lastPromptManifest;
  }

  onEvent(subscriber: (event: SparkAgentLoopEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Submit a user message and run turns until stop. Returns the final
   * assistant message, or the aborted/error message envelope.
   */
  async submit(content: SparkTurnUserContent): Promise<AssistantMessage> {
    return (await this.submitWithOutcome(content)).assistant;
  }

  /** Submit a user turn and retain the reason the loop terminated. */
  async submitWithOutcome(content: SparkTurnUserContent): Promise<SparkRunOutcome> {
    if (this.state !== "idle" || this.triggerTurnRunning) {
      // The TUI handles queueing; the loop refuses to interleave.
      throw new Error(
        `SparkAgentLoop.submit refused: agent is not idle (state=${this.state}). ` +
          "Use SparkNativeSession queueing or wait for the current turn to finish.",
      );
    }

    this.lastOutcome = undefined;
    this.lastPromptManifest = undefined;
    this.startViewRun("user submit");
    // `nextTurn` runtime context must accompany the next real user prompt. It
    // is deliberately not consumed by extension-triggered background turns.
    this.drainOutboxIntoMessages({ includeNextTurn: true });
    const userMessage: UserMessage = {
      role: "user",
      content: content as UserMessage["content"],
      timestamp: Date.now(),
    };
    this.promptItems.push(asProviderMessageItem(userMessage));
    this.publish({ type: "user_message", message: userMessage });
    this.currentAbortReason = undefined;

    return this.runTurns();
  }

  /** Cancel the in-flight stream/tool, marking the agent idle again. */
  abort(reason: string = "user_abort"): void {
    if (this.state === "idle") return;
    this.state = "aborting";
    this.currentAbortReason = reason;
    this.currentAbort?.abort(new Error(reason));
    this.publish({ type: "abort", reason });
  }

  // ── Internal turn loop ─────────────────────────────────────────────────

  private async triggerNextTurn(): Promise<void> {
    if (this.userSubmitPreparationActive) {
      this.triggerTurnDeferred = true;
      this.deferredTriggerOutbox.push(...this.host.drainOutbox());
      return;
    }
    if (this.state !== "idle" || this.triggerTurnRunning) return;
    this.triggerTurnRunning = true;
    try {
      this.lastOutcome = undefined;
      this.lastPromptManifest = undefined;
      await this.host.emit("turn_start", { source: "triggerTurn" });
      const queued = this.drainOutboxIntoMessages({
        incoming: this.deferredTriggerOutbox.splice(0),
      });
      const injected = await this.injectBeforeAgentStartMessages("triggerTurn");
      if (queued + injected === 0) return;
      this.startViewRun("triggered turn");
      await this.runTurns({ skipInitialLifecycle: true, lifecycleSource: "triggerTurn" });
    } finally {
      this.triggerTurnRunning = false;
    }
  }

  private async runTurns(
    options: {
      skipInitialLifecycle?: boolean;
      lifecycleSource?: SparkAgentLifecycleSource;
    } = {},
  ): Promise<SparkRunOutcome> {
    let lastAssistant: AssistantMessage | undefined;
    let roundtrips = 0;
    let agentEndPayload:
      | { messages: AssistantMessage[]; errorMessage?: string; outcome?: SparkRunOutcome }
      | undefined;
    const finishAgentTurn = (outcome: SparkRunOutcome): SparkRunOutcome => {
      this.lastOutcome = outcome;
      this.publish({ type: "run_outcome", outcome });
      const errorMessage = outcome.status === "failed" ? outcome.errorMessage : undefined;
      agentEndPayload ??= {
        messages: [outcome.assistant],
        ...(errorMessage ? { errorMessage } : {}),
        outcome,
      };
      return outcome;
    };
    const fail = (message: string): SparkRunOutcome => {
      const terminalAssistant = loopTerminalAssistant(
        lastAssistant,
        safeGetModel(this.getModel),
        "error",
        message,
      );
      this.promptItems.push(asProviderMessageItem(terminalAssistant));
      return finishAgentTurn({
        status: "failed",
        assistant: terminalAssistant,
        roundtrips,
        errorMessage: message,
      });
    };
    const abort = (message: string): SparkRunOutcome => {
      const terminalAssistant = loopTerminalAssistant(
        lastAssistant,
        safeGetModel(this.getModel),
        "aborted",
        message,
      );
      this.promptItems.push(asProviderMessageItem(terminalAssistant));
      return finishAgentTurn({
        status: "aborted",
        assistant: terminalAssistant,
        roundtrips,
        reason: message,
      });
    };

    try {
      let skipLifecycle = options.skipInitialLifecycle ?? false;
      const lifecycleSource = options.lifecycleSource ?? "agentLoop";
      while (true) {
        if (this.state === "aborting") break;
        if (!skipLifecycle) {
          await this.host.emit("turn_start", { source: lifecycleSource });
          await this.injectBeforeAgentStartMessages(lifecycleSource);
        }
        skipLifecycle = false;
        this.transition("streaming");
        roundtrips += 1;

        const abortController = new AbortController();
        this.currentAbort = abortController;
        const tools = this.collectActiveTools();
        const messageCountBeforeAssistant = this.promptItems.length;
        const promptCache = resolveSparkPromptCache({
          systemPrompt: this.systemPrompt,
          sessionId: this.viewSessionId,
          ...this.promptCacheOptions,
        });
        const context = {
          systemPrompt: this.systemPrompt || undefined,
          systemPromptStable: promptCache.stablePrompt || undefined,
          systemPromptDynamic: promptCache.dynamicPrompt || undefined,
          promptCacheKey: promptCache.promptCacheKey,
          promptCache,
          messages: lowerSparkPromptItems(this.promptItems) as Message[],
          tools,
        } as Context;

        let assistant: AssistantMessage;
        try {
          const reasoning = this.getReasoning?.();
          const model = this.getModel();
          const manifest = buildSparkPromptManifest({
            promptVersion: this.promptManifestOptions.promptVersion,
            sessionId: this.viewSessionId,
            model: {
              provider: model?.provider,
              id: model?.id,
              api: model?.api,
            },
            reasoning,
            stablePrompt: promptCache.stablePrompt,
            dynamicPrompt: promptCache.dynamicPrompt,
            stableHash: promptCache.stableHash,
            dynamicHash: promptCache.dynamicHash,
            promptCacheKey: promptCache.promptCacheKey,
            promptCacheDisabledReason: promptCache.disabledReason,
            tools: this.host.listTools().map((tool) => {
              const policy = resolvedRegisteredToolPolicy(tool);
              return {
                name: tool.config.name,
                active: this.isToolAvailable(tool),
                effect: policy.effect,
                executionMode: policy.executionMode,
                requiresApproval: policy.approval === "required",
                domains: policy.domains,
                phases: policy.phases,
              };
            }),
            selectedSkills: safeSelectedSkills(this.promptManifestOptions.getSelectedSkills),
            roundtripIndex: roundtrips,
            maxParallelToolCalls: this.maxParallelToolCalls,
          });
          this.lastPromptManifest = manifest;
          this.publish({ type: "prompt_manifest", manifest });
          const stream = this.streamFunction(model, context, {
            signal: abortController.signal,
            promptCacheKey: promptCache.promptCacheKey,
            prompt_cache_key: promptCache.promptCacheKey,
            ...(reasoning !== undefined ? { reasoning } : {}),
          } as StreamOptions);
          const consume = this.consumeAssistantStream(stream, abortController);
          assistant =
            this.streamTimeoutMs > 0
              ? await runWithTimeout(
                  consume,
                  this.streamTimeoutMs,
                  `Spark agent model stream timed out after ${this.streamTimeoutMs}ms`,
                  (error) => {
                    (error as Error & { code?: string }).code ??= "STREAM_WALL_TIMEOUT";
                    abortController.abort(error);
                  },
                )
              : await consume;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            (this.state as SparkAgentLoopState) === "aborting" ||
            (abortController.signal.aborted && this.currentAbortReason)
          ) {
            return abort(this.currentAbortReason ?? message);
          }
          this.publish({ type: "error", message });
          return fail(message);
        }

        if (!assistant) {
          const message = "stream produced no assistant message";
          this.publish({ type: "error", message });
          return fail(message);
        }

        const toolCalls = collectToolCalls(assistant);
        if (
          assistant.stopReason !== "error" &&
          assistant.stopReason !== "aborted" &&
          toolCalls.length === 0 &&
          !displaySafeAssistantText(assistant.content).trim()
        ) {
          const message = "model completed without a displayable response";
          this.publish({ type: "error", message });
          return fail(message);
        }

        this.promptItems.push(asProviderMessageItem(assistant));
        lastAssistant = assistant;
        this.publish({ type: "turn_complete", assistant, reason: assistant.stopReason });
        await this.host.emit("turn_end", { message: assistant, toolResults: [] });

        if (assistant.stopReason === "aborted") {
          return finishAgentTurn({
            status: "aborted",
            assistant,
            roundtrips,
            reason: assistant.errorMessage?.trim() || this.currentAbortReason || "provider_abort",
          });
        }
        if (assistant.stopReason === "error") {
          return finishAgentTurn({
            status: "failed",
            assistant,
            roundtrips,
            errorMessage: assistant.errorMessage?.trim() || "provider stream failed",
          });
        }

        // Tool calls require execution and another stream pass.
        if (toolCalls.length === 0) {
          this.drainOutboxIntoMessages();
          // If the outbox didn't add anything beyond the assistant we just
          // pushed, the turn is over. Compare against the snapshot taken
          // before this round, plus 1 for the assistant message itself.
          if (this.promptItems.length === messageCountBeforeAssistant + 1) {
            return finishAgentTurn({ status: "completed", assistant, roundtrips });
          }
          // Outbox queued more user/runtime messages; loop again.
          continue;
        }

        this.transition("tooling");
        const toolResults = await this.dispatchToolCalls(toolCalls, abortController.signal);
        for (const result of toolResults) {
          this.promptItems.push(asProviderMessageItem(result));
          this.publish({ type: "tool_result", message: result });
          this.publishEntityViewsForToolResult(result);
        }

        this.drainOutboxIntoMessages();
      }

      if (this.state === "aborting") {
        return abort(this.currentAbortReason ?? "user_abort");
      }

      const message = "agent loop stopped without a terminal outcome";
      this.publish({ type: "error", message });
      return fail(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.state === "aborting" || this.currentAbortReason) {
        return abort(this.currentAbortReason ?? message);
      }
      this.publish({ type: "error", message });
      return fail(message);
    } finally {
      this.currentAbort = undefined;
      this.currentAbortReason = undefined;
      this.transition("idle");
      await this.host.emit(
        "agent_end",
        agentEndPayload ?? (lastAssistant ? { messages: [lastAssistant] } : { messages: [] }),
      );
    }
  }

  private async dispatchToolCalls(
    toolCalls: ToolCall[],
    signal: AbortSignal,
  ): Promise<ToolResultMessage[]> {
    // Fail closed for mixed batches. Unknown, stateful, write-capable, or
    // approval-gated tools preserve the historical one-at-a-time semantics for
    // the whole assistant message. This also keeps reads ordered around writes.
    const mayRunInParallel =
      toolCalls.length > 1 && toolCalls.every((toolCall) => this.isParallelReadToolCall(toolCall));
    if (!mayRunInParallel) {
      const results: ToolResultMessage[] = [];
      for (const toolCall of toolCalls) {
        if ((this.state as SparkAgentLoopState) === "aborting" || signal.aborted) {
          results.push(
            errorToolResult(toolCall, "tool call skipped because the agent was aborted"),
          );
          continue;
        }
        results.push(await this.dispatchToolCall(toolCall, signal));
      }
      return results;
    }

    // Execution may finish out of order, but orderedParallelMap writes each
    // value into its source index. The transcript and all public result/entity
    // events are therefore committed in the assistant's original call order.
    return await orderedParallelMap(toolCalls, this.maxParallelToolCalls, async (toolCall) => {
      if ((this.state as SparkAgentLoopState) === "aborting" || signal.aborted) {
        return errorToolResult(toolCall, "tool call skipped because the agent was aborted");
      }
      // A host may replace a registered tool while earlier calls in this
      // bounded batch are still running. Re-check immediately before launch
      // so a queued call cannot inherit stale read-only eligibility.
      const tool = this.host.getTool(toolCall.name);
      if (tool && !this.isToolAvailable(tool)) {
        return errorToolResult(toolCall, this.toolUnavailableMessage(toolCall.name, tool));
      }
      if (!this.isParallelReadToolCall(toolCall)) {
        return errorToolResult(
          toolCall,
          `tool execution policy changed before dispatch: ${toolCall.name}`,
        );
      }
      return await this.dispatchToolCall(toolCall, signal);
    });
  }

  private isParallelReadToolCall(toolCall: ToolCall): boolean {
    const tool = this.host.getTool(toolCall.name);
    if (!tool || !this.isToolAvailable(tool)) return false;
    const policy = resolvedRegisteredToolPolicy(tool);
    return (
      policy.effect === "read" && policy.executionMode === "parallel" && !toolRequiresApproval(tool)
    );
  }

  private async consumeAssistantStream(
    stream: ReturnType<SparkAgentStreamFunction>,
    abortController: AbortController,
  ): Promise<AssistantMessage> {
    let assistant;
    const idleMs = this.streamIdleTimeoutMs;
    if (idleMs <= 0) {
      for await (const event of stream) {
        this.publish({ type: "stream_event", event });
        if (event.type === "done" || event.type === "error") {
          assistant = event.type === "done" ? event.message : event.error;
        }
      }
      return assistant ?? (await stream.result());
    }

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectIdle: ((error: Error) => void) | undefined;
    const clearIdle = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        const error = Object.assign(
          new Error(`Spark agent model stream idle for ${idleMs}ms with no events`),
          { name: "SparkAgentLoopIdleTimeoutError", code: "STREAM_IDLE_TIMEOUT" },
        );
        abortController.abort(error);
        rejectIdle?.(error);
      }, idleMs);
      idleTimer.unref?.();
    };

    try {
      armIdle();
      const idleWatch = new Promise<never>((_resolve, reject) => {
        rejectIdle = reject;
      });
      const consume = (async () => {
        for await (const event of stream) {
          armIdle();
          this.publish({ type: "stream_event", event });
          if (event.type === "done" || event.type === "error") {
            assistant = event.type === "done" ? event.message : event.error;
          }
        }
        return assistant ?? (await stream.result());
      })();
      return await Promise.race([consume, idleWatch]);
    } finally {
      clearIdle();
      rejectIdle = undefined;
    }
  }

  private async dispatchToolCall(
    toolCall: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResultMessage> {
    try {
      const tool = this.host.getTool(toolCall.name);
      if (!tool) {
        return errorToolResult(toolCall, `unknown tool: ${toolCall.name}`);
      }
      if (!this.isToolAvailable(tool)) {
        return errorToolResult(toolCall, this.toolUnavailableMessage(toolCall.name, tool));
      }

      const ctx: SparkHostContext = this.host.makeContext({
        model: this.getModel(),
        sessionId: this.viewSessionId,
      });
      const approval = await this.requestToolApprovalIfNeeded(toolCall, tool, signal);
      if (!approval.approved) return errorToolResult(toolCall, approval.message);
      if (this.host.getTool(toolCall.name) !== tool) {
        return errorToolResult(
          toolCall,
          `tool execution policy changed before dispatch: ${toolCall.name}`,
        );
      }
      if (!this.isToolAvailable(tool)) {
        return errorToolResult(toolCall, this.toolUnavailableMessage(toolCall.name, tool));
      }

      const onUpdate = (update: { content: Array<{ type: "text"; text: string }> }): void => {
        this.publishViewEvent({
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: this.viewSessionId,
          message: toolUpdateToMessageView(toolCall, update),
        });
      };
      const toolAbort = new AbortController();
      const cleanupAbort = relayAbort(signal, toolAbort);
      try {
        const result = await runWithTimeout(
          tool.config.execute(toolCall.id, toolCall.arguments, toolAbort.signal, onUpdate, ctx),
          this.toolTimeoutMs,
          `Spark tool "${toolCall.name}" timed out after ${this.toolTimeoutMs}ms`,
          (error) => toolAbort.abort(error),
        );
        const compacted = compactToolResultContent({
          toolName: toolCall.name,
          args: toolCall.arguments,
          content: result.content,
        });
        const recoveryDecision = shouldRecordRawToolResultArtifact({
          toolName: toolCall.name,
          isError: result.isError ?? false,
          compaction: compacted.details,
        });
        const rawRecovery = recoveryDecision.record
          ? await this.recordRawToolResultArtifact({
              toolCall,
              result,
              ctx,
              decision: recoveryDecision,
              signal: toolAbort.signal,
            })
          : undefined;
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: (rawRecovery
            ? appendRawRecoveryHint(compacted.content, rawRecovery.readHint)
            : compacted.content) as ToolResultMessage["content"],
          details: mergeToolResultDetails(result.details, compacted.details, rawRecovery),
          isError: result.isError ?? false,
          timestamp: Date.now(),
        };
      } finally {
        cleanupAbort();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(toolCall, message);
    }
  }

  private async recordRawToolResultArtifact(input: {
    toolCall: ToolCall;
    result: {
      content: Array<{ type: string; text?: string; [key: string]: unknown }>;
      details?: unknown;
      isError?: boolean;
    };
    ctx: SparkHostContext;
    decision: SparkToolResultRawRecoveryDecision;
    signal: AbortSignal;
  }): Promise<ToolResultRawRecoveryRecord | undefined> {
    if (input.toolCall.name === "artifact" || input.toolCall.name === "evidence") return undefined;
    const evidenceTool = this.host.getTool("evidence") ?? this.host.getTool("artifact");
    if (!evidenceTool || !this.isToolAvailable(evidenceTool)) return undefined;
    const rawBody = rawToolResultArtifactBody(input.result.content);
    const artifactAbort = new AbortController();
    const cleanupAbort = relayAbort(input.signal, artifactAbort);
    try {
      throwIfSignalAborted(artifactAbort.signal);
      const recorded = await runWithTimeout(
        runWithAbort(
          evidenceTool.config.execute(
            `internal-raw-output:${input.toolCall.id}`,
            {
              action: "record",
              kind: "trace",
              title: `Raw tool output for ${input.toolCall.name}`,
              format: rawBody.format,
              body: rawBody.body,
              curation: { status: "raw", retention: "ephemeral" },
              provenance: {
                producer: rawToolOutputProducer(input.toolCall.name),
                note: `Raw recoverable tool result for ${input.toolCall.name} (${input.decision.reason ?? "compaction"})`,
              },
            },
            artifactAbort.signal,
            () => undefined,
            input.ctx,
          ),
          artifactAbort.signal,
        ),
        this.toolTimeoutMs,
        `Spark raw tool-result artifact persistence timed out after ${this.toolTimeoutMs}ms`,
        (error) => artifactAbort.abort(error),
      );
      const artifactRef = artifactRefFromToolResult(recorded);
      if (!artifactRef) return undefined;
      const recoveryPath = rawToolResultRecoveryPath(artifactRef);
      return {
        artifactRef,
        reason: input.decision.reason ?? "lossy_compaction",
        omittedChars: input.decision.omittedChars ?? 0,
        bodyChars: rawBody.bodyChars,
        recoveryPath,
        readHint: `Full raw tool output saved as ${artifactRef}; recover with evidence({ action: "read", artifactRef: "${artifactRef}", maxChars: 20000 })`,
      };
    } catch {
      // Raw recovery must never make the original tool call fail. The compacted
      // result remains useful even if artifact persistence is unavailable.
      return undefined;
    } finally {
      cleanupAbort();
    }
  }

  private async requestToolApprovalIfNeeded(
    toolCall: ToolCall,
    tool: SparkTurnRegisteredTool,
    signal: AbortSignal,
  ): Promise<{ approved: true } | { approved: false; message: string }> {
    if (!toolRequiresApproval(tool)) return { approved: true };

    const reason = `Tool "${toolCall.name}" requires approval before execution.`;
    switch (this.approvalMethod) {
      case "skip":
        return { approved: true };
      case "human":
        return await this.requestHumanToolApproval(toolCall, reason, signal);
      case "auto": {
        const review = await this.runAutoToolApproval(toolCall, reason, signal);
        throwIfSignalAborted(signal);
        if (review.outcome === "approved") return { approved: true };
        const rejectMessage =
          review.summary.trim() || `tool "${toolCall.name}" was not auto-approved`;
        if (this.approvalRejectAction === "deny") {
          return { approved: false, message: rejectMessage };
        }
        return await this.requestHumanToolApproval(toolCall, rejectMessage, signal);
      }
      default: {
        const _exhaustive: never = this.approvalMethod;
        return _exhaustive;
      }
    }
  }

  private async runAutoToolApproval(
    toolCall: ToolCall,
    reason: string,
    signal: AbortSignal,
  ): Promise<SparkToolApprovalReviewResult> {
    if (!this.reviewToolApproval) {
      return {
        outcome: "blocked",
        summary: `tool "${toolCall.name}" auto-review unavailable; escalate to ask`,
      };
    }
    try {
      const result = await this.reviewToolApproval(
        {
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          arguments: (toolCall.arguments ?? {}) as Record<string, unknown>,
          reason,
        },
        signal,
      );
      if (result.outcome === "approved") return result;
      if (result.outcome === "needs_changes" || result.outcome === "blocked") return result;
      const _exhaustive: never = result.outcome;
      return _exhaustive;
    } catch (error) {
      throwIfSignalAborted(signal);
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome: "blocked",
        summary: `tool "${toolCall.name}" auto-review failed: ${message}`,
      };
    }
  }

  private async requestHumanToolApproval(
    toolCall: ToolCall,
    reason: string,
    signal: AbortSignal,
  ): Promise<{ approved: true } | { approved: false; message: string }> {
    throwIfSignalAborted(signal);
    const response = await runWithTimeout(
      runWithAbort(
        this.host.requestInteraction({
          version: SPARK_PROTOCOL_VERSION,
          kind: "toolApproval",
          requestId: `tool-approval:${toolCall.id}:${Date.now().toString(36)}`,
          title: `Approve tool: ${toolCall.name}`,
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          arguments: toolCall.arguments as never,
          reason,
          approveLabel: "Approve",
          rejectLabel: "Reject",
          metadata: { source: "SparkAgentLoop" },
        }),
        signal,
      ),
      this.interactionTimeoutMs,
      `Spark tool approval for "${toolCall.name}" timed out after ${this.interactionTimeoutMs}ms`,
    );
    if (response.kind === "toolApproval" && response.status === "answered" && response.approved) {
      return { approved: true };
    }
    return {
      approved: false,
      message:
        response.message ??
        `tool "${toolCall.name}" was not approved (${response.status || "blocked"})`,
    };
  }

  private collectActiveTools(): Tool[] {
    return this.host
      .listTools()
      .filter((entry) => this.isToolAvailable(entry))
      .map((entry) => toToolDefinition(entry.config));
  }

  /** The single availability boundary shared by schemas, manifests, and dispatch. */
  private isToolAvailable(tool: SparkTurnRegisteredTool): boolean {
    if (!tool.active) return false;
    const phases = resolvedRegisteredToolPolicy(tool).phases;
    return (
      this.currentPhase === undefined || phases.length === 0 || phases.includes(this.currentPhase)
    );
  }

  private toolUnavailableMessage(toolName: string, tool: SparkTurnRegisteredTool): string {
    if (!tool.active) return `inactive tool: ${toolName}`;
    const phases = resolvedRegisteredToolPolicy(tool).phases;
    return `phase-inactive tool: ${toolName} (current phase=${this.currentPhase ?? "none"}; allowed phases=${phases.join(",") || "all"})`;
  }

  private async injectBeforeAgentStartMessages(source: SparkAgentLifecycleSource): Promise<number> {
    const results = await this.host.emit("before_agent_start", { source });
    let injected = 0;
    for (const result of results) {
      for (const item of beforeAgentStartPromptItems(result)) {
        this.promptItems.push(item);
        if (item.visibility === "visible") this.publish({ type: "runtime_message", item });
        injected += 1;
      }
    }
    return injected;
  }

  /**
   * Drain the host outbox between turns and retain runtime authority until the
   * provider context is assembled.
   */
  private drainOutboxIntoMessages(
    options: {
      includeNextTurn?: boolean;
      incoming?: readonly SparkTurnOutboxEnvelope[];
    } = {},
  ): number {
    let appended = 0;
    const incoming = [...(options.incoming ?? []), ...this.host.drainOutbox()];
    const deferred = options.includeNextTurn
      ? (this.deferredOutboxBySession.get(this.viewSessionId) ?? [])
      : [];
    if (options.includeNextTurn) this.deferredOutboxBySession.delete(this.viewSessionId);
    const envelopes = [...deferred, ...incoming];
    for (const envelope of envelopes) {
      const envelopeSessionId = envelope.sessionId ?? this.viewSessionId;
      if (envelopeSessionId !== this.viewSessionId) {
        this.deferOutboxEnvelope(envelopeSessionId, envelope);
        continue;
      }
      if (envelope.options.deliverAs === "nextTurn" && !options.includeNextTurn) {
        this.deferOutboxEnvelope(envelopeSessionId, envelope);
        continue;
      }
      if (envelope.kind === "user") {
        const content =
          typeof envelope.content === "string"
            ? envelope.content
            : envelope.content.map((part) => ("text" in part ? String(part.text) : "")).join("");
        const message: UserMessage = {
          role: "user",
          content,
          timestamp: envelope.enqueuedAt,
        };
        this.promptItems.push(asProviderMessageItem(message));
        this.publish({ type: "user_message", message });
        appended += 1;
      } else {
        const controlIsExplicitlyTrusted =
          envelope.authority === "runtime_control" && envelope.trust === "trusted";
        const authority = controlIsExplicitlyTrusted ? "runtime_control" : "runtime_data";
        const trust = controlIsExplicitlyTrusted
          ? "trusted"
          : envelope.authority === "runtime_data" && envelope.trust === "trusted"
            ? "trusted"
            : "untrusted";
        const item = sparkRuntimePromptItem({
          authority,
          trust,
          visibility: envelope.display === false ? "hidden" : "visible",
          persistence: "session",
          content: envelope.content,
          ...(envelope.customType ? { customType: envelope.customType } : {}),
          ...(envelope.details ? { details: envelope.details } : {}),
          timestamp: envelope.enqueuedAt,
        });
        this.promptItems.push(item);
        if (item.visibility === "visible") this.publish({ type: "runtime_message", item });
        appended += 1;
      }
    }
    return appended;
  }

  private deferOutboxEnvelope(sessionId: string, envelope: SparkTurnOutboxEnvelope): void {
    const pending = this.deferredOutboxBySession.get(sessionId) ?? [];
    pending.push(envelope);
    this.deferredOutboxBySession.set(sessionId, pending);
  }

  private transition(next: SparkAgentLoopState): void {
    this.state = next;
    this.host.setIdle(next === "idle");
  }

  private startViewRun(summary: string): void {
    const runId = `${this.viewSessionId}:run:${Date.now().toString(36)}:${++this.viewRunCounter}`;
    this.currentViewRunId = runId;
    this.currentViewRunUsage = undefined;
    this.currentAssistantMessageId = undefined;
    this.currentAssistantPartial = undefined;
    this.currentAssistantProjection = undefined;
    this.publishViewEvent({
      version: SPARK_PROTOCOL_VERSION,
      type: "run.update",
      sessionId: this.viewSessionId,
      run: {
        version: SPARK_PROTOCOL_VERSION,
        id: runId,
        kind: "session",
        status: "running",
        summary,
        startedAt: new Date().toISOString(),
        artifactRefs: [],
        metadata: { source: "SparkAgentLoop" },
      },
    });
  }

  private assistantMessageId(): string {
    this.currentAssistantMessageId ??= nextViewMessageId(this.viewSessionId, "assistant");
    return this.currentAssistantMessageId;
  }

  private takeAssistantMessageId(): string {
    const id = this.assistantMessageId();
    this.currentAssistantMessageId = undefined;
    this.currentAssistantPartial = undefined;
    this.currentAssistantProjection = undefined;
    return id;
  }

  private publish(event: SparkAgentLoopEvent): void {
    if (event.type !== "view_event") this.publishViewForLoopEvent(event);
    for (const subscriber of Array.from(this.subscribers)) {
      try {
        subscriber(event);
      } catch {
        // Subscribers are best-effort observers; never fail the loop.
      }
    }
  }

  private publishViewForLoopEvent(
    event: Exclude<SparkAgentLoopEvent, { type: "view_event" }>,
  ): void {
    switch (event.type) {
      case "user_message":
        this.publishViewEvent({
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: this.viewSessionId,
          message: messageToView(event.message, nextViewMessageId(this.viewSessionId, "user")),
        });
        return;
      case "runtime_message":
        if (event.item.visibility === "hidden") return;
        this.publishViewEvent({
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: this.viewSessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: nextViewMessageId(this.viewSessionId, "runtime"),
            role: "custom",
            text: sparkPromptItemText(event.item),
            status: "done",
            metadata: jsonMetadata({
              authority: event.item.authority,
              trust: event.item.trust,
              persistence: event.item.persistence,
              customType: event.item.customType,
            }),
          },
        });
        return;
      case "prompt_manifest":
        // Privacy-safe structured telemetry is intentionally not projected as
        // a conversation message. Observability subscribers consume it.
        return;
      case "stream_event":
        this.publishStreamViewEvent(event.event);
        return;
      case "tool_result":
        this.publishViewEvent({
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: this.viewSessionId,
          message: toolResultToMessageView(event.message),
        });
        return;
      case "turn_complete":
        this.currentViewRunUsage = mergeRunUsageTotals(
          this.currentViewRunUsage,
          assistantRunUsage(event.assistant, safeGetModel(this.getModel)),
        );
        this.publishViewEvent({
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: this.viewSessionId,
          message: assistantToMessageView(
            event.assistant,
            this.takeAssistantMessageId(),
            event.reason === "error" ? "error" : "done",
          ),
        });
        this.publishCurrentRunStatus(
          runStatusForStopReason(event.reason),
          formatAssistantUsageSummary(event.assistant),
        );
        return;
      case "run_outcome":
        // turn_complete/abort/error own the visible projection. The structured
        // outcome is for callers and observability subscribers.
        return;
      case "abort":
        this.publishCurrentAssistantTerminal(event.reason, "aborted", false);
        this.publishCurrentRunStatus("cancelled", event.reason);
        return;
      case "error":
        this.publishCurrentAssistantTerminal(event.message, "error", true);
        this.publishViewEvent({
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: this.viewSessionId,
          message: {
            version: SPARK_PROTOCOL_VERSION,
            id: nextViewMessageId(this.viewSessionId, "error"),
            role: "system",
            text: event.message,
            status: "error",
            metadata: {},
          },
        });
        this.publishCurrentRunStatus("failed", event.message);
        return;
    }
  }

  private publishStreamViewEvent(event: AssistantMessageEvent): void {
    if (event.type === "start") {
      // A fresh assistant message begins: rotate to a new stable view id so
      // multi-roundtrip turns append in chronological order instead of
      // overwriting the first assistant bubble in place.
      this.currentAssistantMessageId = nextViewMessageId(this.viewSessionId, "assistant");
      this.currentAssistantPartial = undefined;
      this.currentAssistantProjection = undefined;
    }
    const partial = "partial" in event ? event.partial : undefined;
    if (partial && typeof partial === "object") {
      this.currentAssistantPartial = partial as AssistantMessage;
      const message = assistantToMessageView(
        this.currentAssistantPartial,
        this.assistantMessageId(),
        "streaming",
      );
      if (!sameMessageProjection(this.currentAssistantProjection, message)) {
        this.currentAssistantProjection = message;
        this.publishViewEvent({
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: this.viewSessionId,
          message,
        });
      }
    }
    if (event.type === "toolcall_end") {
      const toolCall = "toolCall" in event ? event.toolCall : undefined;
      if (!toolCall) return;
      this.publishViewEvent({
        version: SPARK_PROTOCOL_VERSION,
        type: "session.message",
        sessionId: this.viewSessionId,
        message: toolCallToMessageView(toolCall),
      });
    }
  }

  private publishCurrentAssistantTerminal(
    message: string,
    stopReason: "aborted" | "error",
    release: boolean,
  ): void {
    const partial = this.currentAssistantPartial;
    const id = this.currentAssistantMessageId;
    if (!partial || !id) return;
    this.publishViewEvent({
      version: SPARK_PROTOCOL_VERSION,
      type: "session.message",
      sessionId: this.viewSessionId,
      message: assistantToMessageView(
        { ...partial, stopReason, errorMessage: message },
        id,
        "error",
      ),
    });
    if (release) {
      this.currentAssistantPartial = undefined;
      this.currentAssistantMessageId = undefined;
      this.currentAssistantProjection = undefined;
    }
  }

  private publishEntityViewsForToolResult(message: ToolResultMessage): void {
    for (const task of taskViewsFromToolDetails(message.details, {
      sourceTool: message.toolName,
      toolCallId: message.toolCallId,
    })) {
      this.publishViewEvent({
        version: SPARK_PROTOCOL_VERSION,
        type: "task.update",
        task,
      });
    }
    for (const entity of entityViewsFromToolDetails(message.details, {
      sourceTool: message.toolName,
      toolCallId: message.toolCallId,
    })) {
      if (entity.type === "artifact") {
        this.publishViewEvent({
          version: SPARK_PROTOCOL_VERSION,
          type: "artifact.update",
          artifact: entity.artifact,
        });
        continue;
      }
      this.publishViewEvent({
        version: SPARK_PROTOCOL_VERSION,
        type: "evidence.update",
        evidence: entity.evidence,
      });
    }
  }

  private publishCurrentRunStatus(status: SparkRunView["status"], summary?: string): void {
    const runId = this.currentViewRunId;
    if (!runId) return;
    this.publishViewEvent({
      version: SPARK_PROTOCOL_VERSION,
      type: "run.update",
      sessionId: this.viewSessionId,
      run: {
        version: SPARK_PROTOCOL_VERSION,
        id: runId,
        kind: "session",
        status,
        summary,
        completedAt:
          status === "running" || status === "queued" ? undefined : new Date().toISOString(),
        artifactRefs: [],
        metadata: jsonMetadata({
          source: "SparkAgentLoop",
          ...(this.currentViewRunUsage ? { usageTotals: this.currentViewRunUsage } : {}),
        }),
      },
    });
    if (status !== "running" && status !== "queued") {
      this.currentViewRunId = undefined;
      this.currentViewRunUsage = undefined;
    }
  }

  private publishViewEvent(event: SparkViewModelEvent): void {
    this.host.publishView(event);
    this.publish({ type: "view_event", event });
  }
}

function sameMessageProjection(
  previous: SparkMessageView | undefined,
  next: SparkMessageView,
): boolean {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next);
}

export function splitSparkSystemPrompt(systemPrompt: string): {
  stablePrompt: string;
  dynamicPrompt: string;
} {
  const sections = systemPrompt.split(/\n{2,}/u);
  const stable: string[] = [];
  const dynamic: string[] = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (isDynamicPromptSection(trimmed)) dynamic.push(trimmed);
    else stable.push(trimmed);
  }
  return { stablePrompt: stable.join("\n\n"), dynamicPrompt: dynamic.join("\n\n") };
}

export function resolveSparkPromptCache(input: {
  systemPrompt: string;
  sessionId: string;
  enabled?: boolean;
  checkpoint?: string;
  keyPrefix?: string;
  env?: Record<string, string | undefined>;
}): SparkPromptCacheSnapshot {
  const { stablePrompt, dynamicPrompt } = splitSparkSystemPrompt(input.systemPrompt);
  const stableHash = hashText(stablePrompt);
  const dynamicHash = hashText(dynamicPrompt);
  if (input.enabled === false) {
    return { stablePrompt, dynamicPrompt, stableHash, dynamicHash, disabledReason: "option" };
  }
  const env = input.env ?? process.env;
  if (env.SPARK_PROMPT_CACHE === "off" || env.SPARK_PROMPT_CACHE_KEY === "off") {
    return { stablePrompt, dynamicPrompt, stableHash, dynamicHash, disabledReason: "env" };
  }
  if (!stablePrompt) {
    return {
      stablePrompt,
      dynamicPrompt,
      stableHash,
      dynamicHash,
      disabledReason: "empty_stable_prompt",
    };
  }
  const rawCheckpoint = sanitizePromptCacheKeyPart(input.checkpoint ?? stableHash.slice(0, 12));
  const prefix = boundedPromptCacheKeyPart(
    sanitizePromptCacheKeyPart(input.keyPrefix ?? "spark") || "spark",
    12,
  );
  // Provider adapters cap prompt-cache keys at 64 characters. Hash the
  // session identity before composing the key so a long common prefix cannot
  // push the stable prompt fingerprint and checkpoint past that boundary.
  const sessionPart = hashText(input.sessionId).slice(0, 16);
  const stablePart = stableHash.slice(0, 16);
  const fixedPrefix = `${prefix}:${sessionPart}:${stablePart}:`;
  const checkpoint = boundedPromptCacheKeyPart(
    rawCheckpoint || stableHash.slice(0, 12),
    64 - fixedPrefix.length,
  );
  return {
    stablePrompt,
    dynamicPrompt,
    stableHash,
    dynamicHash,
    promptCacheKey: `${fixedPrefix}${checkpoint}`,
  };
}

function isDynamicPromptSection(section: string): boolean {
  return (
    /^Current date(?: and time)?:/imu.test(section) ||
    /^Current working directory:/imu.test(section) ||
    /^Dynamic context checkpoint:/imu.test(section)
  );
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sanitizePromptCacheKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/gu, "-");
}

function boundedPromptCacheKeyPart(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = hashText(value).slice(0, 8);
  const headChars = Math.max(0, maxChars - suffix.length - 1);
  return `${value.slice(0, headChars)}-${suffix}`;
}

interface SparkRunUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  latestCacheHitPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
}

function assistantRunUsage(
  assistant: AssistantMessage,
  model: Model<string> | undefined,
): SparkRunUsageTotals | undefined {
  const usage = (assistant as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = numberField(usage, "input") ?? numberField(usage, "inputTokens") ?? 0;
  const outputTokens = numberField(usage, "output") ?? numberField(usage, "outputTokens") ?? 0;
  const cacheReadTokens =
    numberField(usage, "cacheRead") ?? numberField(usage, "cacheReadTokens") ?? 0;
  const cacheWriteTokens =
    numberField(usage, "cacheWrite") ?? numberField(usage, "cacheWriteTokens") ?? 0;
  const cost = isPlainRecord((usage as Record<string, unknown>).cost)
    ? ((usage as Record<string, unknown>).cost as Record<string, unknown>)
    : {};
  const costUsd =
    numberField(usage, "costUsd") ??
    numberField(cost, "total") ??
    (numberField(cost, "input") ?? 0) +
      (numberField(cost, "output") ?? 0) +
      (numberField(cost, "cacheRead") ?? 0) +
      (numberField(cost, "cacheWrite") ?? 0);
  const contextTokens =
    numberField(usage, "totalTokens") ||
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  const contextWindow = model ? numberField(model, "contextWindow") : undefined;
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0 &&
    costUsd === 0 &&
    contextTokens === 0
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    ...(promptTokens > 0 ? { latestCacheHitPercent: (cacheReadTokens / promptTokens) * 100 } : {}),
    ...(contextTokens > 0 ? { contextTokens } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

function mergeRunUsageTotals(
  current: SparkRunUsageTotals | undefined,
  next: SparkRunUsageTotals | undefined,
): SparkRunUsageTotals | undefined {
  if (!next) return current;
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
    costUsd: (current?.costUsd ?? 0) + next.costUsd,
    ...(next.latestCacheHitPercent !== undefined
      ? { latestCacheHitPercent: next.latestCacheHitPercent }
      : current?.latestCacheHitPercent !== undefined
        ? { latestCacheHitPercent: current.latestCacheHitPercent }
        : {}),
    ...(next.contextTokens !== undefined
      ? { contextTokens: next.contextTokens }
      : current?.contextTokens !== undefined
        ? { contextTokens: current.contextTokens }
        : {}),
    ...(next.contextWindow !== undefined
      ? { contextWindow: next.contextWindow }
      : current?.contextWindow !== undefined
        ? { contextWindow: current.contextWindow }
        : {}),
  };
}

function formatAssistantUsageSummary(assistant: AssistantMessage): string | undefined {
  const usage = (assistant as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const cacheRead = numberField(usage, "cacheRead") ?? numberField(usage, "cacheReadTokens");
  const cacheWrite = numberField(usage, "cacheWrite") ?? numberField(usage, "cacheWriteTokens");
  if (cacheRead === undefined && cacheWrite === undefined) return undefined;
  return `cache read=${cacheRead ?? 0} write=${cacheWrite ?? 0}`;
}

export { SparkAgentLoop as SparkTurnRunner };
