import { z } from "zod";
import { sparkModelRefSchema, sparkThinkingLevelSchema } from "./model-control.ts";
import { isoDateTimeSchema } from "./refs.ts";

export const sparkSessionStatusOptions = ["ready", "running", "archived"] as const;
export const sparkSessionStatusSchema = z.enum(sparkSessionStatusOptions);

export const sparkChannelAdapterOptions = ["feishu", "infoflow", "qqbot"] as const;
export const sparkChannelAdapterSchema = z.enum(sparkChannelAdapterOptions);

export const sparkSessionChannelBindingSchema = z.object({
  kind: z.literal("channel"),
  adapter: sparkChannelAdapterSchema,
  /** Configured adapter instance used for local routing. */
  adapterId: z.string().trim().min(1).optional(),
  /** Opaque provider-account identity that survives adapter renames and secret rotation. */
  adapterAccountIdentity: z.string().trim().min(1).optional(),
  externalKey: z.string().min(1),
  boundAt: isoDateTimeSchema.optional(),
});

export const sparkWorkspaceSessionScopeSchema = z.object({
  kind: z.literal("workspace"),
  workspaceId: z.string().min(1),
});

export const sparkDaemonSessionScopeSchema = z.object({
  kind: z.literal("daemon"),
  daemonId: z.string().min(1),
});

/** Durable ownership of one conversation. UI visibility remains a client policy. */
export const sparkSessionScopeSchema = z.discriminatedUnion("kind", [
  sparkWorkspaceSessionScopeSchema,
  sparkDaemonSessionScopeSchema,
]);

export const sparkSideThreadModeOptions = ["contextual", "tangent"] as const;
export const sparkSideThreadModeSchema = z.enum(sparkSideThreadModeOptions);

/**
 * A side thread is a daemon-owned child conversation. The relation is emitted
 * by the daemon and cannot be selected through ordinary session.create.
 */
export const sparkSideThreadSessionRelationSchema = z.object({
  kind: z.literal("side_thread"),
  parentSessionId: z.string().min(1),
  generation: z.number().int().positive(),
  mode: sparkSideThreadModeSchema,
});

export const sparkSessionRelationSchema = z.discriminatedUnion("kind", [
  sparkSideThreadSessionRelationSchema,
]);

const sparkSessionRegistryRecordBaseSchema = z.object({
  sessionId: z.string().min(1),
  /** Compatibility display mirror of role for role-named sessions. */
  title: z.string().min(1).optional(),
  status: sparkSessionStatusSchema.default("ready"),
  /** Canonical long-lived division of labour; concrete tasks do not belong here. */
  role: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  sessionPath: z.string().min(1).optional(),
  model: sparkModelRefSchema.optional(),
  thinkingLevel: sparkThinkingLevelSchema.optional(),
  relation: sparkSessionRelationSchema.optional(),
  bindings: z.array(sparkSessionChannelBindingSchema).default([]),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const sparkWorkspaceSessionRegistryRecordSchema = sparkSessionRegistryRecordBaseSchema
  .extend({
    scope: sparkWorkspaceSessionScopeSchema,
    /** @deprecated Read `scope.workspaceId`; retained while older clients migrate. */
    workspaceId: z.string().min(1).optional(),
  })
  .superRefine((record, context) => {
    if (record.workspaceId && record.workspaceId !== record.scope.workspaceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workspaceId must match scope.workspaceId",
        path: ["workspaceId"],
      });
    }
  })
  .transform((record) => ({ ...record, workspaceId: record.scope.workspaceId }));

const sparkDaemonSessionRegistryRecordSchema = sparkSessionRegistryRecordBaseSchema.extend({
  scope: sparkDaemonSessionScopeSchema,
  workspaceId: z.never().optional(),
});

/**
 * Canonical records carry an explicit scope. Registry v1 records only carried
 * workspaceId; normalize those on read instead of forcing an eager file migration.
 */
export const sparkSessionRegistryRecordSchema = z.preprocess(
  normalizeLegacyWorkspaceScope,
  z.union([sparkWorkspaceSessionRegistryRecordSchema, sparkDaemonSessionRegistryRecordSchema]),
);

