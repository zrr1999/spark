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
 *      with the runtime's `ExtensionContext`. The `ToolResult` is appended
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

// Spark-turn deliberately uses loose structural aliases here: the turn loop is
// host-neutral, while concrete model/message schemas still come from the active
// stream provider (currently pi-ai in spark-tui). Follow-up host extraction can
// tighten these once every entrypoint shares the same type boundary.
export type Model<_TId extends string = string> = any;
export type Tool = any;
export type ToolCall = any;
export type Message = any;
export type AssistantMessage = any;
export type ToolResultMessage = any;
export type Context = any;
export type StreamOptions = any;
export type AssistantMessageEvent = any;

import { createHash } from "node:crypto";

import {
  resolveToolPolicy,
  type ExtensionContext,
  type ResolvedToolPolicy,
  type ToolConfig,
} from "@zendev-lab/spark-extension-api";
import {
  compactToolResultContent,
  shouldRecordRawToolResultArtifact,
  type SparkToolResultRawRecoveryDecision,
  type SparkToolResultRawRecoveryPath,
} from "./tool-result-compaction.ts";
import {
  cloneSparkPromptItem,
  lowerSparkPromptItems,
  sparkPromptItemFromProviderMessage,
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
  sparkTextPhaseFromSignature,
  summarizeToolCallArguments,
  summarizeToolResultContent,
  type SparkArtifactView,
  type SparkConversationPart,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
  type SparkMessageView,
  type SparkRunView,
  type SparkTaskTodoView,
  type SparkTaskView,
  type SparkViewModelEvent,
} from "@zendev-lab/spark-protocol";

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

export interface SparkTurnRegisteredTool {
  config: ToolConfig;
  /** Host-resolved immutable policy. Compatibility hosts may omit it. */
  policy?: ResolvedToolPolicy;
  active: boolean;
}

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
  makeContext(extra?: Partial<ExtensionContext>): ExtensionContext;
  requestInteraction(request: SparkInteractionRequest): Promise<SparkInteractionResponse>;
  listTools(): SparkTurnRegisteredTool[];
  drainOutbox(): SparkTurnOutboxEnvelope[];
  setIdle(idle: boolean): void;
  publishView(event: SparkViewModelEvent): void;
}

export const DEFAULT_SPARK_AGENT_LOOP_STREAM_TIMEOUT_MS = 600_000;
export const DEFAULT_SPARK_AGENT_LOOP_TOOL_TIMEOUT_MS = 300_000;
export const DEFAULT_SPARK_AGENT_LOOP_INTERACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_SPARK_AGENT_LOOP_MAX_PARALLEL_TOOL_CALLS = 4;

/** How a session satisfies `requiresApproval` tool gates. Default: `auto`. */
export type SparkToolApprovalMethod = "skip" | "human" | "auto";

/** When `auto` review does not approve: escalate to ask, or deny the tool call. */
export type SparkToolApprovalRejectAction = "ask" | "deny";

export type SparkToolApprovalReviewOutcome = "approved" | "needs_changes" | "blocked";

