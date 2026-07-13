import { z } from "zod";
import { isoDateTimeSchema } from "./refs.ts";

/** Spark thinking / reasoning intensity passed to model streams as `reasoning`. */
export const sparkThinkingLevelOptions = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const sparkThinkingLevelSchema = z.enum(sparkThinkingLevelOptions);

/** Stable model identity shared by session views and model-control APIs. */
export const sparkModelRefSchema = z.object({
  providerName: z.string().min(1),
  modelId: z.string().min(1),
  providerLabel: z.string().min(1).optional(),
  modelLabel: z.string().min(1).optional(),
});

export const sparkProviderAuthStatusSchema = z.object({
  providerName: z.string().min(1),
  kind: z.enum(["none", "api_key", "oauth"]),
  configured: z.boolean(),
  source: z.enum(["stored", "environment", "literal"]).optional(),
  /** Environment-variable name or OAuth provider id; never a key or token. */
  reference: z.string().min(1).optional(),
});

export const sparkModelCostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

export const sparkModelCatalogEntrySchema = z.object({
  model: sparkModelRefSchema,
  description: z.string().optional(),
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])).default([]),
  cost: sparkModelCostSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  available: z.boolean(),
  unavailableReason: z.string().min(1).optional(),
});

export const sparkModelCatalogProviderSchema = z.object({
  providerName: z.string().min(1),
  label: z.string().min(1),
  auth: sparkProviderAuthStatusSchema,
  models: z.array(sparkModelCatalogEntrySchema).default([]),
});

export const sparkSessionModelSelectionSchema = z.object({
  sessionId: z.string().min(1),
  /** Absent means this session inherits the default model selection. */
  model: sparkModelRefSchema.optional(),
  /** Absent means this session inherits the host/default thinking level. */
  thinkingLevel: sparkThinkingLevelSchema.optional(),
});

export const sparkModelControlSnapshotSchema = z.object({
  providers: z.array(sparkModelCatalogProviderSchema).default([]),
  defaultModel: sparkModelRefSchema.optional(),
  session: sparkSessionModelSelectionSchema.optional(),
  diagnostics: z.array(z.string()).default([]),
});

export const sparkDefaultModelSetRequestSchema = z.object({
  model: sparkModelRefSchema,
});

export const sparkAuthFlowStatusSchema = z.enum([
  "pending",
  "waiting_for_user",
  "succeeded",
  "failed",
  "cancelled",
]);

export const sparkAuthFlowPromptSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.enum(["text", "manual_code"]),
    message: z.string().min(1),
    placeholder: z.string().optional(),
    allowEmpty: z.boolean().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("select"),
    message: z.string().min(1),
    options: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
        }),
      )
      .min(1),
  }),
]);

/** Non-sensitive projection of an in-progress or completed OAuth login. */
export const sparkAuthFlowSchema = z.object({
  id: z.string().min(1),
  providerName: z.string().min(1),
  providerLabel: z.string().min(1).optional(),
  oauthProviderId: z.string().min(1).optional(),
  status: sparkAuthFlowStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  authorization: z
    .object({
      url: z.string().url(),
      instructions: z.string().optional(),
    })
    .optional(),
  deviceCode: z
    .object({
      userCode: z.string().min(1),
      verificationUri: z.string().url(),
      intervalSeconds: z.number().int().positive().optional(),
      expiresInSeconds: z.number().int().positive().optional(),
    })
    .optional(),
  prompt: sparkAuthFlowPromptSchema.optional(),
  progress: z.array(z.string()).default([]),
  error: z.string().min(1).optional(),
});

export type SparkThinkingLevel = z.infer<typeof sparkThinkingLevelSchema>;
export type SparkModelRef = z.infer<typeof sparkModelRefSchema>;
export type SparkProviderAuthStatus = z.infer<typeof sparkProviderAuthStatusSchema>;
export type SparkModelCost = z.infer<typeof sparkModelCostSchema>;
export type SparkModelCatalogEntry = z.infer<typeof sparkModelCatalogEntrySchema>;
export type SparkModelCatalogProvider = z.infer<typeof sparkModelCatalogProviderSchema>;
export type SparkSessionModelSelection = z.infer<typeof sparkSessionModelSelectionSchema>;
export type SparkModelControlSnapshot = z.infer<typeof sparkModelControlSnapshotSchema>;
export type SparkDefaultModelSetRequest = z.infer<typeof sparkDefaultModelSetRequestSchema>;
export type SparkAuthFlowStatus = z.infer<typeof sparkAuthFlowStatusSchema>;
export type SparkAuthFlowPrompt = z.infer<typeof sparkAuthFlowPromptSchema>;
export type SparkAuthFlow = z.infer<typeof sparkAuthFlowSchema>;

export function parseSparkModelControlSnapshot(value: unknown): SparkModelControlSnapshot {
  return sparkModelControlSnapshotSchema.parse(value);
}

export function parseSparkAuthFlow(value: unknown): SparkAuthFlow {
  return sparkAuthFlowSchema.parse(value);
}

export function parseSparkDefaultModelSetRequest(value: unknown): SparkDefaultModelSetRequest {
  return sparkDefaultModelSetRequestSchema.parse(value);
}
