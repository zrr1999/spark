import { z } from "zod";
import { isoDateTimeSchema } from "./refs.ts";
import { sparkProtocolJsonObjectSchema } from "./command-events.ts";

export const sparkInvocationIdSchema = z.string().regex(/^inv_[A-Za-z0-9]+$/u);
export const sparkInvocationStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const sparkTurnOriginBindingSchema = z.object({
  workspaceId: z.string().min(1),
  adapter: z.enum(["feishu", "infoflow", "qqbot"]),
  adapterId: z.string().min(1),
  adapterAccountIdentity: z.string().min(1).optional(),
  externalKey: z.string().min(1),
  recipient: z.string().min(1),
});

export const SPARK_TURN_ATTACHMENT_MAX_COUNT = 8;
export const SPARK_TURN_ATTACHMENT_MAX_BYTES = 6 * 1024 * 1024;
export const SPARK_TURN_ATTACHMENT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

const sparkTurnAttachmentSchema = z
  .object({
    kind: z.enum(["image", "file"]),
    name: z.string().trim().min(1).max(240),
    mediaType: z.string().trim().min(1).max(160),
    size: z.number().int().nonnegative().max(SPARK_TURN_ATTACHMENT_MAX_BYTES),
    /** Raw base64 bytes; data URLs are rejected at the browser boundary. */
    data: z.string().max(Math.ceil((SPARK_TURN_ATTACHMENT_MAX_BYTES * 4) / 3) + 4),
  })
  .superRefine((attachment, context) => {
    const decodedSize = decodedBase64Size(attachment.data);
    if (decodedSize === null || decodedSize !== attachment.size) {
      context.addIssue({
        code: "custom",
        message: "attachment data must be canonical base64 matching size",
        path: ["data"],
      });
    }
    if (attachment.kind === "image" && !attachment.mediaType.startsWith("image/")) {
      context.addIssue({
        code: "custom",
        message: "image attachment mediaType must start with image/",
        path: ["mediaType"],
      });
    }
  });

export const sparkTurnAttachmentsSchema = z
  .array(sparkTurnAttachmentSchema)
  .max(SPARK_TURN_ATTACHMENT_MAX_COUNT)
  .superRefine((attachments, context) => {
    const totalBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
    if (totalBytes > SPARK_TURN_ATTACHMENT_MAX_TOTAL_BYTES) {
      context.addIssue({
        code: "custom",
        message: `turn attachments exceed ${SPARK_TURN_ATTACHMENT_MAX_TOTAL_BYTES} bytes`,
      });
    }
  });

export const sparkTurnSubmitRequestSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string(),
  idempotencyKey: z.string().min(1).optional(),
  model: z
    .string()
    .regex(/^[^/\s]+\/.+$/u)
    .optional(),
  reset: z.boolean().optional(),
  originBinding: sparkTurnOriginBindingSchema.optional(),
  attachments: sparkTurnAttachmentsSchema.optional(),
});

export const sparkTurnSubmitResultSchema = z.object({
  invocationId: sparkInvocationIdSchema,
  status: sparkInvocationStatusSchema,
  acceptedAt: isoDateTimeSchema,
});

export const sparkTurnStatusRequestSchema = z.object({
  invocationId: sparkInvocationIdSchema,
});

export const sparkInvocationListRequestSchema = z.object({
  status: sparkInvocationStatusSchema.optional(),
  sessionId: z.string().min(1).optional(),
  since: isoDateTimeSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
});

export const sparkInvocationSummarySchema = z.object({
  invocationId: sparkInvocationIdSchema,
  sessionId: z.string().min(1).optional(),
  retryOfInvocationId: sparkInvocationIdSchema.optional(),
  status: sparkInvocationStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).max(500).optional(),
  retryable: z.boolean(),
  eventCursor: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional(),
  finishedAt: isoDateTimeSchema.optional(),
});

export const sparkInvocationListResultSchema = z.object({
  invocations: z.array(sparkInvocationSummarySchema).max(100),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative(),
  observedAt: isoDateTimeSchema,
});

export const sparkTurnStatusResultSchema = z.object({
  invocationId: sparkInvocationIdSchema,
  sessionId: z.string().min(1).optional(),
  retryOfInvocationId: sparkInvocationIdSchema.optional(),
  status: sparkInvocationStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional(),
  finishedAt: isoDateTimeSchema.optional(),
  cancelReason: z.string().optional(),
  error: z
    .object({
      code: z.string().min(1).optional(),
      message: z.string().min(1),
    })
    .optional(),
  eventCursor: z.number().int().nonnegative(),
});

