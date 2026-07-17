import { z } from "zod";
import {
  runtimeServerCommandKindOptions,
  runtimeServerCommandSpecification,
  runtimeServerCommandSupportsScope,
  sparkProtocolJsonObjectSchema,
} from "../command-events.ts";
import { sparkAuthFlowSchema } from "../model-control.ts";
import { isoDateTimeSchema, prefixedIdSchema } from "../refs.ts";
import { runtimeEnvelopeFor, runtimeFeatureSchema } from "./envelope.ts";
import {
  runtimeEphemeralSecretResultEnvelopeSchema,
  serverEphemeralSecretRequestEnvelopeSchema,
} from "./ephemeral-secret.ts";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const artifactRefSchema = prefixedIdSchema("art");

export const runtimeWorkspaceBindingStatusSchema = z.enum([
  "available",
  "indexing",
  "degraded",
  "unavailable",
  "archived",
]);

export const runtimeConnectionProjectionStatusSchema = z.enum(["connected", "disconnected"]);

export const runtimeConnectionProjectionSchema = z.object({
  status: runtimeConnectionProjectionStatusSchema,
  lastSeenAt: isoDateTimeSchema.optional(),
  reason: z.string().min(1).optional(),
});

export const workspaceClientKindSchema = z.enum(["interactive", "headless", "executor"]);
export const workspaceClientStatusSchema = z.enum(["connected", "disconnected"]);

export const workspaceClientProjectionSchema = z.object({
  clientId: z.string().min(1),
  kind: workspaceClientKindSchema,
  status: workspaceClientStatusSchema,
  displayName: z.string().min(1).optional(),
  attachedAt: isoDateTimeSchema.optional(),
  lastSeenAt: isoDateTimeSchema.optional(),
});

export const workspaceBorrowedStateSchema = z.object({
  borrowed: z.boolean(),
  interactiveClientCount: z.number().int().nonnegative().default(0),
  borrowedByClientIds: z.array(z.string().min(1)).default([]),
  since: isoDateTimeSchema.optional(),
});

export const executorClientStateSchema = z.enum(["none", "starting", "online", "unhealthy"]);

export const executorClientProjectionSchema = z.object({
  state: executorClientStateSchema,
  clientId: z.string().min(1).optional(),
  activeInvocationCount: z.number().int().nonnegative().default(0),
  activeAgentCount: z.number().int().nonnegative().default(0),
  lastSeenAt: isoDateTimeSchema.optional(),
  unhealthyReason: z.string().min(1).optional(),
});

export const runtimeWorkspaceBindingSummarySchema = z.object({
  bindingId: prefixedIdSchema("rtwb"),
  localWorkspaceKey: z.string().min(1),
  localPath: z.string().min(1).optional(),
  displayName: z.string().min(1),
  status: runtimeWorkspaceBindingStatusSchema,
  capabilities: jsonObjectSchema.default({}),
  diagnostics: jsonObjectSchema.default({}),
  connection: runtimeConnectionProjectionSchema.optional(),
  borrowed: workspaceBorrowedStateSchema.optional(),
  workspaceClients: z.array(workspaceClientProjectionSchema).optional(),
  executor: executorClientProjectionSchema.optional(),
});

export const runtimeHelloPayloadSchema = z.object({
  runtimeId: prefixedIdSchema("rt"),
  runtimeVersion: z.string().min(1),
  supportedFeatures: z.array(runtimeFeatureSchema),
  workspaceBindings: z.array(runtimeWorkspaceBindingSummarySchema).default([]),
});

export const serverHelloAckPayloadSchema = z.object({
  runtimeSessionId: prefixedIdSchema("rtsn"),
  acceptedFeatures: z.array(runtimeFeatureSchema),
  heartbeatIntervalMs: z.literal(15_000),
  serverTime: isoDateTimeSchema,
});

export const runtimeHeartbeatPayloadSchema = z.object({
  runtimeId: prefixedIdSchema("rt"),
  runtimeSessionId: prefixedIdSchema("rtsn").optional(),
  sequence: z.number().int().nonnegative(),
  observedAt: isoDateTimeSchema,
  workspaceBindings: z.array(runtimeWorkspaceBindingSummarySchema).optional(),
});

export const runtimeReconcileScopeSchema = z.enum([
  "workspace_bindings",
  "commands",
  "human_responses",
  "invocations",
  "artifacts",
]);

