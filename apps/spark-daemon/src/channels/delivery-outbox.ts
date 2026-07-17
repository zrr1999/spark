import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChannelAskRequest,
  ChannelInteractionAckStatus,
  ChannelReplyTarget,
  IncomingMessage,
} from "@zendev-lab/spark-channels";
import {
  channelReplyDeliveryForCompletion,
  type SparkDaemonChannelReplyDeliveryInput,
} from "../spark/session-run.ts";
import type { SparkDaemonTask } from "../core/types.ts";
import {
  SparkChannelDeliveryStore,
  type SparkChannelDeliveryRecord,
} from "../store/channel-deliveries.ts";
import {
  type CompleteSparkInvocationInput,
  type SparkInvocationRecord,
  SparkInvocationStore,
} from "../store/invocations.ts";
import type { DaemonChannelIngressRuntime } from "./ingress.ts";
import { channelInboundMessageIdempotencyKey } from "./admission.ts";

export interface DaemonChannelAskDeliveryInput {
  idempotencyKey: string;
  workspaceId: string;
  adapterId: string;
  recipient: string;
  request: ChannelAskRequest;
}

export interface DaemonChannelInteractionAckDeliveryInput {
  idempotencyKey: string;
  workspaceId: string;
  adapterId: string;
  interactionId: string;
  status: ChannelInteractionAckStatus;
}

export interface DaemonChannelInboundDeliveryInput {
  workspaceId: string;
  message: IncomingMessage;
}

export interface DaemonChannelNotificationDeliveryInput {
  idempotencyKey: string;
  sessionId: string;
  messageId: string;
  workspaceId: string;
  adapterId: string;
  externalKey: string;
  recipient: string;
  text: string;
}

export interface DaemonChannelDeliveryOutbox {
  enqueueReply(input: SparkDaemonChannelReplyDeliveryInput): Promise<void>;
  enqueueAsk(input: DaemonChannelAskDeliveryInput): Promise<void>;
  enqueueInteractionAck(input: DaemonChannelInteractionAckDeliveryInput): Promise<void>;
  enqueueInbound(input: DaemonChannelInboundDeliveryInput): void;
  enqueueNotification(input: DaemonChannelNotificationDeliveryInput): Promise<void>;
}

export const DEFAULT_CHANNEL_DELIVERY_ATTEMPT_TIMEOUT_MS = 180_000;

type ReplyPayload = Omit<SparkDaemonChannelReplyDeliveryInput, "idempotencyKey">;
type AskPayload = Omit<DaemonChannelAskDeliveryInput, "idempotencyKey">;
type InteractionAckPayload = Omit<DaemonChannelInteractionAckDeliveryInput, "idempotencyKey">;
type InboundPayload = DaemonChannelInboundDeliveryInput;
type NotificationPayload = Omit<DaemonChannelNotificationDeliveryInput, "idempotencyKey">;
type ChannelDeliveryIngress = Pick<
  DaemonChannelIngressRuntime,
  "sendReply" | "sendAsk" | "ackInteraction" | "admitInbound"
> &
  Partial<Pick<DaemonChannelIngressRuntime, "notify">>;

export function createDaemonChannelDeliveryOutbox(
  store: SparkChannelDeliveryStore,
): DaemonChannelDeliveryOutbox {
  return {
    enqueueReply: async (input) => {
      const { idempotencyKey, ...payload } = input;
      store.enqueue({ kind: "reply", idempotencyKey, payload });
    },
    enqueueAsk: async (input) => {
      const { idempotencyKey, ...payload } = input;
      store.enqueue({ kind: "ask", idempotencyKey, payload });
    },
    enqueueInteractionAck: async (input) => {
      const { idempotencyKey, ...payload } = input;
      store.enqueue({ kind: "interaction_ack", idempotencyKey, payload });
    },
    enqueueInbound: (input) => {
      const idempotencyKey =
        channelInboundMessageIdempotencyKey(input.workspaceId, input.message) ??
        `channel.inbound:unkeyed:${randomUUID()}`;
      // Platform identity is authoritative across reconnects. A redelivery may
      // carry harmless projection drift (for example a changed display name),
      // but must not create a second durable admission.
      if (store.findByIdempotencyKey(idempotencyKey)) return;
      try {
        store.enqueue({
          kind: "inbound",
          idempotencyKey,
          payload: {
            workspaceId: input.workspaceId,
            message: durableInboundMessage(input.message),
          } satisfies InboundPayload,
        });
      } catch (error) {
        if (store.findByIdempotencyKey(idempotencyKey)) return;
        throw error;
      }
    },
    enqueueNotification: async (input) => {
      const { idempotencyKey, ...payload } = input;
      store.enqueue({ kind: "notification", idempotencyKey, payload });
    },
  };
}

