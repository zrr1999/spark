import { z } from "zod";
import { TASK_STATUSES } from "@zendev-lab/spark-core";
import { sparkModelRefSchema, sparkThinkingLevelSchema } from "./model-control.ts";

export * from "./action-bars.ts";
export * from "./ask-semantics.ts";
export * from "./channel-control.ts";
export * from "./command-delivery.ts";
export * from "./command-events.ts";
export * from "./command-sources.ts";
export * from "./display-error.ts";
export * from "./errors.ts";
export * from "./human-interaction.ts";
export * from "./invocation-lifecycle.ts";
export * from "./model-control.ts";
export * from "./model-control-client.ts";
export * from "./refs.ts";
export * from "./runtime-v1/envelope.ts";
export * from "./runtime-v1/ephemeral-secret.ts";
export * from "./runtime-v1/messages.ts";
export * from "./runtime-v1/registration.ts";
export * from "./session-assignment.ts";
export * from "./state-ownership.ts";
export * from "./tool-display.ts";
export { SPARK_PROTOCOL_VERSION } from "./version.ts";
export type {
  SparkProtocolVersion,
  SparkProtocolVersionInfo,
  SparkRuntimeProtocolVersion,
} from "./version.ts";
export {
  SPARK_RUNTIME_PROTOCOL_VERSION,
  assertSparkProtocolVersion,
  assertSparkRuntimeProtocolVersion,
  currentSparkProtocolVersions,
  isSparkRuntimeProtocolVersion,
} from "./version.ts";

import { SPARK_PROTOCOL_VERSION } from "./version.ts";

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type SparkJsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: SparkJsonValue }
  | SparkJsonValue[];
export const sparkJsonValueSchema: z.ZodType<SparkJsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(sparkJsonValueSchema),
    z.record(z.string(), sparkJsonValueSchema),
  ]),
);
export const sparkJsonObjectSchema = z.record(z.string(), sparkJsonValueSchema);
export type SparkJsonObject = z.infer<typeof sparkJsonObjectSchema>;

export const sparkProtocolVersionSchema = z.literal(SPARK_PROTOCOL_VERSION);
export const sparkIsoDateTimeSchema = z.string().datetime({ offset: true });
export const sparkRefSchema = z.string().min(1);

export const sparkViewModelStatusSchema = z.enum([
  "idle",
  "queued",
  "running",
  "streaming",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "unknown",
]);

export const sparkMessageRoleSchema = z.enum([
  "system",
  "user",
  "assistant",
  "tool",
  "thinking",
  "custom",
]);
export const sparkMessageStatusSchema = z.enum(["pending", "streaming", "done", "error"]);

export const sparkToolCallStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const sparkConversationPartStatusSchema = z.enum([
  "pending",
  "running",
  "streaming",
  "complete",
  "failed",
  "cancelled",
]);
export const sparkTextConversationPartPhaseSchema = z.enum(["commentary", "final_answer"]);
export const sparkRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

