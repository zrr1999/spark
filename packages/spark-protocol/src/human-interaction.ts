import { z } from "zod";

/**
 * Canonical human-interaction lifecycle owned by the daemon wait registry.
 * Cockpit `human_requests` / inbox rows project from this vocabulary and must
 * not invent additional terminal states.
 */
export const SPARK_HUMAN_INTERACTION_STATUSES = [
  "pending",
  "answered",
  "cancelled",
  "archived",
] as const;

export type SparkHumanInteractionStatus = (typeof SPARK_HUMAN_INTERACTION_STATUSES)[number];

export const sparkHumanInteractionStatusSchema = z.enum(SPARK_HUMAN_INTERACTION_STATUSES);

/** Response payloads delivered back to the daemon (no `pending`). */
export const SPARK_HUMAN_RESPONSE_STATUSES = ["answered", "cancelled", "archived"] as const;

export type SparkHumanResponseStatus = (typeof SPARK_HUMAN_RESPONSE_STATUSES)[number];

export const sparkHumanResponseStatusSchema = z.enum(SPARK_HUMAN_RESPONSE_STATUSES);

/**
 * Cockpit outbox delivery of an operator response toward the daemon.
 * Orthogonal to the interaction lifecycle above.
 */
export const SPARK_HUMAN_RESPONSE_DELIVERY_STATUSES = ["delivering", "acked", "failed"] as const;

export type SparkHumanResponseDeliveryStatus =
  (typeof SPARK_HUMAN_RESPONSE_DELIVERY_STATUSES)[number];

export const sparkHumanResponseDeliveryStatusSchema = z.enum(
  SPARK_HUMAN_RESPONSE_DELIVERY_STATUSES,
);

/**
 * Inbox item projection status. `resolved` means the underlying interaction is
 * no longer pending (answered / cancelled / archived).
 */
export const SPARK_INBOX_ITEM_STATUSES = ["pending", "resolved", "archived"] as const;

export type SparkInboxItemStatus = (typeof SPARK_INBOX_ITEM_STATUSES)[number];

export const sparkInboxItemStatusSchema = z.enum(SPARK_INBOX_ITEM_STATUSES);

export const SPARK_HUMAN_CORRELATION_FIELDS = [
  "humanRequestId",
  "interactionRequestId",
  "humanResponseId",
] as const;

export type SparkHumanCorrelationField = (typeof SPARK_HUMAN_CORRELATION_FIELDS)[number];

export function isSparkHumanInteractionStatus(value: string): value is SparkHumanInteractionStatus {
  return (SPARK_HUMAN_INTERACTION_STATUSES as readonly string[]).includes(value);
}

export function isSparkHumanResponseStatus(value: string): value is SparkHumanResponseStatus {
  return (SPARK_HUMAN_RESPONSE_STATUSES as readonly string[]).includes(value);
}

export function projectInboxItemStatus(
  interactionStatus: SparkHumanInteractionStatus,
): SparkInboxItemStatus {
  switch (interactionStatus) {
    case "pending":
      return "pending";
    case "answered":
    case "cancelled":
      return "resolved";
    case "archived":
      return "archived";
    default: {
      const _exhaustive: never = interactionStatus;
      return _exhaustive;
    }
  }
}