/**
 * Commit a terminal invocation and its user-visible channel reply intent in
 * one SQLite transaction. Platform I/O remains outside this transaction and
 * is handled by the leased reconciler below.
 */
export function completeInvocationWithChannelDelivery(
  deps: {
    db: DatabaseSync;
    invocations: SparkInvocationStore;
    deliveries: SparkChannelDeliveryStore;
  },
  invocation: SparkInvocationRecord,
  task: SparkDaemonTask,
  completion: CompleteSparkInvocationInput,
): SparkInvocationRecord {
  const delivery = channelReplyDeliveryForCompletion(
    task,
    invocation.invocationId,
    completion.status === "succeeded" ? "final" : "failure",
    completion.result,
  );
  if (!delivery) {
    return deps.invocations.complete(invocation.invocationId, completion);
  }

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const completed = deps.invocations.complete(invocation.invocationId, completion);
    const { idempotencyKey, ...payload } = delivery;
    deps.deliveries.enqueue({ kind: "reply", idempotencyKey, payload });
    deps.db.exec("COMMIT");
    return completed;
  } catch (error) {
    deps.db.exec("ROLLBACK");
    throw error;
  }
}

export async function reconcileDaemonChannelDeliveries(
  deps: {
    store: SparkChannelDeliveryStore;
    channelIngress: ChannelDeliveryIngress;
    workerId: string;
  },
  options: {
    limit?: number;
    leaseMs?: number;
    heartbeatIntervalMs?: number;
    attemptTimeoutMs?: number;
  } = {},
): Promise<{ attempted: number; delivered: number; failed: number }> {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
  const leaseMs = positiveDurationMs(options.leaseMs ?? 90_000, "leaseMs");
  const heartbeatIntervalMs = positiveDurationMs(
    options.heartbeatIntervalMs ?? Math.max(1, Math.floor(leaseMs / 3)),
    "heartbeatIntervalMs",
  );
  if (heartbeatIntervalMs >= leaseMs) {
    throw new Error("channel delivery heartbeatIntervalMs must be shorter than leaseMs");
  }
  const attemptTimeoutMs = positiveDurationMs(
    options.attemptTimeoutMs ?? DEFAULT_CHANNEL_DELIVERY_ATTEMPT_TIMEOUT_MS,
    "attemptTimeoutMs",
  );
  const claimed: SparkChannelDeliveryRecord[] = [];
  while (claimed.length < limit) {
    const delivery = deps.store.claimDue(deps.workerId, {
      // Platform HTTP deadlines are 30s. Keep the lease comfortably larger so
      // a healthy slow attempt has time to establish its heartbeat.
      leaseMs,
    });
    if (!delivery) break;
    claimed.push(delivery);
  }

  // Independent platforms and recipients must not head-of-line block each
  // other. Claims are fenced first, then attempts run concurrently; each one
  // owns its own heartbeat and hard application deadline.
  const outcomes = await Promise.all(
    claimed.map(async (delivery): Promise<"delivered" | "failed"> => {
      try {
        const receipt = await dispatchWithLeaseHeartbeat(
          delivery,
          deps.store,
          deps.channelIngress,
          leaseMs,
          heartbeatIntervalMs,
          attemptTimeoutMs,
        );
        deps.store.recordDelivered(delivery.deliveryId, requireLeaseToken(delivery), receipt);
        return "delivered";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          const retry = deps.store.recordFailure(
            delivery.deliveryId,
            requireLeaseToken(delivery),
            message,
          );
          console.error(
            `[spark-daemon] channel delivery ${delivery.deliveryId} ${delivery.kind} attempt=${retry.attemptCount} failed; retryAt=${retry.nextAttemptAt}: ${message}`,
          );
        } catch (recordError) {
          console.error(
            `[spark-daemon] channel delivery ${delivery.deliveryId} failure receipt could not be recorded`,
            recordError,
          );
        }
        return "failed";
      }
    }),
  );
  return {
    attempted: claimed.length,
    delivered: outcomes.filter((outcome) => outcome === "delivered").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
  };
}