export const sparkTurnStreamRequestSchema = z.object({
  invocationId: sparkInvocationIdSchema,
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
});

export const sparkInvocationEventSchema = z.object({
  invocationId: sparkInvocationIdSchema,
  sequence: z.number().int().positive(),
  kind: z.string().min(1),
  payload: sparkProtocolJsonObjectSchema.default({}),
  createdAt: isoDateTimeSchema,
});

export const sparkTurnStreamPageSchema = z.object({
  invocationId: sparkInvocationIdSchema,
  events: z.array(sparkInvocationEventSchema).max(500),
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export const sparkTurnCancelRequestSchema = z.object({
  invocationId: sparkInvocationIdSchema,
  reason: z.string().min(1).optional(),
});

export const sparkTurnCancelResultSchema = z.object({
  invocationId: sparkInvocationIdSchema,
  status: sparkInvocationStatusSchema,
  cancelRequested: z.boolean(),
});

export const sparkTurnResultSchema = z.object({
  invocationId: sparkInvocationIdSchema,
  status: sparkInvocationStatusSchema,
  assistantText: z.string().max(262_144).optional(),
  error: z
    .object({
      code: z.string().min(1).optional(),
      message: z.string().min(1),
      retryable: z.boolean(),
    })
    .optional(),
  finishedAt: isoDateTimeSchema.optional(),
});

export const sparkInvocationRetryRequestSchema = z.object({
  invocationId: sparkInvocationIdSchema,
});

export const sparkInvocationRetryResultSchema = z.object({
  invocationId: sparkInvocationIdSchema,
  retryOfInvocationId: sparkInvocationIdSchema,
  status: z.literal("queued"),
  acceptedAt: isoDateTimeSchema,
});

export const sparkInvocationRetentionPreviewRequestSchema = z.object({
  before: isoDateTimeSchema,
  limit: z.number().int().min(1).max(1_000).default(100),
});

export const sparkInvocationRetentionPreviewResultSchema = z.object({
  before: isoDateTimeSchema,
  invocationIds: z.array(sparkInvocationIdSchema).max(1_000),
  eventCount: z.number().int().nonnegative(),
  blockedByDeliveryCount: z.number().int().nonnegative(),
  dryRun: z.literal(true),
  observedAt: isoDateTimeSchema,
});

export type SparkInvocationStatus = z.infer<typeof sparkInvocationStatusSchema>;
export type SparkTurnAttachment = z.infer<typeof sparkTurnAttachmentSchema>;
export type SparkTurnSubmitRequest = z.infer<typeof sparkTurnSubmitRequestSchema>;
export type SparkTurnSubmitResult = z.infer<typeof sparkTurnSubmitResultSchema>;
export type SparkInvocationListRequest = z.infer<typeof sparkInvocationListRequestSchema>;
export type SparkInvocationSummary = z.infer<typeof sparkInvocationSummarySchema>;
export type SparkInvocationListResult = z.infer<typeof sparkInvocationListResultSchema>;
export type SparkTurnStatusRequest = z.infer<typeof sparkTurnStatusRequestSchema>;
export type SparkTurnStatusResult = z.infer<typeof sparkTurnStatusResultSchema>;
export type SparkTurnStreamRequest = z.infer<typeof sparkTurnStreamRequestSchema>;
export type SparkInvocationEvent = z.infer<typeof sparkInvocationEventSchema>;
export type SparkTurnStreamPage = z.infer<typeof sparkTurnStreamPageSchema>;
export type SparkTurnCancelRequest = z.infer<typeof sparkTurnCancelRequestSchema>;
export type SparkTurnCancelResult = z.infer<typeof sparkTurnCancelResultSchema>;
export type SparkTurnResult = z.infer<typeof sparkTurnResultSchema>;
export type SparkInvocationRetryRequest = z.infer<typeof sparkInvocationRetryRequestSchema>;
export type SparkInvocationRetryResult = z.infer<typeof sparkInvocationRetryResultSchema>;
export type SparkInvocationRetentionPreviewRequest = z.infer<
  typeof sparkInvocationRetentionPreviewRequestSchema
>;
export type SparkInvocationRetentionPreviewResult = z.infer<
  typeof sparkInvocationRetentionPreviewResultSchema
>;

function decodedBase64Size(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = (value.length * 3) / 4 - padding;
  return Number.isInteger(bytes) ? bytes : null;
}
