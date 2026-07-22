import { z } from "zod";
import { sparkModelRefSchema, sparkThinkingLevelSchema } from "./model-control.ts";
import { sparkSessionPendingTurnSchema, sparkSideThreadModeSchema } from "./session-assignment.ts";
import { isoDateTimeSchema } from "./refs.ts";

const nonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "value must be non-blank",
  });

export const sparkSideThreadStatusSchema = z.enum(["idle", "queued", "running"]);

export const sparkSideThreadExchangeSchema = z.object({
  /** Durable assistant entry that closes this exchange. */
  id: z.string().min(1),
  user: z.string(),
  assistant: z.string(),
  createdAt: isoDateTimeSchema,
  userTruncated: z.boolean().optional(),
  userOriginalBytes: z.number().int().nonnegative().optional(),
  assistantTruncated: z.boolean().optional(),
  assistantOriginalBytes: z.number().int().nonnegative().optional(),
});

const sparkSideThreadPendingTurnSchema = sparkSessionPendingTurnSchema.extend({
  promptTruncated: z.boolean().optional(),
  promptOriginalBytes: z.number().int().nonnegative().optional(),
});

/** Display-safe, daemon-owned projection of the active side-thread generation. */
export const sparkSideThreadSnapshotSchema = z.object({
  parentSessionId: z.string().min(1),
  sessionId: z.string().min(1),
  generation: z.number().int().positive(),
  mode: sparkSideThreadModeSchema,
  status: sparkSideThreadStatusSchema,
  pendingTurns: z.array(sparkSideThreadPendingTurnSchema).default([]),
  exchanges: z.array(sparkSideThreadExchangeSchema).default([]),
  headExchangeId: z.string().min(1).optional(),
  hasMore: z.boolean().default(false),
  /** True when display strings or exchange count were reduced to fit transport bounds. */
  projectionTruncated: z.boolean().default(false),
  nextBeforeExchangeId: z.string().min(1).optional(),
  modelOverride: sparkModelRefSchema.optional(),
  thinkingOverride: sparkThinkingLevelSchema.optional(),
  effectiveModel: sparkModelRefSchema.optional(),
  effectiveThinkingLevel: sparkThinkingLevelSchema.optional(),
  fallbackReason: z.string().min(1).optional(),
});

export const sparkSideThreadEnsureRequestSchema = z.object({
  parentSessionId: z.string().trim().min(1),
  mode: sparkSideThreadModeSchema.optional(),
});

export const sparkSideThreadSnapshotRequestSchema = z.object({
  parentSessionId: z.string().trim().min(1),
  beforeExchangeId: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const sparkSideThreadSubmitRequestSchema = z.object({
  parentSessionId: z.string().trim().min(1),
  expectedGeneration: z.number().int().positive(),
  prompt: nonBlankStringSchema,
  idempotencyKey: z.string().trim().min(1),
});

export const sparkSideThreadResetRequestSchema = z.object({
  parentSessionId: z.string().trim().min(1),
  expectedGeneration: z.number().int().positive(),
  mode: sparkSideThreadModeSchema,
});

export const sparkSideThreadConfigureRequestSchema = z
  .object({
    parentSessionId: z.string().trim().min(1),
    expectedGeneration: z.number().int().positive(),
    modelOverride: sparkModelRefSchema.nullable().optional(),
    thinkingOverride: sparkThinkingLevelSchema.nullable().optional(),
  })
  .superRefine((request, context) => {
    if (request.modelOverride === undefined && request.thinkingOverride === undefined) {
      context.addIssue({
        code: "custom",
        message: "configure requires modelOverride or thinkingOverride",
      });
    }
  });

export const sparkSideThreadHandoffRequestSchema = z.object({
  parentSessionId: z.string().trim().min(1),
  expectedGeneration: z.number().int().positive(),
  expectedHeadExchangeId: z.string().trim().min(1),
  kind: z.enum(["full", "summary"]),
  instructions: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1),
});

export const sparkSideThreadSubmitResultSchema = z.object({
  invocationId: z.string().min(1),
  acceptedAt: isoDateTimeSchema,
  snapshot: sparkSideThreadSnapshotSchema,
});

export const sparkSideThreadHandoffResultSchema = z.object({
  parentInvocationId: z.string().min(1),
  acceptedAt: isoDateTimeSchema,
  snapshot: sparkSideThreadSnapshotSchema,
});

export const sparkSideThreadErrorCodeOptions = [
  "side_thread_parent_not_found",
  "side_thread_parent_archived",
  "side_thread_nesting_forbidden",
  "side_thread_scope_mismatch",
  "side_thread_not_found",
  "side_thread_archived",
  "side_thread_generation_conflict",
  "side_thread_head_conflict",
  "side_thread_idempotency_conflict",
  "side_thread_direct_submit_forbidden",
  "side_thread_mutation_forbidden",
  "side_thread_busy",
  "side_thread_drain_timeout",
  "side_thread_transcript_invalid",
  "side_thread_model_unavailable",
  "side_thread_handoff_too_large",
] as const;
export const sparkSideThreadErrorCodeSchema = z.enum(sparkSideThreadErrorCodeOptions);

export type SparkSideThreadStatus = z.infer<typeof sparkSideThreadStatusSchema>;
export type SparkSideThreadExchange = z.infer<typeof sparkSideThreadExchangeSchema>;
export type SparkSideThreadSnapshot = z.infer<typeof sparkSideThreadSnapshotSchema>;
export type SparkSideThreadEnsureRequest = z.infer<typeof sparkSideThreadEnsureRequestSchema>;
export type SparkSideThreadSnapshotRequest = z.infer<typeof sparkSideThreadSnapshotRequestSchema>;
export type SparkSideThreadSubmitRequest = z.infer<typeof sparkSideThreadSubmitRequestSchema>;
export type SparkSideThreadResetRequest = z.infer<typeof sparkSideThreadResetRequestSchema>;
export type SparkSideThreadConfigureRequest = z.infer<typeof sparkSideThreadConfigureRequestSchema>;
export type SparkSideThreadHandoffRequest = z.infer<typeof sparkSideThreadHandoffRequestSchema>;
export type SparkSideThreadSubmitResult = z.infer<typeof sparkSideThreadSubmitResultSchema>;
export type SparkSideThreadHandoffResult = z.infer<typeof sparkSideThreadHandoffResultSchema>;
export type SparkSideThreadErrorCode = z.infer<typeof sparkSideThreadErrorCodeSchema>;

/** True only for Side Thread failures that are safe to expose across a transport boundary. */
export function isSparkSideThreadErrorCode(value: unknown): value is SparkSideThreadErrorCode {
  return sparkSideThreadErrorCodeSchema.safeParse(value).success;
}
