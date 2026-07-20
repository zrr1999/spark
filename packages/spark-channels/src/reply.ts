/** Platform-neutral destination and provenance for one channel reply. */
export interface ChannelReplyTarget {
  recipient: string;
  /** Original sender id; adapters may use it for a group mention. */
  senderId?: string;
  /** Original platform message id; adapters must not guess missing quote metadata. */
  messageId?: string;
  /** Display-safe source preview for adapters that can quote a message. */
  preview?: string;
}

/** Whether replaying the same durable delivery can create another platform message. */
export type ChannelDeliveryReplaySafety = "deduplicated" | "unsafe";

/** What Spark can prove after a failed outbound call. Unknown must never be retried blindly. */
export type ChannelDeliveryFailureCertainty = "not-sent" | "unknown";

/** Platform-neutral facts needed before choosing a durable retry policy. */
export interface ChannelDeliveryFacts {
  replaySafety: ChannelDeliveryReplaySafety;
}

/** JSON-safe provider receipt retained for audit and reconciliation. */
export interface ChannelDeliveryReceipt {
  messageId?: string;
  messageSequence?: string;
  messageKey?: string;
  timestamp?: string;
}

/** Successful outbound result shared by ordinary messages and rich replies. */
export interface ChannelDeliveryResult extends ChannelDeliveryFacts {
  receipt?: ChannelDeliveryReceipt;
}

/** Ordinary proactive message target used to query delivery facts. */
export interface ChannelMessageTarget {
  recipient: string;
}

/** A durable ordinary send. `deliveryId` remains stable across local retries. */
export interface ChannelMessageSendInput extends ChannelMessageTarget {
  text: string;
  deliveryId: string;
}

/** A durable reply send. `deliveryId` remains stable across local retries. */
export interface ChannelReplySendInput extends ChannelReplyTarget {
  text: string;
  deliveryId: string;
}

/** Compatibility input for callers that have not moved delivery ownership to the registry yet. */
export interface ChannelReplyCapabilitySendInput extends ChannelReplyTarget {
  text: string;
  deliveryId?: string;
}

/**
 * Opaque, JSON-safe handle for resuming the same platform reply artifact.
 *
 * The adapter that creates the stream also owns interpreting this value. The
 * daemon persists it before completing an inline stream so restart recovery
 * can update that same artifact instead of sending a second message.
 */
export interface ChannelReplyRecovery {
  kind: string;
  data: Record<string, string | number | boolean>;
}

export const CHANNEL_DELIVERY_NOT_SENT_ERROR_CODE = "CHANNEL_DELIVERY_NOT_SENT";
export const CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE = "CHANNEL_DELIVERY_OUTCOME_UNKNOWN";

/**
 * What is known after a channel adapter rejects a delivery attempt.
 *
 * `not_sent` is an affirmative platform/transport guarantee that no external
 * side effect occurred. Every untagged failure is conservatively `unknown`.
 */
export type ChannelDeliveryFailureOutcome = "not_sent" | "unknown";

/** Canonical delivery error. The outcome-shaped fields preserve the current daemon seam. */
export class ChannelDeliveryError extends Error {
  readonly certainty: ChannelDeliveryFailureCertainty;
  readonly code:
    | typeof CHANNEL_DELIVERY_NOT_SENT_ERROR_CODE
    | typeof CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE;
  readonly outcome: ChannelDeliveryFailureOutcome;

  constructor(
    message: string,
    certainty: ChannelDeliveryFailureCertainty,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ChannelDeliveryError";
    this.certainty = certainty;
    this.outcome = certainty === "not-sent" ? "not_sent" : "unknown";
    this.code =
      certainty === "not-sent"
        ? CHANNEL_DELIVERY_NOT_SENT_ERROR_CODE
        : CHANNEL_DELIVERY_OUTCOME_UNKNOWN_ERROR_CODE;
  }
}

/** @deprecated Prefer {@link ChannelDeliveryError}; retained for current daemon consumers. */
export class ChannelDeliveryOutcomeError extends ChannelDeliveryError {
  constructor(outcome: ChannelDeliveryFailureOutcome, cause: unknown) {
    const detail = deliveryErrorMessage(cause);
    super(
      outcome === "not_sent"
        ? `Channel delivery was confirmed not sent: ${detail}`
        : `Channel delivery outcome is unknown: ${detail}`,
      outcome === "not_sent" ? "not-sent" : "unknown",
      { cause },
    );
    this.name = "ChannelDeliveryOutcomeError";
  }
}