/** Daemon-local session registry request DTOs. The daemon owns the registry
 * engine; clients only exchange these transport-neutral values. */
const sparkSessionCreateRequestBaseSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  /** Legacy display input; new role-aware creators should send role. */
  title: z.string().trim().min(1).optional(),
  /** Stable division of labour chosen at creation for non-user sessions. */
  role: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  sessionPath: z.string().trim().min(1).optional(),
  status: sparkSessionStatusSchema.optional(),
});

const sparkWorkspaceSessionCreateRequestSchema = sparkSessionCreateRequestBaseSchema
  .extend({
    scope: sparkWorkspaceSessionScopeSchema,
    /** @deprecated Prefer scope.workspaceId. */
    workspaceId: z.string().trim().min(1).optional(),
  })
  .superRefine((request, context) => {
    if (request.workspaceId && request.workspaceId !== request.scope.workspaceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workspaceId must match scope.workspaceId",
        path: ["workspaceId"],
      });
    }
  })
  .transform((request) => ({ ...request, workspaceId: request.scope.workspaceId }));

const sparkDaemonSessionCreateRequestSchema = sparkSessionCreateRequestBaseSchema.extend({
  // daemonId is deliberately absent: the receiving daemon injects installationId.
  scope: z.object({ kind: z.literal("daemon") }).strict(),
  workspaceId: z.never().optional(),
});

export const sparkSessionCreateRequestSchema = z.preprocess(
  normalizeLegacyWorkspaceScope,
  z.union([sparkWorkspaceSessionCreateRequestSchema, sparkDaemonSessionCreateRequestSchema]),
);

const sparkSessionListRequestBaseSchema = z.object({
  includeArchived: z.boolean().optional(),
  /** Diagnostic escape hatch; product session lists keep related sessions nested. */
  includeSideThreads: z.boolean().optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const sparkWorkspaceSessionListRequestSchema = sparkSessionListRequestBaseSchema
  .extend({
    scope: sparkWorkspaceSessionScopeSchema,
    /** @deprecated Prefer scope.workspaceId. */
    workspaceId: z.string().trim().min(1).optional(),
  })
  .transform((request) => ({ ...request, workspaceId: request.scope.workspaceId }));
const sparkDaemonSessionListRequestSchema = sparkSessionListRequestBaseSchema.extend({
  scope: z.object({ kind: z.literal("daemon") }).strict(),
  workspaceId: z.never().optional(),
});

export const sparkSessionListRequestSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (record.scope !== undefined || typeof record.workspaceId !== "string") return value;
    return {
      ...record,
      scope: { kind: "workspace", workspaceId: record.workspaceId },
    };
  },
  z.union([
    sparkWorkspaceSessionListRequestSchema,
    sparkDaemonSessionListRequestSchema,
    sparkSessionListRequestBaseSchema.extend({ scope: z.undefined().optional() }),
  ]),
);

export const sparkSessionGetRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
});

/**
 * Read one bounded transcript page. `beforeMessageId` is an exclusive cursor:
 * callers pass the first message id from the current window to load the page
 * immediately before it.
 */
export const sparkSessionSnapshotRequestSchema = sparkSessionGetRequestSchema.extend({
  messageLimit: z.number().int().min(1).max(10_000).optional(),
  beforeMessageId: z.string().trim().min(1).optional(),
});

export const sparkSessionPendingTurnSchema = z.object({
  invocationId: z.string().min(1),
  prompt: z.string(),
  status: z.enum(["queued", "running"]),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional(),
});

export const sparkSessionBindRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  externalKey: z.string().trim().min(1),
  adapterId: z.string().trim().min(1).optional(),
  adapterAccountIdentity: z.string().trim().min(1).optional(),
});

export const sparkSessionUnbindRequestSchema = sparkSessionBindRequestSchema.omit({
  adapterId: true,
});
export const sparkSessionArchiveRequestSchema = sparkSessionGetRequestSchema;
export const sparkSessionSetModelRequestSchema = sparkSessionGetRequestSchema.extend({
  model: sparkModelRefSchema,
});