export const runtimeReconcileRequestPayloadSchema = z.object({
  reason: z.enum(["startup", "heartbeat", "manual", "server_request"]),
  requestedAt: isoDateTimeSchema,
  scopes: z.array(runtimeReconcileScopeSchema).default(["workspace_bindings", "commands"]),
});

export const runtimeReconcileReportPayloadSchema = z.object({
  observedAt: isoDateTimeSchema,
  workspaceBindings: z.array(runtimeWorkspaceBindingSummarySchema).default([]),
  pendingOutboxCount: z.number().int().nonnegative().default(0),
  activeInvocationCount: z.number().int().nonnegative().default(0),
  activeAgentCount: z.number().int().nonnegative().default(0),
  executor: executorClientProjectionSchema.optional(),
  artifacts: z
    .object({
      availableCount: z.number().int().nonnegative().default(0),
      missingCount: z.number().int().nonnegative().default(0),
    })
    .default({ availableCount: 0, missingCount: 0 }),
  diagnostics: jsonObjectSchema.default({}),
});

function routedRuntimeEnvelopeFor<TPayload>(payloadSchema: z.ZodType<TPayload>) {
  return runtimeEnvelopeFor(payloadSchema).extend({
    runtimeId: prefixedIdSchema("rt").optional(),
    workspaceId: prefixedIdSchema("ws").optional(),
    workspaceBindingId: prefixedIdSchema("rtwb").optional(),
    projectId: prefixedIdSchema("proj").optional(),
    commandId: prefixedIdSchema("cmd").optional(),
    humanRequestId: prefixedIdSchema("hreq").optional(),
    humanResponseId: prefixedIdSchema("hres").optional(),
    invocationId: prefixedIdSchema("inv").optional(),
    sessionId: z.string().min(1).optional(),
    ackOf: prefixedIdSchema("msg").optional(),
  });
}

export const workspaceSnapshotProjectSchema = z.object({
  projectId: prefixedIdSchema("proj"),
  title: z.string().min(1),
  status: z.string().min(1),
});

export const workspaceSnapshotPayloadSchema = z.object({
  displayName: z.string().min(1),
  status: runtimeWorkspaceBindingStatusSchema,
  projects: z.array(workspaceSnapshotProjectSchema).default([]),
  unresolvedInboxCount: z.number().int().nonnegative().default(0),
  activeInvocationCount: z.number().int().nonnegative().default(0),
  activeAgentCount: z.number().int().nonnegative().default(0),
  connection: runtimeConnectionProjectionSchema.optional(),
  borrowed: workspaceBorrowedStateSchema.optional(),
  workspaceClients: z.array(workspaceClientProjectionSchema).optional(),
  executor: executorClientProjectionSchema.optional(),
  control: z
    .object({
      mode: z.enum(["full", "snapshot_only"]),
      reason: z.string().min(1).optional(),
      serverMutationAllowed: z.boolean(),
    })
    .optional(),
  latestArtifactIds: z.array(artifactRefSchema).default([]),
  resources: z.array(jsonObjectSchema).default([]),
});

export const commandKindSchema = z.enum(runtimeServerCommandKindOptions);
export const runtimeServerCommandScopeSchema = z.enum(["daemon", "workspace"]);
export const maxRuntimeCommandPayloadBytes = 64 * 1024;
export const maxRuntimeCommandResultBytes = 64 * 1024;

export const payloadRefSchema = z.object({
  url: z.string().min(1),
  contentType: z.string().min(1),
  hash: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const serverCommandPayloadSchema = z
  .object({
    kind: commandKindSchema,
    scope: runtimeServerCommandScopeSchema.optional(),
    title: z.string().min(1).optional(),
    payload: sparkProtocolJsonObjectSchema.optional(),
    payloadRef: payloadRefSchema.optional(),
  })
  .superRefine((command, context) => {
    const specification = runtimeServerCommandSpecification(command.kind);
    const scope = command.scope ?? specification?.scope;
    if (!specification || !scope || !runtimeServerCommandSupportsScope(specification, scope)) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: `Command ${command.kind} does not support ${scope ?? "an undeclared"} scope`,
      });
    }
    validateBoundedPublicPayload(command.payload ?? {}, maxRuntimeCommandPayloadBytes, context, [
      "payload",
    ]);
  });

export const runtimeCommandAckPayloadSchema = z.object({
  accepted: z.literal(true),
  invocationId: prefixedIdSchema("inv").optional(),
  message: z.string().optional(),
});

