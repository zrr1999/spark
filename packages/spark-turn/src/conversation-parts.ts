/**
 * Conversation part projection helpers for SparkAgentLoop.
 */
import {
  sparkTextPhaseFromSignature,
  summarizeToolCallArguments,
  type SparkConversationPart,
  type SparkMessageView,
} from "@zendev-lab/spark-protocol";

export function assistantConversationParts(
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

export function messageStatusToPartStatus(
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

export function displaySafeAssistantText(content: unknown): string {
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
