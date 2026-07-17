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

/** Streaming reply lifecycle shared by daemon and channel adapters. */
export interface ChannelReplyStream {
  /**
   * Where the final assistant answer is delivered. Defaults to `inline`.
   *
   * `inline` (default): the stream is the user-visible answer surface. The
   * daemon awaits `complete`/`fail` and skips durable `sendReply` when the
   * stream finishes successfully (falling back to `sendReply` only on failure).
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
  /** Optional reasoning / thinking stream (Infoflow thinking_aio). */
  appendReasoning?(delta: string): void;
  notifyToolStart(input: { name?: string; phase?: string }): void;
  notifyToolResult(text: string): void;
  complete(label?: string): Promise<void>;
  fail(message: string): Promise<void>;
}

/** Optional adapter capability; ordinary notify remains a simple text API. */
export interface ChannelReplyCapability {
  openReplyStream(target: ChannelReplyTarget): Promise<ChannelReplyStream | undefined>;
  sendReply(target: ChannelReplyTarget & { text: string }): Promise<void>;
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
