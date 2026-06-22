import { z } from "zod";
import { isoDateTimeSchema, prefixedIdSchema } from "../refs.ts";
import { runtimeEnvelopeFor, runtimeFeatureSchema } from "./envelope.ts";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const artifactRefSchema = prefixedIdSchema("art");

export const runtimeWorkspaceBindingStatusSchema = z.enum([
  "available",
  "indexing",
  "degraded",
  "unavailable",
  "archived",
]);

export const runtimeWorkspaceBindingSummarySchema = z.object({
  bindingId: prefixedIdSchema("rtwb"),
  localWorkspaceKey: z.string().min(1),
  displayName: z.string().min(1),
  status: runtimeWorkspaceBindingStatusSchema,
  capabilities: jsonObjectSchema.default({}),
  diagnostics: jsonObjectSchema.default({}),
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
  latestArtifactIds: z.array(artifactRefSchema).default([]),
  resources: z.array(jsonObjectSchema).default([]),
});

export const commandKindSchema = z.enum([
  "workspace.snapshot.request",
  "project.create.request",
  "task.start.request",
  "invocation.cancel.request",
  "artifact.content.request",
  "diagnostics.request",
]);

export const payloadRefSchema = z.object({
  url: z.string().min(1),
  contentType: z.string().min(1),
  hash: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const serverCommandPayloadSchema = z.object({
  kind: commandKindSchema,
  title: z.string().min(1).optional(),
  payload: jsonObjectSchema.optional(),
  payloadRef: payloadRefSchema.optional(),
});

export const runtimeCommandAckPayloadSchema = z.object({
  accepted: z.literal(true),
  invocationId: prefixedIdSchema("inv").optional(),
  message: z.string().optional(),
});

export const runtimeCommandRejectPayloadSchema = z.object({
  reasonCode: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().optional(),
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

export const humanResponseAckPayloadSchema = z.object({
  returnedToTool: z.boolean(),
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
  taskRuntimeId: z.string().optional(),
  agentName: z.string().optional(),
  status: invocationStatusSchema,
  startedAt: isoDateTimeSchema.optional(),
  completedAt: isoDateTimeSchema.optional(),
  terminalReason: z.string().optional(),
  payload: jsonObjectSchema.default({}),
});

export const invocationLogChunkPayloadSchema = z.object({
  runtimeInvocationId: prefixedIdSchema("inv"),
  stream: z.enum(["stdout", "stderr", "system", "agent"]),
  sequence: z.number().int().nonnegative(),
  content: z.string(),
});

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

export const serverCommandEnvelopeSchema = routedRuntimeEnvelopeFor(
  serverCommandPayloadSchema,
).extend({
  type: z.literal("server.command"),
});

export const runtimeCommandAckEnvelopeSchema = routedRuntimeEnvelopeFor(
  runtimeCommandAckPayloadSchema,
).extend({
  type: z.literal("runtime.command.ack"),
});

export const runtimeCommandRejectEnvelopeSchema = routedRuntimeEnvelopeFor(
  runtimeCommandRejectPayloadSchema,
).extend({
  type: z.literal("runtime.command.reject"),
});

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
  runtimeCommandAckEnvelopeSchema,
  runtimeCommandRejectEnvelopeSchema,
  humanRequestCreatedEnvelopeSchema,
  humanResponseDeliverEnvelopeSchema,
  humanResponseAckEnvelopeSchema,
  taskGraphSnapshotEnvelopeSchema,
  invocationUpdateEnvelopeSchema,
  invocationLogChunkEnvelopeSchema,
  artifactProjectionEnvelopeSchema,
]);

export type RuntimeHelloPayload = z.infer<typeof runtimeHelloPayloadSchema>;
export type RuntimeHeartbeatPayload = z.infer<typeof runtimeHeartbeatPayloadSchema>;
export type RuntimeWorkspaceBindingSummary = z.infer<typeof runtimeWorkspaceBindingSummarySchema>;
export type RuntimeReconcileRequestPayload = z.infer<typeof runtimeReconcileRequestPayloadSchema>;
export type RuntimeReconcileReportPayload = z.infer<typeof runtimeReconcileReportPayloadSchema>;
export type WorkspaceSnapshotPayload = z.infer<typeof workspaceSnapshotPayloadSchema>;
export type ServerCommandPayload = z.infer<typeof serverCommandPayloadSchema>;
export type RuntimeCommandAckPayload = z.infer<typeof runtimeCommandAckPayloadSchema>;
export type RuntimeCommandRejectPayload = z.infer<typeof runtimeCommandRejectPayloadSchema>;
export type HumanRequestCreatedPayload = z.infer<typeof humanRequestCreatedPayloadSchema>;
export type HumanResponseDeliverPayload = z.infer<typeof humanResponseDeliverPayloadSchema>;
export type HumanResponseAckPayload = z.infer<typeof humanResponseAckPayloadSchema>;
export type TaskGraphSnapshotPayload = z.infer<typeof taskGraphSnapshotPayloadSchema>;
export type InvocationUpdatePayload = z.infer<typeof invocationUpdatePayloadSchema>;
export type InvocationLogChunkPayload = z.infer<typeof invocationLogChunkPayloadSchema>;
export type ArtifactProjectionPayload = z.infer<typeof artifactProjectionPayloadSchema>;
