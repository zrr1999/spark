/** Native message / view-model conversion helpers. */

import {
  SPARK_PROTOCOL_VERSION,
  type SparkConversationPartStatus,
  type SparkJsonObject,
  type SparkMessageView,
  type SparkToolCallView,
} from "@zendev-lab/spark-protocol";

import type { SparkNativeMessage, SparkNativeMessageRole, SparkNativeToolStatus } from "./types.ts";

export function nativeMessageToView(message: SparkNativeMessage, index: number): SparkMessageView {
  const toolStatus =
    message.role === "tool" ? canonicalToolStatus(message.toolStatus ?? "succeeded") : undefined;
  const metadata = nativeDetailsToMetadata(message.details);
  if (toolStatus) metadata.toolStatus = toolStatus;
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: message.viewId ?? `native-message-${index}`,
    role: message.role,
    text: message.text,
    status:
      message.viewStatus ??
      (message.streaming
        ? "streaming"
        : toolStatus === "pending"
          ? "pending"
          : toolStatus === "failed"
            ? "error"
            : "done"),
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    customType: message.customType,
    display: message.display,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    metadata,
  };
}

export function messageViewToNativeMessages(message: SparkMessageView): SparkNativeMessage[] {
  const parts = message.parts;
  if (!parts || parts.length === 0) return [legacyMessageViewToNativeMessage(message)];

  const messages: SparkNativeMessage[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      messages.push({
        role: message.role,
        text: part.text,
        viewId: part.id,
        streaming: part.status === "running" || part.status === "streaming",
        viewStatus: partStatusToMessageStatus(part.status),
        customType: message.customType,
        display: message.display,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        details: { ...message.metadata, partStatus: part.status, partType: part.type },
      });
      continue;
    }
    if (part.type === "thinking") {
      messages.push({
        role: "thinking",
        text: part.redacted ? "[…]" : part.text,
        viewId: part.id,
        streaming: part.status === "running" || part.status === "streaming",
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        details: { partStatus: part.status, redacted: part.redacted ?? false },
      });
      continue;
    }
    messages.push({
      role: "tool",
      text: part.summary?.trim() ?? "",
      viewId: part.id,
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      toolStatus: partStatusToToolStatus(part.status),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      details: { partStatus: part.status, partType: part.type },
    });
  }
  return messages;
}

export function partStatusToMessageStatus(
  status: SparkConversationPartStatus,
): SparkMessageView["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
    case "streaming":
      return "streaming";
    case "failed":
      return "error";
    case "cancelled":
    case "complete":
      return "done";
  }
}

export function legacyMessageViewToNativeMessage(message: SparkMessageView): SparkNativeMessage {
  const metadataStatus = stringFromRecord(message.metadata, "toolStatus");
  return {
    role: message.role,
    text: message.text,
    viewId: message.id,
    streaming: message.status === "streaming",
    viewStatus: message.status,
    customType: message.customType,
    display: message.display,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    toolStatus:
      message.role === "tool"
        ? canonicalToolStatus(
            metadataStatus ??
              (message.status === "pending"
                ? "pending"
                : message.status === "streaming"
                  ? "running"
                  : message.status === "error"
                    ? "failed"
                    : "succeeded"),
          )
        : undefined,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    details: message.metadata,
  };
}

export function partStatusToToolStatus(status: SparkConversationPartStatus): SparkNativeToolStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
    case "streaming":
      return "running";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "complete":
      return "succeeded";
  }
}

export function toolViewToNativeMessage(tool: SparkToolCallView): SparkNativeMessage {
  return {
    role: "tool",
    text: toolViewDisplayText(tool),
    viewId: `tool:${tool.id}`,
    toolName: tool.name,
    toolCallId: tool.id,
    toolStatus: tool.status,
    createdAt: tool.startedAt,
    updatedAt: tool.completedAt,
    details: { source: "session.tools" },
  };
}

export function toolViewDisplayText(tool: SparkToolCallView): string {
  if (tool.error?.trim()) return tool.error.trim();
  return (
    stringFromRecord(tool.metadata, "displaySummary") ??
    stringFromRecord(tool.metadata, "preview") ??
    ""
  );
}

export function nativeMessageTime(message: SparkNativeMessage): number {
  const createdAt = message.createdAt ? Date.parse(message.createdAt) : NaN;
  return Number.isFinite(createdAt) ? createdAt : 0;
}

export function canonicalToolStatus(status: string): SparkNativeToolStatus {
  if (status === "success") return "succeeded";
  if (status === "error") return "failed";
  if (
    status === "pending" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  return "succeeded";
}

export function toolStatusIcon(status: SparkNativeToolStatus): string {
  switch (status) {
    case "pending":
      return "◌";
    case "running":
      return "▶";
    case "failed":
      return "✗";
    case "cancelled":
      return "■";
    case "succeeded":
      return "✓";
  }
}

export function toolStatusColor(status: SparkNativeToolStatus): string {
  switch (status) {
    case "pending":
      return "warning";
    case "running":
      return "accent";
    case "failed":
      return "error";
    case "cancelled":
      return "muted";
    case "succeeded":
      return "success";
  }
}

export function compactToolPreview(text: string | undefined): string | undefined {
  const firstLine = text
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  const normalized = firstLine.replace(/\s+/gu, " ");
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

export function nativeDetailsToMetadata(
  details: Record<string, unknown> | undefined,
): SparkJsonObject {
  if (!details) return {};
  try {
    return JSON.parse(JSON.stringify(details)) as SparkJsonObject;
  } catch {
    return {};
  }
}

export function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
export function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function userSenderLabelFromDetails(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const origin = recordFromValue(details?.origin);
  if (origin?.kind === "session") {
    const mail = recordFromValue(details?.sessionMail);
    const sessionId =
      stringFromRecord(mail ?? {}, "fromSessionId") ?? stringFromRecord(origin, "sessionId");
    if (sessionId) return `agent:${compactSessionSenderId(sessionId)}`;
  }
  const channel = details?.channel;
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) return undefined;
  const record = channel as Record<string, unknown>;
  const value = stringFromRecord(record, "senderName") ?? stringFromRecord(record, "senderId");
  if (!value) return undefined;
  return value.replace(/\s+/gu, " ").replaceAll(">", "›").slice(0, 48);
}

export function channelQuotePreviewFromDetails(
  details: Record<string, unknown> | undefined,
): { text: string; senderLabel?: string } | undefined {
  const channel = recordFromValue(details?.channel);
  const reference = recordFromValue(channel?.messageReference);
  if (!reference) return undefined;
  const preview = stringFromRecord(reference, "preview");
  const messageId = stringFromRecord(reference, "messageId");
  if (!preview && !messageId) return undefined;
  const senderLabel =
    stringFromRecord(reference, "senderName") ?? stringFromRecord(reference, "senderId");
  return {
    text: (preview || "引用消息").replace(/\s+/gu, " ").slice(0, 240),
    ...(senderLabel
      ? { senderLabel: senderLabel.replace(/\s+/gu, " ").replaceAll(">", "›").slice(0, 48) }
      : {}),
  };
}

function recordFromValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactSessionSenderId(sessionId: string): string {
  const safe = sessionId.replace(/\s+/gu, " ").replaceAll(">", "›");
  const compact = safe.startsWith("session:") ? safe.slice("session:".length) : safe;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(compact)) return `${compact.slice(0, 8)}…`;
  return compact.length > 24 ? `${compact.slice(0, 12)}…` : compact;
}
