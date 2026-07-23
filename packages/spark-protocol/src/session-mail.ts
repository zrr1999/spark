import { z } from "zod";
import { sparkProtocolJsonObjectSchema } from "./command-events.ts";
import { sparkTurnSubmitResultSchema } from "./invocation-lifecycle.ts";
import {
  sparkChannelAdapterSchema,
  sparkSessionRegistryRecordSchema,
} from "./session-assignment.ts";

export const sparkSessionMailKindSchema = z.enum(["request", "notification"]);
export const sparkSessionMailVisibilitySchema = z.enum(["internal", "user"]);
export const sparkSessionMailDeliverySchema = z.enum(["mailbox", "channel"]);
export const sparkSessionMailDeliveryStatusSchema = z.enum([
  "pending",
  "delivered",
  "failed",
  "uncertain",
]);

export const sparkSessionMailChannelTargetSchema = z.object({
  adapter: z.string().trim().min(1),
  externalKey: z.string().trim().min(1),
  adapterId: z.string().trim().min(1).optional(),
  adapterAccountIdentity: z.string().trim().min(1).optional(),
});

export const sparkSessionMailOriginBindingSchema = sparkSessionMailChannelTargetSchema.extend({
  workspaceId: z.string().trim().min(1),
  adapter: sparkChannelAdapterSchema,
  adapterId: z.string().trim().min(1),
  recipient: z.string().trim().min(1),
});

export const sparkSessionMailDeliveryReceiptSchema = sparkSessionMailChannelTargetSchema.extend({
  status: sparkSessionMailDeliveryStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  lastAttemptAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  lastError: z.string().nullable(),
  receipt: z.unknown(),
});

export const sparkSessionMailRequestAdmissionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    updatedAt: z.string(),
  }),
  z.object({
    status: z.literal("accepted"),
    invocationId: z.string().trim().min(1),
    acceptedAt: z.string(),
    updatedAt: z.string(),
  }),
]);

export const sparkSessionMailMessageSchema = z.object({
  id: z.string().trim().min(1),
  toSessionId: z.string().trim().min(1),
  fromSessionId: z.string().trim().min(1),
  kind: sparkSessionMailKindSchema,
  visibility: sparkSessionMailVisibilitySchema,
  delivery: sparkSessionMailDeliverySchema,
  deliveries: z.array(sparkSessionMailDeliveryReceiptSchema),
  originBinding: sparkSessionMailOriginBindingSchema.optional(),
  intent: z.string().trim().min(1),
  payload: sparkProtocolJsonObjectSchema,
  correlationId: z.string().trim().min(1),
  replyToMessageId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  ackedAt: z.string().nullable(),
  source: z.enum(["cli", "tui", "tool"]),
  requestAdmission: sparkSessionMailRequestAdmissionSchema.optional(),
});

export const sparkSessionSendRequestSchema = z.object({
  toSessionId: z.string().trim().min(1),
  fromSessionId: z.string().trim().min(1),
  kind: sparkSessionMailKindSchema,
  intent: z.string().trim().min(1),
  payload: sparkProtocolJsonObjectSchema.default({}),
  correlationId: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1),
  subject: z.string().nullable().optional(),
  body: z.string(),
  originBinding: sparkSessionMailOriginBindingSchema.optional(),
  origin: z.object({
    surface: z.enum(["local", "channel"]),
    host: z.enum(["tui", "web", "channel", "daemon", "session"]),
  }),
  parentInvocationId: z.string().trim().min(1).optional(),
  notifyOnCompletion: z.boolean().default(false),
  source: z.enum(["cli", "tui", "tool"]).default("tool"),
});

export const sparkSessionSendResultSchema = z
  .object({
    message: sparkSessionMailMessageSchema,
    filePath: z.string().min(1),
    created: z.boolean(),
    executionTriggered: z.boolean(),
    target: sparkSessionRegistryRecordSchema,
    submitted: sparkTurnSubmitResultSchema.optional(),
  })
  .superRefine((result, context) => {
    if (result.executionTriggered && !result.submitted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["submitted"],
        message: "executionTriggered session mail requires an invocation receipt",
      });
    }
    if (!result.executionTriggered && result.submitted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["submitted"],
        message: "non-executable session mail must not include an invocation receipt",
      });
    }
  });

export const sparkSessionInboxRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  includeAcked: z.boolean().default(false),
});

export const sparkSessionInboxResultSchema = z.object({
  messages: z.array(sparkSessionMailMessageSchema),
});

export const sparkSessionMailMutationRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
});

export const sparkSessionMailMutationResultSchema = z.object({
  message: sparkSessionMailMessageSchema,
});

export type SparkSessionMailKind = z.infer<typeof sparkSessionMailKindSchema>;
export type SparkSessionMailVisibility = z.infer<typeof sparkSessionMailVisibilitySchema>;
export type SparkSessionMailDelivery = z.infer<typeof sparkSessionMailDeliverySchema>;
export type SparkSessionMailDeliveryStatus = z.infer<typeof sparkSessionMailDeliveryStatusSchema>;
export type SparkSessionMailChannelTarget = z.infer<typeof sparkSessionMailChannelTargetSchema>;
export type SparkSessionMailOriginBinding = z.infer<typeof sparkSessionMailOriginBindingSchema>;
export type SparkSessionMailDeliveryReceipt = z.infer<typeof sparkSessionMailDeliveryReceiptSchema>;
export type SparkSessionMailRequestAdmission = z.infer<
  typeof sparkSessionMailRequestAdmissionSchema
>;
export type SparkSessionMailMessage = z.infer<typeof sparkSessionMailMessageSchema>;
export type SparkSessionSendRequest = z.infer<typeof sparkSessionSendRequestSchema>;
export type SparkSessionSendResult = z.infer<typeof sparkSessionSendResultSchema>;
export type SparkSessionInboxRequest = z.infer<typeof sparkSessionInboxRequestSchema>;
export type SparkSessionInboxResult = z.infer<typeof sparkSessionInboxResultSchema>;
export type SparkSessionMailMutationRequest = z.infer<typeof sparkSessionMailMutationRequestSchema>;
export type SparkSessionMailMutationResult = z.infer<typeof sparkSessionMailMutationResultSchema>;
