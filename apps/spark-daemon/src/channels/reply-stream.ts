import type { ChannelReplyStream } from "@zendev-lab/spark-channels";
import type {
  SparkConversationPart,
  SparkDaemonEvent,
  SparkMessageView,
} from "@zendev-lab/spark-protocol";

const TOOL_CALL_MARKER = /\[tool call:\s*[^\]]+\]/giu;

/**
 * Projects display-safe daemon events onto a channel reply stream.
 *
 * Final-answer prose goes to `appendText`; execution commentary goes to the
 * optional `appendProgress`. Thinking parts go to `appendReasoning` (Infoflow
 * thinking_aio). Tool lifecycle stays on notifyTool* — never as `[tool call:
 * …]` markers inside the answer body.
 */
export class ChannelReplyEventProjector {
  private readonly stream: ChannelReplyStream;
  private readonly projectsAnswerText: boolean;
  private readonly answerTexts = new Map<string, string>();
  private readonly progressTexts = new Map<string, string>();
  private readonly reasoningTexts = new Map<string, string>();
  private renderedAnswer = "";
  private renderedReasoning = "";

  constructor(stream: ChannelReplyStream) {
    this.stream = stream;
    this.projectsAnswerText = stream.answerMode !== "separate";
  }

  observe(event: SparkDaemonEvent): void {
    if (event.type !== "daemon.view_event" || event.view.type !== "session.message") return;
    const message = event.view.message;
    if (message.role === "assistant") {
      this.observeAssistant(message);
      return;
    }
    if (message.role === "thinking") {
      this.appendReasoningDelta(message.id, stripToolCallMarkers(message.text));
      return;
    }
    if (message.role !== "tool") return;
    const name = message.toolName?.trim() || "tool";
    if (message.status === "pending" || message.status === "streaming") {
      this.stream.notifyToolStart({ name, phase: "执行中" });
      return;
    }
    this.stream.notifyToolResult(`${name} ${message.status === "error" ? "失败" : "完成"}`);
  }

  appendFinalText(text: string | undefined): void {
    if (!this.projectsAnswerText) return;
    const finalText = stripToolCallMarkers(text ?? "").trim();
    if (!finalText) return;
    if (!this.renderedAnswer) {
      this.stream.appendText(finalText);
      this.renderedAnswer = finalText;
      return;
    }
    if (finalText.startsWith(this.renderedAnswer)) {
      const delta = finalText.slice(this.renderedAnswer.length);
      if (delta) this.stream.appendText(delta);
      this.renderedAnswer = finalText;
    }
  }

  private observeAssistant(message: SparkMessageView): void {
    this.appendProgressDelta(message.id, progressTextFromMessage(message));
    if (this.projectsAnswerText) {
      this.appendAnswerDelta(message.id, answerTextFromMessage(message));
    }
    this.appendReasoningDelta(message.id, reasoningTextFromMessage(message));
  }

  private appendAnswerDelta(id: string, text: string): void {
    const previous = this.answerTexts.get(id) ?? "";
    this.answerTexts.set(id, text);
    if (!text.startsWith(previous)) return;
    const delta = text.slice(previous.length);
    if (!delta) return;
    this.stream.appendText(delta);
    this.renderedAnswer += delta;
  }

  private appendProgressDelta(id: string, text: string): void {
    const previous = this.progressTexts.get(id) ?? "";
    this.progressTexts.set(id, text);
    if (!text.startsWith(previous)) return;
    const delta = text.slice(previous.length);
    if (!delta) return;
    this.stream.appendProgress?.(delta);
  }

  private appendReasoningDelta(id: string, text: string): void {
    const previous = this.reasoningTexts.get(id) ?? "";
    this.reasoningTexts.set(id, text);
    if (!text.startsWith(previous)) return;
    const delta = text.slice(previous.length);
    if (!delta) return;
    this.stream.appendReasoning?.(delta);
    this.renderedReasoning += delta;
  }
}

function answerTextFromMessage(message: SparkMessageView): string {
  const parts = message.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const textParts = parts.filter(
      (part): part is Extract<SparkConversationPart, { type: "text" }> => part.type === "text",
    );
    const finalParts = textParts.filter((part) => part.phase === "final_answer" && part.text);
    if (finalParts.length > 0) return finalParts.map((part) => part.text).join("\n");
    const hasToolCall = parts.some((part) => part.type === "tool-call");
    if (message.metadata.stopReason === "toolUse" || hasToolCall) return "";

    // Inline adapters retain their existing streaming behavior. Adapters that
    // need a hard execution/answer boundary declare `answerMode: "separate"`
    // and never project this text into their progress surface.
    return textParts
      .flatMap((part) => (part.phase !== "commentary" && part.text ? [part.text] : []))
      .filter(Boolean)
      .join("\n");
  }
  return stripToolCallMarkers(message.text);
}

function progressTextFromMessage(message: SparkMessageView): string {
  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length === 0) return "";
  const commentary = parts.flatMap((part) =>
    part.type === "text" && part.phase === "commentary" && part.text ? [part.text] : [],
  );
  if (commentary.length > 0) return commentary.join("\n");
  const hasToolCall = parts.some((part) => part.type === "tool-call");
  if (message.status !== "done" || (message.metadata.stopReason !== "toolUse" && !hasToolCall)) {
    return "";
  }
  return parts
    .flatMap((part) =>
      part.type === "text" && part.phase === undefined && part.text ? [part.text] : [],
    )
    .join("\n");
}

function reasoningTextFromMessage(message: SparkMessageView): string {
  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length === 0) return "";
  return parts
    .flatMap((part: SparkConversationPart) => {
      if (part.type !== "thinking" || part.redacted) return [];
      const text = part.text?.trim();
      return text ? [text] : [];
    })
    .join("\n");
}

function stripToolCallMarkers(text: string): string {
  return text
    .replace(TOOL_CALL_MARKER, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trimStart();
}
