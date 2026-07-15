/**
 * Canonical server-command delivery helpers shared by Cockpit projection and daemon runtime.
 *
 * Cockpit persists commands in SQLite as a projection outbox; daemon execution is authoritative.
 * All wire envelopes must be built through these helpers so clients do not drift.
 */

import { runtimeServerCommandSpecification } from "./command-events.ts";
import { createId } from "./refs.ts";
import {
  serverCommandEnvelopeSchema,
  serverCommandPayloadSchema,
  type ServerCommandPayload,
} from "./runtime-v1/messages.ts";
import { runtimeProtocolVersion } from "./runtime-v1/envelope.ts";
import { sparkAssignmentSchema } from "./session-assignment.ts";
import { assertSparkRuntimeProtocolVersion } from "./version.ts";

export type { ServerCommandPayload };
export type ServerCommandEnvelope = ReturnType<typeof serverCommandEnvelopeSchema.parse>;

export interface ServerCommandRouting {
  runtimeId: string;
  workspaceBindingId?: string;
  workspaceId?: string;
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
  const specification = runtimeServerCommandSpecification(input.payload.kind);
  if (!specification) {
    throw new Error(`Unknown runtime server command kind: ${input.payload.kind}`);
  }
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
    payload: serverCommandPayloadSchema.parse({
      ...input.payload,
      scope: input.payload.scope ?? specification.scope,
    }),
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

export type ServerCommandExecutionNormalizationResult =
  | { ok: true; envelope: ServerCommandEnvelope }
  | {
      ok: false;
      reasonCode: "ASSIGNMENT_INVALID";
      message: string;
      retryable: false;
    };

export function normalizeServerCommandForExecution(
  envelope: ServerCommandEnvelope,
): ServerCommandExecutionNormalizationResult {
  if (envelope.payload.kind !== "assignment.create.request") {
    return { ok: true, envelope };
  }

  const assignmentResult = sparkAssignmentSchema.safeParse(envelope.payload.payload);
  if (!assignmentResult.success) {
    return {
      ok: false,
      reasonCode: "ASSIGNMENT_INVALID",
      message:
        assignmentResult.error.issues[0]?.message ?? "Invalid assignment.create.request payload.",
      retryable: false,
    };
  }

  const assignment = assignmentResult.data;
  return {
    ok: true,
    envelope: serverCommandEnvelopeSchema.parse({
      ...envelope,
      payload: serverCommandPayloadSchema.parse({
        ...envelope.payload,
        kind: "task.start.request",
        title: titleForAssignmentExecution(
          envelope.payload.title,
          assignment.title,
          assignment.goal,
        ),
        payload: {
          ...assignment,
          prompt: assignment.goal,
          sessionId: assignment.target.sessionId,
          assignment,
        },
      }),
    }),
  };
}

function titleForAssignmentExecution(
  payloadTitle: string | undefined,
  assignmentTitle: string | undefined,
  goal: string,
): string {
  return payloadTitle?.trim() || assignmentTitle?.trim() || goal.trim().slice(0, 80);
}