const sparkConversationPartBaseSchema = z.object({
  id: z.string().min(1),
  status: sparkConversationPartStatusSchema,
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkTextConversationPartSchema = sparkConversationPartBaseSchema.extend({
  type: z.literal("text"),
  text: z.string(),
  phase: sparkTextConversationPartPhaseSchema.optional(),
});

export type SparkTextConversationPartPhase = z.infer<typeof sparkTextConversationPartPhaseSchema>;

/**
 * Extract the display-safe phase marker embedded by Pi/native providers.
 *
 * The signature itself is opaque provider data and must never be projected to
 * session views. Unknown or malformed signatures intentionally fall back to
 * legacy text semantics.
 */
export function sparkTextPhaseFromSignature(
  signature: unknown,
): SparkTextConversationPartPhase | undefined {
  if (typeof signature !== "string" || !signature) return undefined;
  try {
    const parsed: unknown = JSON.parse(signature);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const phase = (parsed as { phase?: unknown }).phase;
    return phase === "commentary" || phase === "final_answer" ? phase : undefined;
  } catch {
    return undefined;
  }
}

export const sparkThinkingConversationPartSchema = sparkConversationPartBaseSchema.extend({
  type: z.literal("thinking"),
  text: z.string(),
  redacted: z.boolean().optional(),
});

export const sparkToolCallConversationPartSchema = sparkConversationPartBaseSchema.extend({
  type: z.literal("tool-call"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  summary: z.string().optional(),
});

export const sparkToolResultConversationPartSchema = sparkConversationPartBaseSchema.extend({
  type: z.literal("tool-result"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  summary: z.string().optional(),
});

/** Ordered, display-safe conversation data shared by terminal and graphical hosts. */
export const sparkConversationPartSchema = z.discriminatedUnion("type", [
  sparkTextConversationPartSchema,
  sparkThinkingConversationPartSchema,
  sparkToolCallConversationPartSchema,
  sparkToolResultConversationPartSchema,
]);

export const sparkMessageViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  id: z.string().min(1),
  role: sparkMessageRoleSchema,
  text: z.string().default(""),
  status: sparkMessageStatusSchema.default("done"),
  createdAt: sparkIsoDateTimeSchema.optional(),
  updatedAt: sparkIsoDateTimeSchema.optional(),
  parentId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  customType: z.string().min(1).optional(),
  display: z.boolean().optional(),
  parts: z.array(sparkConversationPartSchema).optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkToolCallViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  status: sparkToolCallStatusSchema,
  input: sparkJsonValueSchema.optional(),
  output: sparkJsonValueSchema.optional(),
  error: z.string().optional(),
  startedAt: sparkIsoDateTimeSchema.optional(),
  completedAt: sparkIsoDateTimeSchema.optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkRunViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  id: z.string().min(1),
  kind: z.enum(["session", "role", "workflow", "task", "daemon", "other"]),
  title: z.string().min(1).optional(),
  status: sparkRunStatusSchema,
  progress: z.number().min(0).max(1).optional(),
  summary: z.string().optional(),
  startedAt: sparkIsoDateTimeSchema.optional(),
  completedAt: sparkIsoDateTimeSchema.optional(),
  artifactRefs: z.array(sparkRefSchema).default([]),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkTaskTodoViewSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "blocked", "done", "cancelled"]),
  notes: z.array(z.string()).default([]),
});

export const sparkTaskViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  ref: sparkRefSchema,
  name: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  kind: z.string().optional(),
  status: z.enum(TASK_STATUSES),
  owner: z.string().optional(),
  projectRef: sparkRefSchema.optional(),
  todos: z.array(sparkTaskTodoViewSchema).default([]),
  runRefs: z.array(sparkRefSchema).default([]),
  artifactRefs: z.array(sparkRefSchema).default([]),
  metadata: sparkJsonObjectSchema.default({}),
});

/**
 * Product-facing deliverables (Cockpit 产物): issue / pr / preview.
 * Legacy snapshots may still carry evidence kinds here; new emits use
 * `evidence.update` + `sparkEvidenceViewSchema` instead.
 */
export const sparkArtifactViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  ref: sparkRefSchema,
  title: z.string().min(1),
  kind: z.enum(["document", "record", "trace", "knowledge", "issue", "pr", "preview", "other"]),
  format: z.enum(["markdown", "json", "text", "mdx", "html", "blob", "other"]),
  status: z.string().optional(),
  producer: z.string().optional(),
  createdAt: sparkIsoDateTimeSchema.optional(),
  updatedAt: sparkIsoDateTimeSchema.optional(),
  preview: z.string().optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

/** Agent-internal ledger notes (not Cockpit 产物). Prefer `evidence:` refs. */
export const sparkEvidenceViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  ref: sparkRefSchema,
  title: z.string().min(1),
  kind: z.enum(["document", "record", "trace", "knowledge", "other"]),
  format: z.enum(["markdown", "json", "text", "blob", "other"]),
  status: z.string().optional(),
  producer: z.string().optional(),
  createdAt: sparkIsoDateTimeSchema.optional(),
  updatedAt: sparkIsoDateTimeSchema.optional(),
  preview: z.string().optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkSessionMailChannelDeliveryViewSchema = z.object({
  status: z.enum(["pending", "delivered", "failed", "uncertain"]),
  total: z.number().int().positive(),
  pending: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  uncertain: z.number().int().nonnegative(),
});

