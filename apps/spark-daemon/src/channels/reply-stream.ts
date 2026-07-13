import type { ChannelReplyStream } from "@zendev-lab/spark-channels";
import type { SparkDaemonEvent } from "@zendev-lab/spark-protocol";

/**
 * Projects display-safe daemon events onto a channel reply stream.
 * Thinking parts and tool payloads are deliberately ignored.
 */
export class ChannelReplyEventProjector {
  private readonly stream: ChannelReplyStream;
  private readonly texts = new Map<string, string>();
  private renderedText = "";

  constructor(stream: ChannelReplyStream) {
    this.stream = stream;
  }

  observe(event: SparkDaemonEvent): void {
    if (event.type !== "daemon.view_event" || event.view.type !== "session.message") return;
    const message = event.view.message;
    if (message.role === "assistant") {
      this.observeAssistant(message.id, message.text);
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
    const finalText = text?.trim();
    if (!finalText) return;
    if (!this.renderedText) {
      this.stream.appendText(finalText);
      this.renderedText = finalText;
      return;
    }
    if (finalText.startsWith(this.renderedText)) {
      const delta = finalText.slice(this.renderedText.length);
      if (delta) this.stream.appendText(delta);
      this.renderedText = finalText;
    }
  }

  private observeAssistant(id: string, text: string): void {
    const previous = this.texts.get(id) ?? "";
    this.texts.set(id, text);
    if (!text.startsWith(previous)) return;
    const delta = text.slice(previous.length);
    if (!delta) return;
    this.stream.appendText(delta);
    this.renderedText += delta;
  }
}
