/**
 * Canonical server-command delivery helpers shared by Cockpit projection and daemon runtime.
 *
 * Cockpit persists commands in SQLite as a projection outbox; daemon execution is authoritative.
 * All wire envelopes must be built through these helpers so clients do not drift.
 */

import { createId } from "./refs.ts";
import {
  serverCommandEnvelopeSchema,
  serverCommandPayloadSchema,
  type ServerCommandPayload,
} from "./runtime-v1/messages.ts";
import { runtimeProtocolVersion } from "./runtime-v1/envelope.ts";
import { assertSparkRuntimeProtocolVersion } from "./version.ts";

export type { ServerCommandPayload };

export interface ServerCommandRouting {
  runtimeId: string;
  workspaceBindingId: string;
  workspaceId: string;
  projectId?: string;
  commandId: string;
  idempotencyKey?: string;
}

export interface CreateServerCommandEnvelopeInput extends ServerCommandRouting {
  payload: ServerCommandPayload;
  messageId?: string;
  sentAt?: string;
  protocolVersion?: string;
}

export function createServerCommandEnvelope(input: CreateServerCommandEnvelopeInput) {
  const sentAt = input.sentAt ?? new Date().toISOString();
  const envelope = {
    protocolVersion: input.protocolVersion ?? runtimeProtocolVersion,
    messageId: input.messageId ?? createId("msg"),
    type: "server.command" as const,
    sentAt,
    runtimeId: input.runtimeId,
    workspaceBindingId: input.workspaceBindingId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    payload: serverCommandPayloadSchema.parse(input.payload),
  };
  assertSparkRuntimeProtocolVersion(envelope.protocolVersion, { label: "server.command" });
  return serverCommandEnvelopeSchema.parse(envelope);
}

export function parseServerCommandEnvelope(value: unknown) {
  const envelope = serverCommandEnvelopeSchema.parse(value);
  assertSparkRuntimeProtocolVersion(envelope.protocolVersion, { label: "server.command" });
  return envelope;
}

export function serializeServerCommandEnvelope(input: CreateServerCommandEnvelopeInput): string {
  return JSON.stringify(createServerCommandEnvelope(input));
}
