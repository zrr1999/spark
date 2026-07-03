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

import type { ExtensionContext, ToolConfig } from "@zendev-lab/spark-extension-api";
import {
  compactToolResultContent,
  shouldRecordRawToolResultArtifact,
  type SparkToolResultRawRecoveryDecision,
} from "./tool-result-compaction.ts";
import {
  SPARK_PROTOCOL_VERSION,
  type SparkArtifactView,
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

export interface SparkTurnRegisteredTool {
  config: ToolConfig;
  active: boolean;
}

export interface SparkTurnOutboxEnvelope {
  kind: "custom" | "user";
  customType?: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  display?: boolean;
  details?: Record<string, unknown>;
  options: {
    deliverAs?: "steer" | "followUp" | "nextTurn";
    streamingBehavior?: "steer" | "followUp";
    triggerTurn?: boolean;
  };
  enqueuedAt: number;
}

export interface SparkTurnHost {
  setTriggerTurnHandler(handler: (() => void | Promise<void>) | undefined): void;
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

export interface SparkAgentLoopOptions {
  host: SparkTurnHost;
  /** pi-ai stream function. Pass the production `stream` import or a test fake. */
  streamFunction: SparkAgentStreamFunction;
  /** Resolves the current model. May be replaced at runtime via setModel. */
  getModel: () => Model<string>;
  systemPrompt?: string;
  /** Maximum number of tool roundtrips per submit. Defaults to 16. */
  maxRoundtrips?: number;
  /** Wall-clock timeout for one model stream pass. Defaults to 10 minutes; <=0 disables. */
  streamTimeoutMs?: number;
  /** Wall-clock timeout for one tool execution. Defaults to 5 minutes; <=0 disables. */
  toolTimeoutMs?: number;
  /** Wall-clock timeout for one host interaction/approval wait. Defaults to 60s; <=0 disables. */
  interactionTimeoutMs?: number;
}

export type SparkAgentLoopEvent =
  | { type: "stream_event"; event: AssistantMessageEvent }
  | { type: "user_message"; message: Message }
  | { type: "tool_result"; message: ToolResultMessage }
  | { type: "turn_complete"; assistant: AssistantMessage; reason: AssistantMessage["stopReason"] }
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
  private systemPrompt: string;
  private readonly messages: Message[] = [];
  private state: SparkAgentLoopState = "idle";
  private currentAbort: AbortController | undefined;
  private triggerTurnRunning = false;
  private viewSessionId = "spark-agent";
  private viewRunCounter = 0;
  private currentViewRunId: string | undefined;
  private readonly subscribers = new Set<(event: SparkAgentLoopEvent) => void>();

  constructor(options: SparkAgentLoopOptions) {
    this.host = options.host;
    this.streamFunction = options.streamFunction;
    this.getModel = options.getModel;
    this.systemPrompt = options.systemPrompt ?? "";
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
    this.host.setTriggerTurnHandler(() => this.triggerNextTurn());
  }

  // ── Public API ─────────────────────────────────────────────────────────

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setViewSessionId(sessionId: string | undefined): void {
    const normalized = sessionId?.trim();
    this.viewSessionId = normalized || "spark-agent";
  }

  getViewSessionId(): string {
    return this.viewSessionId;
  }

  /** Snapshot of the current message log. Useful for sessions/branches. */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /** Replace the message log when resuming a persisted Spark session. */
  replaceMessages(messages: readonly Message[]): void {
    if (this.state !== "idle") {
      throw new Error(
        `SparkAgentLoop.replaceMessages refused: agent is not idle (state=${this.state})`,
      );
    }
    this.messages.splice(0, this.messages.length, ...messages.map((message) => ({ ...message })));
  }

  getState(): SparkAgentLoopState {
    return this.state;
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
    if (this.state !== "idle" || this.triggerTurnRunning) {
      // The TUI handles queueing; the loop refuses to interleave.
      throw new Error(
        `SparkAgentLoop.submit refused: agent is not idle (state=${this.state}). ` +
          "Use SparkNativeSession queueing or wait for the current turn to finish.",
      );
    }

    this.startViewRun("user submit");
    const userMessage: Message = {
      role: "user",
      content,
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);
    this.publish({ type: "user_message", message: userMessage });

    return this.runTurns();
  }

  /** Cancel the in-flight stream/tool, marking the agent idle again. */
  abort(reason: string = "user_abort"): void {
    if (this.state === "idle") return;
    this.state = "aborting";
    this.currentAbort?.abort(new Error(reason));
    this.publish({ type: "abort", reason });
  }

  // ── Internal turn loop ─────────────────────────────────────────────────

  private async triggerNextTurn(): Promise<void> {
    if (this.state !== "idle" || this.triggerTurnRunning) return;
    this.triggerTurnRunning = true;
    try {
      await this.host.emit("turn_start", { source: "triggerTurn" });
      const queued = this.drainOutboxIntoMessages();
      const injected = await this.injectBeforeAgentStartMessages();
      if (queued + injected === 0) return;
      this.startViewRun("triggered turn");
      await this.runTurns({ skipInitialLifecycle: true });
    } finally {
      this.triggerTurnRunning = false;
    }
  }

  private async runTurns(
    options: { skipInitialLifecycle?: boolean } = {},
  ): Promise<AssistantMessage> {
    let lastAssistant: AssistantMessage;
    let roundtrips = 0;
    let agentEndPayload: { messages: AssistantMessage[]; errorMessage?: string } | undefined;
    const finishAgentTurn = (payload: {
      messages: AssistantMessage[];
      errorMessage?: string;
    }): void => {
      agentEndPayload ??= payload;
    };

    try {
      let skipLifecycle = options.skipInitialLifecycle ?? false;
      while (roundtrips < this.maxRoundtrips) {
        if (this.state === "aborting") break;
        if (!skipLifecycle) {
          await this.host.emit("turn_start", { source: "agentLoop" });
          await this.injectBeforeAgentStartMessages();
        }
        skipLifecycle = false;
        this.transition("streaming");

        const abortController = new AbortController();
        this.currentAbort = abortController;
        const tools = this.collectActiveTools();
        const messageCountBeforeAssistant = this.messages.length;
        const context: Context = {
          systemPrompt: this.systemPrompt || undefined,
          messages: this.messages,
          tools,
        };

        let assistant: AssistantMessage;
        try {
          const stream = this.streamFunction(this.getModel(), context, {
            signal: abortController.signal,
          } as StreamOptions);
          assistant = await runWithTimeout(
            this.consumeAssistantStream(stream),
            this.streamTimeoutMs,
            `Spark agent model stream timed out after ${this.streamTimeoutMs}ms`,
            (error) => abortController.abort(error),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.publish({ type: "error", message });
          finishAgentTurn({ messages: [], errorMessage: message });
          return undefined;
        }

        if (!assistant) {
          const message = "stream produced no assistant message";
          this.publish({ type: "error", message });
          finishAgentTurn({ messages: [], errorMessage: message });
          return undefined;
        }

        this.messages.push(assistant);
        lastAssistant = assistant;
        this.publish({ type: "turn_complete", assistant, reason: assistant.stopReason });
        await this.host.emit("turn_end", { message: assistant, toolResults: [] });

        if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
          finishAgentTurn({ messages: [assistant] });
          return assistant;
        }

        // Tool calls require execution and another stream pass.
        const toolCalls = collectToolCalls(assistant);
        if (toolCalls.length === 0) {
          this.drainOutboxIntoMessages();
          // If the outbox didn't add anything beyond the assistant we just
          // pushed, the turn is over. Compare against the snapshot taken
          // before this round, plus 1 for the assistant message itself.
          if (this.messages.length === messageCountBeforeAssistant + 1) {
            finishAgentTurn({ messages: [assistant] });
            return assistant;
          }
          // Outbox queued more user/system messages; loop again.
          roundtrips += 1;
          continue;
        }

        this.transition("tooling");
        for (const toolCall of toolCalls) {
          if ((this.state as SparkAgentLoopState) === "aborting") break;
          const result = await this.dispatchToolCall(toolCall, abortController.signal);
          this.messages.push(result);
          this.publish({ type: "tool_result", message: result });
          this.publishEntityViewsForToolResult(result);
        }

        this.drainOutboxIntoMessages();
        roundtrips += 1;
      }

      if (this.state === "aborting") {
        finishAgentTurn(lastAssistant ? { messages: [lastAssistant] } : { messages: [] });
        return lastAssistant;
      }

      if (roundtrips >= this.maxRoundtrips) {
        this.publish({
          type: "error",
          message: `agent loop hit maxRoundtrips=${this.maxRoundtrips}; stopping`,
        });
      }
      finishAgentTurn(lastAssistant ? { messages: [lastAssistant] } : { messages: [] });
      return lastAssistant;
    } finally {
      this.currentAbort = undefined;
      this.transition("idle");
      await this.host.emit(
        "agent_end",
        agentEndPayload ?? (lastAssistant ? { messages: [lastAssistant] } : { messages: [] }),
      );
    }
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
    const tool = this.host.getTool(toolCall.name);
    if (!tool) {
      return errorToolResult(toolCall, `unknown tool: ${toolCall.name}`);
    }

    const ctx: ExtensionContext = this.host.makeContext({ model: this.getModel() });
    try {
      const approval = await this.requestToolApprovalIfNeeded(toolCall, tool.config, signal);
      if (!approval.approved) return errorToolResult(toolCall, approval.message);

      const onUpdate = () => undefined;
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
  }): Promise<ToolResultRawRecoveryRecord | undefined> {
    if (input.toolCall.name === "artifact") return undefined;
    const artifactTool = this.host.getTool("artifact");
    if (!artifactTool) return undefined;
    const rawBody = rawToolResultArtifactBody(input.result.content);
    try {
      const recorded = await artifactTool.config.execute(
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
        new AbortController().signal,
        () => undefined,
        input.ctx,
      );
      const artifactRef = artifactRefFromToolResult(recorded);
      if (!artifactRef) return undefined;
      return {
        artifactRef,
        reason: input.decision.reason ?? "lossy_compaction",
        omittedChars: input.decision.omittedChars ?? 0,
        bodyChars: rawBody.bodyChars,
        readHint: `Full raw tool output saved as ${artifactRef}; recover with artifact({ action: "read", artifactRef: "${artifactRef}", maxChars: 20000 })`,
      };
    } catch {
      // Raw recovery must never make the original tool call fail. The compacted
      // result remains useful even if artifact persistence is unavailable.
      return undefined;
    }
  }

  private async requestToolApprovalIfNeeded(
    toolCall: ToolCall,
    config: ToolConfig,
    _signal: AbortSignal,
  ): Promise<{ approved: true } | { approved: false; message: string }> {
    if (!toolRequiresApproval(config)) return { approved: true };
    const response = await runWithTimeout(
      this.host.requestInteraction({
        version: SPARK_PROTOCOL_VERSION,
        kind: "toolApproval",
        requestId: `tool-approval:${toolCall.id}:${Date.now().toString(36)}`,
        title: `Approve tool: ${toolCall.name}`,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        arguments: toolCall.arguments as never,
        reason: `Tool "${toolCall.name}" requires approval before execution.`,
        approveLabel: "Approve",
        rejectLabel: "Reject",
        metadata: { source: "SparkAgentLoop" },
      }),
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
      .filter((entry) => entry.active)
      .map((entry) => toToolDefinition(entry.config));
  }

  private async injectBeforeAgentStartMessages(): Promise<number> {
    const results = await this.host.emit("before_agent_start", {});
    let injected = 0;
    for (const result of results) {
      const injectedMessage = beforeAgentStartMessage(result);
      if (!injectedMessage) continue;
      this.messages.push(injectedMessage.message);
      if (injectedMessage.visible)
        this.publish({ type: "user_message", message: injectedMessage.message });
      injected += 1;
    }
    return injected;
  }

  /**
   * Drain the host outbox between turns and convert each envelope into a
   * Message that the next stream call will see.
   */
  private drainOutboxIntoMessages(): number {
    let appended = 0;
    const envelopes = this.host.drainOutbox();
    for (const envelope of envelopes) {
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
        this.messages.push(message);
        this.publish({ type: "user_message", message });
        appended += 1;
      } else {
        // Custom messages are extension/runtime instructions. They must enter
        // the model context queue, but hidden custom instructions are not real
        // user input and must not be published to the user-message UI stream.
        // pi-ai's Message union has no runtime-system role, so the context
        // message is represented as user-role data with an explicit marker.
        if (envelope.options.deliverAs === "nextTurn") continue;
        const message: Message = {
          role: "user",
          content:
            typeof envelope.content === "string"
              ? `[${envelope.customType ?? "host-message"}] ${envelope.content}`
              : "",
          timestamp: envelope.enqueuedAt,
        };
        this.messages.push(message);
        if (envelope.display !== false) this.publish({ type: "user_message", message });
        appended += 1;
      }
    }
    return appended;
  }

  private transition(next: SparkAgentLoopState): void {
    this.state = next;
    this.host.setIdle(next === "idle");
  }

  private startViewRun(summary: string): void {
    const runId = `${this.viewSessionId}:run:${Date.now().toString(36)}:${++this.viewRunCounter}`;
    this.currentViewRunId = runId;
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
        this.publishViewEvent({
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: this.viewSessionId,
          message: assistantToMessageView(
            event.assistant,
            currentAssistantViewId(this.viewSessionId, this.currentViewRunId),
            event.reason === "error" ? "error" : "done",
          ),
        });
        this.publishCurrentRunStatus(runStatusForStopReason(event.reason));
        return;
      case "abort":
        this.publishCurrentRunStatus("cancelled", event.reason);
        return;
      case "error":
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
    if (event.type === "text_delta" || event.type === "start") {
      const partial = "partial" in event ? event.partial : undefined;
      if (partial && typeof partial === "object") {
        this.publishViewEvent({
          version: SPARK_PROTOCOL_VERSION,
          type: "session.message",
          sessionId: this.viewSessionId,
          message: assistantToMessageView(
            partial as AssistantMessage,
            currentAssistantViewId(this.viewSessionId, this.currentViewRunId),
            "streaming",
          ),
        });
      }
      return;
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
        metadata: { source: "SparkAgentLoop" },
      },
    });
    if (status !== "running" && status !== "queued") this.currentViewRunId = undefined;
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
            readHint: rawRecovery.readHint,
          },
        }
      : {}),
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