export const sparkSessionMailMessageViewSchema = z.object({
  id: z.string().min(1),
  fromSessionId: z.string().min(1),
  kind: z.enum(["request", "question", "notification"]),
  intent: z.string().min(1),
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: sparkIsoDateTimeSchema,
  readAt: sparkIsoDateTimeSchema.nullable(),
  ackedAt: sparkIsoDateTimeSchema.nullable(),
  /** Display-safe channel delivery aggregate; provider targets and receipts stay daemon-private. */
  channelDelivery: sparkSessionMailChannelDeliveryViewSchema.optional(),
});

/**
 * Lifetime, display-safe usage totals for one session.
 *
 * Token totals are cumulative across the complete native transcript. Context
 * tokens describe the latest trustworthy assistant response and may be absent
 * immediately after compaction or before the first provider response.
 */
export const sparkSessionUsageSchema = z.object({
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  cacheReadTokens: z.number().nonnegative().default(0),
  cacheWriteTokens: z.number().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  latestCacheHitPercent: z.number().min(0).max(100).optional(),
  contextTokens: z.number().nonnegative().optional(),
  contextTokenSource: z.enum(["reported", "tokenizer", "estimated"]).optional(),
  contextWindow: z.number().positive().optional(),
});

/**
 * Daemon-owned admission state for turns that have not reached a terminal
 * invocation status yet. The field on `SparkSessionView` is optional so a
 * Cockpit-only fallback projection can be distinguished from an authoritative
 * daemon snapshot with an empty pending set.
 */
export const sparkSessionPendingTurnSchema = z.object({
  invocationId: z.string().min(1),
  prompt: z.string(),
  status: z.enum(["queued", "running"]),
  createdAt: sparkIsoDateTimeSchema,
  startedAt: sparkIsoDateTimeSchema.optional(),
});

export const sparkSessionViewSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  title: z.string().min(1).optional(),
  cwd: z.string().optional(),
  activeLeafId: z.string().min(1).optional(),
  status: sparkViewModelStatusSchema.default("idle"),
  model: sparkModelRefSchema.optional(),
  thinkingLevel: sparkThinkingLevelSchema.optional(),
  gitBranch: z.string().min(1).optional(),
  usage: sparkSessionUsageSchema.optional(),
  pendingTurns: z.array(sparkSessionPendingTurnSchema).optional(),
  messages: z.array(sparkMessageViewSchema).default([]),
  tools: z.array(sparkToolCallViewSchema).default([]),
  runs: z.array(sparkRunViewSchema).default([]),
  tasks: z.array(sparkTaskViewSchema).default([]),
  artifacts: z.array(sparkArtifactViewSchema).default([]),
  /** Agent-internal evidence ledger projections; product deliverables stay in `artifacts`. */
  evidence: z.array(sparkEvidenceViewSchema).default([]),
  mailbox: z.array(sparkSessionMailMessageViewSchema).optional(),
  createdAt: sparkIsoDateTimeSchema.optional(),
  updatedAt: sparkIsoDateTimeSchema.optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkSessionSnapshotHistorySchema = z.object({
  totalMessages: z.number().int().nonnegative(),
  loadedMessages: z.number().int().nonnegative(),
  hiddenMessages: z.number().int().nonnegative(),
  /** Messages before this page. */
  earlierMessages: z.number().int().nonnegative(),
  /** Messages after this page; non-zero for an older cursor page. */
  laterMessages: z.number().int().nonnegative(),
  hasEarlierMessages: z.boolean(),
  /** Exclusive cursor for the next older page. */
  nextBeforeMessageId: z.string().trim().min(1).optional(),
});

