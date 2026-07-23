import { z } from "zod";
import { isoDateTimeSchema } from "./refs.ts";

export const sparkDriverKindOptions = [
  "goal",
  "loop",
  "repro",
  "implement",
  "workflow",
  "session_todo",
] as const;

export const sparkDriverStatusOptions = [
  "scheduled",
  "running",
  "retry_wait",
  "dormant",
  "blocked",
  "stopped",
] as const;

export const sparkDriverContinuityOptions = ["session", "fresh"] as const;

export const sparkDriverKindSchema = z.enum(sparkDriverKindOptions);
export const sparkDriverStatusSchema = z.enum(sparkDriverStatusOptions);
export const sparkDriverContinuitySchema = z.enum(sparkDriverContinuityOptions);

export const sparkDriverViewSchema = z.object({
  driverId: z.string().min(1),
  kind: sparkDriverKindSchema,
  ownerSessionId: z.string().min(1),
  status: sparkDriverStatusSchema,
  continuity: sparkDriverContinuitySchema,
  dueAt: isoDateTimeSchema.optional(),
  attempt: z.number().int().nonnegative(),
  lastInvocationId: z.string().min(1).optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

const driverRouteSchema = z.object({
  cwd: z.string().min(1),
  workspaceBindingId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

export const sparkDriverStartRequestSchema = driverRouteSchema.extend({
  driverId: z.string().min(1).optional(),
  kind: sparkDriverKindSchema,
  ownerSessionId: z.string().min(1),
  continuity: sparkDriverContinuitySchema.default("session"),
  prompt: z.string().min(1),
  dueAt: isoDateTimeSchema.optional(),
  reason: z.string().optional(),
  domainStateDigest: z.string().min(1).optional(),
});

export const sparkDriverStatusRequestSchema = z.object({
  driverId: z.string().min(1).optional(),
  ownerSessionId: z.string().min(1).optional(),
  includeStopped: z.boolean().default(false),
});

export const sparkDriverMutationRequestSchema = z.object({
  driverId: z.string().min(1),
  reason: z.string().optional(),
});

export const sparkDriverWakeRequestSchema = sparkDriverMutationRequestSchema.extend({
  prompt: z.string().min(1).optional(),
});

/**
 * Only the currently executing driver tick may call schedule. The generation
 * is a daemon-issued compare-and-swap token, never a client-side timer token.
 */
export const sparkDriverScheduleRequestSchema = z.object({
  driverId: z.string().min(1),
  generation: z.number().int().positive(),
  dueAt: isoDateTimeSchema.optional(),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60 * 60_000)
    .optional(),
  reason: z.string().optional(),
  prompt: z.string().min(1).optional(),
});

export const sparkDriverListResultSchema = z.object({
  drivers: z.array(sparkDriverViewSchema),
  observedAt: isoDateTimeSchema,
});

export const sparkDriverMutationResultSchema = z.object({
  driver: sparkDriverViewSchema,
  observedAt: isoDateTimeSchema,
});

export type SparkDriverKind = z.infer<typeof sparkDriverKindSchema>;
export type SparkDriverStatus = z.infer<typeof sparkDriverStatusSchema>;
export type SparkDriverContinuity = z.infer<typeof sparkDriverContinuitySchema>;
export type SparkDriverView = z.infer<typeof sparkDriverViewSchema>;
export type SparkDriverStartRequest = z.infer<typeof sparkDriverStartRequestSchema>;
export type SparkDriverStatusRequest = z.infer<typeof sparkDriverStatusRequestSchema>;
export type SparkDriverMutationRequest = z.infer<typeof sparkDriverMutationRequestSchema>;
export type SparkDriverWakeRequest = z.infer<typeof sparkDriverWakeRequestSchema>;
export type SparkDriverScheduleRequest = z.infer<typeof sparkDriverScheduleRequestSchema>;
export type SparkDriverListResult = z.infer<typeof sparkDriverListResultSchema>;
export type SparkDriverMutationResult = z.infer<typeof sparkDriverMutationResultSchema>;
