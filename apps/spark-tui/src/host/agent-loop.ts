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
} from "@earendil-works/pi-ai";

import type { ExtensionContext, ToolConfig } from "@zendev-lab/pi-extension-api";

import type { SparkHostRuntime } from "./runtime.ts";

export type SparkAgentStreamFunction = (
  model: Model<string>,
  context: Context,
  options?: StreamOptions,
) => AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export type SparkAgentLoopState = "idle" | "streaming" | "tooling" | "aborting";

export interface SparkAgentLoopOptions {
  host: SparkHostRuntime;
  /** pi-ai stream function. Pass the production `stream` import or a test fake. */
  streamFunction: SparkAgentStreamFunction;
  /** Resolves the current model. May be replaced at runtime via setModel. */
  getModel: () => Model<string>;
  systemPrompt?: string;
  /** Maximum number of tool roundtrips per submit. Defaults to 16. */
  maxRoundtrips?: number;
}

export type SparkAgentLoopEvent =
  | { type: "stream_event"; event: AssistantMessageEvent }
  | { type: "user_message"; message: Message }
  | { type: "tool_result"; message: ToolResultMessage }
  | { type: "turn_complete"; assistant: AssistantMessage; reason: AssistantMessage["stopReason"] }
  | { type: "abort"; reason: string }
  | { type: "error"; message: string };

export class SparkAgentLoop {
  readonly host: SparkHostRuntime;
  private readonly streamFunction: SparkAgentStreamFunction;
  private readonly getModel: () => Model<string>;
  private readonly maxRoundtrips: number;
  private systemPrompt: string;
  private readonly messages: Message[] = [];
  private state: SparkAgentLoopState = "idle";
  private currentAbort: AbortController | undefined;
  private triggerTurnRunning = false;
  private readonly subscribers = new Set<(event: SparkAgentLoopEvent) => void>();

  constructor(options: SparkAgentLoopOptions) {
    this.host = options.host;
    this.streamFunction = options.streamFunction;
    this.getModel = options.getModel;
    this.systemPrompt = options.systemPrompt ?? "";
    this.maxRoundtrips = options.maxRoundtrips ?? 16;
    this.host.setTriggerTurnHandler(() => this.triggerNextTurn());
  }

  // ── Public API ─────────────────────────────────────────────────────────

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
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
  async submit(content: string): Promise<AssistantMessage | undefined> {
    if (this.state !== "idle" || this.triggerTurnRunning) {
      // The TUI handles queueing; the loop refuses to interleave.
      throw new Error(
        `SparkAgentLoop.submit refused: agent is not idle (state=${this.state}). ` +
          "Use SparkNativeSession queueing or wait for the current turn to finish.",
      );
    }

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
      await this.runTurns({ skipInitialLifecycle: true });
    } finally {
      this.triggerTurnRunning = false;
    }
  }

  private async runTurns(
    options: { skipInitialLifecycle?: boolean } = {},
  ): Promise<AssistantMessage | undefined> {
    let lastAssistant: AssistantMessage | undefined;
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

        let assistant: AssistantMessage | undefined;
        try {
          const stream = this.streamFunction(this.getModel(), context, {
            signal: abortController.signal,
          } as StreamOptions);
          for await (const event of stream) {
            this.publish({ type: "stream_event", event });
            if (event.type === "done" || event.type === "error") {
              assistant = event.type === "done" ? event.message : event.error;
            }
          }
          if (!assistant) assistant = await stream.result();
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
      const onUpdate = () => undefined;
      const result = await tool.config.execute(
        toolCall.id,
        toolCall.arguments,
        signal,
        onUpdate,
        ctx,
      );
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content,
        details: result.details,
        isError: result.isError ?? false,
        timestamp: Date.now(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(toolCall, message);
    }
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
      const message = beforeAgentStartMessage(result);
      if (!message) continue;
      this.messages.push(message);
      this.publish({ type: "user_message", message });
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
        // Custom messages are extension instructions/notices. They go in via
        // a synthesized user role because pi-ai's Message union doesn't include
        // runtime system entries. Hidden follow-up messages still enter the
        // message log; only explicit nextTurn envelopes are left for a later
        // host surface.
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
        this.publish({ type: "user_message", message });
        appended += 1;
      }
    }
    return appended;
  }

  private transition(next: SparkAgentLoopState): void {
    this.state = next;
    this.host.setIdle(next === "idle");
  }

  private publish(event: SparkAgentLoopEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // Subscribers are best-effort observers; never fail the loop.
      }
    }
  }
}

function beforeAgentStartMessage(result: unknown): Message | undefined {
  if (!result || typeof result !== "object") return undefined;
  const message = (result as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || !content.trim()) return undefined;
  const customType = (message as { customType?: unknown }).customType;
  return {
    role: "user",
    content: typeof customType === "string" && customType ? `[${customType}] ${content}` : content,
    timestamp: Date.now(),
  };
}

function collectToolCalls(message: AssistantMessage): ToolCall[] {
  const out: ToolCall[] = [];
  for (const part of message.content) {
    if (part.type === "toolCall") out.push(part);
  }
  return out;
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