/** Mark an adapter failure that is guaranteed not to have produced a message. */
export function channelDeliveryNotSent(cause: unknown): ChannelDeliveryError {
  if (cause instanceof ChannelDeliveryError && cause.certainty === "not-sent") return cause;
  return new ChannelDeliveryOutcomeError("not_sent", cause);
}

/** Mark an adapter failure whose external side effect cannot be determined. */
export function channelDeliveryOutcomeUnknown(cause: unknown): ChannelDeliveryOutcomeError {
  return new ChannelDeliveryOutcomeError("unknown", cause);
}

/**
 * Classify a thrown delivery failure without relying on `instanceof` across
 * package/worker boundaries. Only the explicit `not_sent` tag relaxes the
 * fail-closed default.
 */
export function channelDeliveryFailureOutcome(error: unknown): ChannelDeliveryFailureOutcome {
  return channelDeliveryFailureCertainty(error) === "not-sent" ? "not_sent" : "unknown";
}

/** Canonical certainty classifier; untagged and post-dispatch failures remain unknown. */
export function channelDeliveryFailureCertainty(error: unknown): ChannelDeliveryFailureCertainty {
  if (!error || typeof error !== "object") return "unknown";
  const tagged = error as { certainty?: unknown; code?: unknown; outcome?: unknown };
  return tagged.code === CHANNEL_DELIVERY_NOT_SENT_ERROR_CODE &&
    (tagged.certainty === "not-sent" || tagged.outcome === "not_sent")
    ? "not-sent"
    : "unknown";
}

/** Reject missing durable identities before any provider request is constructed. */
export function requireChannelDeliveryId(deliveryId: string): string {
  const normalized = deliveryId.trim();
  if (!normalized) {
    throw channelDeliveryNotSent(new Error("channel deliveryId is required"));
  }
  return normalized;
}

export function normalizeChannelDeliveryResult(
  result: ChannelDeliveryResult | void,
  facts: ChannelDeliveryFacts,
): ChannelDeliveryResult {
  return result ?? facts;
}

/** Streaming reply lifecycle shared by daemon and channel adapters. */
export interface ChannelReplyStream {
  /**
   * Where the final assistant answer is delivered. Defaults to `inline`.
   *
   * `inline` (default): the stream is the user-visible answer surface. The
   * daemon awaits `complete`/`fail` and skips durable `sendReply` when the
   * stream finishes successfully. A fallback is safe only when the adapter
   * explicitly reports `not_sent`; ambiguous failures remain fail-closed.
   *
   * `separate`: progress-only surface. The daemon still enqueues durable
   * `sendReply` for the final answer after the stream reaches a terminal state.
   */
  answerMode?: "inline" | "separate";
  /** Durable handle for retrying this exact inline reply after a daemon crash. */
  deliveryRecovery?: ChannelReplyRecovery;
  /** Display-safe execution commentary for progress-only platform surfaces. */
  appendProgress?(delta: string): void;
  appendText(delta: string): void;
  /**
   * Replace the entire answer body. Required for replace-mode surfaces when the
   * final assistant prose is not a pure prefix of earlier streamed text (common
   * after tool rounds).
   */
  replaceText?(text: string): void;
  /** Optional reasoning / thinking stream (Infoflow thinking_aio). */
  appendReasoning?(delta: string): void;
  notifyToolStart(input: { name?: string; phase?: string }): void;
  notifyToolResult(text: string): void;
  complete(label?: string): Promise<void>;
  fail(message: string): Promise<void>;
}

/** Optional adapter capability; ordinary notify remains a simple text API. */
export interface ChannelReplyCapability {
  /** Replay policy for this concrete destination and source-message identity. */
  deliveryFacts?(target: ChannelReplyTarget): ChannelDeliveryFacts;
  openReplyStream(target: ChannelReplyTarget): Promise<ChannelReplyStream | undefined>;
  sendReply(target: ChannelReplyCapabilitySendInput): Promise<ChannelDeliveryResult | void>;
  /**
   * Resume/update the platform artifact identified by `recovery`.
   *
   * Implementations must not create a fresh message. A failed or unsupported
   * recovery throws so the durable outbox remains pending for a later retry.
   */
  recoverReply?(
    input: ChannelReplyTarget & {
      text: string;
      deliveryId: string;
      recovery: ChannelReplyRecovery;
    },
  ): Promise<void>;
}

function deliveryErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const value = String(error).trim();
  return value || "unknown error";
}
