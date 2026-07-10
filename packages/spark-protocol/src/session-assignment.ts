import { z } from "zod";
import { sparkModelRefSchema } from "./model-control.ts";
import { isoDateTimeSchema } from "./refs.ts";

export const sparkSessionStatusOptions = ["ready", "running", "archived"] as const;
export const sparkSessionStatusSchema = z.enum(sparkSessionStatusOptions);

export const sparkChannelAdapterOptions = ["feishu", "infoflow"] as const;
export const sparkChannelAdapterSchema = z.enum(sparkChannelAdapterOptions);

export const sparkSessionChannelBindingSchema = z.object({
  kind: z.literal("channel"),
  adapter: sparkChannelAdapterSchema,
  externalKey: z.string().min(1),
  boundAt: isoDateTimeSchema.optional(),
});

export const sparkSessionRegistryRecordSchema = z.object({
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().min(1).optional(),
  status: sparkSessionStatusSchema.default("ready"),
  role: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  sessionPath: z.string().min(1).optional(),
  model: sparkModelRefSchema.optional(),
  bindings: z.array(sparkSessionChannelBindingSchema).default([]),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** Daemon-local session registry request DTOs. The daemon owns the registry
 * engine; clients only exchange these transport-neutral values. */
export const sparkSessionCreateRequestSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  sessionPath: z.string().trim().min(1).optional(),
  status: sparkSessionStatusSchema.optional(),
});

export const sparkSessionListRequestSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  includeArchived: z.boolean().optional(),
});

export const sparkSessionGetRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
});

export const sparkSessionBindRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  externalKey: z.string().trim().min(1),
});

export const sparkSessionUnbindRequestSchema = sparkSessionBindRequestSchema;
export const sparkSessionArchiveRequestSchema = sparkSessionGetRequestSchema;
export const sparkSessionSetModelRequestSchema = sparkSessionGetRequestSchema.extend({
  model: sparkModelRefSchema,
});

export const sparkAssignmentSourceSchema = z.object({
  kind: z.enum(["cockpit", "channel", "cli", "internal"]),
  channel: sparkChannelAdapterSchema.optional(),
  externalRef: z.string().min(1).optional(),
});

export const sparkAssignmentTargetSchema = z.object({
  sessionId: z.string().min(1),
  role: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});

export const sparkAssignmentSchema = z.object({
  goal: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: "goal must be non-blank",
    }),
  target: sparkAssignmentTargetSchema,
  constraints: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  source: sparkAssignmentSourceSchema,
  title: z.string().min(1).optional(),
});

export const sparkAssignmentCreatePayloadSchema = sparkAssignmentSchema;

export type SparkSessionStatus = z.infer<typeof sparkSessionStatusSchema>;
export type SparkChannelAdapter = z.infer<typeof sparkChannelAdapterSchema>;
export type SparkSessionChannelBinding = z.infer<typeof sparkSessionChannelBindingSchema>;
export type SparkSessionRegistryRecord = z.infer<typeof sparkSessionRegistryRecordSchema>;
export type SparkSessionCreateRequest = z.infer<typeof sparkSessionCreateRequestSchema>;
export type SparkSessionListRequest = z.infer<typeof sparkSessionListRequestSchema>;
export type SparkSessionGetRequest = z.infer<typeof sparkSessionGetRequestSchema>;
export type SparkSessionBindRequest = z.infer<typeof sparkSessionBindRequestSchema>;
export type SparkSessionUnbindRequest = z.infer<typeof sparkSessionUnbindRequestSchema>;
export type SparkSessionArchiveRequest = z.infer<typeof sparkSessionArchiveRequestSchema>;
export type SparkSessionSetModelRequest = z.infer<typeof sparkSessionSetModelRequestSchema>;
export type SparkAssignmentSource = z.infer<typeof sparkAssignmentSourceSchema>;
export type SparkAssignmentTarget = z.infer<typeof sparkAssignmentTargetSchema>;
export type SparkAssignment = z.infer<typeof sparkAssignmentSchema>;

export function parseSparkSessionRegistryRecord(value: unknown): SparkSessionRegistryRecord {
  return sparkSessionRegistryRecordSchema.parse(value);
}

export function parseSparkSessionRegistryRecords(value: unknown): SparkSessionRegistryRecord[] {
  return z.array(sparkSessionRegistryRecordSchema).parse(value);
}

export function parseSparkSessionSetModelRequest(value: unknown): SparkSessionSetModelRequest {
  return sparkSessionSetModelRequestSchema.parse(value);
}

export function parseSparkAssignment(value: unknown): SparkAssignment {
  return sparkAssignmentSchema.parse(value);
}

/** Normalize external keys: `feishu:chat:oc_x`, `infoflow:user:u`, or `conv:feishu:oc_x`. */
export function normalizeChannelExternalKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("externalKey must be non-empty");
  const parts = trimmed.split(":").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `externalKey must look like feishu:chat:<id>, infoflow:user:<id>, or conv:<adapter>:<id>; got ${trimmed}`,
    );
  }
  if (parts[0] === "conv") {
    if (parts.length < 3) {
      throw new Error(`conv externalKey requires conv:<adapter>:<id>; got ${trimmed}`);
    }
    const adapter = parts[1];
    if (adapter !== "feishu" && adapter !== "infoflow") {
      throw new Error(`unsupported conv adapter: ${adapter}`);
    }
    return `conv:${adapter}:${parts.slice(2).join(":")}`;
  }
  if (parts[0] !== "feishu" && parts[0] !== "infoflow") {
    throw new Error(`unsupported channel adapter in externalKey: ${parts[0]}`);
  }
  if (parts.length < 3) {
    throw new Error(`externalKey requires <adapter>:<scope>:<id>; got ${trimmed}`);
  }
  return `${parts[0]}:${parts[1]}:${parts.slice(2).join(":")}`;
}

export function channelAdapterFromExternalKey(externalKey: string): SparkChannelAdapter {
  const normalized = normalizeChannelExternalKey(externalKey);
  const head = normalized.startsWith("conv:") ? normalized.split(":")[1] : normalized.split(":")[0];
  if (head !== "feishu" && head !== "infoflow") {
    throw new Error(`unsupported channel adapter: ${head}`);
  }
  return head;
}