async function dispatchWithLeaseHeartbeat(
  delivery: SparkChannelDeliveryRecord,
  store: SparkChannelDeliveryStore,
  channelIngress: ChannelDeliveryIngress,
  leaseMs: number,
  heartbeatIntervalMs: number,
  attemptTimeoutMs: number,
): Promise<unknown> {
  const leaseToken = requireLeaseToken(delivery);
  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    if (heartbeatError !== undefined) return;
    try {
      store.renewLease(delivery.deliveryId, leaseToken, { leaseMs });
    } catch (error) {
      heartbeatError = error;
      clearInterval(heartbeat);
    }
  }, heartbeatIntervalMs);

  try {
    let receipt: unknown;
    let dispatchError: unknown;
    let dispatchFailed = false;
    try {
      receipt = await withChannelDeliveryAttemptTimeout(
        dispatchChannelDelivery(delivery, channelIngress),
        delivery,
        attemptTimeoutMs,
      );
    } catch (error) {
      dispatchFailed = true;
      dispatchError = error;
    }
    if (heartbeatError !== undefined) throw heartbeatError;

    // Fence the receipt/failure write with one final renewal. A worker that
    // lost ownership while the platform call was in flight must not commit it.
    store.renewLease(delivery.deliveryId, leaseToken, { leaseMs });
    if (dispatchFailed) throw dispatchError;
    return receipt;
  } finally {
    clearInterval(heartbeat);
  }
}