export type SparkRunOutcome =
  | { status: "completed"; assistant: AssistantMessage; roundtrips: number }
  | {
      status: "aborted";
      assistant: AssistantMessage;
      roundtrips: number;
      reason: string;
    }
  | {
      status: "budget_exhausted";
      assistant: AssistantMessage;
      roundtrips: number;
      errorMessage: string;
    }
  | {
      status: "failed";
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
  /** Maximum number of model roundtrips per submit. Defaults to 16. */
  maxRoundtrips?: number;
  /** Wall-clock timeout for one model stream pass. Defaults to 10 minutes; <=0 disables. */
  streamTimeoutMs?: number;
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

export type SparkAgentLoopEvent =
  | { type: "stream_event"; event: AssistantMessageEvent }
  | { type: "user_message"; message: Message }
  | { type: "runtime_message"; item: SparkPromptItem }
  | { type: "prompt_manifest"; manifest: SparkPromptManifest }
  | { type: "tool_result"; message: ToolResultMessage }
  | { type: "turn_complete"; assistant: AssistantMessage; reason: AssistantMessage["stopReason"] }
  | { type: "run_outcome"; outcome: SparkRunOutcome }
  | { type: "view_event"; event: SparkViewModelEvent }
  | { type: "abort"; reason: string }
  | { type: "error"; message: string };

export class SparkAgentLoop {
  readonly host: SparkTurnHost;
  private readonly streamFunction: SparkAgentStreamFunction;
  private readonly getModel: () => Model<string>;
  private readonly maxRoundtrips: number;
  private readonly streamTimeoutMs: number;
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
  private readonly subscribers = new Set<(event: SparkAgentLoopEvent) => void>();

  constructor(options: SparkAgentLoopOptions) {
    this.host = options.host;
    this.streamFunction = options.streamFunction;
    this.getModel = options.getModel;
    this.systemPrompt = options.systemPrompt ?? "";
    this.promptCacheOptions = options.promptCache ?? {};
    this.promptManifestOptions = options.promptManifest ?? {};
    this.maxRoundtrips = options.maxRoundtrips ?? 16;
    this.streamTimeoutMs = normalizeTimeoutMs(
      options.streamTimeoutMs,
      DEFAULT_SPARK_AGENT_LOOP_STREAM_TIMEOUT_MS,
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
    this.replacePromptItems(
      messages.map((message) =>
        sparkPromptItemFromProviderMessage(message as Record<string, unknown> & { role: string }),
      ),
    );
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
  async submit(content: string): Promise<AssistantMessage> {
    return (await this.submitWithOutcome(content)).assistant;
  }

  /** Submit a user turn and retain the reason the loop terminated. */
  async submitWithOutcome(content: string): Promise<SparkRunOutcome> {
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
    const userMessage: Message = {
      role: "user",
      content,
      timestamp: Date.now(),
    };
    this.promptItems.push(sparkPromptItemFromProviderMessage(userMessage));
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
    let lastAssistant: AssistantMessage;
    let roundtrips = 0;
    let agentEndPayload:
      | { messages: AssistantMessage[]; errorMessage?: string; outcome?: SparkRunOutcome }
      | undefined;
    const finishAgentTurn = (outcome: SparkRunOutcome): SparkRunOutcome => {
      this.lastOutcome = outcome;
      this.publish({ type: "run_outcome", outcome });
      const errorMessage =
        outcome.status === "failed" || outcome.status === "budget_exhausted"
          ? outcome.errorMessage
          : undefined;
      agentEndPayload ??= {
        messages: [outcome.assistant],
        ...(errorMessage ? { errorMessage } : {}),
        outcome,
      };
      return outcome;
    };
    const fail = (status: "failed" | "budget_exhausted", message: string): SparkRunOutcome => {
      const terminalAssistant = loopTerminalAssistant(
        lastAssistant,
        safeGetModel(this.getModel),
        "error",
        message,
      );
      this.promptItems.push(sparkPromptItemFromProviderMessage(terminalAssistant));
      return finishAgentTurn({
        status,
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
      this.promptItems.push(sparkPromptItemFromProviderMessage(terminalAssistant));
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
      while (roundtrips < this.maxRoundtrips) {
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
        const context: Context = {
          systemPrompt: this.systemPrompt || undefined,
          systemPromptStable: promptCache.stablePrompt || undefined,
          systemPromptDynamic: promptCache.dynamicPrompt || undefined,
          promptCacheKey: promptCache.promptCacheKey,
          promptCache,
          messages: lowerSparkPromptItems(this.promptItems),
          tools,
        };

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
            maxRoundtrips: this.maxRoundtrips,
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
          assistant = await runWithTimeout(
            this.consumeAssistantStream(stream),
            this.streamTimeoutMs,
            `Spark agent model stream timed out after ${this.streamTimeoutMs}ms`,
            (error) => abortController.abort(error),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            (this.state as SparkAgentLoopState) === "aborting" ||
            (abortController.signal.aborted && this.currentAbortReason)
          ) {
            return abort(this.currentAbortReason ?? message);
          }
          this.publish({ type: "error", message });
          return fail("failed", message);
        }

        if (!assistant) {
          const message = "stream produced no assistant message";
          this.publish({ type: "error", message });
          return fail("failed", message);
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
          return fail("failed", message);
        }

        this.promptItems.push(sparkPromptItemFromProviderMessage(assistant));
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
          this.promptItems.push(sparkPromptItemFromProviderMessage(result));
          this.publish({ type: "tool_result", message: result });
          this.publishEntityViewsForToolResult(result);
        }

        this.drainOutboxIntoMessages();
      }

      if (this.state === "aborting") {
        return abort(this.currentAbortReason ?? "user_abort");
      }

      if (roundtrips >= this.maxRoundtrips) {
        const message = `agent loop hit maxRoundtrips=${this.maxRoundtrips}; stopping`;
        this.publish({
          type: "error",
          message,
        });
        return fail("budget_exhausted", message);
      }

      const message = "agent loop stopped without a terminal outcome";
      this.publish({ type: "error", message });
      return fail("failed", message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.state === "aborting" || this.currentAbortReason) {
        return abort(this.currentAbortReason ?? message);
      }
      this.publish({ type: "error", message });
      return fail("failed", message);
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
  ): Promise<AssistantMessage> {
    let assistant: AssistantMessage;
    for await (const event of stream) {
      this.publish({ type: "stream_event", event });
      if (event.type === "done" || event.type === "error") {
        assistant = event.type === "done" ? event.message : event.error;
      }
    }
    return assistant ?? (await stream.result());
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

      const ctx: ExtensionContext = this.host.makeContext({
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
          content: rawRecovery
            ? appendRawRecoveryHint(compacted.content, rawRecovery.readHint)
            : compacted.content,
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
    ctx: ExtensionContext;
    decision: SparkToolResultRawRecoveryDecision;
    signal: AbortSignal;
  }): Promise<ToolResultRawRecoveryRecord | undefined> {
    if (input.toolCall.name === "artifact") return undefined;
    const artifactTool = this.host.getTool("artifact");
    if (!artifactTool || !this.isToolAvailable(artifactTool)) return undefined;
    const rawBody = rawToolResultArtifactBody(input.result.content);
    const artifactAbort = new AbortController();
    const cleanupAbort = relayAbort(input.signal, artifactAbort);
    try {
      throwIfSignalAborted(artifactAbort.signal);
      const recorded = await runWithTimeout(
        runWithAbort(
          artifactTool.config.execute(
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
        readHint: `Full raw tool output saved as ${artifactRef}; recover with artifact({ action: "read", artifactRef: "${artifactRef}", maxChars: 20000 })`,
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
        const message: Message = {
          role: "user",
          content,
          timestamp: envelope.enqueuedAt,
        };
        this.promptItems.push(sparkPromptItemFromProviderMessage(message));
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
    }
    const partial = "partial" in event ? event.partial : undefined;
    if (partial && typeof partial === "object") {
      this.currentAssistantPartial = partial as AssistantMessage;
      this.publishViewEvent({
        version: SPARK_PROTOCOL_VERSION,
        type: "session.message",
        sessionId: this.viewSessionId,
        message: assistantToMessageView(
          this.currentAssistantPartial,
          this.assistantMessageId(),
          "streaming",
        ),
      });
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
    for (const artifact of artifactViewsFromToolDetails(message.details, {
      sourceTool: message.toolName,
      toolCallId: message.toolCallId,
    })) {
      this.publishViewEvent({
        version: SPARK_PROTOCOL_VERSION,
        type: "artifact.update",
        artifact,
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

interface ToolResultRawRecoveryRecord {
  artifactRef: string;
  reason: "lossy_compaction" | "error_compaction";
  omittedChars: number;
  bodyChars: number;
  recoveryPath: SparkToolResultRawRecoveryPath;
  readHint: string;
}

function mergeToolResultDetails(
  originalDetails: unknown,
  compaction: ReturnType<typeof compactToolResultContent>["details"],
  rawRecovery: ToolResultRawRecoveryRecord | undefined,
): unknown {
  if (!compaction && !rawRecovery) return originalDetails;
  return {
    ...(isPlainRecord(originalDetails) ? originalDetails : {}),
    ...(compaction ? { toolResultCompaction: compaction } : {}),
    ...(rawRecovery
      ? {
          toolResultRawRecovery: {
            artifactRef: rawRecovery.artifactRef,
            reason: rawRecovery.reason,
            omittedChars: rawRecovery.omittedChars,
            bodyChars: rawRecovery.bodyChars,
            recoveryPath: rawRecovery.recoveryPath,
            readHint: rawRecovery.readHint,
          },
        }
      : {}),
  };
}

function rawToolResultRecoveryPath(artifactRef: string): SparkToolResultRawRecoveryPath {
  return {
    kind: "artifact",
    artifactRef,
    readTool: "artifact",
    readArgs: { action: "read", artifactRef, maxChars: 20_000 },
  };
}

function appendRawRecoveryHint(
  content: Array<{ type: string; text?: string; [key: string]: unknown }>,
  hint: string,
): Array<{ type: string; text?: string; [key: string]: unknown }> {
  const index = content.findLastIndex(
    (part) => part.type === "text" && typeof part.text === "string",
  );
  const hintText = `[recovery] ${hint}`;
  if (index < 0) return [...content, { type: "text", text: hintText }];
  return content.map((part, partIndex) =>
    partIndex === index ? { ...part, text: `${part.text}\n\n${hintText}` } : part,
  );
}

function rawToolResultArtifactBody(
  content: Array<{ type: string; text?: string; [key: string]: unknown }>,
): { format: "text" | "json"; body: string | Record<string, unknown>; bodyChars: number } {
  if (content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string") {
    return { format: "text", body: content[0].text, bodyChars: content[0].text.length };
  }
  const body = { schemaVersion: 1, content: jsonSafe(content) };
  return { format: "json", body, bodyChars: JSON.stringify(body).length };
}

function rawToolOutputProducer(toolName: string): "spark" | "cue" {
  return toolName.startsWith("cue_") || toolName === "script_run" || toolName === "script_eval"
    ? "cue"
    : "spark";
}

function artifactRefFromToolResult(result: {
  content?: unknown;
  details?: unknown;
}): string | undefined {
  const details = isPlainRecord(result.details) ? result.details : undefined;
  const refs = isPlainRecord(details?.refs) ? details.refs : undefined;
  const fromRefs = stringField(refs, "artifactRef");
  if (fromRefs?.startsWith("artifact:")) return fromRefs;
  const artifact = isPlainRecord(details?.artifact) ? details.artifact : undefined;
  const fromArtifact = stringField(artifact, "ref");
  if (fromArtifact?.startsWith("artifact:")) return fromArtifact;
  const text = Array.isArray(result.content)
    ? result.content
        .map((part) => (isPlainRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("\n")
    : "";
  return text.match(/artifact:[A-Za-z0-9._:-]+/u)?.[0];
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol")
    return value.description ? `[Symbol:${value.description}]` : "[Symbol]";
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      jsonSafe(child, seen),
    ]),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

async function orderedParallelMap<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index]!, index);
    }
  };
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => await worker()));
  return results;
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: (error: Error) => void,
): Promise<T> {
  if (timeoutMs <= 0) return await promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.name = "SparkAgentLoopTimeoutError";
          onTimeout?.(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfSignalAborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortSignalError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function throwIfSignalAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortSignalError(signal);
}

function abortSignalError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" && reason ? reason : "operation aborted");
  error.name = "AbortError";
  return error;
}

function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort((source as { reason?: unknown }).reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function beforeAgentStartPromptItems(result: unknown): SparkPromptItem[] {
  if (!result || typeof result !== "object") return [];
  const record = result as { message?: unknown; messages?: unknown };
  const messages = Array.isArray(record.messages) ? record.messages : [record.message];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const content = (message as { content?: unknown }).content;
    if (typeof content !== "string" || !content.trim()) return [];
    const authorityValue = (message as { authority?: unknown }).authority;
    const trustValue = (message as { trust?: unknown }).trust;
    const controlIsExplicitlyTrusted =
      authorityValue === "runtime_control" && trustValue === "trusted";
    const authority = controlIsExplicitlyTrusted ? "runtime_control" : "runtime_data";
    const trust =
      controlIsExplicitlyTrusted || (authorityValue === "runtime_data" && trustValue === "trusted")
        ? "trusted"
        : "untrusted";
    const customType = (message as { customType?: unknown }).customType;
    const details = (message as { details?: unknown }).details;
    return [
      sparkRuntimePromptItem({
        authority,
        trust,
        visibility: (message as { display?: unknown }).display === false ? "hidden" : "visible",
        // before_agent_start is regenerated from current host state on every turn.
        persistence: "transient",
        content,
        ...(typeof customType === "string" && customType ? { customType } : {}),
        ...(isPlainRecord(details) ? { details } : {}),
        timestamp: Date.now(),
      }),
    ];
  });
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
  model: Model<string>,
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
  const contextWindow = numberField(model, "contextWindow");
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

function loopTerminalAssistant(
  previous: { api: string; provider: string; model: string } | undefined,
  model: Model<string>,
  stopReason: "error" | "aborted",
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: previous?.api ?? model?.api ?? "unknown",
    provider: previous?.provider ?? model?.provider ?? "spark",
    model: previous?.model ?? model?.id ?? "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function safeGetModel(getModel: () => Model<string>): Model<string> {
  try {
    return getModel();
  } catch {
    return undefined;
  }
}

function numberField(value: object, field: string): number | undefined {
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function collectToolCalls(message: AssistantMessage): ToolCall[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter(
    (part: SparkTurnContentPart) => part.type === "toolCall",
  ) as ToolCall[];
}

function resolvedRegisteredToolPolicy(tool: SparkTurnRegisteredTool): ResolvedToolPolicy {
  const policy = tool.policy ?? resolveToolPolicy(tool.config);
  if (!legacyApprovalPolicyRequiresApproval(tool.config) || policy.approval === "required") {
    return policy;
  }
  return Object.freeze({
    ...policy,
    executionMode: "sequential",
    approval: "required",
  });
}

function toolRequiresApproval(tool: SparkTurnRegisteredTool): boolean {
  return resolvedRegisteredToolPolicy(tool).approval === "required";
}

function legacyApprovalPolicyRequiresApproval(config: ToolConfig): boolean {
  const approvalPolicy = (config as { approvalPolicy?: unknown }).approvalPolicy;
  if (approvalPolicy === true || approvalPolicy === "always") return true;
  return Boolean(
    approvalPolicy &&
    typeof approvalPolicy === "object" &&
    (approvalPolicy as { mode?: unknown }).mode === "always",
  );
}

function safeSelectedSkills(
  getSelectedSkills: (() => readonly string[]) | undefined,
): readonly string[] {
  if (!getSelectedSkills) return [];
  try {
    const selected = getSelectedSkills();
    return Array.isArray(selected)
      ? selected.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeApprovalMethod(
  value: SparkToolApprovalMethod | undefined,
): SparkToolApprovalMethod {
  if (value === "skip" || value === "human" || value === "auto") return value;
  return "auto";
}

function normalizeApprovalRejectAction(
  value: SparkToolApprovalRejectAction | undefined,
): SparkToolApprovalRejectAction {
  if (value === "ask" || value === "deny") return value;
  return "ask";
}

function toToolDefinition(config: ToolConfig): Tool {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters as Tool["parameters"],
  };
}

function errorToolResult(toolCall: ToolCall, message: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: message }],
    isError: true,
    timestamp: Date.now(),
  };
}

let viewMessageCounter = 0;

function nextViewMessageId(sessionId: string, role: string): string {
  viewMessageCounter += 1;
  return `${sessionId}:message:${role}:${Date.now().toString(36)}:${viewMessageCounter}`;
}

function messageToView(message: Message, id: string): SparkMessageView {
  const role = message.role === "toolResult" ? "tool" : message.role;
  return {
    version: SPARK_PROTOCOL_VERSION,
    id,
    role: isSparkMessageRole(role) ? role : "custom",
    text: contentToText((message as { content?: unknown }).content),
    status: "done",
    createdAt: timestampToIso((message as { timestamp?: unknown }).timestamp),
    metadata: jsonMetadata({ sourceRole: message.role }),
  };
}

function assistantToMessageView(
  assistant: AssistantMessage,
  id: string,
  status: SparkMessageView["status"],
): SparkMessageView {
  const displayText = displaySafeAssistantText(assistant.content);
  const errorMessage =
    status === "error" && typeof assistant.errorMessage === "string"
      ? assistant.errorMessage.trim()
      : "";
  return {
    version: SPARK_PROTOCOL_VERSION,
    id,
    role: "assistant",
    text: displayText || errorMessage,
    status,
    createdAt: timestampToIso((assistant as { timestamp?: unknown }).timestamp),
    parts: assistantConversationParts(assistant.content, id, status),
    metadata: jsonMetadata({
      api: (assistant as { api?: unknown }).api,
      provider: (assistant as { provider?: unknown }).provider,
      model: (assistant as { model?: unknown }).model,
      stopReason: assistant.stopReason,
      ...(errorMessage ? { errorMessage } : {}),
      usage: (assistant as { usage?: unknown }).usage,
    }),
  };
}

function toolCallToMessageView(toolCall: ToolCall): SparkMessageView {
  const id = `tool-call:${toolCall.id}`;
  const summary = summarizeToolCallArguments(toolCall.arguments);
  return {
    version: SPARK_PROTOCOL_VERSION,
    id,
    role: "tool",
    text: summary ?? `calling ${toolCall.name}`,
    status: "pending",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    parts: [
      {
        id: `${id}:part:0`,
        type: "tool-call",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "pending",
        ...(summary ? { summary } : {}),
        metadata: {},
      },
    ],
    metadata: { kind: "tool_call" },
  };
}

function toolResultToMessageView(message: ToolResultMessage): SparkMessageView {
  const id = `tool-call:${message.toolCallId}`;
  const summary =
    summarizeToolResultContent(message.content) ??
    `${message.toolName} ${message.isError ? "failed" : "completed"}`;
  return {
    version: SPARK_PROTOCOL_VERSION,
    id,
    role: "tool",
    text: summary,
    status: message.isError ? "error" : "done",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    createdAt: timestampToIso((message as { timestamp?: unknown }).timestamp),
    parts: [
      {
        id: `${id}:part:0`,
        type: "tool-result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        status: message.isError ? "failed" : "complete",
        summary,
        metadata: {},
      },
    ],
    metadata: { kind: "tool_result" },
  };
}

function toolUpdateToMessageView(
  toolCall: ToolCall,
  update: { content: Array<{ type: "text"; text: string }> },
): SparkMessageView {
  const id = `tool-call:${toolCall.id}`;
  const summary = summarizeToolResultContent(update.content) ?? `${toolCall.name} running`;
  return {
    version: SPARK_PROTOCOL_VERSION,
    id,
    role: "tool",
    text: summary,
    status: "streaming",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    updatedAt: new Date().toISOString(),
    parts: [
      {
        id: `${id}:part:0`,
        type: "tool-call",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "running",
        summary,
        metadata: {},
      },
    ],
    metadata: { kind: "tool_progress" },
  };
}

function assistantConversationParts(
  content: unknown,
  messageId: string,
  messageStatus: SparkMessageView["status"],
): SparkConversationPart[] {
  const partStatus = messageStatusToPartStatus(messageStatus);
  if (typeof content === "string") {
    return [
      {
        id: `${messageId}:part:0`,
        type: "text",
        text: content,
        status: partStatus,
        metadata: {},
      },
    ];
  }
  if (!Array.isArray(content)) return [];

  return content.flatMap((value, index): SparkConversationPart[] => {
    if (!value || typeof value !== "object") return [];
    const part = value as Record<string, unknown>;
    const id = `${messageId}:part:${index}`;
    if (part.type === "text" && typeof part.text === "string") {
      const phase = sparkTextPhaseFromSignature(part.textSignature);
      return [
        {
          id,
          type: "text",
          text: part.text,
          status: partStatus,
          ...(phase ? { phase } : {}),
          metadata: {},
        },
      ];
    }
    if (part.type === "thinking") {
      const redacted = part.redacted === true;
      if (!redacted && typeof part.thinking !== "string") return [];
      return [
        {
          id,
          type: "thinking",
          text: redacted ? "" : String(part.thinking),
          status: partStatus,
          ...(redacted ? { redacted: true } : {}),
          metadata: {},
        },
      ];
    }
    if (
      part.type === "toolCall" &&
      typeof part.id === "string" &&
      part.id &&
      typeof part.name === "string" &&
      part.name
    ) {
      const summary = summarizeToolCallArguments(part.arguments);
      return [
        {
          id,
          type: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          status: "pending",
          ...(summary ? { summary } : {}),
          metadata: {},
        },
      ];
    }
    return [];
  });
}

function messageStatusToPartStatus(
  status: SparkMessageView["status"],
): SparkConversationPart["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "streaming":
      return "streaming";
    case "error":
      return "failed";
    case "done":
      return "complete";
  }
}

function displaySafeAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((value): string[] => {
      if (!value || typeof value !== "object") return [];
      const part = value as Record<string, unknown>;
      // Tool calls and thinking belong in structured `parts`, not the prose `text`
      // field. Embedding `[tool call: …]` here leaks into Infoflow answer bodies and
      // Cockpit markdown fallbacks.
      if (
        part.type === "text" &&
        typeof part.text === "string" &&
        sparkTextPhaseFromSignature(part.textSignature) !== "commentary"
      ) {
        return [part.text];
      }
      return [];
    })
    .filter(Boolean)
    .join("\n");
}

function runStatusForStopReason(reason: AssistantMessage["stopReason"]): SparkRunView["status"] {
  if (reason === "toolUse") return "running";
  if (reason === "aborted") return "cancelled";
  if (reason === "error") return "failed";
  return "succeeded";
}

function isSparkMessageRole(role: string): role is SparkMessageView["role"] {
  return (
    role === "system" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool" ||
    role === "thinking" ||
    role === "custom"
  );
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return "";
    if (
      typeof content === "number" ||
      typeof content === "boolean" ||
      typeof content === "bigint"
    ) {
      return String(content);
    }
    return JSON.stringify(content) ?? "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return String(part);
      if ("type" in part && part.type === "text" && "text" in part) return String(part.text);
      if ("type" in part && part.type === "toolCall" && "name" in part) {
        return `[tool call: ${String(part.name)}]`;
      }
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function timestampToIso(timestamp: unknown): string | undefined {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

function jsonMetadata(record: Record<string, unknown>): SparkMessageView["metadata"] {
  try {
    return JSON.parse(JSON.stringify(record)) as SparkMessageView["metadata"];
  } catch {
    return {};
  }
}

function taskViewsFromToolDetails(
  details: unknown,
  metadata: Record<string, unknown>,
): SparkTaskView[] {
  const tasks: SparkTaskView[] = [];
  const seenRefs = new Set<string>();
  scanToolDetails(details, (candidate) => {
    const task = taskViewFromCandidate(candidate, metadata);
    if (!task || seenRefs.has(task.ref)) return;
    seenRefs.add(task.ref);
    tasks.push(task);
  });
  return tasks;
}

function artifactViewsFromToolDetails(
  details: unknown,
  metadata: Record<string, unknown>,
): SparkArtifactView[] {
  const artifacts: SparkArtifactView[] = [];
  const seenRefs = new Set<string>();
  scanToolDetails(details, (candidate) => {
    const artifact = artifactViewFromCandidate(candidate, metadata);
    if (!artifact || seenRefs.has(artifact.ref)) return;
    seenRefs.add(artifact.ref);
    artifacts.push(artifact);
  });
  return artifacts;
}

function scanToolDetails(
  value: unknown,
  visit: (candidate: Record<string, unknown>) => void,
): void {
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < 200) {
    const current = stack.pop()!;
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    visited += 1;
    if (Array.isArray(current.value)) {
      if (current.depth >= 5) continue;
      for (const item of current.value.slice(0, 50))
        stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    const record = current.value as Record<string, unknown>;
    visit(record);
    if (current.depth >= 5) continue;
    for (const [key, child] of Object.entries(record)) {
      if (key === "body" || key === "content" || key === "text" || key === "summary") continue;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function taskViewFromCandidate(
  candidate: Record<string, unknown>,
  metadata: Record<string, unknown>,
): SparkTaskView | undefined {
  const ref = stringField(candidate, "ref");
  if (!ref?.startsWith("task:")) return undefined;
  const title = stringField(candidate, "title") ?? stringField(candidate, "name") ?? ref;
  const status = stringField(candidate, "status") ?? "unknown";
  return {
    version: SPARK_PROTOCOL_VERSION,
    ref,
    title,
    status,
    ...(stringField(candidate, "name") ? { name: stringField(candidate, "name") } : {}),
    ...(stringField(candidate, "description")
      ? { description: stringField(candidate, "description") }
      : {}),
    ...(stringField(candidate, "kind") ? { kind: stringField(candidate, "kind") } : {}),
    ...(stringField(candidate, "owner") ? { owner: stringField(candidate, "owner") } : {}),
    ...(stringField(candidate, "projectRef")
      ? { projectRef: stringField(candidate, "projectRef") }
      : {}),
    todos: taskTodosFromCandidate(candidate),
    runRefs: stringArrayField(candidate, "runRefs"),
    artifactRefs: [
      ...stringArrayField(candidate, "artifactRefs"),
      ...stringArrayField(candidate, "outputArtifacts"),
      ...stringArrayField(candidate, "evidenceRefs"),
    ].filter(
      (value, index, array) => value.startsWith("artifact:") && array.indexOf(value) === index,
    ),
    metadata: jsonMetadata(metadata),
  };
}

function artifactViewFromCandidate(
  candidate: Record<string, unknown>,
  metadata: Record<string, unknown>,
): SparkArtifactView | undefined {
  const ref = stringField(candidate, "ref") ?? stringField(candidate, "artifactRef");
  if (!ref?.startsWith("artifact:")) return undefined;
  const provenance = recordField(candidate, "provenance");
  return {
    version: SPARK_PROTOCOL_VERSION,
    ref,
    title: stringField(candidate, "title") ?? ref,
    kind: artifactKind(stringField(candidate, "kind")),
    format: artifactFormat(stringField(candidate, "format")),
    ...(stringField(candidate, "status") ? { status: stringField(candidate, "status") } : {}),
    ...(stringField(candidate, "producer")
      ? { producer: stringField(candidate, "producer") }
      : stringField(provenance, "producer")
        ? { producer: stringField(provenance, "producer") }
        : {}),
    ...(isoStringField(candidate, "createdAt")
      ? { createdAt: isoStringField(candidate, "createdAt") }
      : {}),
    ...(isoStringField(candidate, "updatedAt")
      ? { updatedAt: isoStringField(candidate, "updatedAt") }
      : {}),
    ...(stringField(candidate, "preview") ? { preview: stringField(candidate, "preview") } : {}),
    metadata: jsonMetadata(metadata),
  };
}

function taskTodosFromCandidate(candidate: Record<string, unknown>): SparkTaskTodoView[] {
  const todosRecord = recordField(candidate, "todos");
  const rawTodos: unknown[] = Array.isArray(candidate.todos)
    ? candidate.todos
    : todosRecord && Array.isArray(todosRecord.items)
      ? todosRecord.items
      : [];
  return rawTodos.flatMap((todo, index): SparkTaskTodoView[] => {
    if (!todo || typeof todo !== "object") return [];
    const record = todo as Record<string, unknown>;
    const content =
      stringField(record, "content") ?? stringField(record, "title") ?? stringField(record, "text");
    if (!content) return [];
    return [
      {
        id: stringField(record, "id") ?? `todo-${index + 1}`,
        content,
        status: taskTodoStatus(stringField(record, "status")),
        notes: stringArrayField(record, "notes"),
      },
    ];
  });
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isoStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function taskTodoStatus(value: string | undefined): SparkTaskTodoView["status"] {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "blocked" ||
    value === "done" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "pending";
}

function artifactKind(value: string | undefined): SparkArtifactView["kind"] {
  if (value === "document" || value === "record" || value === "trace" || value === "knowledge") {
    return value;
  }
  return "other";
}

function artifactFormat(value: string | undefined): SparkArtifactView["format"] {
  if (value === "markdown" || value === "json" || value === "text" || value === "blob") {
    return value;
  }
  return "other";
}

export { SparkAgentLoop as SparkTurnRunner };
