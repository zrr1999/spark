/**
 * Session/view-model projection helpers for SparkAgentLoop.
 */
import { isTaskStatus } from "@zendev-lab/spark-core";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@zendev-lab/spark-ai";
import {
  SPARK_PROTOCOL_VERSION,
  summarizeToolCallArguments,
  summarizeToolResultContent,
  type SparkArtifactView,
  type SparkEvidenceView,
  type SparkMessageView,
  type SparkRunView,
  type SparkTaskTodoView,
  type SparkTaskView,
} from "@zendev-lab/spark-protocol";
import { assistantConversationParts, displaySafeAssistantText } from "./conversation-parts.ts";

let viewMessageCounter = 0;
const PRODUCT_ARTIFACT_PREVIEW_MAX_CHARS = 8_000;
// Keep daemon view events comfortably below Cockpit's 256 KiB inline-preview budget,
// including worst-case multi-byte UTF-8 input.
const PRODUCT_ARTIFACT_INLINE_MAX_CHARS = 64 * 1_024;

export function nextViewMessageId(sessionId: string, role: string): string {
  viewMessageCounter += 1;
  return `${sessionId}:message:${role}:${Date.now().toString(36)}:${viewMessageCounter}`;
}

export function messageToView(message: Message, id: string): SparkMessageView {
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

export function assistantToMessageView(
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

export function toolCallToMessageView(toolCall: ToolCall): SparkMessageView {
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

export function toolResultToMessageView(message: ToolResultMessage): SparkMessageView {
  const id = `tool-call:${message.toolCallId}`;
  const summary =
    summarizeToolResultContent(message.content) ??
    `${message.toolName} ${message.isError ? "failed" : "completed"}`;
  return {
    version: SPARK_PROTOCOL_VERSION,
    id,
    role: "tool",
    text: summary,
    // Tool failure is process state, not a terminal conversation failure.
    // The tool-result part retains status=failed for the execution chain.
    status: "done",
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

export function toolUpdateToMessageView(
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

export function runStatusForStopReason(
  reason: AssistantMessage["stopReason"],
): SparkRunView["status"] {
  if (reason === "toolUse") return "running";
  if (reason === "aborted") return "cancelled";
  if (reason === "error") return "failed";
  return "succeeded";
}

export function isSparkMessageRole(role: string): role is SparkMessageView["role"] {
  return (
    role === "system" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool" ||
    role === "thinking" ||
    role === "custom"
  );
}

export function contentToText(content: unknown): string {
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

export function timestampToIso(timestamp: unknown): string | undefined {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

export function jsonMetadata(record: Record<string, unknown>): SparkMessageView["metadata"] {
  try {
    return JSON.parse(JSON.stringify(record)) as SparkMessageView["metadata"];
  } catch {
    return {};
  }
}

export function taskViewsFromToolDetails(
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

export function entityViewsFromToolDetails(
  details: unknown,
  metadata: Record<string, unknown>,
): Array<
  | { type: "artifact"; artifact: SparkArtifactView }
  | { type: "evidence"; evidence: SparkEvidenceView }
> {
  const entities: Array<
    | { type: "artifact"; artifact: SparkArtifactView }
    | { type: "evidence"; evidence: SparkEvidenceView }
  > = [];
  const seenRefs = new Set<string>();
  scanToolDetails(details, (candidate) => {
    const entity = entityViewFromCandidate(candidate, metadata);
    if (!entity) return;
    const ref = entity.type === "artifact" ? entity.artifact.ref : entity.evidence.ref;
    if (seenRefs.has(ref)) return;
    seenRefs.add(ref);
    entities.push(entity);
  });
  return entities;
}

export function scanToolDetails(
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

export function taskViewFromCandidate(
  candidate: Record<string, unknown>,
  metadata: Record<string, unknown>,
): SparkTaskView | undefined {
  const ref = stringField(candidate, "ref");
  if (!ref?.startsWith("task:")) return undefined;
  const title = stringField(candidate, "title") ?? stringField(candidate, "name") ?? ref;
  const rawStatus = stringField(candidate, "status");
  const status = isTaskStatus(rawStatus) ? rawStatus : "pending";
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
    ].filter(
      (value, index, array) => value.startsWith("artifact:") && array.indexOf(value) === index,
    ),
    evidenceRefs: [
      ...stringArrayField(candidate, "evidenceRefs"),
      ...stringArrayField(candidate, "outputArtifacts"),
    ].filter(
      (value, index, array) => value.startsWith("evidence:") && array.indexOf(value) === index,
    ),
    metadata: jsonMetadata(metadata),
  };
}

export function entityViewFromCandidate(
  candidate: Record<string, unknown>,
  metadata: Record<string, unknown>,
):
  | { type: "artifact"; artifact: SparkArtifactView }
  | { type: "evidence"; evidence: SparkEvidenceView }
  | undefined {
  const ref =
    stringField(candidate, "ref") ??
    stringField(candidate, "artifactRef") ??
    stringField(candidate, "evidenceRef");
  if (!ref) return undefined;
  const isEvidenceRef = ref.startsWith("evidence:");
  const isArtifactRef = ref.startsWith("artifact:");
  if (!isEvidenceRef && !isArtifactRef) return undefined;

  const rawKind = stringField(candidate, "kind");
  const provenance = recordField(candidate, "provenance");
  const producer =
    stringField(candidate, "producer") ?? stringField(provenance, "producer") ?? undefined;
  const common = {
    version: SPARK_PROTOCOL_VERSION,
    ref,
    title: stringField(candidate, "title") ?? ref,
    ...(stringField(candidate, "status") ? { status: stringField(candidate, "status") } : {}),
    ...(producer ? { producer } : {}),
    ...(isoStringField(candidate, "createdAt")
      ? { createdAt: isoStringField(candidate, "createdAt") }
      : {}),
    ...(isoStringField(candidate, "updatedAt")
      ? { updatedAt: isoStringField(candidate, "updatedAt") }
      : {}),
    ...(stringField(candidate, "preview") ? { preview: stringField(candidate, "preview") } : {}),
    metadata: jsonMetadata(metadata),
  };

  if (isProductArtifactKind(rawKind) && isArtifactRef) {
    const rawFormat = stringField(candidate, "format");
    if (!rawFormat && !recordField(candidate, "body") && !stringField(candidate, "preview")) {
      // artifact.list returns summary rows. They are useful for lookup but must
      // not overwrite a previously projected Cockpit body with an empty update.
      return undefined;
    }
    const productPreview = productArtifactPreview(candidate);
    const contentRef = productArtifactContentRef(candidate, rawKind, ref);
    return {
      type: "artifact",
      artifact: {
        ...common,
        kind: rawKind,
        format: productArtifactFormat(rawFormat),
        ...(productPreview ? { preview: productPreview } : {}),
        ...(contentRef ? { contentRef } : {}),
      },
    };
  }

  if (!isEvidenceRef) return undefined;

  return {
    type: "evidence",
    evidence: {
      ...common,
      kind: evidenceKind(rawKind),
      format: evidenceFormat(stringField(candidate, "format")),
    },
  };
}

function productArtifactPreview(candidate: Record<string, unknown>): string | undefined {
  const direct = stringField(candidate, "preview");
  const body = recordField(candidate, "body");
  const content =
    stringField(body, "kind") === "preview" && typeof body?.content === "string"
      ? body.content
      : undefined;
  const value = content?.trim() ? content : direct;
  if (!value) return undefined;
  return value.length <= PRODUCT_ARTIFACT_PREVIEW_MAX_CHARS
    ? value
    : `${value.slice(0, PRODUCT_ARTIFACT_PREVIEW_MAX_CHARS - 1)}…`;
}

function productArtifactContentRef(
  candidate: Record<string, unknown>,
  kind: "issue" | "pr" | "preview",
  ref: string,
): NonNullable<SparkArtifactView["contentRef"]> | undefined {
  const body = recordField(candidate, "body");
  if (!body) return undefined;
  if (kind === "preview") {
    if (typeof body.content !== "string") return undefined;
    const format = stringField(body, "format") ?? stringField(candidate, "format");
    if (body.content.length > PRODUCT_ARTIFACT_INLINE_MAX_CHARS) {
      return { sparkArtifactRef: ref, inlinePreviewOmitted: "too_large" };
    }
    return jsonMetadata({
      sparkArtifactRef: ref,
      ...(format === "html" ? { inlineText: body.content } : { inlineMarkdown: body.content }),
    });
  }
  const safeBody = jsonMetadata(body);
  if (JSON.stringify(safeBody).length > PRODUCT_ARTIFACT_INLINE_MAX_CHARS) {
    return { sparkArtifactRef: ref, inlinePreviewOmitted: "too_large" };
  }
  return { sparkArtifactRef: ref, inlineJson: safeBody };
}

export function taskTodosFromCandidate(candidate: Record<string, unknown>): SparkTaskTodoView[] {
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

export function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function isoStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

export function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function taskTodoStatus(value: string | undefined): SparkTaskTodoView["status"] {
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

export function isProductArtifactKind(
  value: string | undefined,
): value is "issue" | "pr" | "preview" {
  return value === "issue" || value === "pr" || value === "preview";
}

export function evidenceKind(value: string | undefined): SparkEvidenceView["kind"] {
  if (value === "document" || value === "record" || value === "trace" || value === "knowledge") {
    return value;
  }
  return "other";
}

export function evidenceFormat(value: string | undefined): SparkEvidenceView["format"] {
  if (value === "markdown" || value === "json" || value === "text" || value === "blob") {
    return value;
  }
  return "other";
}

export function productArtifactFormat(value: string | undefined): SparkArtifactView["format"] {
  if (
    value === "markdown" ||
    value === "json" ||
    value === "text" ||
    value === "mdx" ||
    value === "html"
  ) {
    return value;
  }
  return "json";
}
