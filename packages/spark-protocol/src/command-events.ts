import { z } from "zod";
import { isoDateTimeSchema } from "./refs.ts";

export const sparkCommandSchemaVersion = "spark.command.v1" as const;
export const sparkEventSchemaVersion = "spark.event.v1" as const;

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type SparkProtocolJsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: SparkProtocolJsonValue }
  | SparkProtocolJsonValue[];
export const sparkProtocolJsonValueSchema: z.ZodType<SparkProtocolJsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(sparkProtocolJsonValueSchema),
    z.record(z.string(), sparkProtocolJsonValueSchema),
  ]),
);
export const sparkProtocolJsonObjectSchema = z.record(z.string(), sparkProtocolJsonValueSchema);

/**
 * Transport-neutral command intents owned by Spark. Local RPC methods and runtime WebSocket
 * `server.command` payload kinds map into this single vocabulary before dispatch.
 */
export const sparkCommandKindOptions = [
  "daemon.status.request",
  "daemon.stop.request",
  "turn.submit.request",
  "turn.cancel.request",
  "turn.status.request",
  "turn.stream.subscribe",
  "channel.status.request",
  "channel.configure.request",
  "channel.reload.request",
  "channel.notify.request",
  "workspace.list.request",
  "workspace.register.request",
  "workspace.ensure_local.request",
  "workspace.attach.request",
  "workspace.stop.request",
  "workspace.client.attach.request",
  "workspace.client.heartbeat.request",
  "workspace.client.release.request",
  "workspace.executor.ensure.request",
  "workspace.snapshot.request",
  "project.create.request",
  "task.start.request",
  "assignment.create.request",
  "session.list.request",
  "session.get.request",
  "session.snapshot.request",
  "session.create.request",
  "session.bind.request",
  "session.unbind.request",
  "session.archive.request",
  "session.model.set.request",
  "model.catalog.request",
  "model.default.set.request",
  "provider.auth.api_key.set.request",
  "provider.auth.logout.request",
  "provider.auth.login.start.request",
  "provider.auth.login.status.request",
  "provider.auth.login.respond.request",
  "provider.auth.login.cancel.request",
  "invocation.cancel.request",
  "artifact.content.request",
  "human.response.deliver.request",
  "diagnostics.request",
] as const;
export const sparkCommandKindSchema = z.enum(sparkCommandKindOptions);

