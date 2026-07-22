/** In-memory native TUI session: transcript, queue, and turn lifecycle. */

import {
  SPARK_PROTOCOL_VERSION,
  createId,
  type SparkMessageView,
  type SparkSessionPendingTurn,
  type SparkSessionView,
  type SparkToolCallView,
} from "@zendev-lab/spark-protocol";

import { displayNativeSubmittedInput } from "./editor-input.ts";
import {
  canonicalToolStatus,
  messageViewToNativeMessages,
  nativeMessageTime,
  nativeMessageToView,
  toolViewToNativeMessage,
} from "./message-view.ts";
import { nativeTuiStrings } from "./strings.ts";
import {
  MAX_TRANSCRIPT_MESSAGES,
  type SparkNativeAbortResult,
  type SparkNativeCustomMessageInput,
  type SparkNativeMessage,
  type SparkNativeQueueMode,
  type SparkNativeQueueSummary,
  type SparkNativeQueuedInput,
  type SparkNativeResponder,
  type SparkNativeSubmitOptions,
  type SparkNativeToolMessageInput,
} from "./types.ts";

function formatSteeringSubmission(inputs: string[]): string {
  const body = inputs.map((input, index) => `Steering ${index + 1}:\n${input.trim()}`).join("\n\n");
  return nativeTuiStrings.steeringUpdate(body);
}

export function defaultSparkNativeResponder(input: string): string {
  if (input === "/help") {
    return nativeTuiStrings.defaultHelp;
  }

  if (input.startsWith("/")) {
    return nativeTuiStrings.capturedCommand(input);
  }

  return nativeTuiStrings.capturedIntent(input);
}

export class SparkNativeSession {
  readonly messages: SparkNativeMessage[] = [];
  /** Optimistic local queue (steer/followUp) until turn.submit ack / drain. */
  private readonly queuedFollowUps: SparkNativeQueuedInput[] = [];
  /** Durable daemon admission projection; undefined until a snapshot supplies it. */
  private daemonPendingTurns: SparkSessionPendingTurn[] | undefined;
  private readonly responder: SparkNativeResponder;
  private lastSubmittedInput: { text: string; submissionId: string } | undefined;
  private processing = false;
  private activeTurnId = 0;
  private currentAbort: AbortController | undefined;
  private nextNativeMessageOrder = 0;

  onChange?: () => void;