async function withChannelDeliveryAttemptTimeout<T>(
  dispatch: Promise<T>,
  delivery: SparkChannelDeliveryRecord,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `channel delivery ${delivery.deliveryId} ${delivery.kind} attempt timed out after ${timeoutMs}ms`,
          { cause: { code: "CHANNEL_DELIVERY_ATTEMPT_TIMEOUT" } },
        ),
      );
    }, timeoutMs);
    timeout.unref?.();
  });

  // Some third-party transports cannot accept AbortSignal yet. Observe their
  // eventual rejection even after the application deadline wins the race;
  // the durable ledger will retry the same immutable delivery identity.
  void dispatch.catch(() => undefined);
  try {
    return await Promise.race([dispatch, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function dispatchChannelDelivery(
  delivery: SparkChannelDeliveryRecord,
  channelIngress: ChannelDeliveryIngress,
): Promise<unknown> {
  switch (delivery.kind) {
    case "reply": {
      const payload = parseReplyPayload(delivery.payload);
      await channelIngress.sendReply(payload.workspaceId, payload.adapterId, {
        ...payload.target,
        text: payload.text,
      });
      return {
        workspaceId: payload.workspaceId,
        adapterId: payload.adapterId,
        recipient: payload.target.recipient,
      };
    }
    case "ask": {
      const payload = parseAskPayload(delivery.payload);
      return await channelIngress.sendAsk(
        payload.workspaceId,
        payload.adapterId,
        payload.recipient,
        {
          ...payload.request,
          // Carry the immutable ledger identity into adapters. QQ uses it to
          // retry the same passive message slot after an ambiguous timeout.
          idempotencyKey: delivery.idempotencyKey,
        },
      );
    }
    case "interaction_ack": {
      const payload = parseInteractionAckPayload(delivery.payload);
      await channelIngress.ackInteraction(
        payload.workspaceId,
        payload.adapterId,
        payload.interactionId,
        payload.status,
      );
      return {
        workspaceId: payload.workspaceId,
        adapterId: payload.adapterId,
        interactionId: payload.interactionId,
        status: payload.status,
      };
    }
    case "inbound": {
      const payload = parseInboundPayload(delivery.payload);
      if (!channelIngress.admitInbound) {
        throw new Error("channel inbound admission is unavailable");
      }
      await channelIngress.admitInbound(payload.workspaceId, payload.message);
      return {
        workspaceId: payload.workspaceId,
        adapterId: payload.message.adapter,
        messageId: payload.message.messageId,
      };
    }
    case "notification": {
      const payload = parseNotificationPayload(delivery.payload);
      if (!channelIngress.notify) {
        throw new Error("channel notification delivery is unavailable");
      }
      return await channelIngress.notify(payload.workspaceId, {
        action: "send",
        adapter: payload.adapterId,
        recipient: payload.recipient,
        text: payload.text,
      });
    }
  }
}

function parseReplyPayload(value: unknown): ReplyPayload {
  const record = requiredRecord(value, "reply payload");
  const target = requiredRecord(record.target, "reply target");
  const kind = record.kind;
  if (kind !== "final" && kind !== "failure") throw new Error("invalid reply kind");
  return {
    kind,
    invocationId: requiredString(record.invocationId, "reply invocationId"),
    sessionId: requiredString(record.sessionId, "reply sessionId"),
    workspaceId: requiredString(record.workspaceId, "reply workspaceId"),
    adapterId: requiredString(record.adapterId, "reply adapterId"),
    ...(optionalString(record.externalKey)
      ? { externalKey: optionalString(record.externalKey) }
      : {}),
    target: {
      recipient: requiredString(target.recipient, "reply recipient"),
      ...(optionalString(target.senderId) ? { senderId: optionalString(target.senderId) } : {}),
      ...(optionalString(target.messageId) ? { messageId: optionalString(target.messageId) } : {}),
      ...(optionalString(target.preview) ? { preview: optionalString(target.preview) } : {}),
    } satisfies ChannelReplyTarget,
    text: requiredString(record.text, "reply text"),
  };
}

function parseAskPayload(value: unknown): AskPayload {
  const record = requiredRecord(value, "ask payload");
  const request = requiredRecord(record.request, "ask request");
  const options = Array.isArray(request.options)
    ? request.options.map((value, index) => {
        const option = requiredRecord(value, `ask option ${index + 1}`);
        return {
          ...(optionalString(option.id) ? { id: optionalString(option.id) } : {}),
          label: requiredString(option.label, `ask option ${index + 1} label`),
          data: requiredString(option.data, `ask option ${index + 1} data`),
        };
      })
    : [];
  const audience = requiredRecord(request.audience, "ask audience");
  const audienceKind = audience.kind;
  if (audienceKind !== "everyone" && audienceKind !== "admins" && audienceKind !== "users") {
    throw new Error("invalid ask audience");
  }
  const parsedAudience: NonNullable<ChannelAskRequest["audience"]> =
    audienceKind === "users"
      ? {
          kind: "users" as const,
          userIds: requiredStringArray(audience.userIds, "ask audience userIds"),
        }
      : audienceKind === "everyone"
        ? { kind: "everyone" }
        : { kind: "admins" };
  return {
    workspaceId: requiredString(record.workspaceId, "ask workspaceId"),
    adapterId: requiredString(record.adapterId, "ask adapterId"),
    recipient: requiredString(record.recipient, "ask recipient"),
    request: {
      prompt: requiredString(request.prompt, "ask prompt"),
      options,
      audience: parsedAudience,
      ...(optionalString(request.messageId)
        ? { messageId: optionalString(request.messageId) }
        : {}),
      ...(optionalString(request.unsupportedText)
        ? { unsupportedText: optionalString(request.unsupportedText) }
        : {}),
    },
  };
}

function parseInteractionAckPayload(value: unknown): InteractionAckPayload {
  const record = requiredRecord(value, "interaction ack payload");
  const status = requiredString(record.status, "interaction ack status");
  if (
    status !== "success" &&
    status !== "failed" &&
    status !== "rate_limited" &&
    status !== "duplicate" &&
    status !== "forbidden" &&
    status !== "admins_only"
  ) {
    throw new Error(`invalid interaction ack status: ${status}`);
  }
  return {
    workspaceId: requiredString(record.workspaceId, "interaction ack workspaceId"),
    adapterId: requiredString(record.adapterId, "interaction ack adapterId"),
    interactionId: requiredString(record.interactionId, "interaction ack interactionId"),
    status,
  };
}

function parseInboundPayload(value: unknown): InboundPayload {
  const record = requiredRecord(value, "inbound payload");
  const rawMessage = requiredRecord(record.message, "inbound message");
  const adapter = requiredString(rawMessage.adapter, "inbound adapter");
  if (adapter !== "feishu" && adapter !== "infoflow" && adapter !== "qqbot") {
    throw new Error(`invalid inbound adapter: ${adapter}`);
  }
  const mentions = Array.isArray(rawMessage.mentions)
    ? rawMessage.mentions.map((entry) => requiredString(entry, "inbound mention"))
    : undefined;
  return {
    workspaceId: requiredString(record.workspaceId, "inbound workspaceId"),
    message: {
      adapter,
      externalKey: requiredString(rawMessage.externalKey, "inbound externalKey"),
      text: requiredString(rawMessage.text, "inbound text"),
      ...(optionalString(rawMessage.senderId)
        ? { senderId: optionalString(rawMessage.senderId) }
        : {}),
      ...(optionalString(rawMessage.senderName)
        ? { senderName: optionalString(rawMessage.senderName) }
        : {}),
      ...(optionalString(rawMessage.chatId) ? { chatId: optionalString(rawMessage.chatId) } : {}),
      ...(optionalString(rawMessage.messageId)
        ? { messageId: optionalString(rawMessage.messageId) }
        : {}),
      ...(optionalString(rawMessage.eventType)
        ? { eventType: optionalString(rawMessage.eventType) }
        : {}),
      ...(optionalString(rawMessage.contentType)
        ? { contentType: optionalString(rawMessage.contentType) }
        : {}),
      ...(Array.isArray(rawMessage.attachments)
        ? { attachments: rawMessage.attachments as IncomingMessage["attachments"] }
        : {}),
      ...(mentions?.length ? { mentions } : {}),
      ...(typeof rawMessage.mentionedSelf === "boolean"
        ? { mentionedSelf: rawMessage.mentionedSelf }
        : {}),
    },
  };
}

function parseNotificationPayload(value: unknown): NotificationPayload {
  const record = requiredRecord(value, "notification payload");
  return {
    sessionId: requiredString(record.sessionId, "notification sessionId"),
    messageId: requiredString(record.messageId, "notification messageId"),
    workspaceId: requiredString(record.workspaceId, "notification workspaceId"),
    adapterId: requiredString(record.adapterId, "notification adapterId"),
    externalKey: requiredString(record.externalKey, "notification externalKey"),
    recipient: requiredString(record.recipient, "notification recipient"),
    text: requiredString(record.text, "notification text"),
  };
}

function durableInboundMessage(message: IncomingMessage): IncomingMessage {
  const { raw: _raw, ...durable } = message;
  return durable;
}

function requireLeaseToken(delivery: SparkChannelDeliveryRecord): string {
  if (!delivery.leaseToken) throw new Error(`channel delivery ${delivery.deliveryId} has no lease`);
  return delivery.leaseToken;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const entries = value.map((entry) => requiredString(entry, label));
  if (entries.length === 0) throw new Error(`${label} must not be empty`);
  return entries;
}

function positiveDurationMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`channel delivery ${label} must be a positive finite number`);
  }
  return Math.max(1, Math.floor(value));
}