export const runtimeCommandRejectPayloadSchema = z.object({
  reasonCode: z.string().min(1),
  message: z.string().min(1).max(4_096),
  retryable: z.boolean().optional(),
});

export const runtimeCommandProjectionKindSchema = z.enum([
  "daemon.status",
  "workspace.snapshot",
  "session.list",
  "session.detail",
  "session.snapshot",
  "turn.status",
  "turn.stream",
  "model.catalog",
  "provider.auth.flow",
  "channel.status",
]);

export const runtimeCommandResultPayloadSchema = z
  .object({
    status: z.enum(["succeeded", "failed"]),
    result: sparkProtocolJsonObjectSchema.default({}),
    projection: z
      .object({
        kind: runtimeCommandProjectionKindSchema,
        data: sparkProtocolJsonObjectSchema,
      })
      .optional(),
    completedAt: isoDateTimeSchema,
    replayed: z.boolean().optional(),
  })
  .superRefine((result, context) => {
    const publicCopy =
      result.projection?.kind === "provider.auth.flow"
        ? {
            ...result,
            projection: { ...result.projection, data: {} },
            result: {},
          }
        : result;
    validateBoundedPublicPayload(publicCopy, maxRuntimeCommandResultBytes, context, []);
    if (result.projection?.kind === "provider.auth.flow") {
      sparkAuthFlowSchema.parse(result.projection.data);
      sparkAuthFlowSchema.parse(result.result.flow);
    }
  });

export const humanQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

export const humanQuestionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["single", "multi", "freeform", "preview"]),
  prompt: z.string().min(1),
  required: z.boolean().default(false),
  options: z.array(humanQuestionOptionSchema).optional(),
});

export const humanRequestKindSchema = z.enum(["ask_user", "review", "approval", "blocker"]);

export const humanRequestCreatedPayloadSchema = z.object({
  kind: humanRequestKindSchema,
  delivery: z.enum(["blocking", "async"]).optional(),
  interactionRequestId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  title: z.string().min(1),
  prompt: z.string().min(1),
  questions: z.array(humanQuestionSchema).default([]),
  context: jsonObjectSchema.default({}),
  contextArtifactRefs: z.array(artifactRefSchema).default([]),
});

export const humanResponseDeliverPayloadSchema = z.object({
  status: z.enum(["answered", "cancelled", "archived"]),
  answers: jsonObjectSchema.default({}),
  responseArtifactRefs: z.array(artifactRefSchema).default([]),
});

/**
 * A response accepted directly by the runtime from a channel surface or a
 * daemon-owned cancellation. Unlike
 * `human.response.deliver`, this is an already-committed fact and must not be
 * delivered back to the runtime by the server.
 */
export const humanResponseRecordedPayloadSchema = humanResponseDeliverPayloadSchema.extend({
  source: z.enum(["channel", "daemon"]),
});

export const humanResponseAckPayloadSchema = z.object({
  returnedToTool: z.boolean(),
  outcome: z
    .enum(["accepted", "replayed", "already_resolved", "orphaned", "unknown_request", "transient"])
    .optional(),
  retryable: z.boolean().optional(),
  winnerResponseId: prefixedIdSchema("hres").optional(),
  message: z.string().optional(),
});

export const taskGraphClusterSchema = z.object({
  runtimeClusterId: z.string().min(1),
  name: z.string().optional(),
  title: z.string().min(1),
  status: z.string().min(1),
  sortKey: z.string().optional(),
  payload: jsonObjectSchema.default({}),
});

export const taskGraphTaskSchema = z.object({
  runtimeTaskId: z.string().min(1),
  runtimeClusterId: z.string().min(1).optional(),
  name: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().min(1),
  agentRef: z.string().optional(),
  inputArtifactIds: z.array(artifactRefSchema).default([]),
  outputArtifactIds: z.array(artifactRefSchema).default([]),
  runIds: z.array(prefixedIdSchema("inv")).default([]),
  payload: jsonObjectSchema.default({}),
});

export const taskGraphDependencySchema = z.object({
  fromTaskRuntimeId: z.string().min(1),
  toTaskRuntimeId: z.string().min(1),
  kind: z.string().min(1).default("depends_on"),
});

export const taskGraphSnapshotPayloadSchema = z.object({
  runtimeSnapshotId: z.string().min(1),
  snapshotVersion: z.number().int().nonnegative(),
  clusters: z.array(taskGraphClusterSchema).default([]),
  tasks: z.array(taskGraphTaskSchema).default([]),
  dependencies: z.array(taskGraphDependencySchema).default([]),
  payload: jsonObjectSchema.default({}),
});