/** Exact bounded transcript page returned by `session.snapshot.request`. */
export const sparkSessionSnapshotPageSchema = z
  .object({
    snapshot: sparkSessionViewSchema,
    history: sparkSessionSnapshotHistorySchema,
  })
  .superRefine((page, context) => {
    const { history, snapshot } = page;
    if (history.loadedMessages + history.hiddenMessages !== history.totalMessages) {
      context.addIssue({
        code: "custom",
        path: ["history"],
        message: "snapshot history counts do not match its total",
      });
    }
    if (history.earlierMessages + history.laterMessages !== history.hiddenMessages) {
      context.addIssue({
        code: "custom",
        path: ["history"],
        message: "snapshot page counts do not match hidden messages",
      });
    }
    if (snapshot.messages.length !== history.loadedMessages) {
      context.addIssue({
        code: "custom",
        path: ["snapshot", "messages"],
        message: "snapshot message window does not match loaded messages",
      });
    }
    if (history.hasEarlierMessages !== history.earlierMessages > 0) {
      context.addIssue({
        code: "custom",
        path: ["history", "hasEarlierMessages"],
        message: "snapshot continuation flag does not match earlier messages",
      });
    }
    const firstMessageId = snapshot.messages[0]?.id;
    if (
      history.hasEarlierMessages &&
      (!history.nextBeforeMessageId || history.nextBeforeMessageId !== firstMessageId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["history", "nextBeforeMessageId"],
        message: "snapshot continuation cursor must match its first message",
      });
    }
    if (!history.hasEarlierMessages && history.nextBeforeMessageId) {
      context.addIssue({
        code: "custom",
        path: ["history", "nextBeforeMessageId"],
        message: "final snapshot page cannot have a continuation cursor",
      });
    }
  });

export const sparkAskOptionViewSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  preview: z.string().optional(),
});

export const sparkAskQuestionViewSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  header: z.string().optional(),
  type: z.enum(["single", "multi", "preview", "freeform"]).default("single"),
  required: z.boolean().default(false),
  defaultValues: z.array(z.string()).default([]),
  options: z.array(sparkAskOptionViewSchema).default([]),
});

export const sparkInteractionBaseRequestSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().optional(),
  createdAt: sparkIsoDateTimeSchema.optional(),
  source: z.enum(["tui", "web", "daemon", "extension", "runtime", "test"]).optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkAskFlowInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend({
  kind: z.literal("askFlow"),
  /**
   * `blocking` keeps the tool call suspended until a human answers. `async`
   * durably opens the request and returns its handle to the caller immediately.
   */
  delivery: z.enum(["blocking", "async"]).optional(),
  /** Host-owned blocking wait deadline. A timeout closes the human wait before fallback begins. */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60_000)
    .optional(),
  mode: z.enum(["clarification", "decision", "approval", "unblock"]).default("clarification"),
  flow: z.string().min(1).optional(),
  questions: z.array(sparkAskQuestionViewSchema).min(1),
  allowElaborate: z.boolean().optional(),
});

