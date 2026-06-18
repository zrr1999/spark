import { z } from "zod";
import { anyPrefixedIdSchema, isoDateTimeSchema, prefixedIdSchema } from "../refs.js";

export const runtimeProtocolVersion = "navia.runtime.v1alpha1" as const;
export const runtimeProtocolVersionSchema = z.literal(runtimeProtocolVersion);

export const runtimeEnvelopeSchema = z.object({
  protocolVersion: runtimeProtocolVersionSchema,
  messageId: prefixedIdSchema("msg"),
  idempotencyKey: prefixedIdSchema("idem").optional(),
  type: z.string().min(1),
  sentAt: isoDateTimeSchema,
  workspaceBindingId: prefixedIdSchema("rtwb").optional(),
  payload: z.unknown(),
});

export type RuntimeEnvelope = z.infer<typeof runtimeEnvelopeSchema>;

export function runtimeEnvelopeFor<TPayload>(payloadSchema: z.ZodType<TPayload>) {
  return runtimeEnvelopeSchema.extend({ payload: payloadSchema });
}

export const runtimeFeatureSchema = z.enum([
  "ws-control-v1",
  "multi-workspace-runtime-v1",
  "workspace-snapshot-v1",
  "command-routing-v1",
  "human-request-v1",
  "logs-v1",
  "artifact-ref-v1",
  "artifact-cache-upload-v1",
  "cancellation-v1",
  "reconcile-v1",
]);

export type RuntimeFeature = z.infer<typeof runtimeFeatureSchema>;
export const runtimeRefSchema = anyPrefixedIdSchema;