function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort((source as { reason?: unknown }).reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function beforeAgentStartMessage(
  result: unknown,
): { message: Message; visible: boolean } | undefined {
  if (!result || typeof result !== "object") return undefined;
  const message = (result as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || !content.trim()) return undefined;
  const customType = (message as { customType?: unknown }).customType;
  return {
    message: {
      role: "user",
      content:
        typeof customType === "string" && customType ? `[${customType}] ${content}` : content,
      timestamp: Date.now(),
    },
    visible: (message as { display?: unknown }).display !== false,
  };
}

function collectToolCalls(message: AssistantMessage): ToolCall[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter(
    (part: SparkTurnContentPart) => part.type === "toolCall",
  ) as ToolCall[];
}

function toolRequiresApproval(config: ToolConfig): boolean {
  const policy = (config as { requiresApproval?: unknown; approvalPolicy?: unknown })
    .requiresApproval;
  if (policy === true || policy === "always") return true;
  const approvalPolicy = (config as { approvalPolicy?: unknown }).approvalPolicy;
  if (approvalPolicy === true || approvalPolicy === "always") return true;
  return Boolean(
    approvalPolicy &&
    typeof approvalPolicy === "object" &&
    (approvalPolicy as { mode?: unknown }).mode === "always",
  );
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

function currentAssistantViewId(sessionId: string, runId: string | undefined): string {
  return runId ? `${runId}:assistant` : nextViewMessageId(sessionId, "assistant");
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
  return {
    version: SPARK_PROTOCOL_VERSION,
    id,
    role: "assistant",
    text: contentToText(assistant.content),
    status,
    createdAt: timestampToIso((assistant as { timestamp?: unknown }).timestamp),
    metadata: jsonMetadata({
      api: (assistant as { api?: unknown }).api,
      provider: (assistant as { provider?: unknown }).provider,
      model: (assistant as { model?: unknown }).model,
      stopReason: assistant.stopReason,
      usage: (assistant as { usage?: unknown }).usage,
    }),
  };
}

function toolCallToMessageView(toolCall: ToolCall): SparkMessageView {
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: `tool-call:${toolCall.id}`,
    role: "tool",
    text: `calling ${toolCall.name}`,
    status: "pending",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    metadata: jsonMetadata({ kind: "tool_call", arguments: toolCall.arguments }),
  };
}

function toolResultToMessageView(message: ToolResultMessage): SparkMessageView {
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: `tool-result:${message.toolCallId}`,
    role: "tool",
    text: contentToText(message.content),
    status: message.isError ? "error" : "done",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    createdAt: timestampToIso((message as { timestamp?: unknown }).timestamp),
    metadata: jsonMetadata({ kind: "tool_result", details: message.details }),
  };
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