export const sparkSessionSetThinkingRequestSchema = sparkSessionGetRequestSchema.extend({
  thinkingLevel: sparkThinkingLevelSchema,
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
export type SparkSessionScope = z.infer<typeof sparkSessionScopeSchema>;
export type SparkSideThreadMode = z.infer<typeof sparkSideThreadModeSchema>;
export type SparkSideThreadSessionRelation = z.infer<typeof sparkSideThreadSessionRelationSchema>;
export type SparkSessionRelation = z.infer<typeof sparkSessionRelationSchema>;
export type SparkSessionRegistryRecord = z.infer<typeof sparkSessionRegistryRecordSchema>;
/** Public input keeps the v1 workspaceId-only shape during migration. */
export type SparkSessionCreateRequest =
  | z.infer<typeof sparkSessionCreateRequestSchema>
  | (z.infer<typeof sparkSessionCreateRequestBaseSchema> & {
      scope?: undefined;
      workspaceId: string;
    });
export type SparkSessionListRequest =
  | z.infer<typeof sparkSessionListRequestSchema>
  | {
      scope?: undefined;
      workspaceId?: string;
      includeArchived?: boolean;
      includeSideThreads?: boolean;
      cursor?: string;
      limit?: number;
    };
export type SparkSessionGetRequest = z.infer<typeof sparkSessionGetRequestSchema>;
export type SparkSessionSnapshotRequest = z.infer<typeof sparkSessionSnapshotRequestSchema>;
export type SparkSessionPendingTurn = z.infer<typeof sparkSessionPendingTurnSchema>;
export type SparkSessionBindRequest = z.infer<typeof sparkSessionBindRequestSchema>;
export type SparkSessionUnbindRequest = z.infer<typeof sparkSessionUnbindRequestSchema>;
export type SparkSessionArchiveRequest = z.infer<typeof sparkSessionArchiveRequestSchema>;
export type SparkSessionSetModelRequest = z.infer<typeof sparkSessionSetModelRequestSchema>;
export type SparkSessionSetThinkingRequest = z.infer<typeof sparkSessionSetThinkingRequestSchema>;
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

export function parseSparkSessionSetThinkingRequest(
  value: unknown,
): SparkSessionSetThinkingRequest {
  return sparkSessionSetThinkingRequestSchema.parse(value);
}

export function parseSparkAssignment(value: unknown): SparkAssignment {
  return sparkAssignmentSchema.parse(value);
}

function normalizeLegacyWorkspaceScope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.scope !== undefined || typeof record.workspaceId !== "string") return value;
  return {
    ...record,
    scope: { kind: "workspace", workspaceId: record.workspaceId },
  };
}

function isSparkChannelAdapterName(value: string): value is SparkChannelAdapter {
  return value === "feishu" || value === "infoflow" || value === "qqbot";
}

/** Normalize external keys: `feishu:chat:oc_x`, `infoflow:user:u`, `qqbot:c2c:…`, or `conv:feishu:oc_x`. */
export function normalizeChannelExternalKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("externalKey must be non-empty");
  const parts = trimmed.split(":").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `externalKey must look like feishu:chat:<id>, infoflow:user:<id>, qqbot:c2c:<id>, or conv:<adapter>:<id>; got ${trimmed}`,
    );
  }
  if (parts[0] === "conv") {
    if (parts.length < 3) {
      throw new Error(`conv externalKey requires conv:<adapter>:<id>; got ${trimmed}`);
    }
    const adapter = parts[1];
    if (!adapter || !isSparkChannelAdapterName(adapter)) {
      throw new Error(`unsupported conv adapter: ${adapter}`);
    }
    return `conv:${adapter}:${parts.slice(2).join(":")}`;
  }
  if (!isSparkChannelAdapterName(parts[0] ?? "")) {
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
  if (!head || !isSparkChannelAdapterName(head)) {
    throw new Error(`unsupported channel adapter: ${head}`);
  }
  return head;
}
