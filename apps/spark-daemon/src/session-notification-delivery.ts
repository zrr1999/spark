import { createHash } from "node:crypto";
import {
  SparkSessionMailStore,
  SparkSessionRegistryError,
  type SparkSessionMailDeliveryReceipt,
} from "@zendev-lab/spark-session";
import type {
  DaemonChannelDeliveryOutbox,
  DaemonChannelNotificationDeliveryInput,
} from "./channels/delivery-outbox.ts";
import type {
  DaemonChannelIngressRuntime,
  DaemonChannelIngressStatus,
} from "./channels/ingress.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import type {
  SparkChannelDeliveryRecord,
  SparkChannelDeliveryStore,
} from "./store/channel-deliveries.ts";

export interface SessionNotificationDeliveryReceipt {
  adapter: string;
  externalKey: string;
  status: SparkSessionMailDeliveryReceipt["status"];
  attemptCount: number;
  receipt?: unknown;
  error?: string;
}

export interface SessionNotificationDeliveryResult {
  deliveries: SessionNotificationDeliveryReceipt[];
}

type DeliveryMailStore = Pick<SparkSessionMailStore, "get" | "recordChannelDelivery">;

export interface SessionNotificationDeliveryQueue {
  store: Pick<SparkChannelDeliveryStore, "findByIdempotencyKey">;
  outbox: Pick<DaemonChannelDeliveryOutbox, "enqueueNotification">;
}

type SessionNotificationDeliveryDeps = {
  mailStore: DeliveryMailStore;
  sessionRegistry: Pick<DaemonSessionRegistry, "get">;
  channelIngress: Pick<DaemonChannelIngressRuntime, "status" | "notify">;
  /** Production path: persist platform intent before any network send. */
  deliveryQueue?: SessionNotificationDeliveryQueue;
};

export async function deliverSessionNotification(
  input: { sessionId: string; messageId: string },
  deps: SessionNotificationDeliveryDeps,
): Promise<SessionNotificationDeliveryResult> {
  return await deliverSelectedSessionNotificationTargets(input, deps);
}