  constructor(responder: SparkNativeResponder = defaultSparkNativeResponder) {
    this.responder = responder;
    this.pushMessage({
      role: "system",
      text: nativeTuiStrings.welcome,
    });
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  get canRetry(): boolean {
    return !this.processing && this.lastSubmittedInput !== undefined;
  }

  get canStopOrRestore(): boolean {
    return this.processing || this.queuedFollowUps.length > 0 || this.daemonQueuedCount() > 0;
  }

  get queuedCount(): number {
    return this.queuedFollowUps.length + this.daemonQueuedCount();
  }

  /** Ordered, detached local optimistic queue for rendering without mutation authority. */
  get queuedInputs(): readonly Pick<SparkNativeQueuedInput, "text" | "mode">[] {
    return Object.freeze(
      this.queuedFollowUps.map((input) => Object.freeze({ text: input.text, mode: input.mode })),
    );
  }

  /** Durable daemon pending turns from the last applied session snapshot. */
  get daemonPending(): readonly SparkSessionPendingTurn[] {
    return Object.freeze([...(this.daemonPendingTurns ?? [])]);
  }

  get queueSummary(): SparkNativeQueueSummary {
    let steer = 0;
    let followUp = 0;
    for (const input of this.queuedFollowUps) {
      if (input.mode === "steer") steer += 1;
      else followUp += 1;
    }
    const daemonPending = this.daemonPendingTurns?.length ?? 0;
    return {
      total: steer + followUp + daemonPending,
      steer,
      followUp,
      daemonPending,
    };
  }

  async submit(
    input: string,
    options: SparkNativeSubmitOptions = {},
  ): Promise<"started" | "queued" | "ignored"> {
    const text = input.trim();
    if (!text) return "ignored";
    const submissionId = options.submissionId ?? createId("idem");
    this.lastSubmittedInput = { text, submissionId };

    if (this.processing) {
      const mode = options.mode ?? "steer";
      this.queuedFollowUps.push({ text, mode, submissionId });
      return "queued";
    }

    void this.process(text, submissionId);
    return "started";
  }

  async retryLast(): Promise<"started" | "queued" | "ignored"> {
    if (!this.lastSubmittedInput) return "ignored";
    const { text, submissionId } = this.lastSubmittedInput;
    this.pushMessage({ role: "system", text: `Retrying: ${text}` });
    return await this.submit(text, { submissionId });
  }

  addSystemMessage(text: string): void {
    this.pushMessage({ role: "system", text });
  }

  addMessageView(message: SparkMessageView): void {
    const natives = messageViewToNativeMessages(message);
    for (const native of natives) this.upsertMessage(native);
    if (natives.length === 0) return;
    this.sortMessagesChronologically();
    this.trimTranscript();
    this.emitChange();
  }

  addToolView(tool: SparkToolCallView): void {
    const native = toolViewToNativeMessage(tool);
    this.upsertMessage(native);
    this.sortMessagesChronologically();
    this.trimTranscript();
    this.emitChange();
  }

  private upsertMessage(native: SparkNativeMessage): void {
    const index = this.findMessageViewIndex(native);
    if (index >= 0) {
      this.messages[index] = this.normalizeMessage(native, this.messages[index]);
      return;
    }
    this.messages.push(this.normalizeMessage(native));
  }

  private findMessageViewIndex(
    native: SparkNativeMessage,
    messages: readonly SparkNativeMessage[] = this.messages,
  ): number {
    if (native.viewId) {
      const byViewId = messages.findIndex((existing) => existing.viewId === native.viewId);
      if (byViewId >= 0) return byViewId;
    }
    if (native.role === "tool" && native.toolCallId) {
      return messages.findIndex(
        (existing) => existing.role === "tool" && existing.toolCallId === native.toolCallId,
      );
    }
    return -1;
  }

  toSessionView(sessionId: string = "native"): SparkSessionView {
    const localPending = this.localOptimisticPendingTurns();
    const daemonPending = this.daemonPendingTurns ?? [];
    const pendingTurns = [...localPending, ...daemonPending];
    const status = this.processing ? "streaming" : pendingTurns.length > 0 ? "queued" : "idle";
    return {
      version: SPARK_PROTOCOL_VERSION,
      sessionId,
      status,
      pendingTurns,
      messages: this.messages.map((message, index) => nativeMessageToView(message, index)),
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      evidence: [],
      metadata: {
        queuedCount: this.queuedFollowUps.length,
        daemonPendingCount: daemonPending.length,
      },
    };
  }

  applySessionView(view: SparkSessionView): void {
    const messages: SparkNativeMessage[] = [];
    for (const projected of view.messages.flatMap(messageViewToNativeMessages)) {
      const index = this.findMessageViewIndex(projected, messages);
      if (index >= 0) messages[index] = this.normalizeMessage(projected, messages[index]);
      else messages.push(this.normalizeMessage(projected));
    }
    for (const tool of view.tools) {
      const projected = toolViewToNativeMessage(tool);
      const index = this.findMessageViewIndex(projected, messages);
      if (index >= 0) messages[index] = this.normalizeMessage(projected, messages[index]);
      else messages.push(this.normalizeMessage(projected));
    }
    this.messages.splice(0, this.messages.length, ...messages);
    if (view.pendingTurns !== undefined) {
      this.daemonPendingTurns = view.pendingTurns.map((turn) => ({ ...turn }));
      this.reconcileOptimisticQueueAgainstDaemon();
    }
    this.sortMessagesChronologically();
    this.trimTranscript();
    this.emitChange();
  }

  clearTranscript(note: string = "Transcript cleared."): void {
    const welcome = this.messages[0];
    this.messages.splice(0, this.messages.length);
    if (welcome) this.messages.push(welcome);
    this.pushMessage({ role: "system", text: note });
  }

  abort(reason: string = "user stop"): SparkNativeAbortResult {
    const clearedQueued = this.queuedFollowUps.length;
    const restoredText = this.restoreQueuedText();
    if (!this.processing) {
      if (clearedQueued > 0) {
        this.pushMessage({
          role: "system",
          text: `Restored ${clearedQueued} queued input(s) to the editor.`,
        });
      }
      return { aborted: false, clearedQueued, restoredText };
    }

    this.activeTurnId += 1;
    this.currentAbort?.abort(new Error(reason));
    this.currentAbort = undefined;
    this.processing = false;
    this.pushMessage({
      role: "system",
      text: nativeTuiStrings.stoppedTurn(reason, clearedQueued),
    });
    return { aborted: true, clearedQueued, restoredText };
  }

  restoreQueuedText(): string | undefined {
    if (this.queuedFollowUps.length === 0) return undefined;
    const restored = this.queuedFollowUps.map((entry) => entry.text).join("\n\n");
    this.queuedFollowUps.splice(0, this.queuedFollowUps.length);
    this.emitChange();
    return restored;
  }

  addCustomMessage(input: SparkNativeCustomMessageInput): void {
    this.pushMessage({
      role: "custom",
      text: input.content,
      customType: input.customType,
      display: input.display,
      details: input.details,
    });
  }

  addToolMessage(input: SparkNativeToolMessageInput): void {
    this.pushMessage({
      role: "tool",
      text: input.text,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      toolStatus: canonicalToolStatus(input.status ?? "succeeded"),
      details: input.details,
    });
  }

  addThinking(text: string, details?: Record<string, unknown>): void {
    this.pushMessage({ role: "thinking", text, details });
  }

  appendAssistantChunk(chunk: string): void {
    const tail = this.messages[this.messages.length - 1];
    if (tail?.role === "assistant" && tail.streaming) {
      tail.text += chunk;
      this.emitChange();
      return;
    }
    this.pushMessage({ role: "assistant", text: chunk, streaming: true });
  }

  finishAssistantMessage(): void {
    const tail = this.messages[this.messages.length - 1];
    if (tail?.role === "assistant") {
      tail.streaming = false;
      this.emitChange();
    }
  }

  private pushMessage(message: SparkNativeMessage): void {
    this.messages.push(this.normalizeMessage(message));
    this.sortMessagesChronologically();
    this.trimTranscript();
    this.emitChange();
  }

  private normalizeMessage(
    message: SparkNativeMessage,
    existing?: SparkNativeMessage,
  ): SparkNativeMessage {
    return {
      ...message,
      text:
        message.role === "tool" && !message.text && existing?.role === "tool"
          ? existing.text
          : message.text,
      createdAt: message.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
      updatedAt: message.updatedAt ?? existing?.updatedAt,
      nativeOrder: existing?.nativeOrder ?? message.nativeOrder ?? ++this.nextNativeMessageOrder,
    };
  }

  private sortMessagesChronologically(): void {
    this.messages.sort((left, right) => {
      const leftTime = nativeMessageTime(left);
      const rightTime = nativeMessageTime(right);
      if (leftTime !== rightTime) return leftTime - rightTime;
      return (left.nativeOrder ?? 0) - (right.nativeOrder ?? 0);
    });
  }

  private async process(input: string, submissionId: string): Promise<void> {
    this.processing = true;
    const turnId = ++this.activeTurnId;
    const abortController = new AbortController();
    this.currentAbort = abortController;
    this.pushMessage({ role: "user", text: displayNativeSubmittedInput(input) });

    let streamedAssistant = false;
    try {
      const response = await this.responder(input, {
        messages: this.messages,
        submissionId,
        signal: abortController.signal,
        appendAssistantChunk: (chunk) => {
          streamedAssistant = true;
          this.appendAssistantChunk(chunk);
        },
        finishAssistantMessage: () => this.finishAssistantMessage(),
      });
      if (this.activeTurnId !== turnId) return;
      if (streamedAssistant) {
        this.finishAssistantMessage();
      } else {
        this.pushMessage({ role: "assistant", text: response });
      }
    } catch (error) {
      if (this.activeTurnId !== turnId) return;
      this.pushMessage({
        role: "system",
        text: nativeTuiStrings.turnFailed(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      if (this.activeTurnId === turnId) {
        this.currentAbort = undefined;
        this.processing = false;
        this.trimTranscript();
        this.emitChange();
      }
    }

    const next = this.nextQueuedSubmission();
    if (next !== undefined) {
      void this.process(next.text, next.submissionId);
    }
  }

  private nextQueuedSubmission(): SparkNativeQueuedInput | undefined {
    const next = this.queuedFollowUps.shift();
    if (!next) return undefined;
    if (next.mode === "followUp") return next;

    const steeringInputs = [next.text];
    while (this.queuedFollowUps[0]?.mode === "steer") {
      steeringInputs.push(this.queuedFollowUps.shift()?.text ?? "");
    }
    return {
      mode: "steer",
      text: formatSteeringSubmission(steeringInputs),
      submissionId: next.submissionId,
    };
  }

  private daemonQueuedCount(): number {
    return (this.daemonPendingTurns ?? []).filter((turn) => turn.status === "queued").length;
  }

  private localOptimisticPendingTurns(): SparkSessionPendingTurn[] {
    const createdAt = new Date().toISOString();
    return this.queuedFollowUps.map((input) => ({
      invocationId: input.submissionId,
      prompt: input.text,
      status: "queued" as const,
      createdAt,
    }));
  }

  /**
   * Drop optimistic local rows once the daemon reports a matching queued/running
   * prompt (exact text). Steer coalesce remains local-only until submit.
   */
  private reconcileOptimisticQueueAgainstDaemon(): void {
    const admitted = new Set(
      (this.daemonPendingTurns ?? []).map((turn) => turn.prompt.trim()).filter(Boolean),
    );
    if (admitted.size === 0) return;
    for (let index = this.queuedFollowUps.length - 1; index >= 0; index -= 1) {
      const entry = this.queuedFollowUps[index];
      if (entry && admitted.has(entry.text.trim())) {
        this.queuedFollowUps.splice(index, 1);
      }
    }
  }

  private trimTranscript(): void {
    if (this.messages.length <= MAX_TRANSCRIPT_MESSAGES) return;
    this.messages.splice(1, this.messages.length - MAX_TRANSCRIPT_MESSAGES);
  }

  private emitChange(): void {
    this.onChange?.();
  }
}