export const invocationStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
]);

export const invocationUpdatePayloadSchema = z.object({
  runtimeInvocationId: prefixedIdSchema("inv"),
  /** Durable per-invocation event sequence used for replay and dedupe when available. */
  sequence: z.number().int().positive().optional(),
  taskRuntimeId: z.string().optional(),
  agentName: z.string().optional(),
  status: invocationStatusSchema,
  startedAt: isoDateTimeSchema.optional(),
  completedAt: isoDateTimeSchema.optional(),
  terminalReason: z.string().optional(),
  payload: jsonObjectSchema.default({}),
});

export const invocationLogChunkStreamSchema = z.enum([
  "stdout",
  "stderr",
  "system",
  "agent",
  "assistant",
  "tool",
]);

export const invocationLogChunkPayloadSchema = z.object({
  runtimeInvocationId: prefixedIdSchema("inv"),
  /**
   * Ordered invocation output stream. `assistant` chunks are token/text deltas
   * for chat transcript assembly; `agent` remains accepted for legacy runtime
   * output and is treated as readable assistant output by older Cockpit views.
   */
  stream: invocationLogChunkStreamSchema,
  /** Monotonic per-invocation sequence used for replay, dedupe, and transcript assembly. */
  sequence: z.number().int().nonnegative(),
  /** Chunk payload. For `assistant`, this is the text delta to append in sequence order. */
  content: z.string(),
  /** Optional runtime metadata, e.g. source event id, tool name, or delta kind. */
  metadata: jsonObjectSchema.optional(),
});

export const daemonEventPayloadSchema = jsonObjectSchema;

export const artifactProjectionPayloadSchema = z.object({
  artifactId: artifactRefSchema,
  scope: z.enum(["workspace", "project"]),
  kind: z.string().min(1),
  title: z.string().min(1),
  format: z.enum(["markdown", "json", "text", "blob"]),
  source: z.enum(["runtime", "human", "import", "server"]),
  hash: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  mime: z.string().min(1).optional(),
  contentRef: jsonObjectSchema.default({}),
  contentAvailability: z
    .object({
      hash: z.string().optional(),
      mime: z.string().min(1).optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
      daemonAvailable: z.boolean().default(true),
      serverCacheUploadUrl: z.string().min(1).optional(),
      serverProxyUrl: z.string().min(1).optional(),
    })
    .optional(),
  provenance: jsonObjectSchema,
  links: z
    .array(
      z.object({
        targetKind: z.string().min(1),
        targetId: z.string().min(1),
        relation: z.string().min(1),
      }),
    )
    .default([]),
});

export const runtimeHelloEnvelopeSchema = runtimeEnvelopeFor(runtimeHelloPayloadSchema).extend({
  type: z.literal("runtime.hello"),
});

export const serverHelloAckEnvelopeSchema = runtimeEnvelopeFor(serverHelloAckPayloadSchema).extend({
  type: z.literal("server.hello_ack"),
});

export const runtimeHeartbeatEnvelopeSchema = runtimeEnvelopeFor(
  runtimeHeartbeatPayloadSchema,
).extend({
  type: z.literal("runtime.heartbeat"),
});

export const runtimeReconcileRequestEnvelopeSchema = routedRuntimeEnvelopeFor(
  runtimeReconcileRequestPayloadSchema,
).extend({
  type: z.literal("runtime.reconcile.request"),
});

export const runtimeReconcileReportEnvelopeSchema = routedRuntimeEnvelopeFor(
  runtimeReconcileReportPayloadSchema,
).extend({
  type: z.literal("runtime.reconcile.report"),
});

export const workspaceSnapshotEnvelopeSchema = routedRuntimeEnvelopeFor(
  workspaceSnapshotPayloadSchema,
).extend({
  type: z.literal("workspace.snapshot"),
});

export const serverCommandEnvelopeSchema = routedRuntimeEnvelopeFor(serverCommandPayloadSchema)
  .extend({
    type: z.literal("server.command"),
  })
  .superRefine((envelope, context) => {
    const scope =
      envelope.payload.scope ?? runtimeServerCommandSpecification(envelope.payload.kind)?.scope;
    requireRouteField(envelope.runtimeId, "runtimeId", context);
    requireRouteField(envelope.commandId, "commandId", context);
    if (scope === "workspace") {
      requireRouteField(envelope.workspaceBindingId, "workspaceBindingId", context);
      requireRouteField(envelope.workspaceId, "workspaceId", context);
    } else if (envelope.workspaceBindingId || envelope.workspaceId || envelope.projectId) {
      context.addIssue({
        code: "custom",
        path: ["payload", "scope"],
        message: "Daemon-scoped commands must not include workspace or project routing",
      });
    }
  });

