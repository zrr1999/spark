import { createHash } from "node:crypto";
import type { IncomingMessage } from "@zendev-lab/spark-channels";
import type { SparkDaemonTask } from "../core/types.ts";
import { SparkInvocationStore, type SparkInvocationRecord } from "../store/invocations.ts";
import type { ChannelIngressAssignment } from "./ingress.ts";

const CHANNEL_INBOUND_IDEMPOTENCY_VERSION = "v1";

/**
 * Derive a stable daemon admission key without embedding platform identifiers in the key.
 *
 * Platform message ids are only authoritative within their adapter/conversation
 * scope, so all three fields participate in the digest. Messages without a
 * platform id deliberately retain the historical non-idempotent admission path.
 */
export function channelInboundInvocationIdempotencyKey(
  assignment: Pick<
    ChannelIngressAssignment,
    "channelReply" | "externalKey" | "source" | "channelContext"
  >,
): string | undefined {
  const messageId =
    assignment.source.externalRef?.trim() || assignment.channelContext?.messageId?.trim();
  if (!messageId) return undefined;

  return channelInboundMessageIdempotencyKey(assignment.channelReply.workspaceId, {
    adapter: assignment.source.channel,
    externalKey: assignment.externalKey,
    messageId,
  });
}

export function channelInboundMessageIdempotencyKey(
  workspaceId: string,
  message: Pick<IncomingMessage, "adapter" | "externalKey" | "messageId">,
): string | undefined {
  const messageId = message.messageId?.trim();
  if (!messageId) return undefined;
  const normalizedWorkspaceId = workspaceId.trim();
  const adapterId = message.adapter.trim();
  const externalKey = message.externalKey.trim();
  if (!normalizedWorkspaceId || !adapterId || !externalKey) {
    throw new Error("channel inbound idempotency requires workspaceId, adapterId, and externalKey");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        CHANNEL_INBOUND_IDEMPOTENCY_VERSION,
        normalizedWorkspaceId,
        adapterId,
        externalKey,
        messageId,
      ]),
    )
    .digest("hex");
  return `channel.inbound:${CHANNEL_INBOUND_IDEMPOTENCY_VERSION}:${digest}`;
}

/**
 * The single durable admission boundary used by daemon channel runtimes.
 * SparkInvocationStore's unique idempotency index fences overlapping daemon
 * processes; a replay returns the original invocation record.
 */
export function submitChannelInboundInvocation(
  store: SparkInvocationStore,
  assignment: ChannelIngressAssignment,
  task: SparkDaemonTask,
): SparkInvocationRecord {
  const idempotencyKey = channelInboundInvocationIdempotencyKey(assignment);
  // Platform identity is authoritative for a replay. Return before rebuilding
  // admission from mutable session/model state, which may have changed while a
  // second daemon was starting.
  if (idempotencyKey) {
    const existing = store.findByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
  }

  try {
    return store.submit({
      sessionId: task.sessionId,
      prompt: task.prompt,
      task,
      sourceKind: "channel",
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  } catch (error) {
    // Two SQLite connections may both observe absence before the UNIQUE insert.
    // A cryptographically scoped platform identity wins over task/config drift.
    const raced = idempotencyKey ? store.findByIdempotencyKey(idempotencyKey) : undefined;
    if (raced) return raced;
    throw error;
  }
}
