import { z } from "zod";
import { sparkChannelControlSnapshotSchema } from "../channel-control.ts";
import { sparkAuthFlowSchema, sparkModelControlSnapshotSchema } from "../model-control.ts";
import { isoDateTimeSchema, prefixedIdSchema } from "../refs.ts";
import { sparkProtocolJsonObjectSchema } from "../command-events.ts";
import { runtimeEnvelopeFor } from "./envelope.ts";

export const runtimeEphemeralSecretOperationSchema = z.enum([
  "provider.auth.api_key.set",
  "provider.auth.login.respond",
  "channel.configure",
]);

const providerNameSchema = z.string().trim().min(1).max(200);
const flowIdSchema = z.string().trim().min(1).max(500);

export const runtimeEphemeralSecretRequestPayloadSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("provider.auth.api_key.set"),
    providerName: providerNameSchema,
    apiKey: z
      .string()
      .min(1)
      .max(64 * 1024),
  }),
  z.object({
    operation: z.literal("provider.auth.login.respond"),
    flowId: flowIdSchema,
    promptId: z.string().trim().min(1).max(500),
    value: z.string().max(64 * 1024),
  }),
  z.object({
    operation: z.literal("channel.configure"),
    workspaceId: prefixedIdSchema("ws"),
    config: sparkProtocolJsonObjectSchema,
  }),
]);

const runtimeEphemeralSecretResultBaseSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  reasonCode: z.string().min(1).max(200).optional(),
  message: z.string().min(1).max(500).optional(),
  completedAt: isoDateTimeSchema,
});

export const runtimeEphemeralSecretResultPayloadSchema = z.discriminatedUnion("operation", [
  runtimeEphemeralSecretResultBaseSchema.extend({
    operation: z.literal("provider.auth.api_key.set"),
    result: sparkModelControlSnapshotSchema.optional(),
  }),
  runtimeEphemeralSecretResultBaseSchema.extend({
    operation: z.literal("provider.auth.login.respond"),
    result: sparkAuthFlowSchema.optional(),
  }),
  runtimeEphemeralSecretResultBaseSchema.extend({
    operation: z.literal("channel.configure"),
    result: sparkChannelControlSnapshotSchema.optional(),
  }),
]);

function ephemeralSecretEnvelopeFor<TPayload>(payloadSchema: z.ZodType<TPayload>) {
  return runtimeEnvelopeFor(payloadSchema).extend({
    runtimeId: prefixedIdSchema("rt"),
    workspaceId: prefixedIdSchema("ws").optional(),
    workspaceBindingId: prefixedIdSchema("rtwb").optional(),
    ephemeralRequestId: prefixedIdSchema("eph"),
  });
}

export const serverEphemeralSecretRequestEnvelopeSchema = ephemeralSecretEnvelopeFor(
  runtimeEphemeralSecretRequestPayloadSchema,
)
  .extend({
    type: z.literal("server.ephemeral_secret.request"),
    actorUserId: prefixedIdSchema("usr"),
    browserRequestId: prefixedIdSchema("msg"),
    csrfVerified: z.literal(true),
    expiresAt: isoDateTimeSchema,
  })
  .superRefine((envelope, context) => {
    const channelOperation = envelope.payload.operation === "channel.configure";
    if (channelOperation && envelope.payload.operation === "channel.configure") {
      if (
        !envelope.workspaceId ||
        !envelope.workspaceBindingId ||
        envelope.payload.workspaceId !== envelope.workspaceId
      ) {
        context.addIssue({
          code: "custom",
          path: ["workspaceId"],
          message: "Channel secret requests require one matching workspace owner route",
        });
      }
    } else if (envelope.workspaceId || envelope.workspaceBindingId) {
      context.addIssue({
        code: "custom",
        path: ["payload", "operation"],
        message: "Provider secret requests are daemon-scoped",
      });
    }
  });

export const runtimeEphemeralSecretResultEnvelopeSchema = ephemeralSecretEnvelopeFor(
  runtimeEphemeralSecretResultPayloadSchema,
).extend({
  type: z.literal("runtime.ephemeral_secret.result"),
});

export type RuntimeEphemeralSecretOperation = z.infer<typeof runtimeEphemeralSecretOperationSchema>;
export type RuntimeEphemeralSecretRequestPayload = z.infer<
  typeof runtimeEphemeralSecretRequestPayloadSchema
>;
export type RuntimeEphemeralSecretResultPayload = z.infer<
  typeof runtimeEphemeralSecretResultPayloadSchema
>;
export type ServerEphemeralSecretRequestEnvelope = z.infer<
  typeof serverEphemeralSecretRequestEnvelopeSchema
>;
export type RuntimeEphemeralSecretResultEnvelope = z.infer<
  typeof runtimeEphemeralSecretResultEnvelopeSchema
>;