export const runtimeCommandAckEnvelopeSchema = routedRuntimeEnvelopeFor(
  runtimeCommandAckPayloadSchema,
)
  .extend({
    type: z.literal("runtime.command.ack"),
  })
  .superRefine(requireCommandResponseRoute);

export const runtimeCommandRejectEnvelopeSchema = routedRuntimeEnvelopeFor(
  runtimeCommandRejectPayloadSchema,
)
  .extend({
    type: z.literal("runtime.command.reject"),
  })
  .superRefine(requireCommandResponseRoute);

export const runtimeCommandResultEnvelopeSchema = routedRuntimeEnvelopeFor(
  runtimeCommandResultPayloadSchema,
)
  .extend({
    type: z.literal("runtime.command.result"),
  })
  .superRefine(requireCommandResponseRoute);

export const humanRequestCreatedEnvelopeSchema = routedRuntimeEnvelopeFor(
  humanRequestCreatedPayloadSchema,
).extend({
  type: z.literal("human.request.created"),
});

export const humanResponseDeliverEnvelopeSchema = routedRuntimeEnvelopeFor(
  humanResponseDeliverPayloadSchema,
).extend({
  type: z.literal("human.response.deliver"),
});

export const humanResponseRecordedEnvelopeSchema = routedRuntimeEnvelopeFor(
  humanResponseRecordedPayloadSchema,
).extend({
  type: z.literal("human.response.recorded"),
});

export const humanResponseAckEnvelopeSchema = routedRuntimeEnvelopeFor(
  humanResponseAckPayloadSchema,
).extend({
  type: z.literal("human.response.ack"),
});

export const taskGraphSnapshotEnvelopeSchema = routedRuntimeEnvelopeFor(
  taskGraphSnapshotPayloadSchema,
).extend({
  type: z.literal("task_graph.snapshot"),
});

export const invocationUpdateEnvelopeSchema = routedRuntimeEnvelopeFor(
  invocationUpdatePayloadSchema,
).extend({
  type: z.literal("invocation.updated"),
});

export const invocationLogChunkEnvelopeSchema = routedRuntimeEnvelopeFor(
  invocationLogChunkPayloadSchema,
).extend({
  type: z.literal("invocation.log_chunk"),
});

export const daemonEventEnvelopeSchema = routedRuntimeEnvelopeFor(daemonEventPayloadSchema).extend({
  type: z.literal("daemon.event"),
});

export const artifactProjectionEnvelopeSchema = routedRuntimeEnvelopeFor(
  artifactProjectionPayloadSchema,
).extend({
  type: z.literal("artifact.projected"),
});

export const runtimeMessageEnvelopeSchema = z.discriminatedUnion("type", [
  runtimeHelloEnvelopeSchema,
  serverHelloAckEnvelopeSchema,
  runtimeHeartbeatEnvelopeSchema,
  runtimeReconcileRequestEnvelopeSchema,
  runtimeReconcileReportEnvelopeSchema,
  workspaceSnapshotEnvelopeSchema,
  serverCommandEnvelopeSchema,
  serverEphemeralSecretRequestEnvelopeSchema,
  runtimeCommandAckEnvelopeSchema,
  runtimeCommandRejectEnvelopeSchema,
  runtimeCommandResultEnvelopeSchema,
  runtimeEphemeralSecretResultEnvelopeSchema,
  humanRequestCreatedEnvelopeSchema,
  humanResponseDeliverEnvelopeSchema,
  humanResponseRecordedEnvelopeSchema,
  humanResponseAckEnvelopeSchema,
  taskGraphSnapshotEnvelopeSchema,
  invocationUpdateEnvelopeSchema,
  invocationLogChunkEnvelopeSchema,
  daemonEventEnvelopeSchema,
  artifactProjectionEnvelopeSchema,
]);

export type RuntimeConnectionProjectionStatus = z.infer<
  typeof runtimeConnectionProjectionStatusSchema