export const sparkModelSelectOptionSchema = sparkModelRefSchema.extend({
  value: z.string().min(1),
  description: z.string().optional(),
  active: z.boolean().default(false),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkModelSelectInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend({
  kind: z.literal("modelSelect"),
  active: sparkModelRefSchema.optional(),
  options: z.array(sparkModelSelectOptionSchema).default([]),
});

export const sparkWorkflowPickerOptionSchema = z.object({
  selector: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  phaseCount: z.number().int().nonnegative().optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkWorkflowPickerInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend(
  {
    kind: z.literal("workflowPicker"),
    options: z.array(sparkWorkflowPickerOptionSchema).default([]),
  },
);

export const sparkConfirmationInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend({
  kind: z.literal("confirmation"),
  severity: z.enum(["info", "warning", "danger"]).default("info"),
  confirmLabel: z.string().min(1).default("Confirm"),
  cancelLabel: z.string().min(1).default("Cancel"),
});

export const sparkDiffApprovalInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend({
  kind: z.literal("diffApproval"),
  filePath: z.string().optional(),
  diff: z.string().min(1),
  summary: z.string().optional(),
  approveLabel: z.string().min(1).default("Approve"),
  rejectLabel: z.string().min(1).default("Reject"),
});

export const sparkToolApprovalInteractionRequestSchema = sparkInteractionBaseRequestSchema.extend({
  kind: z.literal("toolApproval"),
  toolName: z.string().min(1),
  toolCallId: z.string().min(1).optional(),
  arguments: sparkJsonValueSchema.optional(),
  reason: z.string().optional(),
  approveLabel: z.string().min(1).default("Approve"),
  rejectLabel: z.string().min(1).default("Reject"),
});

export const sparkInteractionRequestSchema = z.discriminatedUnion("kind", [
  sparkAskFlowInteractionRequestSchema,
  sparkModelSelectInteractionRequestSchema,
  sparkWorkflowPickerInteractionRequestSchema,
  sparkConfirmationInteractionRequestSchema,
  sparkDiffApprovalInteractionRequestSchema,
  sparkToolApprovalInteractionRequestSchema,
]);

const sparkInteractionResponseBaseSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  requestId: z.string().min(1),
  status: z.enum(["answered", "pending", "cancelled", "blocked", "error"]),
  message: z.string().optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkAskFlowInteractionResponseSchema = sparkInteractionResponseBaseSchema.extend({
  kind: z.literal("askFlow"),
  /** Present for daemon-backed asks, and required by convention for `pending`. */
  humanRequestId: z.string().min(1).optional(),
  answers: sparkJsonObjectSchema.default({}),
  nextAction: z.enum(["resume", "block", "cancel"]).optional(),
});

export const sparkModelSelectInteractionResponseSchema = sparkInteractionResponseBaseSchema.extend({
  kind: z.literal("modelSelect"),
  selection: sparkModelRefSchema.optional(),
});

export const sparkWorkflowPickerInteractionResponseSchema =
  sparkInteractionResponseBaseSchema.extend({
    kind: z.literal("workflowPicker"),
    selector: z.string().min(1).optional(),
  });

export const sparkApprovalInteractionResponseSchema = sparkInteractionResponseBaseSchema.extend({
  kind: z.enum(["confirmation", "diffApproval", "toolApproval"]),
  approved: z.boolean().optional(),
  note: z.string().optional(),
});

export const sparkInteractionResponseSchema = z.discriminatedUnion("kind", [
  sparkAskFlowInteractionResponseSchema,
  sparkModelSelectInteractionResponseSchema,
  sparkWorkflowPickerInteractionResponseSchema,
  sparkApprovalInteractionResponseSchema,
]);

export const sparkViewModelEventSchema = z.discriminatedUnion("type", [
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("session.snapshot"),
    session: sparkSessionViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("session.message"),
    sessionId: z.string().min(1),
    message: sparkMessageViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("run.update"),
    sessionId: z.string().min(1).optional(),
    run: sparkRunViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("task.update"),
    task: sparkTaskViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("artifact.update"),
    artifact: sparkArtifactViewSchema,
  }),
  z.object({
    version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
    type: z.literal("evidence.update"),
    evidence: sparkEvidenceViewSchema,
  }),
]);

const sparkDaemonEventBaseSchema = z.object({
  version: sparkProtocolVersionSchema.default(SPARK_PROTOCOL_VERSION),
  eventId: z.string().min(1).optional(),
  emittedAt: sparkIsoDateTimeSchema.optional(),
  source: z.enum(["daemon", "runtime", "tui", "web", "cockpit", "test"]).default("daemon"),
  workspaceId: sparkRefSchema.optional(),
  projectId: sparkRefSchema.optional(),
  sessionId: z.string().min(1).optional(),
  invocationId: sparkRefSchema.optional(),
  metadata: sparkJsonObjectSchema.default({}),
});

export const sparkDaemonTaskLifecycleEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.task.lifecycle"),
  taskType: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  summary: z.string().optional(),
});

export const sparkDaemonViewEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.view_event"),
  view: sparkViewModelEventSchema,
});

export const sparkDaemonInteractionRequestEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.interaction.request"),
  request: sparkInteractionRequestSchema,
});

export const sparkDaemonInteractionResponseEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.interaction.response"),
  response: sparkInteractionResponseSchema,
});

export const sparkDaemonSessionUpdatedEventSchema = sparkDaemonEventBaseSchema.extend({
  type: z.literal("daemon.session.updated"),
  title: z.string().min(1).optional(),
});

export const sparkDaemonEventSchema = z.discriminatedUnion("type", [
  sparkDaemonTaskLifecycleEventSchema,
  sparkDaemonViewEventSchema,
  sparkDaemonInteractionRequestEventSchema,
  sparkDaemonInteractionResponseEventSchema,
  sparkDaemonSessionUpdatedEventSchema,
]);

