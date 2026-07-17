import { z } from "zod";
import { isoDateTimeSchema } from "./refs.ts";

export const sparkChannelRuntimeStateSchema = z.enum([
  "unconfigured",
  "running",
  "stopped",
  "degraded",
]);

export const sparkChannelAdapterRuntimeStateSchema = z.enum([
  "stopped",
  "connecting",
  "connected",
  "reconnecting",
  "degraded",
]);

export const sparkChannelAdapterStatusSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  running: z.boolean(),
  state: sparkChannelAdapterRuntimeStateSchema,
  error: z.string().min(1).optional(),
});

export const sparkChannelRouteProjectionSchema = z.object({
  name: z.string().min(1),
  adapter: z.string().min(1),
  recipient: z.string(),
});

const groupPolicySchema = z.enum(["disabled", "allowlist", "open"]);
const groupTriggerSchema = z.enum(["mention", "command", "all"]);

export const sparkChannelConfigurationProjectionSchema = z.object({
  feishu: z
    .object({
      appId: z.string().default(""),
      appSecretSet: z.boolean(),
    })
    .optional(),
  infoflow: z
    .object({
      endpoint: z.string().default(""),
      appKeySet: z.boolean(),
      appAgentId: z.string().default(""),
      appSecretSet: z.boolean(),
      allowedUserIds: z.array(z.string()).default([]),
      groupPolicy: groupPolicySchema.default("disabled"),
      groupTrigger: groupTriggerSchema.default("mention"),
      allowedGroupIds: z.array(z.string()).default([]),
      systemPrompt: z.string().default(""),
    })
    .optional(),
  qqbot: z
    .object({
      appId: z.string().default(""),
      clientSecretSet: z.boolean(),
      sandbox: z.boolean().default(true),
      allowedUserIds: z.array(z.string()).default([]),
      groupPolicy: groupPolicySchema.default("disabled"),
      groupTrigger: groupTriggerSchema.default("mention"),
      allowedGroupIds: z.array(z.string()).default([]),
      systemPrompt: z.string().default(""),
    })
    .optional(),
  routes: z.array(sparkChannelRouteProjectionSchema).default([]),
  onUnbound: z.enum(["reject", "create"]).default("create"),
});

export const sparkChannelControlSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  available: z.literal(true),
  configured: z.boolean(),
  ingressEnabled: z.boolean(),
  state: sparkChannelRuntimeStateSchema,
  adapters: z.array(sparkChannelAdapterStatusSchema).default([]),
  routes: z.array(sparkChannelRouteProjectionSchema).default([]),
  configuration: sparkChannelConfigurationProjectionSchema,
  lastReloadedAt: isoDateTimeSchema.optional(),
  observedAt: isoDateTimeSchema,
  error: z.string().min(1).optional(),
  text: z.string(),
});

export type SparkChannelRuntimeState = z.infer<typeof sparkChannelRuntimeStateSchema>;
export type SparkChannelAdapterRuntimeState = z.infer<typeof sparkChannelAdapterRuntimeStateSchema>;
export type SparkChannelAdapterStatus = z.infer<typeof sparkChannelAdapterStatusSchema>;
export type SparkChannelRouteProjection = z.infer<typeof sparkChannelRouteProjectionSchema>;
export type SparkChannelConfigurationProjection = z.infer<
  typeof sparkChannelConfigurationProjectionSchema
>;
export type SparkChannelControlSnapshot = z.infer<typeof sparkChannelControlSnapshotSchema>;

export function parseSparkChannelControlSnapshot(value: unknown): SparkChannelControlSnapshot {
  return sparkChannelControlSnapshotSchema.parse(value);
}