>;
export type RuntimeConnectionProjection = z.infer<typeof runtimeConnectionProjectionSchema>;
export type WorkspaceClientKind = z.infer<typeof workspaceClientKindSchema>;
export type WorkspaceClientStatus = z.infer<typeof workspaceClientStatusSchema>;
export type WorkspaceClientProjection = z.infer<typeof workspaceClientProjectionSchema>;
export type WorkspaceBorrowedState = z.infer<typeof workspaceBorrowedStateSchema>;
export type ExecutorClientState = z.infer<typeof executorClientStateSchema>;
export type ExecutorClientProjection = z.infer<typeof executorClientProjectionSchema>;
export type RuntimeHelloPayload = z.infer<typeof runtimeHelloPayloadSchema>;
export type RuntimeHeartbeatPayload = z.infer<typeof runtimeHeartbeatPayloadSchema>;
export type RuntimeWorkspaceBindingSummary = z.infer<typeof runtimeWorkspaceBindingSummarySchema>;
export type RuntimeReconcileRequestPayload = z.infer<typeof runtimeReconcileRequestPayloadSchema>;
export type RuntimeReconcileReportPayload = z.infer<typeof runtimeReconcileReportPayloadSchema>;
export type WorkspaceSnapshotPayload = z.infer<typeof workspaceSnapshotPayloadSchema>;
export type ServerCommandPayload = z.infer<typeof serverCommandPayloadSchema>;
export type RuntimeCommandAckPayload = z.infer<typeof runtimeCommandAckPayloadSchema>;
export type RuntimeCommandRejectPayload = z.infer<typeof runtimeCommandRejectPayloadSchema>;
export type RuntimeCommandResultPayload = z.infer<typeof runtimeCommandResultPayloadSchema>;
export type RuntimeCommandProjectionKind = z.infer<typeof runtimeCommandProjectionKindSchema>;
export type HumanRequestCreatedPayload = z.infer<typeof humanRequestCreatedPayloadSchema>;
export type HumanResponseDeliverPayload = z.infer<typeof humanResponseDeliverPayloadSchema>;
export type HumanResponseRecordedPayload = z.infer<typeof humanResponseRecordedPayloadSchema>;
export type HumanResponseAckPayload = z.infer<typeof humanResponseAckPayloadSchema>;
export type TaskGraphSnapshotPayload = z.infer<typeof taskGraphSnapshotPayloadSchema>;
export type InvocationUpdatePayload = z.infer<typeof invocationUpdatePayloadSchema>;
export type InvocationLogChunkStream = z.infer<typeof invocationLogChunkStreamSchema>;
export type InvocationLogChunkPayload = z.infer<typeof invocationLogChunkPayloadSchema>;
export type DaemonEventPayload = z.infer<typeof daemonEventPayloadSchema>;
export type ArtifactProjectionPayload = z.infer<typeof artifactProjectionPayloadSchema>;

const sensitiveRuntimePayloadKeys = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "runtimetoken",
  "registrationtoken",
  "devicecode",
  "password",
  "secret",
  "clientsecret",
  "credential",
  "credentials",
  "authorization",
  "oauthcode",
  "oauthresponse",
]);

function validateBoundedPublicPayload(
  value: unknown,
  maxBytes: number,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > maxBytes) {
    context.addIssue({
      code: "custom",
      path,
      message: `Payload exceeds ${maxBytes} bytes`,
    });
  }
  inspectPublicPayload(value, context, path);
}

function inspectPublicPayload(
  value: unknown,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectPublicPayload(item, context, [...path, index]));
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (typeof record.method === "string" && Object.hasOwn(record, "params")) {
    context.addIssue({
      code: "custom",
      path,
      message: "Arbitrary RPC method/params payloads are not allowed",
    });
  }
  for (const [key, item] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    if (sensitiveRuntimePayloadKeys.has(normalizedKey)) {
      context.addIssue({
        code: "custom",
        path: [...path, key],
        message: "Secret-bearing payload fields are not allowed on durable runtime commands",
      });
      continue;
    }
    inspectPublicPayload(item, context, [...path, key]);
  }
}

function requireCommandResponseRoute(
  envelope: { runtimeId?: string | undefined; commandId?: string | undefined },
  context: z.RefinementCtx,
): void {
  requireRouteField(envelope.runtimeId, "runtimeId", context);
  requireRouteField(envelope.commandId, "commandId", context);
}

function requireRouteField(
  value: string | undefined,
  field: string,
  context: z.RefinementCtx,
): void {
  if (value) return;
  context.addIssue({
    code: "custom",
    path: [field],
    message: `server.command requires ${field}`,
  });
}