export type SparkViewModelStatus = z.infer<typeof sparkViewModelStatusSchema>;
export type SparkMessageRole = z.infer<typeof sparkMessageRoleSchema>;
export type SparkMessageStatus = z.infer<typeof sparkMessageStatusSchema>;
export type SparkConversationPartStatus = z.infer<typeof sparkConversationPartStatusSchema>;
export type SparkTextConversationPart = z.infer<typeof sparkTextConversationPartSchema>;
export type SparkThinkingConversationPart = z.infer<typeof sparkThinkingConversationPartSchema>;
export type SparkToolCallConversationPart = z.infer<typeof sparkToolCallConversationPartSchema>;
export type SparkToolResultConversationPart = z.infer<typeof sparkToolResultConversationPartSchema>;
export type SparkConversationPart = z.infer<typeof sparkConversationPartSchema>;
export type SparkMessageView = z.infer<typeof sparkMessageViewSchema>;
export type SparkToolCallView = z.infer<typeof sparkToolCallViewSchema>;
export type SparkRunView = z.infer<typeof sparkRunViewSchema>;
export type SparkTaskTodoView = z.infer<typeof sparkTaskTodoViewSchema>;
export type SparkTaskView = z.infer<typeof sparkTaskViewSchema>;
export type SparkArtifactView = z.infer<typeof sparkArtifactViewSchema>;
export type SparkEvidenceView = z.infer<typeof sparkEvidenceViewSchema>;
export type SparkSessionMailChannelDeliveryView = z.infer<
  typeof sparkSessionMailChannelDeliveryViewSchema
>;
export type SparkSessionMailMessageView = z.infer<typeof sparkSessionMailMessageViewSchema>;
export type SparkSessionUsage = z.infer<typeof sparkSessionUsageSchema>;
export type SparkSessionPendingTurn = z.infer<typeof sparkSessionPendingTurnSchema>;
export type SparkSessionView = z.infer<typeof sparkSessionViewSchema>;
export type SparkSessionSnapshotHistory = z.infer<typeof sparkSessionSnapshotHistorySchema>;
export type SparkSessionSnapshotPage = z.infer<typeof sparkSessionSnapshotPageSchema>;
export type SparkAskQuestionView = z.infer<typeof sparkAskQuestionViewSchema>;
export type SparkInteractionRequest = z.infer<typeof sparkInteractionRequestSchema>;
export type SparkInteractionResponse = z.infer<typeof sparkInteractionResponseSchema>;
export type SparkViewModelEvent = z.infer<typeof sparkViewModelEventSchema>;
export type SparkDaemonTaskLifecycleEvent = z.infer<typeof sparkDaemonTaskLifecycleEventSchema>;
export type SparkDaemonViewEvent = z.infer<typeof sparkDaemonViewEventSchema>;
export type SparkDaemonInteractionRequestEvent = z.infer<
  typeof sparkDaemonInteractionRequestEventSchema
>;
export type SparkDaemonInteractionResponseEvent = z.infer<
  typeof sparkDaemonInteractionResponseEventSchema
>;
export type SparkDaemonSessionUpdatedEvent = z.infer<typeof sparkDaemonSessionUpdatedEventSchema>;
export type SparkDaemonEvent = z.infer<typeof sparkDaemonEventSchema>;

export function parseSparkInteractionRequest(value: unknown): SparkInteractionRequest {
  return sparkInteractionRequestSchema.parse(value);
}

export function parseSparkInteractionResponse(value: unknown): SparkInteractionResponse {
  return sparkInteractionResponseSchema.parse(value);
}

export function parseSparkSessionView(value: unknown): SparkSessionView {
  return sparkSessionViewSchema.parse(value);
}

export function parseSparkViewModelEvent(value: unknown): SparkViewModelEvent {
  return sparkViewModelEventSchema.parse(value);
}

export function parseSparkDaemonEvent(value: unknown): SparkDaemonEvent {
  return sparkDaemonEventSchema.parse(value);
}

export function createBlockedInteractionResponse(
  request: SparkInteractionRequest,
  message: string,
): SparkInteractionResponse {
  if (
    request.kind === "confirmation" ||
    request.kind === "diffApproval" ||
    request.kind === "toolApproval"
  ) {
    return {
      version: SPARK_PROTOCOL_VERSION,
      kind: request.kind,
      requestId: request.requestId,
      status: "blocked",
      approved: false,
      message,
      metadata: {},
    };
  }
  return {
    version: SPARK_PROTOCOL_VERSION,
    kind: request.kind,
    requestId: request.requestId,
    status: "blocked",
    message,
    metadata: {},
  } as SparkInteractionResponse;
}