export const sparkCommandPayloadRefSchema = z.object({
  url: z.string().min(1),
  contentType: z.string().min(1),
  hash: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

const transportScopedIdSchema = z.string().min(1);

export const sparkCommandRouteSchema = z.object({
  runtimeId: transportScopedIdSchema.optional(),
  workspaceBindingId: transportScopedIdSchema.optional(),
  workspaceId: transportScopedIdSchema.optional(),
  projectId: transportScopedIdSchema.optional(),
  commandId: transportScopedIdSchema.optional(),
  invocationId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  taskRuntimeId: z.string().min(1).optional(),
  workspaceLocalPath: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
});

export const sparkCommandTransportKindSchema = z.enum([
  "local-rpc",
  "runtime-ws",
  "daemon-queue",
  "internal",
  "unknown",
]);

export const sparkCommandTransportTraceSchema = z.object({
  kind: sparkCommandTransportKindSchema,
  method: z.string().min(1).optional(),
  envelopeType: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  sourceKind: z.string().min(1).optional(),
});

export const sparkCommandSchema = z.object({
  schemaVersion: z.literal(sparkCommandSchemaVersion).default(sparkCommandSchemaVersion),
  id: z.string().min(1).optional(),
  kind: sparkCommandKindSchema,
  title: z.string().min(1).optional(),
  route: sparkCommandRouteSchema.default({}),
  payload: sparkProtocolJsonObjectSchema.default({}),
  payloadRef: sparkCommandPayloadRefSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  requestedAt: isoDateTimeSchema.optional(),
  transport: sparkCommandTransportTraceSchema.optional(),
});

export const sparkEventKindOptions = [
  "command.accepted",
  "command.rejected",
  "command.status",
  "projection.workspace.snapshot",
  "projection.task_graph.snapshot",
  "projection.artifact.projected",
  "projection.invocation.updated",
  "projection.invocation.log_chunk",
  "projection.human_request.created",
  "projection.human_response.ack",
  "projection.session.updated",
  "projection.assignment.updated",
  "diagnostic.reported",
  "error.reported",
  "daemon.event",
  "runtime.reconcile.report",
] as const;
export const sparkEventKindSchema = z.enum(sparkEventKindOptions);

export const sparkCommandStatusSchema = z.enum([
  "queued",
  "accepted",
  "rejected",
  "running",
  "streaming",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
  "unknown",
]);

export const sparkEventSubjectSchema = z.object({
  kind: z.enum([
    "runtime",
    "workspace",
    "workspace_binding",
    "project",
    "command",
    "invocation",
    "task_graph",
    "task",
    "artifact",
    "human_request",
    "human_response",
    "session",
    "assignment",
    "diagnostic",
    "daemon",
  ]),
  id: z.string().min(1).optional(),
});

export const sparkDiagnosticSeveritySchema = z.enum(["debug", "info", "warning", "error"]);
export const sparkDiagnosticSchema = z.object({
  severity: sparkDiagnosticSeveritySchema,
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().optional(),
});

export const sparkEventSchema = z
  .object({
    schemaVersion: z.literal(sparkEventSchemaVersion).default(sparkEventSchemaVersion),
    id: z.string().min(1).optional(),
    kind: sparkEventKindSchema,
    commandId: z.string().min(1).optional(),
    status: sparkCommandStatusSchema.optional(),
    route: sparkCommandRouteSchema.default({}),
    subject: sparkEventSubjectSchema.optional(),
    payload: sparkProtocolJsonObjectSchema.default({}),
    diagnostic: sparkDiagnosticSchema.optional(),
    observedAt: isoDateTimeSchema.optional(),
    transport: sparkCommandTransportTraceSchema.optional(),
  })
  .superRefine((event, context) => {
    if (
      (event.kind === "diagnostic.reported" || event.kind === "error.reported") &&
      !event.diagnostic
    ) {
      context.addIssue({
        code: "custom",
        path: ["diagnostic"],
        message: `${event.kind} events must include diagnostic details`,
      });
    }
  });

export type SparkCommandKind = z.infer<typeof sparkCommandKindSchema>;
export type SparkCommandPayloadRef = z.infer<typeof sparkCommandPayloadRefSchema>;
export type SparkCommandRoute = z.infer<typeof sparkCommandRouteSchema>;
export type SparkCommandTransportKind = z.infer<typeof sparkCommandTransportKindSchema>;
export type SparkCommandTransportTrace = z.infer<typeof sparkCommandTransportTraceSchema>;
export type SparkCommand = z.infer<typeof sparkCommandSchema>;
export type SparkEventKind = z.infer<typeof sparkEventKindSchema>;
export type SparkCommandStatus = z.infer<typeof sparkCommandStatusSchema>;
export type SparkEventSubject = z.infer<typeof sparkEventSubjectSchema>;
export type SparkDiagnosticSeverity = z.infer<typeof sparkDiagnosticSeveritySchema>;
export type SparkDiagnostic = z.infer<typeof sparkDiagnosticSchema>;
export type SparkEvent = z.infer<typeof sparkEventSchema>;

export const localRpcMethodToSparkCommandKind = {
  "daemon.status": "daemon.status.request",
  "daemon.stop": "daemon.stop.request",
  "daemon.queue": "turn.status.request",
  "turn.submit": "turn.submit.request",
  "turn.cancel": "turn.cancel.request",
  "turn.stream": "turn.stream.subscribe",
  "channel.status": "channel.status.request",
  "channel.configure": "channel.configure.request",
  "channel.reload": "channel.reload.request",
  "channel.notify": "channel.notify.request",
  "workspace.list": "workspace.list.request",
  "workspace.register": "workspace.register.request",
  "workspace.ensure-local": "workspace.ensure_local.request",
  "workspace.attach": "workspace.attach.request",
  "workspace.stop": "workspace.stop.request",
  "workspace.client.attach": "workspace.client.attach.request",
  "workspace.client.heartbeat": "workspace.client.heartbeat.request",
  "workspace.client.release": "workspace.client.release.request",
  "workspace.executor.ensure": "workspace.executor.ensure.request",
  "session.list": "session.list.request",
  "session.get": "session.get.request",
  "session.snapshot": "session.snapshot.request",
  "session.create": "session.create.request",
  "session.bind": "session.bind.request",
  "session.unbind": "session.unbind.request",
  "session.archive": "session.archive.request",
  "session.model.set": "session.model.set.request",
  "model.catalog": "model.catalog.request",
  "model.default.set": "model.default.set.request",
  "provider.auth.api-key.set": "provider.auth.api_key.set.request",
  "provider.auth.logout": "provider.auth.logout.request",
  "provider.auth.login.start": "provider.auth.login.start.request",
  "provider.auth.login.status": "provider.auth.login.status.request",
  "provider.auth.login.respond": "provider.auth.login.respond.request",
  "provider.auth.login.cancel": "provider.auth.login.cancel.request",
} as const satisfies Record<string, SparkCommandKind>;

export const runtimeServerCommandKindOptions = [
  "workspace.snapshot.request",
  "project.create.request",
  "task.start.request",
  "assignment.create.request",
  "session.create.request",
  "session.bind.request",
  "session.unbind.request",
  "session.archive.request",
  "invocation.cancel.request",
  "artifact.content.request",
  "human.response.deliver.request",
  "diagnostics.request",
] as const satisfies readonly SparkCommandKind[];
export type RuntimeServerCommandKind = (typeof runtimeServerCommandKindOptions)[number];
export const runtimeServerCommandKindToSparkCommandKind = Object.fromEntries(
  runtimeServerCommandKindOptions.map((kind) => [kind, kind]),
) as Record<RuntimeServerCommandKind, SparkCommandKind>;

export const runtimeEnvelopeTypeToSparkEventKind = {
  "runtime.command.ack": "command.accepted",
  "runtime.command.reject": "command.rejected",
  "workspace.snapshot": "projection.workspace.snapshot",
  "task_graph.snapshot": "projection.task_graph.snapshot",
  "artifact.projected": "projection.artifact.projected",
  "invocation.updated": "projection.invocation.updated",
  "invocation.log_chunk": "projection.invocation.log_chunk",
  "human.request.created": "projection.human_request.created",
  "human.response.ack": "projection.human_response.ack",
  "runtime.reconcile.report": "runtime.reconcile.report",
  "daemon.event": "daemon.event",
} as const satisfies Record<string, SparkEventKind>;

export type LocalRpcCommandMethod = keyof typeof localRpcMethodToSparkCommandKind;
export type RuntimeEventEnvelopeType = keyof typeof runtimeEnvelopeTypeToSparkEventKind;

export function sparkCommandKindForLocalRpcMethod(method: string): SparkCommandKind | null {
  return localRpcMethodToSparkCommandKind[method as LocalRpcCommandMethod] ?? null;
}

export function sparkCommandKindForRuntimeServerCommand(kind: string): SparkCommandKind | null {
  return runtimeServerCommandKindToSparkCommandKind[kind as RuntimeServerCommandKind] ?? null;
}

export function sparkEventKindForRuntimeEnvelopeType(type: string): SparkEventKind | null {
  return runtimeEnvelopeTypeToSparkEventKind[type as RuntimeEventEnvelopeType] ?? null;
}

export function parseSparkCommand(value: unknown): SparkCommand {
  return sparkCommandSchema.parse(value);
}

export function parseSparkEvent(value: unknown): SparkEvent {
  return sparkEventSchema.parse(value);
}