async function deliverSelectedSessionNotificationTargets(
  input: { sessionId: string; messageId: string },
  deps: SessionNotificationDeliveryDeps,
  selectedTargets?: ReadonlySet<string>,
): Promise<SessionNotificationDeliveryResult> {
  const session = await deps.sessionRegistry.get(input.sessionId);
  if (!session) {
    throw new SparkSessionRegistryError("session_not_found", `unknown session: ${input.sessionId}`);
  }
  if (session.scope.kind !== "workspace") {
    throw new SparkSessionRegistryError(
      "session_scope_mismatch",
      `channel notification target is not a workspace session: ${input.sessionId}`,
    );
  }
  const message = await deps.mailStore.get(input.sessionId, input.messageId);
  if (message.toSessionId !== input.sessionId) {
    throw new Error(
      `session mail ${input.messageId} belongs to ${message.toSessionId}, not ${input.sessionId}`,
    );
  }
  if (message.kind !== "notification") {
    throw new Error(`session mail ${input.messageId} is not a notification`);
  }
  if (message.visibility !== "user") {
    throw new Error(`session notification ${input.messageId} is not user-visible`);
  }
  if (message.delivery !== "channel") {
    throw new Error(`session mail ${input.messageId} is not a channel delivery`);
  }

  const deliveries: SessionNotificationDeliveryReceipt[] = [];
  for (const target of message.deliveries) {
    if (target.status === "delivered" || !isSelectedTarget(target, selectedTargets)) {
      deliveries.push(projectDelivery(target));
      continue;
    }
    if (deps.deliveryQueue) {
      const idempotencyKey = sessionNotificationDeliveryIdempotencyKey({
        sessionId: input.sessionId,
        messageId: input.messageId,
        adapter: target.adapter,
        externalKey: target.externalKey,
      });
      const existing = deps.deliveryQueue.store.findByIdempotencyKey(idempotencyKey);
      if (existing?.status === "delivered") {
        try {
          const updated = await deps.mailStore.recordChannelDelivery(
            input.sessionId,
            input.messageId,
            target,
            { ok: true, receipt: existing.receipt },
          );
          deliveries.push(projectDelivery(findRecordedDelivery(updated.deliveries, target)));
        } catch (error) {
          // The durable outbox remains the source of truth, so a failed
          // mailbox projection is retried without another platform send.
          console.error(
            `[spark-daemon] delivered session notification receipt could not be projected` +
              ` session=${input.sessionId} message=${input.messageId}` +
              ` target=${target.adapter}:${target.externalKey}`,
            error,
          );
          deliveries.push(
            projectQueuedDelivery(
              target,
              existing,
              `delivery receipt persistence failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
        continue;
      }
      if (existing) {
        deliveries.push(projectQueuedDelivery(target, existing));
        continue;
      }
      try {
        const queued = notificationOutboxInput(
          {
            sessionId: input.sessionId,
            messageId: input.messageId,
            workspaceId: session.scope.workspaceId,
            body: message.body,
            target,
          },
          deps.channelIngress.status(session.scope.workspaceId),
          idempotencyKey,
        );
        await deps.deliveryQueue.outbox.enqueueNotification(queued);
        const persisted = deps.deliveryQueue.store.findByIdempotencyKey(idempotencyKey);
        deliveries.push(
          persisted ? projectQueuedDelivery(target, persisted) : projectDelivery(target),
        );
      } catch (error) {
        const updated = await deps.mailStore.recordChannelDelivery(
          input.sessionId,
          input.messageId,
          target,
          { ok: false, error: error instanceof Error ? error.message : String(error) },
        );
        deliveries.push(projectDelivery(findRecordedDelivery(updated.deliveries, target)));
      }
      continue;
    }
    let receipt: unknown;
    try {
      const status = deps.channelIngress.status(session.scope.workspaceId);
      const adapterId = resolveNotificationAdapterId(status, target.adapter);
      const recipient = notificationRecipient(target.externalKey, target.adapter);
      receipt = await deps.channelIngress.notify(session.scope.workspaceId, {
        action: "send",
        adapter: adapterId,
        recipient,
        text: message.body,
      });
    } catch (error) {
      const updated = await deps.mailStore.recordChannelDelivery(
        input.sessionId,
        input.messageId,
        target,
        { ok: false, error: error instanceof Error ? error.message : String(error) },
      );
      deliveries.push(projectDelivery(findRecordedDelivery(updated.deliveries, target)));
      continue;
    }
    const updated = await deps.mailStore.recordChannelDelivery(
      input.sessionId,
      input.messageId,
      target,
      { ok: true, receipt },
    );
    deliveries.push(projectDelivery(findRecordedDelivery(updated.deliveries, target)));
  }
  return { deliveries };
}

export async function reconcileSessionNotificationDeliveries(
  deps: {
    mailStore: Pick<
      SparkSessionMailStore,
      "pendingChannelDeliveries" | "get" | "recordChannelDelivery"
    >;
    sessionRegistry: Pick<DaemonSessionRegistry, "get">;
    channelIngress: Pick<DaemonChannelIngressRuntime, "status" | "notify">;
    deliveryQueue?: SessionNotificationDeliveryQueue;
  },
  limit = 50,
): Promise<{ attempted: number; delivered: number; failed: number }> {
  const pending = await deps.mailStore.pendingChannelDeliveries(limit);
  const messages = new Map<
    string,
    {
      message: (typeof pending)[number]["message"];
      targets: Map<string, (typeof pending)[number]["target"]>;
    }
  >();
  for (const { message, target } of pending) {
    const messageKey = `${message.toSessionId}\u0000${message.id}`;
    const group = messages.get(messageKey) ?? { message, targets: new Map() };
    group.targets.set(deliveryTargetKey(target), target);
    messages.set(messageKey, group);
  }
  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  for (const { message, targets } of messages.values()) {
    const selectedTargets = new Set(targets.keys());
    attempted += selectedTargets.size;
    try {
      const result = await deliverSelectedSessionNotificationTargets(
        { sessionId: message.toSessionId, messageId: message.id },
        deps,
        selectedTargets,
      );
      delivered += result.deliveries.filter(
        (target) => selectedTargets.has(deliveryTargetKey(target)) && target.status === "delivered",
      ).length;
      failed += result.deliveries.filter(
        (target) => selectedTargets.has(deliveryTargetKey(target)) && target.status === "failed",
      ).length;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      for (const target of targets.values()) {
        try {
          await deps.mailStore.recordChannelDelivery(message.toSessionId, message.id, target, {
            ok: false,
            error: errorMessage,
          });
        } catch (recordError) {
          // One corrupt/unwritable mailbox must not poison later delivery
          // groups, but it must remain visible to operators.
          console.error(
            `[spark-daemon] session notification failure receipt could not be recorded` +
              ` session=${message.toSessionId} message=${message.id}` +
              ` target=${target.adapter}:${target.externalKey}`,
            recordError,
          );
        }
        failed += 1;
      }
    }
  }
  return { attempted, delivered, failed };
}

export function sessionNotificationDeliveryIdempotencyKey(input: {
  sessionId: string;
  messageId: string;
  adapter: string;
  externalKey: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.sessionId, input.messageId, input.adapter, input.externalKey]))
    .digest("hex");
  return `session.notification:${digest}`;
}

function notificationOutboxInput(
  input: {
    sessionId: string;
    messageId: string;
    workspaceId: string;
    body: string;
    target: Pick<SparkSessionMailDeliveryReceipt, "adapter" | "externalKey">;
  },
  status: DaemonChannelIngressStatus,
  idempotencyKey: string,
): DaemonChannelNotificationDeliveryInput {
  return {
    idempotencyKey,
    sessionId: input.sessionId,
    messageId: input.messageId,
    workspaceId: input.workspaceId,
    adapterId: resolveNotificationAdapterId(status, input.target.adapter),
    externalKey: input.target.externalKey,
    recipient: notificationRecipient(input.target.externalKey, input.target.adapter),
    text: input.body,
  };
}

function projectQueuedDelivery(
  target: SparkSessionMailDeliveryReceipt,
  delivery: SparkChannelDeliveryRecord,
  projectionError?: string,
): SessionNotificationDeliveryReceipt {
  if (projectionError || delivery.status === "retry_wait") {
    return {
      adapter: target.adapter,
      externalKey: target.externalKey,
      status: "failed",
      attemptCount: delivery.attemptCount,
      error: projectionError ?? delivery.lastError ?? "channel delivery is waiting to retry",
    };
  }
  return {
    adapter: target.adapter,
    externalKey: target.externalKey,
    status: delivery.status === "delivered" ? "delivered" : "pending",
    attemptCount: delivery.attemptCount,
    ...(delivery.receipt !== undefined ? { receipt: delivery.receipt } : {}),
  };
}

function isSelectedTarget(
  target: Pick<SparkSessionMailDeliveryReceipt, "adapter" | "externalKey">,
  selectedTargets: ReadonlySet<string> | undefined,
): boolean {
  return !selectedTargets || selectedTargets.has(deliveryTargetKey(target));
}

function deliveryTargetKey(
  target: Pick<SparkSessionMailDeliveryReceipt, "adapter" | "externalKey">,
): string {
  return `${target.adapter}\u0000${target.externalKey}`;
}

function findRecordedDelivery(
  deliveries: SparkSessionMailDeliveryReceipt[],
  target: Pick<SparkSessionMailDeliveryReceipt, "adapter" | "externalKey">,
): SparkSessionMailDeliveryReceipt {
  const recorded = deliveries.find(
    (entry) => entry.adapter === target.adapter && entry.externalKey === target.externalKey,
  );
  if (!recorded) {
    throw new Error(
      `session mail delivery receipt disappeared for ${target.adapter}:${target.externalKey}`,
    );
  }
  return recorded;
}

function projectDelivery(
  delivery: SparkSessionMailDeliveryReceipt,
): SessionNotificationDeliveryReceipt {
  return {
    adapter: delivery.adapter,
    externalKey: delivery.externalKey,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    ...(delivery.receipt !== null ? { receipt: delivery.receipt } : {}),
    ...(delivery.lastError ? { error: delivery.lastError } : {}),
  };
}

function resolveNotificationAdapterId(status: DaemonChannelIngressStatus, adapter: string): string {
  const matching = status.adapters.filter((entry) => entry.type === adapter);
  if (matching.length === 1) return matching[0]!.id;
  const exact = matching.find((entry) => entry.id === adapter);
  if (exact) return exact.id;
  if (matching.length === 0) throw new Error(`no configured channel adapter for type ${adapter}`);
  throw new Error(`multiple channel adapters use type ${adapter}`);
}

function notificationRecipient(externalKey: string, adapter: string): string {
  const parts = externalKey.split(":").filter(Boolean);
  if (parts[0] === "conv") {
    if (parts[1] !== adapter || parts.length < 3) {
      throw new Error(`invalid channel externalKey: ${externalKey}`);
    }
    const legacy = parts.slice(2).join(":");
    return adapter === "qqbot" && !/^(?:c2c|group|channel):/u.test(legacy)
      ? `c2c:${legacy}`
      : legacy;
  }
  if (parts[0] !== adapter || !parts[1] || !parts.slice(2).join(":")) {
    throw new Error(`invalid channel externalKey: ${externalKey}`);
  }
  const scope = parts[1];
  const id = parts.slice(2).join(":");
  if (adapter === "qqbot") {
    if (scope === "group") return `group:${id}`;
    if (scope === "channel") return `channel:${id}`;
    return `c2c:${id}`;
  }
  if (adapter === "infoflow" && scope === "group") return `group:${id}`;
  return id;
}
